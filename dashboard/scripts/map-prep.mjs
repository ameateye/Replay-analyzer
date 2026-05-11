// Builds the per-run map JSON the React player consumes — directly from
// extracted-data + the cross-run sprite-meta lookup, no Java FBSR involved.
//
// Pipeline (see docs/specs/fbsr_elimination.md):
//   extracted-data/<run>/{entityLayout, minerActivity, machineProduction,
//                         labContents, bufferAmounts, playerPosition,
//                         rocketLaunchTime}.json
//   + game-data/map-sprite-meta.json   (cross-run lookup: name|dir|bgt → layers[])
//   + game-data/map-sprites.json       (sprite dimensions, for viewBox bounds)
//   ↓
//   dashboard/src/data/<run>.map.json  (entities + overlays + playerTrack + viewBox)
//
// The meta lookup is keyed on END-OF-RUN orientation: each entity's mutations
// are folded to durationTick (first rocket launch) before lookup. Layers per
// variant are stacked (e.g. inserter base at L43 + arm at L53; UB belt-surface
// at L28 + drum at L43). Each rendered entry carries (px+oxOff, py+oyOff,
// sid, L, en, tb, tr?) — the same shape the legacy FBSR manifest produced.
//
// Overlays — recipeMachines / splitterMarkers / inserterMarkers — are built
// here too (responsibility moved over from the old fbsr-prep timing sidecar).
// Each carries an `en` (1-based, internal to this map.json) so MapView can
// join overlay timelines back onto the rendered entities.
//
// Entities whose (name|dir|bgt) variant isn't in the meta are skipped with an
// aggregated warning — the gap-fill flow in dashboard/scripts/fbsr-prep.mjs
// (Component C of the spec) is responsible for closing those gaps.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Only these entity names participate in the rendered scope. Mirrors the
// LAYOUT_SCOPE in the old fbsr-prep — poles in particular are excluded
// because nothing else in the dashboard renders them.
const LAYOUT_SCOPE = new Set([
  'transport-belt', 'fast-transport-belt', 'express-transport-belt',
  'underground-belt', 'fast-underground-belt', 'express-underground-belt',
  'splitter', 'fast-splitter', 'express-splitter',
  'burner-inserter', 'inserter', 'long-handed-inserter',
  'fast-inserter', 'filter-inserter', 'stack-inserter', 'stack-filter-inserter',
  'bulk-inserter',
]);

const INSERTER_NAMES = new Set([
  'inserter', 'burner-inserter', 'long-handed-inserter', 'fast-inserter',
  'filter-inserter', 'stack-inserter', 'stack-filter-inserter', 'bulk-inserter',
]);

function readJsonOrNull(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}
function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }
function round4(n) { return Math.round(n * 1e4) / 1e4; }

function foldDirection(e, cutoff) {
  let dir = e.direction ?? 0;
  let bgt = e.beltToGroundType ?? null;
  for (const m of e.mutations ?? []) {
    if (m.tick > cutoff) break;
    if (m.direction !== undefined) dir = m.direction;
    if (m.beltToGroundType !== undefined) bgt = m.beltToGroundType;
  }
  return { dir, bgt };
}

// Splitter alt-mode timeline. Each event { ts, ip, op, f }. Emitted only when
// the splitter is non-default at some point in the run.
function buildSplitterTimeline(e) {
  let ip = e.splitterInputPriority  ?? 'none';
  let op = e.splitterOutputPriority ?? 'none';
  let f  = e.splitterFilter         ?? '';
  const events = [{ ts: e.timeBuilt ?? 0, ip, op, f }];
  for (const m of e.mutations ?? []) {
    let changed = false;
    if (m.splitterInputPriority  !== undefined && m.splitterInputPriority  !== ip) { ip = m.splitterInputPriority;  changed = true; }
    if (m.splitterOutputPriority !== undefined && m.splitterOutputPriority !== op) { op = m.splitterOutputPriority; changed = true; }
    if (m.splitterFilter         !== undefined && m.splitterFilter         !== f)  { f  = m.splitterFilter;         changed = true; }
    if (changed) events.push({ ts: m.tick, ip, op, f });
  }
  const anyOverlay = events.some(ev => ev.ip !== 'none' || ev.op !== 'none' || ev.f !== '');
  return anyOverlay ? events : [];
}

function sameStrArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Inserter filter timeline. Each event { ts, u, m, f }. Emitted only when
// the inserter ever has useFilters=true with a non-empty filter set.
function buildInserterTimeline(e) {
  const asArr = (v) => Array.isArray(v) ? v : [];
  let u = e.inserterUseFilters ?? false;
  let m = e.inserterFilterMode;
  let f = asArr(e.inserterFilters);
  const events = [{ ts: e.timeBuilt ?? 0, u, m, f }];
  for (const mu of e.mutations ?? []) {
    let changed = false;
    if (mu.inserterUseFilters !== undefined && mu.inserterUseFilters !== u) { u = mu.inserterUseFilters; changed = true; }
    if (mu.inserterFilterMode !== undefined && mu.inserterFilterMode !== m) { m = mu.inserterFilterMode; changed = true; }
    if (mu.inserterFilters    !== undefined) {
      const next = asArr(mu.inserterFilters);
      if (!sameStrArr(next, f)) { f = next; changed = true; }
    }
    if (changed) events.push({ ts: mu.tick, u, m, f });
  }
  const anyOverlay = events.some(ev => ev.u && ev.f.length > 0);
  return anyOverlay ? events : [];
}

// Lab timeRemoved heuristic — labContents doesn't currently record removal,
// so a lab whose last periodic sample is well before the latest sample seen
// across any lab was removed shortly after that last sample.
function deriveLabRemovedTick(lab, maxSample, period) {
  if (lab.timeRemoved !== undefined) return lab.timeRemoved;
  const last = lab.packs[lab.packs.length - 1];
  if (last && last[0] + period * 2 < maxSample) return last[0] + period;
  return undefined;
}

// Machine timeRemoved heuristic — machineProduction doesn't always set
// timeRemoved, but stoppedReason=mined|entity_died on the active recipe
// signals removal. Mirrors the legacy fbsr-prep behaviour.
function deriveMachineRemovedTick(machine) {
  if (machine.timeRemoved !== undefined) return machine.timeRemoved;
  let tr;
  for (const r of machine.recipes ?? []) {
    if ((r.stoppedReason === 'mined' || r.stoppedReason === 'entity_died')
        && r.timeStopped !== undefined) {
      if (tr === undefined || r.timeStopped > tr) tr = r.timeStopped;
    }
  }
  return tr;
}

// Build the unified merged-entity list (mirrors the 5 sources fbsr-prep
// pulls from). Returns records normalized to:
//   { name, ux, uy, dir, bgt, tb, tr?, un, recipeTimeline?, splitterTimeline?, inserterTimeline? }
function buildMergedEntities(runDir, durationTick, externalMiners) {
  const merged = [];

  // 1) entityLayout (belts, UBs, splitters, inserters — poles excluded).
  const layout = readJson(resolve(runDir, 'entityLayout.json'));
  for (const e of layout.entities) {
    if (!LAYOUT_SCOPE.has(e.name)) continue;
    const { dir, bgt } = foldDirection(e, durationTick);
    const rec = {
      name: e.name,
      ux: e.location.x, uy: e.location.y,
      dir, bgt,
      tb: e.timeBuilt ?? 0,
      tr: e.timeRemoved,
      un: e.unitNumber,
    };
    if (e.name.endsWith('splitter')) {
      const evs = buildSplitterTimeline(e);
      if (evs.length > 0) rec.splitterTimeline = evs;
    }
    if (INSERTER_NAMES.has(e.name)) {
      const evs = buildInserterTimeline(e);
      if (evs.length > 0) rec.inserterTimeline = evs;
    }
    merged.push(rec);
  }

  // 2) Miners (prefer caller-supplied lifted view to share source-of-truth).
  const minerList = externalMiners?.miners
    ?? readJsonOrNull(resolve(runDir, 'minerActivity.json'))?.miners
    ?? [];
  for (const m of minerList) {
    merged.push({
      name: m.name,
      ux: m.location.x, uy: m.location.y,
      dir: m.direction ?? 0, bgt: null,
      tb: m.timeBuilt ?? 0,
      tr: m.timeRemoved,
      un: m.unitNumber,
    });
  }

  // 3) Machines (recipe timeline drives the recipeMachines overlay).
  const mp = readJsonOrNull(resolve(runDir, 'machineProduction.json'));
  for (const m of mp?.machines ?? []) {
    const timeline = (m.recipes ?? [])
      .filter(r => r && r.recipe)
      .map(r => ({ ts: r.timeStarted ?? 0, n: r.recipe }));
    merged.push({
      name: m.name,
      ux: m.location.x, uy: m.location.y,
      dir: m.direction ?? 0, bgt: null,
      tb: m.timeBuilt ?? 0,
      tr: deriveMachineRemovedTick(m),
      un: m.unitNumber,
      recipeTimeline: timeline.length > 0 ? timeline : undefined,
    });
  }

  // 4) Labs.
  const labData = readJsonOrNull(resolve(runDir, 'labContents.json'));
  if (labData) {
    let maxSample = 0;
    for (const l of labData.labs) {
      const last = l.packs[l.packs.length - 1];
      if (last && last[0] > maxSample) maxSample = last[0];
    }
    for (const l of labData.labs) {
      merged.push({
        name: l.name,
        ux: l.location.x, uy: l.location.y,
        dir: 0, bgt: null,
        tb: l.timeBuilt ?? 0,
        tr: deriveLabRemovedTick(l, maxSample, labData.period),
        un: l.unitNumber,
      });
    }
  }

  // 5) Buffers (chests + tanks).
  const ba = readJsonOrNull(resolve(runDir, 'bufferAmounts.json'));
  for (const b of ba?.buffers ?? []) {
    merged.push({
      name: b.name,
      ux: b.location.x, uy: b.location.y,
      dir: 0, bgt: null,
      tb: b.timeBuilt ?? 0,
      tr: b.timeRemoved,
      un: b.unitNumber,
    });
  }

  return merged;
}

function metaKey(name, dir, bgt) {
  return `${name}|${dir ?? 0}|${bgt ?? '_'}`;
}

// Callable form invoked inline from build-run-data.mjs.
//   phases — optional `run.phases` slice; embedded for the map player so it
//            can snap its timeline to phase boundaries.
//   miners — optional `run.miners` lifted dataset; reused for end-of-run
//            direction folding instead of re-reading minerActivity.json.
export function buildMapData(runName, { phases = null, miners = null } = {}) {
  const RUN = runName;
  const runDir     = resolve(ROOT, 'extracted-data', RUN);
  const outDir     = resolve(ROOT, 'dashboard', 'src', 'data');
  const outPath    = resolve(outDir, `${RUN}.map.json`);
  const metaPath   = resolve(ROOT, 'game-data', 'map-sprite-meta.json');
  const spritePath = resolve(ROOT, 'game-data', 'map-sprites.json');
  const rocketPath = resolve(runDir, 'rocketLaunchTime.json');
  const playerPath = resolve(runDir, 'playerPosition.json');

  if (!existsSync(runDir)) throw new Error(`extracted-data/${RUN}/ not found`);
  if (!existsSync(metaPath)) throw new Error(`${metaPath} missing — run dashboard/scripts/fbsr-prep.mjs first to populate it`);
  if (!existsSync(spritePath)) throw new Error(`${spritePath} missing`);

  const meta    = readJson(metaPath);
  const sprites = readJson(spritePath);

  // durationTick = first rocket launch. Fall back to latest build tick later.
  let durationTick = 0;
  const rocket = readJsonOrNull(rocketPath);
  if (rocket?.rocketLaunchTimes?.length) durationTick = rocket.rocketLaunchTimes[0];

  const merged = buildMergedEntities(runDir, durationTick, miners);

  // Place entities by looking up meta layers. Assign a 1-based `en` per
  // merged record so overlays can join entities[] entries by `en`.
  const entities = [];
  const recipeMachines = [];
  const splitterMarkers = [];
  const inserterMarkers = [];
  const spriteIds = new Set(Object.keys(sprites));
  const missingVariants = new Map();   // key → count
  let missingSprites = 0;
  let droppedRecipeEntries = 0;
  let droppedSplitterFilters = 0;
  let droppedInserterFilters = 0;

  merged.forEach((rec, i) => {
    const en = i + 1;
    const key = metaKey(rec.name, rec.dir, rec.bgt);
    const variant = meta[key];
    if (!variant) {
      missingVariants.set(key, (missingVariants.get(key) ?? 0) + 1);
    } else {
      for (const layer of variant.layers) {
        if (!spriteIds.has(layer.sid)) { missingSprites++; continue; }
        const out = {
          name: rec.name,
          px: rec.ux,
          en,
          py: rec.uy,
          ox: round4(rec.ux + layer.oxOff),
          oy: round4(rec.uy + layer.oyOff),
          L:  layer.L,
          sid: layer.sid,
          tb: rec.tb,
        };
        if (rec.tr !== undefined) out.tr = rec.tr;
        entities.push(out);
      }
    }

    // Recipe overlay — one entry per machine that ever set a recipe.
    if (rec.recipeTimeline) {
      const filtered = rec.recipeTimeline.filter(r => spriteIds.has(`r:${r.n}`));
      droppedRecipeEntries += rec.recipeTimeline.length - filtered.length;
      if (filtered.length > 0) {
        const m = { en, name: rec.name, px: rec.ux, py: rec.uy, rs: filtered };
        if (rec.tr !== undefined) m.tr = rec.tr;
        recipeMachines.push(m);
      }
    }

    // Splitter alt-mode overlay.
    if (rec.splitterTimeline) {
      for (const ev of rec.splitterTimeline) if (ev.f && !spriteIds.has(`f:${ev.f}`)) droppedSplitterFilters++;
      const m = { en, name: rec.name, px: rec.ux, py: rec.uy, dir: rec.dir ?? 0, ts: rec.splitterTimeline };
      if (rec.tr !== undefined) m.tr = rec.tr;
      splitterMarkers.push(m);
    }

    // Inserter alt-mode overlay.
    if (rec.inserterTimeline) {
      for (const ev of rec.inserterTimeline) for (const name of (ev.f || [])) {
        if (!spriteIds.has(`f:${name}`)) droppedInserterFilters++;
      }
      const m = { en, name: rec.name, px: rec.ux, py: rec.uy, dir: rec.dir ?? 0, ts: rec.inserterTimeline };
      if (rec.tr !== undefined) m.tr = rec.tr;
      inserterMarkers.push(m);
    }
  });

  // Sort entities globally by (L, py, px) so DOM order matches FBSR's draw
  // order. Belts at low L draw under objects at higher L, etc.
  entities.sort((a, b) => {
    if (a.L !== b.L) return a.L - b.L;
    if (a.py !== b.py) return a.py - b.py;
    return a.px - b.px;
  });

  // Latest build tick — fallback durationTick when rocketLaunchTime missing.
  let maxTb = 0;
  for (const e of entities) if (e.tb > maxTb) maxTb = e.tb;
  if (!durationTick) durationTick = maxTb;

  // Drop entities built after the run cutoff (rocket-launch). These come
  // from late-game builds the dashboard intentionally clips. Matches the
  // chart-side clipping behaviour.
  const cutoff = durationTick;
  const visibleEntities = entities.filter(e => e.tb > 0 && e.tb <= cutoff);

  // viewBox = tight bbox of rendered sprite extents. FBSR did the same.
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const e of visibleEntities) {
    const s = sprites[e.sid];
    if (!s) continue;
    if (e.ox < xmin) xmin = e.ox;
    if (e.oy < ymin) ymin = e.oy;
    if (e.ox + s.w > xmax) xmax = e.ox + s.w;
    if (e.oy + s.h > ymax) ymax = e.oy + s.h;
  }
  const viewBox = xmin === Infinity
    ? [0, 0, 0, 0]
    : [round4(xmin), round4(ymin), round4(xmax - xmin), round4(ymax - ymin)];

  // Player track — convert {period, players:{name:[[x,y],...]}} to a single
  // array with period preserved. Uses the first player only.
  let playerTrack = null;
  const pp = readJsonOrNull(playerPath);
  if (pp) {
    const names = Object.keys(pp.players || {});
    if (names.length > 0) {
      const name = names[0];
      playerTrack = {
        name,
        period: pp.period ?? 60,
        positions: pp.players[name].map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
      };
    }
  }

  const out = {
    runName: RUN,
    viewBox,
    durationTick,
    entities: visibleEntities,
    recipeMachines,
    splitterMarkers,
    inserterMarkers,
    playerTrack,
  };
  if (phases && phases.length > 0) out.phases = phases;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out));

  const layerCount = new Set(visibleEntities.map(e => e.L)).size;
  const skippedTotal = [...missingVariants.values()].reduce((a, b) => a + b, 0);
  console.log('wrote', outPath);
  console.log('renderables:', visibleEntities.length, '/ across', layerCount, 'FBSR layers');
  console.log('with timeRemoved:', visibleEntities.filter(e => e.tr !== undefined).length);
  console.log('recipe machines:', recipeMachines.length, droppedRecipeEntries ? `(${droppedRecipeEntries} recipe events without sprite)` : '');
  console.log('splitter markers:', splitterMarkers.length, droppedSplitterFilters ? `(${droppedSplitterFilters} filter events without sprite)` : '');
  console.log('inserter markers:', inserterMarkers.length, droppedInserterFilters ? `(${droppedInserterFilters} filter events without sprite)` : '');
  console.log('player track:', playerTrack ? `${playerTrack.name} (${playerTrack.positions.length} samples @ ${playerTrack.period}t)` : 'none');
  console.log('max build tick:', maxTb, '/ duration tick:', durationTick);
  console.log('phases:', phases?.length ? `${phases.length} embedded` : 'none (standalone invocation)');
  console.log('viewBox:', viewBox);
  if (skippedTotal > 0) {
    console.log(`meta gaps: ${missingVariants.size} variant(s), ${skippedTotal} entities skipped — run fbsr-prep to backfill`);
    const top = [...missingVariants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [k, n] of top) console.log(`    ${k}: ${n}`);
  }
  if (missingSprites > 0) console.log(`missing sprite ids in atlas: ${missingSprites} (meta references sids absent from map-sprites.json)`);

  return { outPath, durationTick, entityCount: visibleEntities.length };
}

// CLI: standalone invocation (no phases passed in).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const RUN = process.argv[2];
  if (!RUN) {
    console.error('usage: node map-prep.mjs <run-name>');
    process.exit(1);
  }
  buildMapData(RUN);
}
