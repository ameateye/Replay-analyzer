// Render-time replacement for the build-time `buildRecipeRow` helper
// (dashboard/scripts/lib/recipe-row.mjs). Same Recipe-shaped output so the
// ProductionRow component can keep consuming a single shape; this version
// projects from the per-run cube + stocks datasets at the cube's native
// period (matching the chart's grid) instead of joining raw machine-
// production + bufferAmounts + playerInventory at build time.
//
// chestCount and the buffer-limit series are derived from the per-entity
// metadata that stocks-prep attaches to each `source: 'buffer'` group,
// joined at render time with game-data capacities (chestSlots × stackSizes
// for solids, tankCapacity for fluids). Callers pass `capacityCfg` from
// `useGameData()` — when omitted, chestCount falls back to 0 and the
// buffer-limit line is suppressed (`showBufferLimit: false`).

import type {
  ProductionCube,
  StatusKey,
  StocksDataset,
  StocksSource,
  MinersDataset,
} from './runDatasets';
import { STATUS_KEYS } from './runDatasets';
import { projectProduction } from './projectProduction';
import { projectStocks, bufferApproachesCapacity, type CapacityCfg } from './projectStocks';
import { projectMinerCounts } from './projectMiners';

export type { CapacityCfg } from './projectStocks';

// Mirrors the Recipe type ProductionWidget.tsx consumes. Kept structurally
// identical so a widget can swap its data source without touching its row
// rendering.
// Per-source component within a combined row (e.g. basic + advanced oil
// processing stacked under "Refinery throughput"). Mirrors the
// RecipeComponent type ProductionWidget consumes.
export type RecipeRowComponent = {
  recipe: string;
  actual: number[];
  cum: number[];
  peakActual: number;
  finalCum: number;
};

export type RecipeRow = {
  recipe: string;
  chestCount: number;
  finalCum: number;
  peakActual: number;
  peakPotential: number;
  peakBuffer: number;
  peakBufferWithInv: number;
  actual: number[];
  potential: number[];
  itemsByLoss: string[];
  fluidsByLoss: string[];
  itemLoss: Record<string, number[] | undefined>;
  fluidLoss: Record<string, number[] | undefined>;
  statusLoss: Record<StatusKey, number[]>;
  cum: number[];
  buffer: number[];
  bufferWithInv: number[];
  bufferLimit: number[] | null;
  peakBufferLimit: number;
  showBufferLimit: boolean;
  components?: RecipeRowComponent[];
};

export type BuildRecipeRowOpts = {
  recipe: string;
  // Restrict the production half to groups in these build phases.
  // Mirrors the existing `machineFilter` parameter — phase membership
  // replaces per-machine timeBuilt predicates.
  buildPhases?: ReadonlySet<string> | null;
  // Restrict the stocks half (defaults to both buffer + inventory).
  stockSources?: ReadonlySet<StocksSource> | null;
  // Period-aligned tick array, same grid used across the widget.
  gridTicks: number[];
  // Game-data capacities used to derive chestCount + the buffer-limit
  // reference series. Pass `gameData.recipes` (or the three fields below)
  // from `useGameData()`. When omitted, chestCount stays 0 and the
  // buffer-limit line is suppressed.
  capacityCfg?: CapacityCfg | null;
};

export function buildRecipeRow(
  cube: ProductionCube,
  stocks: StocksDataset,
  opts: BuildRecipeRowOpts,
): RecipeRow {
  const { recipe, buildPhases, stockSources, gridTicks, capacityCfg } = opts;

  const prod = projectProduction(cube, { recipe, buildPhases, gridTicks });
  const stk = projectStocks(stocks, { item: recipe, sources: stockSources, gridTicks, capacityCfg });

  const round2 = (arr: number[]) => arr.map(v => +v.toFixed(2));
  const roundInt = (arr: number[]) => arr.map(v => Math.round(v));
  const roundMap2 = (m: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, arr]) => [k, round2(arr)]));

  const showBufferLimit = bufferApproachesCapacity(stk.buffer, stk.capacity);

  return {
    recipe,
    chestCount: stk.chestCount,
    finalCum: prod.finalCum,
    peakActual: +prod.peakActual.toFixed(2),
    peakPotential: +prod.peakPotential.toFixed(2),
    peakBuffer: Math.round(stk.peakBuffer),
    peakBufferWithInv: Math.round(stk.peakBufferWithInv),

    actual: round2(prod.actual),
    potential: round2(prod.potential),
    itemsByLoss: prod.itemsByLoss,
    fluidsByLoss: prod.fluidsByLoss,
    itemLoss: roundMap2(prod.itemLoss),
    fluidLoss: roundMap2(prod.fluidLoss),
    statusLoss: roundMap2(prod.statusLoss) as Record<StatusKey, number[]>,

    cum: roundInt(prod.cum),
    buffer: roundInt(stk.buffer),
    bufferWithInv: roundInt(stk.bufferWithInv),
    bufferLimit: showBufferLimit && stk.capacity ? stk.capacity.map(v => Math.round(v)) : null,
    peakBufferLimit: showBufferLimit ? Math.round(stk.peakCapacity) : 0,
    showBufferLimit,
  };
}

// Combined row: stack multiple recipes into one Recipe-shaped output (e.g.
// basic + advanced oil processing under "Refinery throughput"). actual /
// potential / cum are element-wise sums; per-component series go on
// `components` so the renderer can paint them as a coloured stack. Mirrors
// the build-time `buildCombinedRow` in oil-phase-prep.mjs.
export type BuildCombinedRecipeRowOpts = {
  // Headline `recipe` field reported on the row (typically the first
  // component's recipe — only used for tooltip / hover headline).
  rowRecipe: string;
  components: ReadonlyArray<{ recipe: string; buildPhases?: ReadonlySet<string> | null }>;
  gridTicks: number[];
};

export function buildCombinedRecipeRow(
  cube: ProductionCube,
  opts: BuildCombinedRecipeRowOpts,
): RecipeRow {
  const { rowRecipe, components, gridTicks } = opts;
  const N = gridTicks.length;
  const round2 = (arr: number[]) => arr.map(v => +v.toFixed(2));
  const roundInt = (arr: number[]) => arr.map(v => Math.round(v));

  const compSlices = components.map(c => ({
    recipe: c.recipe,
    slice: projectProduction(cube, { recipe: c.recipe, buildPhases: c.buildPhases ?? null, gridTicks }),
  }));

  // Element-wise sum of per-component arrays.
  const sumArr = (key: 'actual' | 'potential' | 'cum') => {
    const out = new Array(N).fill(0);
    for (const { slice } of compSlices) {
      const arr = slice[key];
      for (let i = 0; i < N; i++) out[i] += arr[i];
    }
    return out;
  };
  const actual = sumArr('actual');
  const potential = sumArr('potential');
  const cum = sumArr('cum');

  // Merge loss maps: union of keys across components, summed element-wise.
  const mergeLossMap = (mapKey: 'itemLoss' | 'fluidLoss'): Record<string, number[]> => {
    const merged: Record<string, number[]> = {};
    for (const { slice } of compSlices) {
      for (const k of Object.keys(slice[mapKey])) {
        const arr = merged[k] ?? (merged[k] = new Array(N).fill(0));
        const src = slice[mapKey][k];
        for (let i = 0; i < N; i++) arr[i] += src[i];
      }
    }
    return merged;
  };
  const itemLoss = mergeLossMap('itemLoss');
  const fluidLoss = mergeLossMap('fluidLoss');

  const statusLoss: Record<string, number[]> = {};
  for (const k of STATUS_KEYS) statusLoss[k] = new Array(N).fill(0);
  for (const { slice } of compSlices) {
    for (const k of STATUS_KEYS) {
      const src = slice.statusLoss[k];
      const dst = statusLoss[k];
      for (let i = 0; i < N; i++) dst[i] += src[i];
    }
  }

  const totalsOf = (m: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, arr]) => [k, arr.reduce((s, v) => s + v, 0)]));
  const itemTotals = totalsOf(itemLoss);
  const fluidTotals = totalsOf(fluidLoss);
  const itemsByLoss = Object.keys(itemTotals).filter(k => itemTotals[k] > 0).sort((a, b) => itemTotals[b] - itemTotals[a]);
  const fluidsByLoss = Object.keys(fluidTotals).filter(k => fluidTotals[k] > 0).sort((a, b) => fluidTotals[b] - fluidTotals[a]);

  let peakActual = 0, peakPotential = 0;
  for (let i = 0; i < N; i++) {
    if (actual[i] > peakActual) peakActual = actual[i];
    if (potential[i] > peakPotential) peakPotential = potential[i];
  }
  const finalCum = cum[N - 1] ?? 0;

  return {
    recipe: rowRecipe,
    chestCount: 0,
    finalCum: Math.round(finalCum),
    peakActual: +peakActual.toFixed(2),
    peakPotential: +peakPotential.toFixed(2),
    peakBuffer: 0,
    peakBufferWithInv: 0,
    actual: round2(actual),
    potential: round2(potential),
    itemsByLoss,
    fluidsByLoss,
    itemLoss: Object.fromEntries(Object.entries(itemLoss).map(([k, arr]) => [k, round2(arr)])),
    fluidLoss: Object.fromEntries(Object.entries(fluidLoss).map(([k, arr]) => [k, round2(arr)])),
    statusLoss: Object.fromEntries(Object.entries(statusLoss).map(([k, arr]) => [k, round2(arr)])) as Record<StatusKey, number[]>,
    cum: roundInt(cum),
    buffer: new Array(N).fill(0),
    bufferWithInv: new Array(N).fill(0),
    bufferLimit: null,
    peakBufferLimit: 0,
    showBufferLimit: false,
    components: compSlices.map(({ recipe, slice }) => ({
      recipe,
      actual: round2(slice.actual),
      cum: roundInt(slice.cum),
      peakActual: +slice.peakActual.toFixed(2),
      finalCum: slice.finalCum,
    })),
  };
}

// Miner-count row: count-mode rendering of a per-resource miner count
// series, sourced from the lifted miners dataset. Parks the count series
// in buffer + bufferWithInv so ProductionRow's count-mode renderer reads
// it the same way the old burner-phase-prep emitted it. `runningMin` is
// the total minutes count > 0 — surfaced via headlineOverride by the
// caller.
export type MinerRow = RecipeRow & { runningMin: number };

export function buildMinerCountRow(
  miners: MinersDataset,
  opts: { name: string; resource: string; gridTicks: number[]; period: number },
): MinerRow {
  const { name, resource, gridTicks, period } = opts;
  const N = gridTicks.length;
  const { count, peak, runningMin } = projectMinerCounts(miners.miners, { name, resource, gridTicks, period });
  const zeros = () => new Array(N).fill(0);
  return {
    recipe: resource,
    chestCount: 0,
    finalCum: 0,
    peakActual: 0,
    peakPotential: 0,
    peakBuffer: peak,
    peakBufferWithInv: peak,
    actual: zeros(),
    potential: zeros(),
    itemsByLoss: [],
    fluidsByLoss: [],
    itemLoss: {},
    fluidLoss: {},
    statusLoss: Object.fromEntries(STATUS_KEYS.map(k => [k, zeros()])) as Record<StatusKey, number[]>,
    cum: zeros(),
    buffer: count,
    bufferWithInv: count,
    bufferLimit: null,
    peakBufferLimit: 0,
    showBufferLimit: false,
    runningMin,
  };
}

// Fluid-buffer row: buffer-mode rendering of a fluid item's stock series.
// In the new stocks schema fluids and solids share the same `buffer` source
// (tanks were merged with chests under a unified item-source schema), so
// this is just a thin wrapper around projectStocks that produces a
// Recipe-shaped row with all production fields zeroed. `chestCount` here
// is the tank count for the fluid (the headline shows "X tanks" via the
// widget's fluid-buffer rendering).
export function buildFluidBufferRow(
  stocks: StocksDataset,
  opts: { item: string; gridTicks: number[]; capacityCfg?: CapacityCfg | null },
): RecipeRow {
  const { item, gridTicks, capacityCfg } = opts;
  const N = gridTicks.length;
  const stk = projectStocks(stocks, { item, gridTicks, capacityCfg });
  const zeros = () => new Array(N).fill(0);
  const buffer = stk.buffer.map(v => Math.round(v));
  const showBufferLimit = bufferApproachesCapacity(stk.buffer, stk.capacity);
  return {
    recipe: item,
    chestCount: stk.chestCount,
    finalCum: 0,
    peakActual: 0,
    peakPotential: 0,
    peakBuffer: Math.round(stk.peakBuffer),
    peakBufferWithInv: Math.round(stk.peakBuffer),
    actual: zeros(),
    potential: zeros(),
    itemsByLoss: [],
    fluidsByLoss: [],
    itemLoss: {},
    fluidLoss: {},
    statusLoss: Object.fromEntries(STATUS_KEYS.map(k => [k, zeros()])) as Record<StatusKey, number[]>,
    cum: zeros(),
    buffer,
    bufferWithInv: buffer,
    bufferLimit: showBufferLimit && stk.capacity ? stk.capacity.map(v => Math.round(v)) : null,
    peakBufferLimit: showBufferLimit ? Math.round(stk.peakCapacity) : 0,
    showBufferLimit,
  };
}
