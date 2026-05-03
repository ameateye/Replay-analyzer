// Per-recipe end-game series for the dashboard widgets.
//
// For each recipe in RECIPES, builds three modes worth of data on a shared
// per-period grid (machineProduction.json's `period` ticks), clipped to rocket
// launch:
//
//   "rate" mode   — actual items/min, plus stacked stall-loss bands keyed by
//                   the missing item/fluid (or other status) for each period,
//                   plus the potential rate (machines × empirical per-machine
//                   rate). Smoothed with a 2-min centered MA, and per-period
//                   losses scaled so their sum equals (potential − actual),
//                   which keeps the stack top tracking the explicit potential
//                   line during stalls.
//
//   "cum" mode    — cumulative items produced.
//
//   "buffer" mode — sum of chest contents holding that item, last-known value
//                   per chest, with the player's inventory of the same item
//                   added in. Sample-and-hold across the master grid since
//                   chest snapshots only fire when non-empty.
//
// Inputs:
//   <runDir>/machineProduction.json
//   <runDir>/bufferAmounts.json
//   <runDir>/playerInventory.json

import * as fs from 'fs';
import * as path from 'path';

const RECIPES = [
  { recipe: 'processing-unit',         label: 'Blue chips',     color: '#2756c8' },
  { recipe: 'low-density-structure',   label: 'LDS',            color: '#c5cad0' },
  { recipe: 'rocket-fuel',             label: 'Rocket fuel',    color: '#ef4444' },
  { recipe: 'production-science-pack', label: 'Purple science', color: '#b14df5' },
  { recipe: 'utility-science-pack',    label: 'Yellow science', color: '#f2c94f' },
];

const RECIPE_OUTPUT_COUNT = {
  'production-science-pack': 3,
  'utility-science-pack': 3,
  'chemical-science-pack': 2,
  'military-science-pack': 2,
  'copper-cable': 2,
};

const LOSS_STATUS_ORDER = ['full_output', 'low_power', 'unknown'];

const SMOOTH_HALF_WINDOW = 12; // ±12 periods × 5 s ≈ ±1 min

// ---- generic helpers ------------------------------------------------------

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

// ---- per-recipe loss decomposition (port of production-data.ts) ----------

// For each (machine × recipe) instance, returns the steady-state items/period
// rate, computed from the longest contiguous 'working' stretch (items / N).
// Stretches < 20 periods fall back to a global average — short bursts include
// partial cycles whose progress never lands and would under-estimate.
function computePerRunRates(mpFile, recipe) {
  const period = mpFile.period;
  const outputCount = RECIPE_OUTPUT_COUNT[recipe] ?? 1;

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
      runs.push({ machineType: machine.name, samples });
    }
  }

  let bestGlobalItems = 0;
  let bestGlobalPeriods = 0;
  const runRate = new Map();
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
      runRate.set(run, bestItems / bestPeriods);
      if (bestPeriods > bestGlobalPeriods) {
        bestGlobalPeriods = bestPeriods;
        bestGlobalItems = bestItems;
      }
    }
  }
  const fallback = bestGlobalPeriods > 0 ? bestGlobalItems / bestGlobalPeriods : 0;
  for (const run of runs) if (!runRate.has(run)) runRate.set(run, fallback);

  return { runs, runRate };
}

function buildRateMode(mpFile, recipe, gridTicks) {
  const period = mpFile.period;
  const ratePerMinFactor = 60 / (period / 60);
  const { runs, runRate } = computePerRunRates(mpFile, recipe);

  // Per-grid raw arrays (still in items/period; we'll convert to /min later).
  const actualPP    = new Array(gridTicks.length).fill(0);
  const potentialPP = new Array(gridTicks.length).fill(0);
  const totalMach   = new Array(gridTicks.length).fill(0);
  const itemLossPP  = {};
  const fluidLossPP = {};
  const statusLossPP = {
    full_output: new Array(gridTicks.length).fill(0),
    low_power:   new Array(gridTicks.length).fill(0),
    unknown:     new Array(gridTicks.length).fill(0),
  };

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
      } else if (status === 'full_output' || status === 'low_power') {
        statusLossPP[status][i] += lost;
      } else {
        statusLossPP.unknown[i] += lost;
      }
    }
    actualPP[i] = act;
    potentialPP[i] = pot;
    totalMach[i] = tot;
  }

  // Convert to items/min then smooth (same order production-d3.ts uses).
  const toMin = arr => arr.map(v => v * ratePerMinFactor);
  const actualSm    = smooth(toMin(actualPP), SMOOTH_HALF_WINDOW);
  const potentialSm = smooth(toMin(potentialPP), SMOOTH_HALF_WINDOW);
  const itemLossSm  = smoothMap(Object.fromEntries(Object.entries(itemLossPP).map(([k, v]) => [k, toMin(v)])), SMOOTH_HALF_WINDOW);
  const fluidLossSm = smoothMap(Object.fromEntries(Object.entries(fluidLossPP).map(([k, v]) => [k, toMin(v)])), SMOOTH_HALF_WINDOW);
  const statusLossSm = smoothMap({
    full_output: toMin(statusLossPP.full_output),
    low_power:   toMin(statusLossPP.low_power),
    unknown:     toMin(statusLossPP.unknown),
  }, SMOOTH_HALF_WINDOW);

  // Scale per-period losses so their sum exactly equals max(0, potential −
  // actual). Without this, smoothing + items-already-in-flight clamping drift
  // the stack top above the explicit potential line during stall edges.
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

  // Order items / fluids by total loss (largest first) for stack ordering.
  const totalBy = (m) => Object.fromEntries(Object.entries(m).map(([k, arr]) => [k, arr.reduce((s, v) => s + v, 0)]));
  const itemsByLoss  = Object.entries(totalBy(itemLossSm)).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const fluidsByLoss = Object.entries(totalBy(fluidLossSm)).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const peakPotential = potentialSm.reduce((m, v) => Math.max(m, v), 0);
  const peakActual    = actualSm.reduce((m, v) => Math.max(m, v), 0);

  // Cumulative actual (raw, not smoothed) — counts actual items produced.
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
    statusLoss: {
      full_output: round2(statusLossSm.full_output),
      low_power:   round2(statusLossSm.low_power),
      unknown:     round2(statusLossSm.unknown),
    },
  };
}

function buildBufferSeries(bufFile, item, gridTicks) {
  const chests = bufFile.buffers.filter(b => b.type === 'chest' && b.content === item);
  if (chests.length === 0) {
    return { buffer: gridTicks.map(() => 0), peak: 0, chestCount: 0 };
  }
  const series = chests.map(c => c.amounts.slice().sort((a, b) => a[0] - b[0]));
  const cursors = new Array(chests.length).fill(0);
  const lastVal = new Array(chests.length).fill(0);
  const buffer = new Array(gridTicks.length);
  let peak = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const t = gridTicks[i];
    let total = 0;
    for (let c = 0; c < chests.length; c++) {
      const samples = series[c];
      while (cursors[c] < samples.length && samples[cursors[c]][0] <= t) {
        lastVal[c] = samples[cursors[c]][1];
        cursors[c]++;
      }
      total += lastVal[c];
    }
    buffer[i] = total;
    if (total > peak) peak = total;
  }
  return { buffer, peak, chestCount: chests.length };
}

function buildPlayerInventorySeries(invFile, item, gridTicks) {
  const period = invFile.period;
  const players = Object.values(invFile.players ?? {});
  if (players.length === 0) {
    return { inv: gridTicks.map(() => 0), peak: 0 };
  }
  const inv = new Array(gridTicks.length);
  let peak = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const sampleIdx = Math.min(
      Math.floor(gridTicks[i] / period),
      ...players.map(p => (p.inventory?.length ?? 1) - 1),
    );
    let total = 0;
    for (const p of players) {
      const snap = p.inventory?.[sampleIdx];
      if (snap) total += snap[item] ?? 0;
    }
    inv[i] = total;
    if (total > peak) peak = total;
  }
  return { inv, peak };
}

// ---- main entrypoint ------------------------------------------------------

export function buildEndGameProduction(runDir, rocketLaunchTick) {
  const mp = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const period = mp.period;
  const gridTicks = [];
  for (let t = 0; t <= rocketLaunchTick; t += period) gridTicks.push(t);
  const minutes = gridTicks.map(t => +(t / 3600).toFixed(4));

  const recipes = RECIPES.map(({ recipe, label, color }) => {
    const rate = buildRateMode(mp, recipe, gridTicks);
    const buffer = buildBufferSeries(buf, recipe, gridTicks);
    const player = buildPlayerInventorySeries(inv, recipe, gridTicks);
    const bufferWithInv = buffer.buffer.map((b, i) => b + player.inv[i]);
    const peakBufferWithInv = bufferWithInv.reduce((m, v) => Math.max(m, v), 0);

    return {
      recipe,
      label,
      color,
      chestCount: buffer.chestCount,
      finalCum: rate.finalCum,
      peakActual: rate.peakActual,
      peakPotential: rate.peakPotential,
      peakBuffer: Math.round(buffer.peak),
      peakBufferWithInv: Math.round(peakBufferWithInv),

      // rate mode
      actual: rate.actual,
      potential: rate.potential,
      itemsByLoss: rate.itemsByLoss,
      fluidsByLoss: rate.fluidsByLoss,
      itemLoss: rate.itemLoss,
      fluidLoss: rate.fluidLoss,
      statusLoss: rate.statusLoss,

      // cum / buffer modes
      cum: rate.cum,
      buffer: buffer.buffer.map(v => Math.round(v)),
      bufferWithInv: bufferWithInv.map(v => Math.round(v)),
    };
  });

  return { durationMin: +(rocketLaunchTick / 3600).toFixed(4), minutes, recipes };
}
