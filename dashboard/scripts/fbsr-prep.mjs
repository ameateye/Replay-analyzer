// Prepares the input that ReplaySvgRender (Java/FBSR) consumes for one run.
//
// FBSR's parser is anchored on the standard Factorio blueprint shape, so we
// transform our per-source extraction JSONs (entityLayout, minerActivity,
// machineProduction, labContents, bufferAmounts) into a synthetic blueprint
// object plus a sidecar carrying the metadata FBSR doesn't care about
// (build/remove ticks, unit numbers, recipe timelines).
//
// Outputs (under tools/output/):
//   <RUN>.json         — { blueprint: {…FBSR shape…}, recipes: [name, …] }
//   <RUN>.timing.json  — { entityNumber → { tb, tr?, un, rs? } }
//
// `recipes` is the unique-recipes list: ReplaySvgRender renders one icon
// sprite per recipe so the React side can overlay them dynamically as
// machines change recipes during the run.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const RUN = process.argv[2] || 'DS-2_14_45';
const SRC_DIR    = resolve(ROOT, 'extracted-data', RUN);
// tools/output/ is the shared intermediate dir between fbsr-prep, the Java
// renderer, and map-prep — all three hand off through one place.
const OUT_JSON   = resolve(ROOT, 'tools', 'output', `${RUN}.json`);
const OUT_TIMING = resolve(ROOT, 'tools', 'output', `${RUN}.timing.json`);

const FACTORIO_VERSION = Number((2n << 48n) | (0n << 32n) | (20n << 16n) | 0n);

const LAYOUT_SCOPE = new Set([
  'transport-belt', 'fast-transport-belt', 'express-transport-belt',
  'underground-belt', 'fast-underground-belt', 'express-underground-belt',
  'splitter', 'fast-splitter', 'express-splitter',
  'burner-inserter', 'inserter', 'long-handed-inserter',
  'fast-inserter', 'filter-inserter', 'stack-inserter', 'stack-filter-inserter',
  'bulk-inserter',
]);

function readJson(file) {
  return JSON.parse(readFileSync(resolve(SRC_DIR, file), 'utf-8'));
}

function buildBlueprintObject(entities, label) {
  return {
    blueprint: {
      item: 'blueprint',
      label,
      entities: entities.map((e, i) => {
        const out = { entity_number: i + 1, name: e.name, position: e.position };
        if (e.direction) out.direction = e.direction;
        if (e.type)      out.type = e.type;
        if (e.recipe)    out.recipe = e.recipe;
        return out;
      }),
      version: FACTORIO_VERSION,
    },
  };
}

function main() {
  // Each source contributes a uniform record:
  //   { name, position {x,y}, direction?, recipe?, type?, timeBuilt, timeRemoved?, unitNumber }
  const merged = [];

  // 1) Belts / inserters from entityLayout (poles excluded by user-defined scope).
  const layout = readJson('entityLayout.json');
  for (const e of layout.entities) {
    if (!LAYOUT_SCOPE.has(e.name)) continue;
    const rec = {
      name: e.name,
      position: { x: e.location.x, y: e.location.y },
      direction: e.direction || 0,
      timeBuilt: e.timeBuilt ?? 0,
      unitNumber: e.unitNumber,
    };
    // entityLayout doesn't track underground-belt I/O type; default to input.
    if (e.name.endsWith('underground-belt')) rec.type = 'input';
    merged.push(rec);
  }

  // 2) Miners (minerActivity has its own per-tick status timeline; we only
  //    need the entity record for rendering).
  for (const m of readJson('minerActivity.json').miners) {
    merged.push({
      name: m.name,
      position: { x: m.location.x, y: m.location.y },
      direction: m.direction || 0,
      timeBuilt: m.timeBuilt ?? 0,
      timeRemoved: m.timeRemoved,
      unitNumber: m.unitNumber,
    });
  }

  // 3) Machines. Recipe-on-blueprint is the FIRST recipe ever set (FBSR
  //    needs it to decide fluid-box rendering for refineries / chem plants).
  //    The visible recipe-icon overlay comes from the recipeTimeline in the
  //    timing sidecar, which carries every recipe change with its tick.
  for (const m of readJson('machineProduction.json').machines) {
    const timeline = (m.recipes || [])
      .filter(r => r && r.recipe)
      .map(r => ({ tStart: r.timeStarted ?? 0, recipe: r.recipe }));
    merged.push({
      name: m.name,
      position: { x: m.location.x, y: m.location.y },
      direction: m.direction || 0,
      recipe: timeline[0]?.recipe,
      recipeTimeline: timeline.length > 0 ? timeline : undefined,
      timeBuilt: m.timeBuilt ?? 0,
      timeRemoved: m.timeRemoved,
      unitNumber: m.unitNumber,
    });
  }

  // 4) Labs (no direction — radial symmetry).
  for (const l of readJson('labContents.json').labs) {
    merged.push({
      name: l.name,
      position: { x: l.location.x, y: l.location.y },
      timeBuilt: l.timeBuilt ?? 0,
      timeRemoved: l.timeRemoved,
      unitNumber: l.unitNumber,
    });
  }

  // 5) Boxes — chests and tanks tracked alongside their content series in
  //    bufferAmounts. No direction tracked (chests are radially symmetric;
  //    tanks have orientation but the data layer doesn't capture it yet).
  try {
    for (const b of readJson('bufferAmounts.json').buffers) {
      merged.push({
        name: b.name,
        position: { x: b.location.x, y: b.location.y },
        timeBuilt: b.timeBuilt ?? 0,
        timeRemoved: b.timeRemoved,
        unitNumber: b.unitNumber,
      });
    }
  } catch {
    // bufferAmounts is optional in older extractions.
  }

  // Collect every distinct recipe ever seen — Java reads this list at the
  // top of the input JSON and emits one icon sprite per recipe.
  const recipeSet = new Set();
  for (const e of merged) {
    if (e.recipeTimeline) {
      for (const r of e.recipeTimeline) recipeSet.add(r.recipe);
    } else if (e.recipe) {
      recipeSet.add(e.recipe);
    }
  }
  const recipesList = [...recipeSet].sort();

  const bp = buildBlueprintObject(merged, `replay-analyzer ${RUN} all-categories`);
  bp.recipes = recipesList;

  // Timing sidecar — keyed by 1-based entity_number (matches the order in
  // bp.blueprint.entities). `rs` is the recipe timeline for machines that
  // ever set a recipe.
  const timing = {};
  merged.forEach((e, i) => {
    const rec = { tb: e.timeBuilt, un: e.unitNumber };
    if (e.timeRemoved !== undefined) rec.tr = e.timeRemoved;
    if (e.recipeTimeline) rec.rs = e.recipeTimeline.map(r => ({ ts: r.tStart, n: r.recipe }));
    timing[i + 1] = rec;
  });

  const counts = {};
  for (const e of merged) counts[e.name] = (counts[e.name] || 0) + 1;

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON,   JSON.stringify(bp, null, 2), 'utf-8');
  writeFileSync(OUT_TIMING, JSON.stringify(timing),      'utf-8');

  console.log('source dir:    ', SRC_DIR);
  console.log('total merged:  ', merged.length);
  console.log('with tr:       ', merged.filter(e => e.timeRemoved !== undefined).length);
  console.log('with timeline: ', merged.filter(e => e.recipeTimeline).length);
  console.log('unique recipes:', recipesList.length);
  console.log('by name:       ', counts);
  console.log('json:          ', OUT_JSON);
  console.log('timing:        ', OUT_TIMING);
}

main();
