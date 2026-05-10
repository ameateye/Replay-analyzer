// Prepares the input that ReplaySvgRender (Java/FBSR) consumes for one run.
//
// FBSR's parser is anchored on the standard Factorio blueprint shape, so we
// transform our per-source extraction JSONs (entityLayout, minerActivity,
// machineProduction, labContents, bufferAmounts) into a synthetic blueprint
// object plus a sidecar carrying the metadata FBSR doesn't care about
// (build/remove ticks, unit numbers, recipe timelines, splitter/inserter
// alt-mode state timelines).
//
// Outputs (under tools/output/):
//   <RUN>.json         — { blueprint: {…FBSR shape…}, recipes: [name, …],
//                          filterItems: [name, …] }
//   <RUN>.timing.json  — { entityNumber → { tb, tr?, un, rs?, ss?, is? } }
//
// `recipes` and `filterItems` are unique-name lists: ReplaySvgRender renders
// one icon sprite per entry so the React side can overlay them dynamically
// as machines change recipes / splitters get filters / inserters change
// filter sets during the run.
//
// Splitter/inserter alt-mode timelines (ss / is on the timing record) only
// exist on entities whose state ever differs from "no overlay". Splitters
// without any priority and without a filter, or inserters with useFilters
// false, get no timeline entry — saves space and skips empty work in
// map-prep / MapView.

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

// Build splitter alt-mode timeline by folding mutations forward. Each event
// is a state snapshot at a tick: { ts, ip, op, f } — input priority, output
// priority, filter (item name or '' = none). We emit an event for the initial
// state and another at every mutation that changes any of these fields.
// Returns [] if the splitter never had any non-default state.
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
  // Drop the timeline entirely if every event is the no-overlay state
  // (no priority and no filter). Saves bytes and cycles downstream.
  const anyOverlay = events.some(ev => ev.ip !== 'none' || ev.op !== 'none' || ev.f !== '');
  return anyOverlay ? events : [];
}

// Build inserter filter timeline. Each event: { ts, u, m, f } where
// u = useFilters (bool), m = 'whitelist' | 'blacklist' | undefined,
// f = string[] of item names. Only entities that ever had useFilters=true
// emit a non-empty timeline.
function buildInserterTimeline(e) {
  // TypeScriptToLua serializes empty Lua tables as `{}` (JSON object)
  // rather than `[]`. Normalize before any array operations.
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

function sameStrArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  //
  // The data layer stores the BUILD-TIME `direction` on the entity and
  // appends every later rotation to `mutations[*].direction`. Reading
  // `e.direction` alone gives the orientation the entity had when first
  // placed, not the one in effect at the end of the run. For a static
  // end-of-game render we want the latest folded value — otherwise rows
  // that were rotated mid-build (e.g. row-3 of the top-left copper bank
  // in DS-2_14_45, which was rotated N→S at tick 113103) end up drawn
  // facing the wrong way and the inserter sprites disagree with the
  // flow-arrows overlay.
  const layout = readJson('entityLayout.json');
  for (const e of layout.entities) {
    if (!LAYOUT_SCOPE.has(e.name)) continue;
    let direction = e.direction || 0;
    let beltToGround = e.beltToGroundType;
    for (const m of e.mutations ?? []) {
      if (m.direction        !== undefined) direction    = m.direction;
      if (m.beltToGroundType !== undefined) beltToGround = m.beltToGroundType;
    }
    const rec = {
      name: e.name,
      position: { x: e.location.x, y: e.location.y },
      direction,
      timeBuilt: e.timeBuilt ?? 0,
      timeRemoved: e.timeRemoved,
      unitNumber: e.unitNumber,
    };
    if (e.name.endsWith('underground-belt')) rec.type = beltToGround ?? 'input';

    // Splitter alt-mode state timeline. Build is the initial event;
    // every mutation that changes priority OR filter is an additional
    // event. We only attach the timeline if the entity is ever non-default
    // (any priority != 'none' OR any filter set), since the vast majority
    // of splitters have nothing worth overlaying.
    if (e.name.endsWith('splitter')) {
      const events = buildSplitterTimeline(e);
      if (events.length > 0) rec.splitterTimeline = events;
    }

    // Inserter filter timeline. Same reasoning: only entities that ever
    // had useFilters=true OR filters set get a timeline.
    if (LAYOUT_SCOPE.has(e.name) && (
        e.name === 'inserter' || e.name === 'burner-inserter' ||
        e.name === 'long-handed-inserter' || e.name === 'fast-inserter' ||
        e.name === 'filter-inserter' || e.name === 'stack-inserter' ||
        e.name === 'stack-filter-inserter' || e.name === 'bulk-inserter')) {
      const events = buildInserterTimeline(e);
      if (events.length > 0) rec.inserterTimeline = events;
    }

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
  //
  //    The data collector doesn't currently set timeRemoved on the machine
  //    record, but it does mark the active recipe production with
  //    stoppedReason: 'mined' | 'entity_died' when the entity is destroyed
  //    (machine-production.ts onDeleted). Derive timeRemoved from that —
  //    if any recipe was stopped due to deletion, the machine was removed
  //    at that tick. (Other stop reasons — configuration_changed,
  //    marked_for_deconstruction, disabled_by_script — leave the entity in
  //    place and don't count as removal.)
  for (const m of readJson('machineProduction.json').machines) {
    const timeline = (m.recipes || [])
      .filter(r => r && r.recipe)
      .map(r => ({ tStart: r.timeStarted ?? 0, recipe: r.recipe }));
    let timeRemoved = m.timeRemoved;
    if (timeRemoved === undefined) {
      for (const r of m.recipes || []) {
        if ((r.stoppedReason === 'mined' || r.stoppedReason === 'entity_died')
            && r.timeStopped !== undefined) {
          if (timeRemoved === undefined || r.timeStopped > timeRemoved) {
            timeRemoved = r.timeStopped;
          }
        }
      }
    }
    merged.push({
      name: m.name,
      position: { x: m.location.x, y: m.location.y },
      direction: m.direction || 0,
      recipe: timeline[0]?.recipe,
      recipeTimeline: timeline.length > 0 ? timeline : undefined,
      timeBuilt: m.timeBuilt ?? 0,
      timeRemoved,
      unitNumber: m.unitNumber,
    });
  }

  // 4) Labs (no direction — radial symmetry).
  //
  //    The data collector doesn't currently set timeRemoved on the lab
  //    record. Derive it from the periodic packs[] timeline: every lab is
  //    sampled every `period` ticks while it exists, so a lab whose last
  //    sample is well before the latest sample seen across any lab was
  //    removed shortly after that last sample. Threshold of 2*period to
  //    avoid false-positives at the very end of the run (a lab that
  //    survived to rocket-launch may still miss a sample by timing).
  const labData = readJson('labContents.json');
  let maxLabSample = 0;
  for (const l of labData.labs) {
    const last = l.packs[l.packs.length - 1];
    if (last && last[0] > maxLabSample) maxLabSample = last[0];
  }
  for (const l of labData.labs) {
    let timeRemoved = l.timeRemoved;
    if (timeRemoved === undefined) {
      const last = l.packs[l.packs.length - 1];
      if (last && last[0] + labData.period * 2 < maxLabSample) {
        timeRemoved = last[0] + labData.period;
      }
    }
    merged.push({
      name: l.name,
      position: { x: l.location.x, y: l.location.y },
      timeBuilt: l.timeBuilt ?? 0,
      timeRemoved,
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

  // Collect every distinct filter-item name ever seen — Java emits one
  // icon sprite per item under sid `f:<itemName>`. Spans both splitters
  // (single-item splitter_filter) and inserters (1-4 inserter_filters).
  const filterItemSet = new Set();
  for (const e of merged) {
    if (e.splitterTimeline) {
      for (const ev of e.splitterTimeline) if (ev.f) filterItemSet.add(ev.f);
    }
    if (e.inserterTimeline) {
      for (const ev of e.inserterTimeline) for (const name of ev.f) filterItemSet.add(name);
    }
  }
  const filterItemsList = [...filterItemSet].sort();

  const bp = buildBlueprintObject(merged, `replay-analyzer ${RUN} all-categories`);
  bp.recipes = recipesList;
  bp.filterItems = filterItemsList;

  // Timing sidecar — keyed by 1-based entity_number (matches the order in
  // bp.blueprint.entities). `rs` is the recipe timeline for machines that
  // ever set a recipe.
  const timing = {};
  merged.forEach((e, i) => {
    const rec = { tb: e.timeBuilt, un: e.unitNumber };
    if (e.timeRemoved !== undefined) rec.tr = e.timeRemoved;
    if (e.recipeTimeline) rec.rs = e.recipeTimeline.map(r => ({ ts: r.tStart, n: r.recipe }));
    if (e.splitterTimeline)  rec.ss = e.splitterTimeline;
    if (e.inserterTimeline)  rec.is = e.inserterTimeline;
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
  console.log('splitter ovly: ', merged.filter(e => e.splitterTimeline).length);
  console.log('inserter ovly: ', merged.filter(e => e.inserterTimeline).length);
  console.log('filter items:  ', filterItemsList.length);
  console.log('by name:       ', counts);
  console.log('json:          ', OUT_JSON);
  console.log('timing:        ', OUT_TIMING);
}

main();
