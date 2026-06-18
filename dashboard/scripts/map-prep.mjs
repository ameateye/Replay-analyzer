// Builds the per-run map JSON the React player consumes — event-driven via
// the Java ReplaySidecar (com.demod.fbsr.cli.ReplaySidecar).
//
// Pipeline:
//   extracted-data/<run>/{entityLayout, minerActivity, machineProduction,
//                         labContents, bufferAmounts, playerPosition,
//                         rocketLaunchTime}.json
//   ↓ buildMergedEntities (lib/layout/merge-entities.mjs)
//   ↓ explodeMutations  → BSEntity-shape records w/ disjoint [tb,tr)
//   ↓ ReplaySidecar     → per-`un` renderableTimeline + atlas growth
//   ↓ flatten timeline  → flat entities[] keyed by `en` (legacy MapView shape)
//   + overlays (recipeMachines / splitterMarkers / inserterMarkers) folded
//     from the lossless merged stream (same logic as the legacy pipeline)
//   + playerTrack from playerPosition.json
//   ↓
//   built-data/<run>.map.json   (repo-root sibling, gitignored)
//
// Atlas accumulation is monotonic into game-data/map-sprites.json — the
// sidecar's FileAtlasSink appends new hex sids per run and never rewrites
// existing ones. Overlay sids (`r:<recipe>`, `f:<item>`) live in the same
// file; sidecar leaves them untouched.
//
// Spec: docs/specs/fbsr_event_driven_pipeline.md.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildMergedEntities, foldForMap } from './lib/layout/merge-entities.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const FBSR_DIR = resolve(ROOT, 'Factorio-FBSR', 'FactorioBlueprintStringRenderer');
const FBSR_CP  = resolve(FBSR_DIR, 'target', 'cp.txt');
const JDK_HOME = resolve(ROOT, 'tools', 'jdk21', 'jdk-21.0.11+10');
const JAVA_EXE = resolve(JDK_HOME, 'bin', 'java.exe');

function readJsonOrNull(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }
function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }
function round4(n) { return Math.round(n * 1e4) / 1e4; }

// ===== BSEntity record synthesis =============================================
//
// A mutation produces a fresh BSEntity record (a re-render at that tick) when it
// touches a render-relevant key. Two flavours:
//   • STATE keys (direction / name / belt-to-ground / splitter config) — change
//     the record's own fields, which the sidecar renders directly.
//   • TRIGGER keys (belt-graph: beltInputs / beltOutputs / undergroundPair) — carry
//     no field the sidecar reads (it reconstructs adjacency from the placed
//     entities itself), but the entity's SPRITE depends on that adjacency, so the
//     delta must still force a re-render. Omitting them is why a feeder belt built
//     BEFORE the corner it later feeds kept a stale dead-end end-cap: the collector
//     recorded the new beltOutputs, but map-prep dropped it, so the sidecar was
//     never asked to redraw the feeder against the now-present corner.
const RENDER_STATE_KEYS = [
  'direction',
  'name',
  'beltToGroundType',
  'splitterInputPriority', 'splitterOutputPriority', 'splitterFilter',
];
const RERENDER_TRIGGER_KEYS = ['beltInputs', 'beltOutputs', 'undergroundPair'];

function mutationIsRenderRelevant(m) {
  for (const k of RENDER_STATE_KEYS) if (m[k] !== undefined) return true;
  for (const k of RERENDER_TRIGGER_KEYS) if (m[k] !== undefined) return true;
  return false;
}

// Only STATE keys flow into the record; trigger keys just forced the re-render.
function applyMutation(state, m) {
  const next = { ...state };
  for (const k of RENDER_STATE_KEYS) if (m[k] !== undefined) next[k] = m[k];
  return next;
}

function buildBSEntityRecord(merged, state, tb, tr) {
  const r = {
    entity_number: merged.unitNumber,
    name: state.name,
    position: { x: merged.location.x, y: merged.location.y },
    direction: state.direction ?? 0,
    tb,
  };
  if (tr !== undefined) r.tr = tr;
  // BSEntity field-name translations (extracted-data is camelCase, BSEntity
  // / Factorio blueprint JSON is snake_case).
  if (state.beltToGroundType != null && state.beltToGroundType !== '') {
    r.type = state.beltToGroundType;
  }
  if (state.splitterInputPriority && state.splitterInputPriority !== 'none') {
    r.input_priority = state.splitterInputPriority;
  }
  if (state.splitterOutputPriority && state.splitterOutputPriority !== 'none') {
    r.output_priority = state.splitterOutputPriority;
  }
  if (state.splitterFilter) r.filter = state.splitterFilter;
  return r;
}

// MergedEntity → N BSEntity-shape records, disjoint [tb, tr) per
// render-relevant mutation. Records carry full state, not deltas
// (per spec §B.1: mutations are represented as new records).
function explodeEntity(merged) {
  const state0 = {
    name: merged.name,
    direction: merged.direction ?? 0,
  };
  if (merged.beltToGroundType !== undefined) state0.beltToGroundType = merged.beltToGroundType;
  if (merged.splitterInputPriority  !== undefined) state0.splitterInputPriority  = merged.splitterInputPriority;
  if (merged.splitterOutputPriority !== undefined) state0.splitterOutputPriority = merged.splitterOutputPriority;
  if (merged.splitterFilter         !== undefined) state0.splitterFilter         = merged.splitterFilter;

  const mutations = (merged.mutations ?? [])
    .filter(mutationIsRenderRelevant)
    .slice()
    .sort((a, b) => a.tick - b.tick);

  const records = [];
  let state = state0;
  let curTb = merged.timeBuilt ?? 0;

  for (const m of mutations) {
    if (m.tick <= curTb) { state = applyMutation(state, m); continue; }
    records.push(buildBSEntityRecord(merged, state, curTb, m.tick));
    state = applyMutation(state, m);
    curTb = m.tick;
  }
  records.push(buildBSEntityRecord(merged, state, curTb, merged.timeRemoved));
  return records;
}

// ===== Sidecar invocation ====================================================

function javaToolingReady() {
  if (!existsSync(FBSR_CP))  return { ok: false, reason: `FBSR cp.txt missing: ${FBSR_CP}. Run mvn package in Factorio-FBSR.` };
  if (!existsSync(JAVA_EXE)) return { ok: false, reason: `JDK launcher missing: ${JAVA_EXE}` };
  return { ok: true };
}

function invokeSidecar(inputPath, outputPath, atlasPath) {
  const targetClasses = resolve(FBSR_DIR, 'target', 'classes');
  const cpTxt = readFileSync(FBSR_CP, 'utf-8').trim();
  // target/classes prepended so post-package edits to IncrementalMap /
  // ReplaySidecar / AtlasSink win over the jar.
  const cp = `${targetClasses};${cpTxt}`;
  const args = ['-cp', cp, 'com.demod.fbsr.cli.ReplaySidecar', inputPath, outputPath, atlasPath];
  const result = spawnSync(JAVA_EXE, args, {
    cwd: FBSR_DIR,
    env: { ...process.env, JAVA_HOME: JDK_HOME },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ReplaySidecar exit code ${result.status}`);
}

// ===== Overlay builders (extracted from legacy map-prep) =====================

function buildOverlays(mapMerged, spriteIds) {
  const recipeMachines = [];
  const splitterMarkers = [];
  const inserterMarkers = [];
  let droppedRecipeEntries = 0, droppedSplitterFilters = 0, droppedInserterFilters = 0;

  mapMerged.forEach((rec, i) => {
    const en = i + 1;
    if (rec.recipeTimeline) {
      const filtered = rec.recipeTimeline.filter(r => spriteIds.has(`r:${r.n}`));
      droppedRecipeEntries += rec.recipeTimeline.length - filtered.length;
      if (filtered.length > 0) {
        const m = { en, name: rec.name, px: rec.ux, py: rec.uy, rs: filtered };
        if (rec.tr !== undefined) m.tr = rec.tr;
        recipeMachines.push(m);
      }
    }
    if (rec.splitterTimeline) {
      for (const ev of rec.splitterTimeline) if (ev.f && !spriteIds.has(`f:${ev.f}`)) droppedSplitterFilters++;
      const m = { en, name: rec.name, px: rec.ux, py: rec.uy, dir: rec.dir ?? 0, ts: rec.splitterTimeline };
      if (rec.tr !== undefined) m.tr = rec.tr;
      splitterMarkers.push(m);
    }
    if (rec.inserterTimeline) {
      for (const ev of rec.inserterTimeline) for (const name of (ev.f || [])) {
        if (!spriteIds.has(`f:${name}`)) droppedInserterFilters++;
      }
      const m = { en, name: rec.name, px: rec.ux, py: rec.uy, dir: rec.dir ?? 0, ts: rec.inserterTimeline };
      if (rec.tr !== undefined) m.tr = rec.tr;
      inserterMarkers.push(m);
    }
  });

  return { recipeMachines, splitterMarkers, inserterMarkers,
           droppedRecipeEntries, droppedSplitterFilters, droppedInserterFilters };
}

// Roboport pipeline. Roboports aren't in LAYOUT_SCOPE / entityLayout.json
// (so merge-entities skips them), but they exist in roboportUsage.json with
// position + lifecycle + bot-queue samples. We feed them into the FBSR
// sidecar as synthetic BSEntity records so they render with the real
// roboport sprite, AND emit a parallel overlay-marker timeline carrying
// the delta-compressed (charging, waiting) state for the halo overlay.
function loadRoboports(roboportPath, durationTick) {
  const j = readJsonOrNull(roboportPath);
  if (!j?.roboports?.length) return [];
  const out = [];
  for (const r of j.roboports) {
    if (r.timeBuilt == null || r.timeBuilt > durationTick) continue;
    const tr = (r.timeRemoved != null && r.timeRemoved <= durationTick) ? r.timeRemoved : undefined;
    out.push({
      unitNumber: r.unitNumber,
      x: r.location.x,
      y: r.location.y,
      timeBuilt: r.timeBuilt,
      timeRemoved: tr,
      usage: r.usage || [],
    });
  }
  return out;
}

function buildRoboportBSRecords(roboports) {
  return roboports.map(r => {
    const rec = {
      entity_number: r.unitNumber,
      name: 'roboport',
      position: { x: r.x, y: r.y },
      direction: 0,
      tb: r.timeBuilt,
    };
    if (r.timeRemoved !== undefined) rec.tr = r.timeRemoved;
    return rec;
  });
}

function buildRoboportMarkers(roboports, durationTick) {
  return roboports.map(r => {
    const ts = [];
    let prevC = -1, prevW = -1;
    for (const sample of r.usage) {
      const [tick, c, w] = sample;
      if (tick > durationTick) break;
      if (c === prevC && w === prevW) continue;
      ts.push({ ts: tick, c, w });
      prevC = c; prevW = w;
    }
    const m = { un: r.unitNumber, px: r.x, py: r.y, tb: r.timeBuilt, ts };
    if (r.timeRemoved !== undefined) m.tr = r.timeRemoved;
    return m;
  });
}

function buildPlayerTrack(playerPath) {
  const pp = readJsonOrNull(playerPath);
  if (!pp) return null;
  const names = Object.keys(pp.players || {});
  if (names.length === 0) return null;
  const name = names[0];
  return {
    name,
    period: pp.period ?? 60,
    positions: pp.players[name].map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
  };
}

// ===== Main entry ============================================================

export function buildMapData(runName, { phases = null, miners = null, merged = null } = {}) {
  const runDir     = resolve(ROOT, 'extracted-data', runName);
  const outDir     = resolve(ROOT, 'built-data');
  const outPath    = resolve(outDir, `${runName}.map.json`);
  const spritePath = resolve(ROOT, 'game-data', 'map-sprites.json');
  const rocketPath = resolve(runDir, 'rocketLaunchTime.json');
  const playerPath = resolve(runDir, 'playerPosition.json');
  const roboportPath = resolve(runDir, 'roboportUsage.json');

  if (!existsSync(runDir)) throw new Error(`extracted-data/${runName}/ not found`);
  const tooling = javaToolingReady();
  if (!tooling.ok) throw new Error(tooling.reason);

  // durationTick = first rocket launch. Fall back to latest build tick later.
  let durationTick = 0;
  const rocket = readJsonOrNull(rocketPath);
  if (rocket?.rocketLaunchTimes?.length) durationTick = rocket.rocketLaunchTimes[0];

  // 1. Lossless merged stream (caller may pre-build it for flow-prep).
  const losslessMerged = merged ?? buildMergedEntities(runDir, durationTick, { externalMiners: miners });
  const mapMerged = foldForMap(losslessMerged, durationTick);

  // 2. Synthesise BSEntity records and invoke sidecar. Includes the merged
  //    layout stream PLUS roboport records synthesised from roboportUsage.json
  //    (roboports aren't in LAYOUT_SCOPE so they're absent from mapMerged).
  const roboports = loadRoboports(roboportPath, durationTick);
  const records = [];
  for (const e of losslessMerged) for (const r of explodeEntity(e)) records.push(r);
  for (const r of buildRoboportBSRecords(roboports)) records.push(r);

  const sidecarInput  = resolve(runDir, 'replay-input.json');
  const sidecarOutput = resolve(runDir, 'replay-output.json');
  writeFileSync(sidecarInput, JSON.stringify({ runName, durationTick, entities: records }));

  invokeSidecar(sidecarInput, sidecarOutput, spritePath);

  const sidecarOut = readJson(sidecarOutput);
  const sprites    = readJson(spritePath);
  const spriteIds  = new Set(Object.keys(sprites));

  // 3. un → en bridge so flattened entities[] aligns with overlays-by-en.
  //    Roboports get en values past mapMerged.length so they don't collide
  //    with the layout-derived entries.
  const facts = new Map();
  mapMerged.forEach((rec, i) => {
    facts.set(rec.un, {
      en: i + 1, name: rec.name, px: rec.ux, py: rec.uy, tr: rec.tr,
    });
  });
  roboports.forEach((r, i) => {
    facts.set(r.unitNumber, {
      en: mapMerged.length + i + 1, name: 'roboport', px: r.x, py: r.y, tr: r.timeRemoved,
    });
  });

  // 4. Flatten per-`un` renderableTimeline → flat per-(entity × layer × snapshot)
  //    entries with disjoint [tb, tr) intervals. tr of the final snapshot is the
  //    entity's own timeRemoved (if any); earlier snapshots' tr is the next
  //    snapshot's ts.
  const entities = [];
  let missingFacts = 0, missingSprites = 0;
  for (const e of sidecarOut.entities ?? []) {
    const f = facts.get(e.un);
    if (!f) { missingFacts++; continue; }
    const tl = e.renderableTimeline ?? [];
    for (let i = 0; i < tl.length; i++) {
      const snap = tl[i];
      const tb = snap.ts;
      const tr = (i + 1 < tl.length) ? tl[i + 1].ts : f.tr;
      for (const layer of snap.layers) {
        if (!sprites[layer.sid]) { missingSprites++; continue; }
        const out = {
          name: f.name,
          un:   e.un,
          px:   f.px, en: f.en, py: f.py,
          ox:   round4(layer.ox),
          oy:   round4(layer.oy),
          L:    layer.L,
          sid:  layer.sid,
          tb,
        };
        if (tr !== undefined) out.tr = tr;
        entities.push(out);
      }
    }
  }

  entities.sort((a, b) => {
    if (a.L !== b.L)  return a.L  - b.L;
    if (a.py !== b.py) return a.py - b.py;
    return a.px - b.px;
  });

  // 5. Clip to rocket-launch cutoff.
  let maxTb = 0;
  for (const e of entities) if (e.tb > maxTb) maxTb = e.tb;
  if (!durationTick) durationTick = maxTb;
  const cutoff = durationTick;
  const visibleEntities = entities.filter(e => e.tb > 0 && e.tb <= cutoff);

  // 6. viewBox = tight bbox of rendered sprite extents.
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

  // 7. Overlays + playerTrack — same logic as the legacy pipeline.
  const ov = buildOverlays(mapMerged, spriteIds);
  const roboportMarkers = buildRoboportMarkers(roboports, durationTick);
  const playerTrack = buildPlayerTrack(playerPath);

  const out = {
    runName,
    viewBox,
    durationTick,
    entities: visibleEntities,
    recipeMachines:   ov.recipeMachines,
    splitterMarkers:  ov.splitterMarkers,
    inserterMarkers:  ov.inserterMarkers,
    roboportMarkers,
    playerTrack,
  };
  if (phases && phases.length > 0) out.phases = phases;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out));

  const layerCount = new Set(visibleEntities.map(e => e.L)).size;
  console.log('wrote', outPath);
  console.log('renderables:', visibleEntities.length, '/ across', layerCount, 'FBSR layers');
  console.log('with timeRemoved:', visibleEntities.filter(e => e.tr !== undefined).length);
  console.log('recipe machines:', ov.recipeMachines.length, ov.droppedRecipeEntries ? `(${ov.droppedRecipeEntries} recipe events without sprite)` : '');
  console.log('splitter markers:', ov.splitterMarkers.length, ov.droppedSplitterFilters ? `(${ov.droppedSplitterFilters} filter events without sprite)` : '');
  console.log('inserter markers:', ov.inserterMarkers.length, ov.droppedInserterFilters ? `(${ov.droppedInserterFilters} filter events without sprite)` : '');
  console.log('roboport markers:', roboportMarkers.length, roboports.length ? `(${roboports.length} roboports, ${roboportMarkers.reduce((a,m)=>a+m.ts.length,0)} state events)` : '');
  console.log('player track:', playerTrack ? `${playerTrack.name} (${playerTrack.positions.length} samples @ ${playerTrack.period}t)` : 'none');
  console.log('max build tick:', maxTb, '/ duration tick:', durationTick);
  console.log('phases:', phases?.length ? `${phases.length} embedded` : 'none (standalone invocation)');
  console.log('viewBox:', viewBox);
  if (missingFacts > 0)   console.log(`missing facts (un not in mapMerged): ${missingFacts}`);
  if (missingSprites > 0) console.log(`missing sprites (sid not in atlas): ${missingSprites}`);

  return { outPath, durationTick, entityCount: visibleEntities.length };
}

// CLI: standalone invocation (no phases passed in).
if (process.argv[1] && basename(process.argv[1]) === 'map-prep.mjs') {
  const RUN = process.argv[2];
  if (!RUN) {
    console.error('usage: node map-prep.mjs <run-name>');
    process.exit(1);
  }
  buildMapData(RUN);
}
