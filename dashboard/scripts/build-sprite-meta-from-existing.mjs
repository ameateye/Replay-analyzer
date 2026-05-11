// One-shot bootstrap for game-data/map-sprite-meta.json.
//
// Reads every committed dashboard/src/data/<run>.map.json, joins each
// entry's (en, sid, L, ox-px, oy-py) with the en→unitNumber sidecar in
// tools/output/<run>.timing.json plus the end-of-run direction / bgt
// folded from extracted-data/<run>/{entityLayout,minerActivity,
// machineProduction,labContents,bufferAmounts}.json, and emits a single
// shared meta file:
//
//   { "<name>|<dir>|<bgt>": { "layers": [{L,sid,oxOff,oyOff}, ...] } }
//
// This is the "shortcut" bootstrap referenced in
// docs/specs/fbsr_elimination.md — derive meta from already-rendered runs
// rather than invoking Java FBSR. Belt-curve variants are collapsed
// (first-seen wins per (name,dir,bgt,L)); full variant coverage is
// recovered later by Component B (SpriteEnumerator) + C (gap-fill).
//
// Run once, commit the output, delete this script. Idempotent — re-running
// produces the same file modulo iteration order.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MAP_DIR    = resolve(ROOT, 'dashboard', 'src', 'data');
const TIMING_DIR = resolve(ROOT, 'tools', 'output');
const EXTRACT_DIR = resolve(ROOT, 'extracted-data');
const OUT_PATH   = resolve(ROOT, 'game-data', 'map-sprite-meta.json');

function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }
function round4(n) { return Math.round(n * 1e4) / 1e4; }

// Find a usable extraction directory for a run. Some runs are checked out
// under Actual-<name>/ instead of <name>/ — match either.
function findExtractDir(runName) {
  const direct = resolve(EXTRACT_DIR, runName);
  if (existsSync(direct)) return direct;
  const actual = resolve(EXTRACT_DIR, `Actual-${runName}`);
  if (existsSync(actual)) return actual;
  return null;
}

// Fold mutations forward to a cutoff tick, returning the entity's
// (direction, beltToGroundType) as of that tick.
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

// Build un → { dir, bgt } map from every source that contributes an entity
// to the rendered scope. The five sources mirror what fbsr-prep merges.
function buildEndStateByUn(extractDir, durationTick) {
  const endByUn = new Map();
  const layout = readJson(resolve(extractDir, 'entityLayout.json'));
  for (const e of layout.entities) endByUn.set(e.unitNumber, foldDirection(e, durationTick));

  // Miners, machines, labs, buffers don't carry rotation mutations in the
  // current schema — direction is whatever was set at build time.
  for (const m of readJson(resolve(extractDir, 'minerActivity.json')).miners) {
    endByUn.set(m.unitNumber, { dir: m.direction ?? 0, bgt: null });
  }
  for (const m of readJson(resolve(extractDir, 'machineProduction.json')).machines) {
    endByUn.set(m.unitNumber, { dir: m.direction ?? 0, bgt: null });
  }
  for (const l of readJson(resolve(extractDir, 'labContents.json')).labs) {
    endByUn.set(l.unitNumber, { dir: 0, bgt: null });
  }
  try {
    for (const b of readJson(resolve(extractDir, 'bufferAmounts.json')).buffers) {
      endByUn.set(b.unitNumber, { dir: 0, bgt: null });
    }
  } catch { /* older extractions lack bufferAmounts */ }
  return endByUn;
}

function metaKey(name, dir, bgt) {
  return `${name}|${dir ?? 0}|${bgt ?? '_'}`;
}

// Harvest one run into the cross-run accumulator. For each unitNumber we
// group its rendered layers (one per L) so we can later pick the modal
// per-variant layer-SET — this prevents topology-specific extras (belt
// corners at L=29) from being applied universally during placement.
//
// `accum[key]` shape: {
//   layerSetCounts: Map<canonicalKey, count>,
//   layerSetDetails: Map<canonicalKey, Array<{L, sid, oxOff, oyOff}>>,
//   sidByL: Map<L, sid>     // first-seen sid per L (for the chosen set)
// }
function harvestRun(runName, accum, conflicts) {
  const mapPath    = resolve(MAP_DIR, `${runName}.map.json`);
  const timingPath = resolve(TIMING_DIR, `${runName}.timing.json`);
  const extractDir = findExtractDir(runName);
  if (!existsSync(mapPath))    { console.warn(`[skip ${runName}] no committed map.json`); return; }
  if (!existsSync(timingPath)) { console.warn(`[skip ${runName}] no tools/output/${runName}.timing.json`); return; }
  if (!extractDir)             { console.warn(`[skip ${runName}] no extracted-data/${runName}/`); return; }

  const mapData = readJson(mapPath);
  const timing  = readJson(timingPath);
  const rocket  = readJson(resolve(extractDir, 'rocketLaunchTime.json'));
  const durationTick = rocket.rocketLaunchTimes?.[0] ?? mapData.durationTick;

  const unByEn = new Map();
  for (const [en, t] of Object.entries(timing)) unByEn.set(+en, t.un);
  const endByUn = buildEndStateByUn(extractDir, durationTick);

  // Group committed entries by un → list-of-layer-entries, then key each un
  // by its end-of-run (name, dir, bgt).
  const entriesByUn = new Map();
  let missingUn = 0, missingState = 0;
  for (const e of mapData.entities) {
    const un = unByEn.get(e.en);
    if (un === undefined) { missingUn++; continue; }
    if (!endByUn.has(un)) { missingState++; continue; }
    if (!entriesByUn.has(un)) entriesByUn.set(un, []);
    entriesByUn.get(un).push({
      L: e.L,
      sid: e.sid,
      oxOff: round4(e.ox - e.px),
      oyOff: round4(e.oy - e.py),
      name: e.name,
    });
  }

  for (const [un, layers] of entriesByUn) {
    const state = endByUn.get(un);
    const name = layers[0].name;
    const key = metaKey(name, state.dir, state.bgt);

    // Canonicalize the layer set for this entity: sort by L, then concat
    // (L:sid) as the discriminator. Topology-dependent extras (e.g. belt
    // curve overlays) show up as a different canonical key here, which we
    // can then outvote with the modal set across all entities of the
    // variant.
    layers.sort((a, b) => a.L - b.L);
    const canon = layers.map(l => `${l.L}:${l.sid}`).join(',');

    if (!accum[key]) accum[key] = { layerSetCounts: new Map(), layerSetDetails: new Map() };
    const entry = accum[key];
    entry.layerSetCounts.set(canon, (entry.layerSetCounts.get(canon) ?? 0) + 1);
    if (!entry.layerSetDetails.has(canon)) {
      entry.layerSetDetails.set(canon, layers.map(l => ({ L: l.L, sid: l.sid, oxOff: l.oxOff, oyOff: l.oyOff })));
    }
  }
  console.log(`[${runName}] entities=${mapData.entities.length} grouped uns=${entriesByUn.size} missingUn=${missingUn} missingState=${missingState}`);
}

// Pick the modal layer-set per variant and emit the final meta.
function finalizeMeta(accum, conflicts) {
  const out = {};
  for (const [key, entry] of Object.entries(accum)) {
    const sorted = [...entry.layerSetCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [chosen, chosenN] = sorted[0];
    const layers = entry.layerSetDetails.get(chosen);
    out[key] = { layers };
    // Track per-variant alternate layer-sets that lost the vote — useful
    // signal for the gap-fill flow once Component B+C land.
    for (let i = 1; i < sorted.length; i++) {
      conflicts.push({ key, kept: chosen, keptCount: chosenN, dropped: sorted[i][0], droppedCount: sorted[i][1] });
    }
  }
  return out;
}

const runs = readdirSync(MAP_DIR)
  .filter(n => n.endsWith('.map.json'))
  .map(n => basename(n, '.map.json'))
  .sort();

if (runs.length === 0) {
  console.error('No committed .map.json files found under', MAP_DIR);
  process.exit(1);
}

console.log('Bootstrapping meta from', runs.length, 'committed run(s):', runs.join(', '));

const accum = {};
const conflicts = [];
for (const r of runs) harvestRun(r, accum, conflicts);
const meta = finalizeMeta(accum, conflicts);

// Sort meta keys + each layer set deterministically so the committed JSON
// has a stable diff across re-runs.
const sortedMeta = {};
for (const k of Object.keys(meta).sort()) {
  const layers = meta[k].layers.slice().sort((a, b) => a.L - b.L);
  sortedMeta[k] = { layers };
}

writeFileSync(OUT_PATH, JSON.stringify(sortedMeta, null, 2));

const layerCount = Object.values(sortedMeta).reduce((n, m) => n + m.layers.length, 0);
console.log(`\nwrote ${OUT_PATH}`);
console.log(`  variants: ${Object.keys(sortedMeta).length} keys / ${layerCount} layers total`);
console.log(`  outvoted alt layer-sets: ${conflicts.length}`);
if (conflicts.length > 0) {
  const top = conflicts.slice().sort((a, b) => b.droppedCount - a.droppedCount).slice(0, 5);
  for (const c of top) {
    console.log(`    ${c.key}: kept ${c.kept} (${c.keptCount}) over ${c.dropped} (${c.droppedCount})`);
  }
}
