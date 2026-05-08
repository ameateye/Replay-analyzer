// Joins the FBSR atlas manifest with the timing sidecar produced by
// fbsr-prep, and writes the two files the React player needs at runtime:
// a small map-data JSON (entities + viewBox + timeline) and a run-local
// sprite atlas served from game-data.
//
// Inputs (under tools/output/):
//   <RUN>.manifest.json   — { viewBox, sprites: {id→{w,h,data}},
//                             entities: [{en, name, px, py, ox, oy, sid, L}] }
//                           Granular layering: one entry per (entity, FBSR Layer)
//                           bucket; L is the FBSR Layer ordinal (see
//                           Factorio-FBSR Layer.java) carrying global draw order.
//   <RUN>.timing.json     — { [entityNumber]: { tb, tr?, un, rs? } }   (rs = recipe timeline)
//
// Outputs:
//   dashboard/public/map-data/<RUN>.map.json
//       — { viewBox, durationTick, entities (renderables, sorted globally by
//           (L, py, px)), recipeMachines (one per entity-with-rs), playerTrack }
//   game-data/map-sprites/<RUN>.json
//       — { id → {w, h, data} }   (entity sprites + recipe-icon sprites with sid prefix "r:")
//
// Splitting sprites out of the per-run map.json keeps that file small
// (entities + timing only) and lets the React side fetch sprites via the
// shared game-data URL contract — same caching/path semantics as the rest
// of the cross-run reference data.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const RUN = process.argv[2];
if (!RUN) {
  console.error('usage: node map-prep.mjs <run-name>');
  process.exit(1);
}

const manifestPath = resolve(ROOT, 'tools', 'output', `${RUN}.manifest.json`);
const timingPath   = resolve(ROOT, 'tools', 'output', `${RUN}.timing.json`);
const rocketPath   = resolve(ROOT, 'extracted-data', RUN, 'rocketLaunchTime.json');
const playerPath   = resolve(ROOT, 'extracted-data', RUN, 'playerPosition.json');
const outDir       = resolve(ROOT, 'dashboard', 'public', 'map-data');
const outPath      = resolve(outDir, `${RUN}.map.json`);
const spriteDir    = resolve(ROOT, 'game-data', 'map-sprites');
const spritePath   = resolve(spriteDir, `${RUN}.json`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const timing   = JSON.parse(readFileSync(timingPath,   'utf-8'));

let durationTick = 0;
try {
  const r = JSON.parse(readFileSync(rocketPath, 'utf-8'));
  durationTick = r.rocketLaunchTimes?.[0] ?? 0;
} catch {
  // First-rocket-launch tick is optional; player just falls back to last build tick.
}

// Join sprite manifest with timing sidecar (tb / tr / rs per entityNumber).
// Manifest entries are renderables — one per (entity, FBSR Layer) bucket.
// Sort globally by (L, py, px) so DOM order = FBSR draw order: belts at
// TRANSPORT_BELT (36) below objects at OBJECT (51) below inserter arms at
// HIGHER_OBJECT_UNDER (53) below indicators at INSERTER_INDICATORS (58),
// with southern-then-eastern y-x sort within a layer (matches Factorio's
// natural 2D depth cue).
const entities = manifest.entities
  .map(e => {
    const t = timing[e.en];
    if (!t) return null;
    const out = { ...e, tb: t.tb };
    if (t.tr !== undefined) out.tr = t.tr;
    return out;
  })
  .filter(e => e && e.tb > 0)
  .sort((a, b) => {
    if (a.L !== b.L) return a.L - b.L;
    if (a.py !== b.py) return a.py - b.py;
    return a.px - b.px;
  });

// Latest build tick — used as a fallback when rocketLaunchTime is missing.
// Can't read off entities[length-1] anymore: the array is layer-sorted, not
// time-sorted, so the last entry is whichever renderable lands at the
// highest (L, py, px), which is unrelated to build order.
let maxTb = 0;
for (const e of entities) if (e.tb > maxTb) maxTb = e.tb;
if (!durationTick) durationTick = maxTb;

// Player track. Source: { period, players: { name: [[x,y], ...] } }.
// Convert to a single array (first player) with the period preserved so the
// React side can interpolate between samples. Drop unused players for now —
// DS runs are solo.
let playerTrack = null;
try {
  const pp = JSON.parse(readFileSync(playerPath, 'utf-8'));
  const names = Object.keys(pp.players || {});
  if (names.length > 0) {
    const name = names[0];
    playerTrack = {
      name,
      period: pp.period ?? 60,
      // round to 2 decimals to keep file size reasonable — sub-tile precision
      // is plenty for a small marker on a base-sized canvas.
      positions: pp.players[name].map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
    };
  }
} catch {
  // playerPosition.json is optional; just skip the marker if missing.
}

// Recipe overlay: one entry per machine that ever ran a recipe, decoupled
// from the renderable list (an entity has multiple renderables now, but
// only one recipe overlay). Dropped events whose sprite didn't make it
// into the atlas (resolver miss).
const spriteIds = new Set(Object.keys(manifest.sprites));
const recipeMachineSeen = new Map();   // en → { en, name, px, py, rs }
let droppedRecipeEntries = 0;
for (const e of manifest.entities) {
  const t = timing[e.en];
  if (!t || !t.rs || t.rs.length === 0) continue;
  if (recipeMachineSeen.has(e.en)) continue;
  const filtered = t.rs.filter(r => spriteIds.has(`r:${r.n}`));
  droppedRecipeEntries += t.rs.length - filtered.length;
  if (filtered.length === 0) continue;
  recipeMachineSeen.set(e.en, { en: e.en, name: e.name, px: e.px, py: e.py, rs: filtered });
}
const recipeMachines = [...recipeMachineSeen.values()];

const out = {
  runName: RUN,
  viewBox: manifest.viewBox,
  durationTick,
  entities,
  recipeMachines,
  playerTrack,
};

mkdirSync(outDir, { recursive: true });
mkdirSync(spriteDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
writeFileSync(spritePath, JSON.stringify(manifest.sprites));

const entitySpriteCount = Object.keys(manifest.sprites).filter(k => !k.startsWith('r:')).length;
const recipeSpriteCount = Object.keys(manifest.sprites).length - entitySpriteCount;
const layerCount = new Set(entities.map(e => e.L)).size;

console.log('wrote', outPath);
console.log('wrote', spritePath);
console.log('renderables:', entities.length, '/ across', layerCount, 'FBSR layers');
console.log('entity sprites:', entitySpriteCount, '/ recipe sprites:', recipeSpriteCount);
console.log('with timeRemoved:', entities.filter(e => e.tr !== undefined).length);
console.log('recipe machines:', recipeMachines.length);
if (droppedRecipeEntries) console.log('dropped recipe-events (sprite missing):', droppedRecipeEntries);
console.log('player track:', playerTrack ? `${playerTrack.name} (${playerTrack.positions.length} samples @ ${playerTrack.period}t)` : 'none');
console.log('max build tick:', maxTb, '/ duration tick:', durationTick);
console.log('viewBox:', manifest.viewBox);
