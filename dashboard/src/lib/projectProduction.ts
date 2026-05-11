// Project the (recipe × buildPhase) production groups into a per-period
// series for a single recipe, optionally restricted to a subset of build
// phases. Mirrors `buildProductionSeries` (dashboard/scripts/lib/
// production.mjs) end-to-end: sum dense arrays across matching groups,
// convert items/period → items/min, ±12-period centred moving-average
// smooth, then clamp losses so the loss stack sits inside (potential -
// actual). The output is per-period at the cube's native period — same
// resolution the existing widgets render at.
//
// All output arrays are aligned to `gridTicks`: arr[i] is the value at
// `gridTicks[i]`. `gridTicks[0]` must be 0 and steps must equal the cube's
// period — the projection assumes a dense grid.

import type { ProductionCube, StatusKey } from './runDatasets';
import { STATUS_KEYS, SMOOTH_HALF_WINDOW } from './runDatasets';

export type ProductionSlice = {
  // items per minute (smoothed)
  actual: number[];
  // potential items per minute (smoothed)
  potential: number[];
  // running cumulative of raw items (pre-smoothing) — integer step path
  cum: number[];
  finalCum: number;
  peakActual: number;
  peakPotential: number;
  // loss decomposition, items/min per stall reason / ingredient, smoothed
  // and gap-clamped
  statusLoss: Record<StatusKey, number[]>;
  itemLoss: Record<string, number[]>;
  fluidLoss: Record<string, number[]>;
  itemsByLoss: string[];
  fluidsByLoss: string[];
};

export type ProjectProductionOpts = {
  recipe: string;
  // Restrict to groups whose buildPhase ∈ buildPhases. null / omitted =
  // include every phase.
  buildPhases?: ReadonlySet<string> | null;
  // Period-aligned tick array (e.g. [0, 300, 600, ..., rocketLaunchTick]).
  // Determines the projection's time domain.
  gridTicks: number[];
};

export function projectProduction(
  cube: ProductionCube,
  opts: ProjectProductionOpts,
): ProductionSlice {
  const { recipe, buildPhases, gridTicks } = opts;
  const period = cube.period;
  const N = gridTicks.length;
  // Per-period raw accumulators, in items/period.
  const actualPP = new Array(N).fill(0);
  const potentialPP = new Array(N).fill(0);
  const statusLossPP: Record<string, number[]> = {};
  for (const k of STATUS_KEYS) statusLossPP[k] = new Array(N).fill(0);
  const itemLossPP: Record<string, number[]> = {};
  const fluidLossPP: Record<string, number[]> = {};

  for (const group of cube.groups) {
    if (group.recipe !== recipe) continue;
    if (buildPhases && !buildPhases.has(group.buildPhase)) continue;
    const baseIdx = Math.floor(group.firstTick / period);
    const len = group.items.length;
    for (let j = 0; j < len; j++) {
      const i = baseIdx + j;
      if (i < 0 || i >= N) continue;
      actualPP[i] += group.items[j];
      potentialPP[i] += group.potential[j];
    }
    if (group.statusLoss) addLossSeries(statusLossPP, group.statusLoss, baseIdx, len, N);
    if (group.itemLoss) addLossSeries(itemLossPP, group.itemLoss, baseIdx, len, N);
    if (group.fluidLoss) addLossSeries(fluidLossPP, group.fluidLoss, baseIdx, len, N);
  }

  const ratePerMinFactor = 3600 / period; // items/period × this = items/min
  const toMin = (arr: number[]) => arr.map(v => v * ratePerMinFactor);
  const actualSm = smooth(toMin(actualPP), SMOOTH_HALF_WINDOW);
  const potentialSm = smooth(toMin(potentialPP), SMOOTH_HALF_WINDOW);
  const statusLossSm = smoothMap(mapToMin(statusLossPP, ratePerMinFactor), SMOOTH_HALF_WINDOW);
  const itemLossSm = smoothMap(mapToMin(itemLossPP, ratePerMinFactor), SMOOTH_HALF_WINDOW);
  const fluidLossSm = smoothMap(mapToMin(fluidLossPP, ratePerMinFactor), SMOOTH_HALF_WINDOW);

  // Per-tick gap-clamp: scale losses so their sum equals max(0, potential -
  // actual). Same logic as buildProductionSeries — without this, smoothing
  // + in-flight clamping drifts the stack top above the potential line.
  const itemNames = Object.keys(itemLossSm);
  const fluidNames = Object.keys(fluidLossSm);
  for (let i = 0; i < N; i++) {
    let rawSum = 0;
    for (const k of itemNames) rawSum += itemLossSm[k][i];
    for (const k of fluidNames) rawSum += fluidLossSm[k][i];
    for (const k of STATUS_KEYS) rawSum += statusLossSm[k][i];
    const gap = Math.max(0, potentialSm[i] - actualSm[i]);
    const scale = rawSum > 0 ? gap / rawSum : 0;
    for (const k of itemNames) itemLossSm[k][i] *= scale;
    for (const k of fluidNames) fluidLossSm[k][i] *= scale;
    for (const k of STATUS_KEYS) statusLossSm[k][i] *= scale;
  }

  // Cumulative is from raw items (not items/min), so it matches the
  // pre-redesign `cum` array — running total of items produced.
  const cum = new Array(N);
  let running = 0;
  for (let i = 0; i < N; i++) {
    running += actualPP[i];
    cum[i] = running;
  }

  const totalsOf = (m: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, arr]) => [k, arr.reduce((s, v) => s + v, 0)]));
  const itemTotals = totalsOf(itemLossSm);
  const fluidTotals = totalsOf(fluidLossSm);
  const itemsByLoss = Object.keys(itemTotals)
    .filter(k => itemTotals[k] > 0)
    .sort((a, b) => itemTotals[b] - itemTotals[a]);
  const fluidsByLoss = Object.keys(fluidTotals)
    .filter(k => fluidTotals[k] > 0)
    .sort((a, b) => fluidTotals[b] - fluidTotals[a]);

  let peakActual = 0, peakPotential = 0;
  for (let i = 0; i < N; i++) {
    if (actualSm[i] > peakActual) peakActual = actualSm[i];
    if (potentialSm[i] > peakPotential) peakPotential = potentialSm[i];
  }

  return {
    actual: actualSm,
    potential: potentialSm,
    cum,
    finalCum: Math.round(running),
    peakActual,
    peakPotential,
    statusLoss: statusLossSm as Record<StatusKey, number[]>,
    itemLoss: itemLossSm,
    fluidLoss: fluidLossSm,
    itemsByLoss,
    fluidsByLoss,
  };
}

function addLossSeries(
  target: Record<string, number[]>,
  src: Record<string, number[]>,
  baseIdx: number,
  len: number,
  N: number,
): void {
  for (const k of Object.keys(src)) {
    let arr = target[k];
    if (!arr) {
      arr = new Array(N).fill(0);
      target[k] = arr;
    }
    const srcArr = src[k];
    for (let j = 0; j < len; j++) {
      const i = baseIdx + j;
      if (i < 0 || i >= N) continue;
      arr[i] += srcArr[j];
    }
  }
}

function smooth(values: number[], halfWindow: number): number[] {
  const N = values.length;
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, n = 0;
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(N - 1, i + halfWindow);
    for (let j = lo; j <= hi; j++) { sum += values[j]; n++; }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

function smoothMap(m: Record<string, number[]>, halfWindow: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of Object.keys(m)) out[k] = smooth(m[k], halfWindow);
  return out;
}

function mapToMin(m: Record<string, number[]>, factor: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of Object.keys(m)) out[k] = m[k].map(v => v * factor);
  return out;
}
