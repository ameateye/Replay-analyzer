// Joins the FBSR atlas manifest with the timing sidecar produced by
// fbsr-prep, and writes the two files the React player needs at runtime:
// a small map-data JSON (entities + viewBox + timelines + phases) and a
// single cross-run sprite atlas served from game-data.
//
// Three dynamic-overlay arrays are emitted alongside the renderable
// entities, each parallel to the recipe-overlay pattern:
//   recipeMachines[]  — one per machine that ever set a recipe
//   splitterMarkers[] — one per splitter that ever had non-default state
//   inserterMarkers[] — one per inserter that ever had useFilters + filters
// Each carries the entity's (en, name, px, py [, dir]) plus a pre-filtered
// state timeline. MapView walks each timeline to drive visibility / href.
//
// Inputs (under tools/output/):
//   <RUN>.manifest.json   — { viewBox, sprites: {id→{w,h,data}},
//                             entities: [{en, name, px, py, ox, oy, sid, L}] }
//                           Granular layering: one entry per (entity, FBSR Layer)
//                           bucket; L is the FBSR Layer ordinal (see
//                           Factorio-FBSR Layer.java) carrying global draw order.
//                           Transient: this script DELETES the manifest after
//                           a successful write — its data is fully captured in
//                           the per-run map.json (placements) and the shared
//                           atlas (sprites). Re-running map-prep means
//                           re-rendering with FBSR.
//   <RUN>.timing.json     — { [entityNumber]: { tb, tr?, un, rs? } }   (rs = recipe timeline)
//
// Outputs:
//   dashboard/src/data/<RUN>.map.json
//       — { viewBox, durationTick, phases?, entities (renderables, sorted
//           globally by (L, py, px)), recipeMachines (one per entity-with-rs),
//           splitterMarkers, inserterMarkers, playerTrack }
//   game-data/map-sprites.json
//       — { id → {w, h, data} }   (entity sprites + recipe-icon sprites with sid prefix "r:")
//         Shared across all runs: sprite IDs are deterministic (entity name
//         / `r:<recipe>`), so this script MERGES new sprites into the
//         existing atlas rather than overwriting. Existing IDs keep their
//         data; new IDs are added.
//
// Splitting sprites out of the per-run map.json keeps that file small
// (entities + timing only) and lets the React side fetch sprites via the
// shared game-data URL contract — same caching/path semantics as the rest
// of the cross-run reference data. The atlas is shared because every run
// re-renders the same set of entity / recipe sprites.
//
// Phases (optional): when build-run-data calls this prep inline, it passes
// the run's computed phase boundaries through so the map player can snap
// its timeline to phase ends. Standalone CLI invocations don't pass them
// (the chart-side computePhases isn't run); the player falls back to a
// linear durationTick scrubber.
//
// Miners (optional): the chart-side build-run-data also passes the lifted
// `miners` dataset so map-prep can reuse the same per-run source-of-truth
// for end-of-run direction folding (single read, single shape). When
// missing (e.g. CLI invocation without a chart-side build) map-prep falls
// back to reading raw minerActivity.json directly.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Returns true iff buildMapData has its inputs in place for this run —
// the Java FBSR step's two outputs both exist in tools/output/.
// build-run-data.mjs checks this to decide whether to invoke us inline.
export function mapPrepInputsReady(runName) {
  return existsSync(resolve(ROOT, 'tools', 'output', `${runName}.manifest.json`))
      && existsSync(resolve(ROOT, 'tools', 'output', `${runName}.timing.json`));
}

// Callable form of the map-prep pipeline.
//   phases — optional array of `{ name, startTick, endTick, ... }` (typically
//            `run.phases` from the chart-side build). When present it's
//            embedded in the per-run map.json so the React map player can
//            snap its timeline to phase boundaries. When null the map.json
//            omits the `phases` field and the player falls back to the
//            linear durationTick range.
//   miners — optional `{ miners: [...] }` (typically `run.miners` from the
//            chart-side build). When present, map-prep uses it for end-of-
//            run direction folding instead of re-reading minerActivity.json.
export function buildMapData(runName, { phases = null, miners = null } = {}) {
  const RUN = runName;
  const manifestPath = resolve(ROOT, 'tools', 'output', `${RUN}.manifest.json`);
  const timingPath   = resolve(ROOT, 'tools', 'output', `${RUN}.timing.json`);
  const rocketPath   = resolve(ROOT, 'extracted-data', RUN, 'rocketLaunchTime.json');
  const playerPath   = resolve(ROOT, 'extracted-data', RUN, 'playerPosition.json');
  const outDir       = resolve(ROOT, 'dashboard', 'src', 'data');
  const outPath      = resolve(outDir, `${RUN}.map.json`);
  const spritePath   = resolve(ROOT, 'game-data', 'map-sprites.json');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const timing   = JSON.parse(readFileSync(timingPath,   'utf-8'));

  let durationTick = 0;
  try {
    const r = JSON.parse(readFileSync(rocketPath, 'utf-8'));
    durationTick = r.rocketLaunchTimes?.[0] ?? 0;
  } catch {
    // First-rocket-launch tick is optional; player just falls back to last build tick.
  }

  // Rebind each entity's sprite to its END-OF-RUN orientation.
  // FBSR's manifest bakes one sid per renderable based on the direction it
  // saw in the input blueprint at render time. The atlas already contains
  // all four orientation sprites — only the per-entity sid pointer is wrong.
  // Strategy: derive a `(name, direction[, beltToGroundType], L) → {sid, ox, oy}`
  // lookup from the manifest itself, keyed on each entity's RAW (build-time)
  // direction. Then walk the manifest again with each entity's CUTOFF
  // direction and swap the sid/offsets when it differs.
  // Skip if rocketLaunchTime.json is missing — without a cutoff we can't fold.
  const layoutPath = resolve(ROOT, 'extracted-data', RUN, 'entityLayout.json');
  const minerPath  = resolve(ROOT, 'extracted-data', RUN, 'minerActivity.json');

  const rawByUn = new Map();   // unitNumber → { dir?, bgt?, tr? }
  const cutByUn = new Map();   // unitNumber → { dir, bgt }
  try {
    const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
    for (const e of layout.entities) {
      rawByUn.set(e.unitNumber, { dir: e.direction ?? 0, bgt: e.beltToGroundType, tr: e.timeRemoved });
      if (durationTick > 0) cutByUn.set(e.unitNumber, foldDirection(e, durationTick));
    }
  } catch {
    // entityLayout missing — leave the manifest as-is.
  }
  // Prefer the lifted `miners` payload (passed in by build-run-data so both
  // pipelines share one source of truth). Fall back to reading raw
  // minerActivity.json so the standalone CLI keeps working.
  let minerList = null;
  if (miners?.miners) {
    minerList = miners.miners;
  } else {
    try {
      const raw = JSON.parse(readFileSync(minerPath, 'utf-8'));
      minerList = raw.miners ?? null;
    } catch {
      // minerActivity missing — drills/pumpjack stay on their manifest sids.
    }
  }
  if (minerList) {
    for (const e of minerList) {
      rawByUn.set(e.unitNumber, { dir: e.direction ?? 0, tr: e.timeRemoved });
      if (durationTick > 0) cutByUn.set(e.unitNumber, foldDirection(e, durationTick));
    }
  }

  // entity_number → unitNumber via the timing sidecar.
  const enToUn = new Map();
  for (const [en, t] of Object.entries(timing)) enToUn.set(+en, t.un);

  if (durationTick > 0) {
    // Lookup table built from the manifest's CURRENT sids, keyed on RAW direction.
    const lookup = new Map();
    for (const e of manifest.entities) {
      const un = enToUn.get(e.en);
      const raw = rawByUn.get(un);
      if (!raw || raw.dir === undefined) continue;
      const key = `${e.name}|${raw.dir}|${raw.bgt ?? '_'}|${e.L}`;
      if (!lookup.has(key)) {
        lookup.set(key, { sid: e.sid, oxOff: e.ox - e.px, oyOff: e.oy - e.py });
      }
    }
    // Patch entities whose cutoff direction or beltToGroundType differs from build.
    let patched = 0, missingTarget = 0;
    for (const e of manifest.entities) {
      const un = enToUn.get(e.en);
      const cur = cutByUn.get(un);
      const raw = rawByUn.get(un);
      if (!cur || !raw) continue;
      const sameDir = (cur.dir ?? 0) === (raw.dir ?? 0);
      const sameBgt = (cur.bgt ?? '_') === (raw.bgt ?? '_');
      if (sameDir && sameBgt) continue;
      const key = `${e.name}|${cur.dir ?? 0}|${cur.bgt ?? '_'}|${e.L}`;
      const target = lookup.get(key);
      if (!target) { missingTarget++; continue; }
      e.sid = target.sid;
      e.ox = e.px + target.oxOff;
      e.oy = e.py + target.oyOff;
      patched++;
    }
    console.log('sprite-rebinds (rotation/flip):', patched, missingTarget ? `(no atlas variant for ${missingTarget})` : '');
  }

  // Join sprite manifest with timing sidecar (tb / tr / rs per entityNumber).
  // Manifest entries are renderables — one per (entity, FBSR Layer) bucket.
  // Sort globally by (L, py, px) so DOM order = FBSR draw order: belts at
  // TRANSPORT_BELT (36) below objects at OBJECT (51) below inserter arms at
  // HIGHER_OBJECT_UNDER (53) below indicators at INSERTER_INDICATORS (58).
  let trFallbackHits = 0;
  const entities = manifest.entities
    .map(e => {
      const t = timing[e.en];
      if (!t) return null;
      const out = { ...e, tb: t.tb };
      if (t.tr !== undefined) out.tr = t.tr;
      else {
        const raw = rawByUn.get(t.un);
        if (raw && raw.tr !== undefined) { out.tr = raw.tr; trFallbackHits++; }
      }
      return out;
    })
    .filter(e => e && e.tb > 0)
    .sort((a, b) => {
      if (a.L !== b.L) return a.L - b.L;
      if (a.py !== b.py) return a.py - b.py;
      return a.px - b.px;
    });

  // Latest build tick — used as a fallback when rocketLaunchTime is missing.
  let maxTb = 0;
  for (const e of entities) if (e.tb > maxTb) maxTb = e.tb;
  if (!durationTick) durationTick = maxTb;

  // Player track. Source: { period, players: { name: [[x,y], ...] } }.
  // Convert to a single array (first player) with the period preserved.
  let playerTrack = null;
  try {
    const pp = JSON.parse(readFileSync(playerPath, 'utf-8'));
    const names = Object.keys(pp.players || {});
    if (names.length > 0) {
      const name = names[0];
      playerTrack = {
        name,
        period: pp.period ?? 60,
        positions: pp.players[name].map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
      };
    }
  } catch {
    // playerPosition.json is optional; just skip the marker if missing.
  }

  // Recipe overlay: one entry per machine that ever ran a recipe.
  const spriteIds = new Set(Object.keys(manifest.sprites));
  const recipeMachineSeen = new Map();
  let droppedRecipeEntries = 0;
  for (const e of manifest.entities) {
    const t = timing[e.en];
    if (!t || !t.rs || t.rs.length === 0) continue;
    if (recipeMachineSeen.has(e.en)) continue;
    const filtered = t.rs.filter(r => spriteIds.has(`r:${r.n}`));
    droppedRecipeEntries += t.rs.length - filtered.length;
    if (filtered.length === 0) continue;
    const m = { en: e.en, name: e.name, px: e.px, py: e.py, rs: filtered };
    if (t.tr !== undefined) m.tr = t.tr;
    recipeMachineSeen.set(e.en, m);
  }
  const recipeMachines = [...recipeMachineSeen.values()];

  // Splitter alt-mode overlay.
  const splitterSeen = new Map();
  let droppedSplitterFilters = 0;
  for (const e of manifest.entities) {
    const t = timing[e.en];
    if (!t || !t.ss || t.ss.length === 0) continue;
    if (splitterSeen.has(e.en)) continue;
    const evs = t.ss;
    for (const ev of evs) if (ev.f && !spriteIds.has(`f:${ev.f}`)) droppedSplitterFilters++;
    const cur = cutByUn.get(t.un);
    const dir = cur ? (cur.dir ?? 0) : 0;
    const m = { en: e.en, name: e.name, px: e.px, py: e.py, dir, ts: evs };
    const tr = t.tr ?? rawByUn.get(t.un)?.tr;
    if (tr !== undefined) m.tr = tr;
    splitterSeen.set(e.en, m);
  }
  const splitterMarkers = [...splitterSeen.values()];

  // Inserter alt-mode overlay.
  const inserterSeen = new Map();
  let droppedInserterFilters = 0;
  for (const e of manifest.entities) {
    const t = timing[e.en];
    if (!t || !t.is || t.is.length === 0) continue;
    if (inserterSeen.has(e.en)) continue;
    const evs = t.is;
    for (const ev of evs) for (const name of (ev.f || [])) {
      if (!spriteIds.has(`f:${name}`)) droppedInserterFilters++;
    }
    const cur = cutByUn.get(t.un);
    const dir = cur ? (cur.dir ?? 0) : 0;
    const m = { en: e.en, name: e.name, px: e.px, py: e.py, dir, ts: evs };
    const tr = t.tr ?? rawByUn.get(t.un)?.tr;
    if (tr !== undefined) m.tr = tr;
    inserterSeen.set(e.en, m);
  }
  const inserterMarkers = [...inserterSeen.values()];

  const out = {
    runName: RUN,
    viewBox: manifest.viewBox,
    durationTick,
    entities,
    recipeMachines,
    splitterMarkers,
    inserterMarkers,
    playerTrack,
  };
  // Phases come from the chart-side build (when build-run-data invokes us
  // inline). Standalone CLI invocations omit them — the player then falls
  // back to its linear durationTick scrubber.
  if (phases && phases.length > 0) out.phases = phases;

  // Merge into the shared atlas. Sprite IDs are deterministic, so re-running
  // for an existing run is idempotent and adding a new run augments the
  // atlas with whatever IDs it introduced.
  const existingSprites = existsSync(spritePath)
    ? JSON.parse(readFileSync(spritePath, 'utf-8'))
    : {};
  const beforeCount = Object.keys(existingSprites).length;
  const mergedSprites = { ...existingSprites, ...manifest.sprites };
  const addedCount = Object.keys(mergedSprites).length - beforeCount;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out));
  writeFileSync(spritePath, JSON.stringify(mergedSprites));

  // Manifest is now redundant: sprites are in the shared atlas, placements
  // are in the per-run map.json. Drop it so the only persistent FBSR-side
  // state is `<RUN>.json` (blueprint) + `<RUN>.timing.json`.
  unlinkSync(manifestPath);

  const entitySpriteCount = Object.keys(manifest.sprites).filter(k => !k.startsWith('r:')).length;
  const recipeSpriteCount = Object.keys(manifest.sprites).length - entitySpriteCount;
  const layerCount = new Set(entities.map(e => e.L)).size;

  console.log('wrote', outPath);
  console.log('wrote', spritePath, `(atlas: ${Object.keys(mergedSprites).length} sprites, +${addedCount} new from this run)`);
  console.log('renderables:', entities.length, '/ across', layerCount, 'FBSR layers');
  console.log('entity sprites in run:', entitySpriteCount, '/ recipe sprites in run:', recipeSpriteCount);
  console.log('with timeRemoved:', entities.filter(e => e.tr !== undefined).length, trFallbackHits ? `(+${trFallbackHits} from raw fallback)` : '');
  console.log('recipe machines:', recipeMachines.length);
  if (droppedRecipeEntries) console.log('dropped recipe-events (sprite missing):', droppedRecipeEntries);
  console.log('splitter markers:', splitterMarkers.length, droppedSplitterFilters ? `(${droppedSplitterFilters} filter-events without sprite)` : '');
  console.log('inserter markers:', inserterMarkers.length, droppedInserterFilters ? `(${droppedInserterFilters} filter-events without sprite)` : '');
  console.log('player track:', playerTrack ? `${playerTrack.name} (${playerTrack.positions.length} samples @ ${playerTrack.period}t)` : 'none');
  console.log('max build tick:', maxTb, '/ duration tick:', durationTick);
  console.log('phases:', phases ? `${phases.length} embedded` : 'none (standalone invocation)');
  console.log('viewBox:', manifest.viewBox);

  return { outPath, durationTick, entityCount: entities.length };
}

function foldDirection(e, cutoff) {
  let dir = e.direction ?? 0;
  let bgt = e.beltToGroundType;
  for (const m of e.mutations ?? []) {
    if (m.tick > cutoff) break;
    if (m.direction !== undefined) dir = m.direction;
    if (m.beltToGroundType !== undefined) bgt = m.beltToGroundType;
  }
  return { dir, bgt };
}

// CLI: thin wrapper for users running map-prep standalone (no phases). The
// chart-side build-run-data.mjs imports buildMapData() directly and passes
// phases.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const RUN = process.argv[2];
  if (!RUN) {
    console.error('usage: node map-prep.mjs <run-name>');
    process.exit(1);
  }
  buildMapData(RUN);
}
