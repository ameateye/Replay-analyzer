// Production cube: per-period (recipe × buildPhase) groups, each holding
// dense arrays of items / potential / loss decomposition aligned to the
// data collector's native period (mp.period — typically 300 ticks = 5s,
// matching every other chart's grid). Replaces the per-widget production
// preps' aggregation step at the same time resolution they shipped at, but
// keyed on phase rather than widget so a single dataset covers every widget.
//
// Shape:
//   {
//     period: 300,
//     groups: [
//       {
//         recipe:     "copper-plate",
//         buildPhase: "Mixed",          // phase covering machine.timeBuilt
//                                       //   ("Earlier" sentinel for pre-phase)
//         firstTick:  86700,            // tick of items[0]
//         items:      [42, 50, 65, ...],  // dense, items produced per period
//                                       //   (cycles × outputCount)
//         potential:  [71.2, 71.2, ...],// dense, potential items per period
//         statusLoss: { full_output: [..], no_fuel: [..] },  // optional
//         itemLoss:   { "iron-ore": [...] },                  // optional
//         fluidLoss:  { ... }                                  // optional
//       },
//       ...
//     ]
//   }
//
// Each loss series is the same length as `items` / `potential`. Loss keys
// with all-zero series are dropped from the group. Per-period loss totals
// are clamped so their sum ≤ max(0, potential - items) — same gap-clamp
// `buildProductionSeries` applies on its smoothed series.
//
// Leading and trailing zero periods are trimmed: firstTick + items.length
// describes the active range. Groups with no production at all are dropped.
//
// Render-time helpers in dashboard/src/lib apply the matching ±12-period
// smoothing + items-per-period → items-per-minute conversion that
// `buildProductionSeries` did at build time, so chart lines visually match
// the pre-redesign rendering.

import * as fs from 'fs';
import * as path from 'path';
import { RECIPES_GAME_DATA, STATUS_KEYS } from './lib/common.mjs';
import { computePerRunRates } from './lib/production.mjs';
import { makePhaseLookup } from './lib/phase-lookup.mjs';

// In-memory group while we accumulate. Once everything is summed, we trim
// leading/trailing zeros and clamp losses to the gap before emitting.
function emptyGroup(recipe, buildPhase, N) {
  return {
    recipe,
    buildPhase,
    items: new Array(N).fill(0),
    potential: new Array(N).fill(0),
    statusLoss: {},
    itemLoss: {},
    fluidLoss: {},
  };
}

function ensureLossSeries(map, key, N) {
  let s = map[key];
  if (!s) {
    s = new Array(N).fill(0);
    map[key] = s;
  }
  return s;
}

export function buildProductionCube(runDir, phases, rocketLaunchTick) {
  const mp = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const period = mp.period;
  const N = Math.floor(rocketLaunchTick / period) + 1; // tick index range [0, N)
  const outputCount = RECIPES_GAME_DATA.outputCount ?? {};
  const craftTimes = RECIPES_GAME_DATA.craftTimes ?? {};
  const phaseAtTick = makePhaseLookup(phases, period);

  const recipesPresent = new Set();
  for (const m of mp.machines) {
    if (!m.recipes) continue;
    for (const r of m.recipes) recipesPresent.add(r.recipe);
  }

  const rateByBlock = new Map();
  for (const recipe of recipesPresent) {
    const factor = outputCount[recipe] ?? 1;
    const craftTime = craftTimes[recipe] ?? null;
    const { runs, runRate } = computePerRunRates(mp, recipe, factor, craftTime);
    for (const run of runs) rateByBlock.set(run.rBlock, runRate.get(run) ?? 0);
  }

  const groups = new Map(); // `${recipe}|${buildPhase}` -> group

  for (const machine of mp.machines) {
    if (!machine.recipes) continue;
    const buildPhase = phaseAtTick(machine.timeBuilt);
    for (const rBlock of machine.recipes) {
      if (!rBlock.production) continue;
      const factor = outputCount[rBlock.recipe] ?? 1;
      const rate = rateByBlock.get(rBlock) ?? 0;
      const groupKey = `${rBlock.recipe}|${buildPhase}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = emptyGroup(rBlock.recipe, buildPhase, N);
        groups.set(groupKey, group);
      }
      for (const sample of rBlock.production) {
        const tick = sample[0];
        if (tick > rocketLaunchTick) break; // production[] is tick-sorted
        // Non-aligned samples (tick % period !== 0) are end-of-life / recipe-
        // transition markers emitted by the data collector at the moment of
        // change. Including them double-counts the block's rate when an
        // aligned sample at the same period already exists. The legacy
        // build-time aggregation read samples via a strict tick→sample map
        // keyed on grid ticks (multiples of period), so non-aligned samples
        // were silently dropped; reproduce that here so the cube renders
        // identically to the published dashboard.
        if (tick % period !== 0) continue;
        const i = Math.floor(tick / period);
        if (i < 0 || i >= N) continue;
        const items = sample[1] * factor;
        const status = sample[4];
        const missing = sample[5];
        group.items[i] += items;
        group.potential[i] += rate;
        if (items >= rate) continue;
        const lost = rate - items;
        if (lost <= 0) continue;
        if (status === 'item_ingredient_shortage') {
          const list = (Array.isArray(missing) && missing.length) ? missing : ['(unspecified)'];
          const share = lost / list.length;
          for (const ing of list) ensureLossSeries(group.itemLoss, ing, N)[i] += share;
        } else if (status === 'fluid_ingredient_shortage') {
          const list = (Array.isArray(missing) && missing.length) ? missing : ['(unspecified)'];
          const share = lost / list.length;
          for (const ing of list) ensureLossSeries(group.fluidLoss, ing, N)[i] += share;
        } else if (status === 'working') {
          continue;
        } else if (STATUS_KEYS.includes(status)) {
          ensureLossSeries(group.statusLoss, status, N)[i] += lost;
        } else {
          ensureLossSeries(group.statusLoss, 'unknown', N)[i] += lost;
        }
      }
    }
  }

  // Per-period loss clamp + sparse serialization.
  const outGroups = [];
  for (const group of groups.values()) {
    clampLosses(group);
    // Trim leading/trailing zero periods (against items + potential combined).
    let lo = 0;
    while (lo < N && group.items[lo] === 0 && group.potential[lo] === 0) lo++;
    let hi = N - 1;
    while (hi >= lo && group.items[hi] === 0 && group.potential[hi] === 0) hi--;
    if (lo > hi) continue;

    // `items` are integer cycle counts × outputCount, so integer storage is
    // lossless. `potential` and loss arrays are real-valued; we serialize at
    // 4 decimals to keep round-trip precision tighter than 2 decimals (the
    // legacy preps rounded only once at the final stage, after smoothing,
    // so per-group 2-decimal rounding here would accumulate enough error
    // across phase splits to show up in peakPotential parity tests).
    const sliceItems = (arr) => arr.slice(lo, hi + 1).map(v => Math.round(v));
    const slice4 = (arr) => arr.slice(lo, hi + 1).map(v => +v.toFixed(4));
    const sliceMap = (m) => {
      const out = {};
      for (const k of Object.keys(m)) {
        const a = slice4(m[k]);
        if (a.some(v => v > 0)) out[k] = a;
      }
      return out;
    };

    const entry = {
      recipe: group.recipe,
      buildPhase: group.buildPhase,
      firstTick: lo * period,
      items: sliceItems(group.items),
      potential: slice4(group.potential),
    };
    const sl = sliceMap(group.statusLoss);
    const il = sliceMap(group.itemLoss);
    const fl = sliceMap(group.fluidLoss);
    if (Object.keys(sl).length) entry.statusLoss = sl;
    if (Object.keys(il).length) entry.itemLoss = il;
    if (Object.keys(fl).length) entry.fluidLoss = fl;
    outGroups.push(entry);
  }

  outGroups.sort((a, b) =>
    a.recipe.localeCompare(b.recipe)
    || a.buildPhase.localeCompare(b.buildPhase),
  );
  return { period, groups: outGroups };
}

function clampLosses(group) {
  const N = group.items.length;
  for (let i = 0; i < N; i++) {
    let rawSum = 0;
    for (const k in group.itemLoss) rawSum += group.itemLoss[k][i];
    for (const k in group.fluidLoss) rawSum += group.fluidLoss[k][i];
    for (const k in group.statusLoss) rawSum += group.statusLoss[k][i];
    if (rawSum <= 0) continue;
    const gap = Math.max(0, group.potential[i] - group.items[i]);
    if (rawSum > gap) {
      const scale = gap / rawSum;
      for (const k in group.itemLoss) group.itemLoss[k][i] *= scale;
      for (const k in group.fluidLoss) group.fluidLoss[k][i] *= scale;
      for (const k in group.statusLoss) group.statusLoss[k][i] *= scale;
    }
  }
}
