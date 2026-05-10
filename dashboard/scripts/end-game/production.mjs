// Per-recipe production series: actual + potential rate (items/min) plus
// stacked stall-loss bands, smoothed with a 2-min centered moving average.
// Also returns the raw cumulative actual count.
//
// Per-period losses are scaled so their sum equals max(0, potential − actual);
// without this, smoothing + items-already-in-flight clamping drift the stack
// top above the explicit potential line during stall edges.
//
// Potential rate per machine: when game-data carries the recipe's craftTime,
// we compute it directly as
//     items/period = craftingSpeed × (1 + prodBonus) / craftTime × periodSec × outputCount
// using the craftingSpeed and productivityBonus the data collector captured at
// run start. That's strictly better than inferring from samples — heuristic
// inference fails for slow / output-throttled recipes (e.g. electric-furnace,
// where almost every cycle completes on a 'full_output' sample, so no
// 'working' streak exceeds the threshold and the inferred rate collapses to
// 0). The empirical-streak path remains as a fallback for any recipe missing
// from craftTimes.

const LOSS_STATUS_ORDER = ['no_ingredients', 'no_fuel', 'full_output', 'low_power', 'depleted', 'unknown'];
const SMOOTH_HALF_WINDOW = 12; // ±12 periods × 5 s ≈ ±1 min

function smooth(values, halfWindow) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(values.length - 1, i + halfWindow);
    for (let j = lo; j <= hi; j++) { sum += values[j]; n++; }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

function smoothMap(map, halfWindow) {
  const out = {};
  for (const k of Object.keys(map)) out[k] = smooth(map[k], halfWindow);
  return out;
}

// For each (machine × recipe) instance, returns the steady-state items/period
// rate. Two estimators run in parallel and the per-machine MAX wins:
//
//   1. craftTime estimator (when game-data has the recipe's craftTime):
//      rate = craftingSpeed × (1 + prodBonus) / craftTime × periodSec × outputCount.
//      Exact when the data collector captured the final machine config.
//      Under-estimates when later module/beacon changes weren't observed
//      (the captured speed/prod can lag the entity's true effective speed).
//
//   2. Empirical heuristic: longest contiguous 'working' stretch, items/N.
//      Stretches < 20 periods fall back to a global average. Catches
//      hidden module/beacon contributions that estimator 1 missed.
//      Returns 0 for output-throttled recipes whose cycles always land on
//      'full_output' samples (e.g. electric-furnace) — covered by
//      estimator 1 in that case.
//
// The max is conservative for "potential": it bounds the upper end of what
// the machine actually achieved. Using max also avoids spurious
// actual > potential rendering when one estimator under-shoots.
function computePerRunRates(mpFile, recipe, outputCount, craftTime) {
  const period = mpFile.period;
  const periodSec = period / 60;

  const runs = [];
  for (const machine of mpFile.machines) {
    if (!machine.recipes) continue;
    for (const r of machine.recipes) {
      if (r.recipe !== recipe || !r.production) continue;
      const samples = new Map();
      for (const p of r.production) {
        // [tick, cycles, progress, _, status, missing?]
        const items = p[1] * outputCount;
        const sample = [items, p[2], p[3], p[4]];
        if (Array.isArray(p[5])) sample[4] = p[5];
        samples.set(p[0], sample);
      }
      runs.push({
        machineType: machine.name,
        craftingSpeed: r.craftingSpeed ?? 1,
        productivityBonus: r.productivityBonus ?? 0,
        samples,
      });
    }
  }

  // Estimator 1: craftTime-based per-machine rate.
  const craftTimeRate = new Map();
  if (craftTime != null && craftTime > 0) {
    for (const run of runs) {
      craftTimeRate.set(
        run,
        (run.craftingSpeed * (1 + run.productivityBonus) / craftTime) * periodSec * outputCount,
      );
    }
  }

  // Estimator 2: heuristic peak-streak rate, with global fallback for runs
  // that never reach the 20-period working threshold.
  let bestGlobalItems = 0;
  let bestGlobalPeriods = 0;
  const heuristicRate = new Map();
  for (const run of runs) {
    const ticks = [...run.samples.keys()].sort((a, b) => a - b);
    let bestItems = 0, bestPeriods = 0, curItems = 0, curPeriods = 0;
    let prevTick = null;
    for (const t of ticks) {
      const s = run.samples.get(t);
      const isWorking = s[3] === 'working';
      const contiguous = prevTick === null || t - prevTick === period;
      if (isWorking && contiguous) {
        curItems += s[0];
        curPeriods++;
      } else if (isWorking) {
        curItems = s[0];
        curPeriods = 1;
      } else {
        if (curPeriods > bestPeriods) { bestItems = curItems; bestPeriods = curPeriods; }
        curItems = 0; curPeriods = 0;
      }
      prevTick = t;
    }
    if (curPeriods > bestPeriods) { bestItems = curItems; bestPeriods = curPeriods; }
    if (bestPeriods >= 20) {
      heuristicRate.set(run, bestItems / bestPeriods);
      if (bestPeriods > bestGlobalPeriods) {
        bestGlobalPeriods = bestPeriods;
        bestGlobalItems = bestItems;
      }
    }
  }
  const fallback = bestGlobalPeriods > 0 ? bestGlobalItems / bestGlobalPeriods : 0;
  for (const run of runs) if (!heuristicRate.has(run)) heuristicRate.set(run, fallback);

  // Combine: per-machine max of the two estimators.
  const runRate = new Map();
  for (const run of runs) {
    const c = craftTimeRate.get(run) ?? 0;
    const h = heuristicRate.get(run) ?? 0;
    runRate.set(run, Math.max(c, h));
  }
  return { runs, runRate };
}

export function buildProductionSeries(mpFile, recipe, gridTicks, outputCount = 1, craftTime = null) {
  const period = mpFile.period;
  const ratePerMinFactor = 60 / (period / 60);
  const { runs, runRate } = computePerRunRates(mpFile, recipe, outputCount, craftTime);

  // Per-grid raw arrays (still in items/period; we'll convert to /min later).
  const actualPP    = new Array(gridTicks.length).fill(0);
  const potentialPP = new Array(gridTicks.length).fill(0);
  const totalMach   = new Array(gridTicks.length).fill(0);
  const itemLossPP  = {};
  const fluidLossPP = {};
  const statusLossPP = Object.fromEntries(
    LOSS_STATUS_ORDER.map(k => [k, new Array(gridTicks.length).fill(0)]),
  );

  for (let i = 0; i < gridTicks.length; i++) {
    const tick = gridTicks[i];
    let act = 0, pot = 0, tot = 0;
    for (const run of runs) {
      const s = run.samples.get(tick);
      if (!s) continue;
      tot++;
      const items = s[0];
      const status = s[3];
      const missing = s[4];
      const rate = runRate.get(run);
      act += items;
      pot += rate;
      if (status === 'working') continue;
      const lost = Math.max(0, rate - items);
      if (lost === 0) continue;
      if (status === 'item_ingredient_shortage') {
        const list = (Array.isArray(missing) && missing.length) ? missing : ['(unspecified)'];
        const share = lost / list.length;
        for (const ing of list) {
          (itemLossPP[ing] ??= new Array(gridTicks.length).fill(0))[i] += share;
        }
      } else if (status === 'fluid_ingredient_shortage') {
        const list = (Array.isArray(missing) && missing.length) ? missing : ['(unspecified)'];
        const share = lost / list.length;
        for (const ing of list) {
          (fluidLossPP[ing] ??= new Array(gridTicks.length).fill(0))[i] += share;
        }
      } else if (statusLossPP[status]) {
        statusLossPP[status][i] += lost;
      } else {
        statusLossPP.unknown[i] += lost;
      }
    }
    actualPP[i] = act;
    potentialPP[i] = pot;
    totalMach[i] = tot;
  }

  const toMin = arr => arr.map(v => v * ratePerMinFactor);
  const actualSm    = smooth(toMin(actualPP), SMOOTH_HALF_WINDOW);
  const potentialSm = smooth(toMin(potentialPP), SMOOTH_HALF_WINDOW);
  const itemLossSm  = smoothMap(Object.fromEntries(Object.entries(itemLossPP).map(([k, v]) => [k, toMin(v)])), SMOOTH_HALF_WINDOW);
  const fluidLossSm = smoothMap(Object.fromEntries(Object.entries(fluidLossPP).map(([k, v]) => [k, toMin(v)])), SMOOTH_HALF_WINDOW);
  const statusLossSm = smoothMap(
    Object.fromEntries(LOSS_STATUS_ORDER.map(k => [k, toMin(statusLossPP[k])])),
    SMOOTH_HALF_WINDOW,
  );

  const itemNames  = Object.keys(itemLossSm);
  const fluidNames = Object.keys(fluidLossSm);
  for (let i = 0; i < gridTicks.length; i++) {
    let rawSum = 0;
    for (const k of itemNames)  rawSum += itemLossSm[k][i];
    for (const k of fluidNames) rawSum += fluidLossSm[k][i];
    for (const k of LOSS_STATUS_ORDER) rawSum += statusLossSm[k][i];
    const gap = Math.max(0, potentialSm[i] - actualSm[i]);
    const scale = rawSum > 0 ? gap / rawSum : 0;
    for (const k of itemNames)  itemLossSm[k][i] *= scale;
    for (const k of fluidNames) fluidLossSm[k][i] *= scale;
    for (const k of LOSS_STATUS_ORDER) statusLossSm[k][i] *= scale;
  }

  const totalBy = (m) => Object.fromEntries(Object.entries(m).map(([k, arr]) => [k, arr.reduce((s, v) => s + v, 0)]));
  const itemsByLoss  = Object.entries(totalBy(itemLossSm)).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const fluidsByLoss = Object.entries(totalBy(fluidLossSm)).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const peakPotential = potentialSm.reduce((m, v) => Math.max(m, v), 0);
  const peakActual    = actualSm.reduce((m, v) => Math.max(m, v), 0);

  let running = 0;
  const cum = actualPP.map(v => (running += v));

  const round2 = arr => arr.map(v => +v.toFixed(2));
  return {
    runMachineCount: runs.length,
    actual:    round2(actualSm),
    potential: round2(potentialSm),
    totalMachines: totalMach,
    peakActual:    +peakActual.toFixed(2),
    peakPotential: +peakPotential.toFixed(2),
    finalCum: Math.round(running),
    cum: cum.map(v => Math.round(v)),
    itemsByLoss,
    fluidsByLoss,
    itemLoss:   Object.fromEntries(itemsByLoss.map(k => [k, round2(itemLossSm[k])])),
    fluidLoss:  Object.fromEntries(fluidsByLoss.map(k => [k, round2(fluidLossSm[k])])),
    statusLoss: Object.fromEntries(
      LOSS_STATUS_ORDER.map(k => [k, round2(statusLossSm[k])]),
    ),
  };
}
