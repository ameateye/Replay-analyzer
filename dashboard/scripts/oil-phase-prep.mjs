// Oil-phase analysis bundle. Produces one row per entry in recipes.json's
// `oilPhaseDisplay`, in the same Recipe shape the dashboard's ProductionRow
// already consumes — so the React side renders these as ordinary rows with a
// per-row fixed display mode (rate / cum / fluid-buffer) instead of the global
// toggle the end-game widget uses.
//
// Time grid spans the whole run (0 → rocket launch) so the x-axis aligns with
// RunOverview / EndGameWidgets above. Rows that only become non-zero late in
// the run still occupy the same width.
//
// Special handling:
//   - `mode: "fluid-buffer"` rows pull from `bufferAmounts.json` filtered by
//     buffer type='tank', summed across all tanks of a given fluid content.
//     Rate/cum fields are zeroed.
//   - `machineFilter: "before-mixed"` rows compute production against only the
//     machines built before the Mixed phase boundary — for advanced-circuit,
//     that gives "the oil-phase RC line, not the dedicated Mixed RC line".

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildRecipeRow, CAPACITY_CFG } from './end-game-production-prep.mjs';
import { buildBufferSeries, bufferApproachesCapacity } from './end-game/buffer.mjs';
import { buildProductionSeries } from './end-game/production.mjs';

const STATUS_KEYS = ['no_ingredients', 'no_fuel', 'full_output', 'low_power', 'unknown'];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = path.resolve(SCRIPT_DIR, '..', '..', 'game-data', 'recipes.json');
const RECIPES_GAME_DATA = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));

export function buildOilPhase(runDir, rocketLaunchTick, phases) {
  const cfgRaw = RECIPES_GAME_DATA.oilPhaseDisplay;
  // Tolerate the legacy flat-array shape so older recipes.json checkouts keep
  // working: in that case, all rows land in a single default group.
  const groups = Array.isArray(cfgRaw) ? [{ id: 'oil', label: 'Oil' }] : (cfgRaw?.groups ?? []);
  const config = Array.isArray(cfgRaw) ? cfgRaw : (cfgRaw?.rows ?? []);
  if (config.length === 0) return null;

  const mp  = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const period = mp.period;
  const gridTicks = [];
  for (let t = 0; t <= rocketLaunchTick; t += period) gridTicks.push(t);
  const minutes = gridTicks.map(t => +(t / 3600).toFixed(4));
  const N = gridTicks.length;

  const mixedStartTick = phases.find(p => p.name === 'Mixed')?.startTick ?? null;
  const zeros = () => new Array(N).fill(0);

  const rows = config.map(cfg => {
    // key + mode are kept in the per-run JSON because they're how the
    // runtime widget correlates rows to their display config in
    // recipes.json (looked up via gameData.recipes.oilPhaseDisplay.rows).
    // label / color / group come from runtime so editing them in
    // recipes.json takes effect on the next page reload.
    const stub = { key: cfg.key, mode: cfg.mode };

    if (cfg.mode === 'fluid-buffer') {
      const fluid = buildBufferSeries(buf, cfg.recipe, gridTicks, 'tank', CAPACITY_CFG);
      const buffer = fluid.buffer.map(v => Math.round(v));
      const showBufferLimit = bufferApproachesCapacity(fluid.buffer, fluid.capacity);
      return {
        ...stub,
        recipe: cfg.recipe,
        chestCount: fluid.chestCount,
        finalCum: 0,
        peakActual: 0,
        peakPotential: 0,
        peakBuffer: Math.round(fluid.peak),
        peakBufferWithInv: Math.round(fluid.peak),
        actual: zeros(),
        potential: zeros(),
        itemsByLoss: [],
        fluidsByLoss: [],
        itemLoss: {},
        fluidLoss: {},
        statusLoss: Object.fromEntries(STATUS_KEYS.map(k => [k, zeros()])),
        cum: zeros(),
        buffer,
        bufferWithInv: buffer,
        bufferLimit: showBufferLimit ? fluid.capacity.map(v => Math.round(v)) : null,
        peakBufferLimit: showBufferLimit ? Math.round(fluid.peakCapacity) : 0,
        showBufferLimit,
      };
    }

    if (Array.isArray(cfg.components) && cfg.components.length > 0) {
      return buildCombinedRow(mp, gridTicks, stub, cfg.components, N);
    }

    const machineFilter = (cfg.machineFilter === 'before-mixed' && mixedStartTick != null)
      ? (m => m.timeBuilt < mixedStartTick)
      : null;

    const row = buildRecipeRow(mp, buf, inv, cfg.recipe, gridTicks, machineFilter);
    return { ...row, ...stub };
  });

  return {
    durationMin: +(rocketLaunchTick / 3600).toFixed(4),
    minutes,
    groups,
    rows,
  };
}

// Stacks multiple recipes (e.g. basic + advanced oil processing) into a single
// row whose `actual` / `cum` are element-wise sums. Each component keeps its
// own `actual` / `cum` so the renderer can stack them in distinct colors. Loss
// arrays are merged across components — itemsByLoss / fluidsByLoss become the
// union sorted by combined-loss total, matching the order the rate stack uses.
//
// Per-component label/color are NOT baked here; the runtime widget looks them
// up by recipe from the row's display config in gameData.
function buildCombinedRow(mp, gridTicks, stub, componentCfgs, N) {
  const components = componentCfgs.map(c => {
    const outputCount = RECIPES_GAME_DATA.outputCount[c.recipe] ?? 1;
    const craftTime = RECIPES_GAME_DATA.craftTimes?.[c.recipe] ?? null;
    const series = buildProductionSeries(mp, c.recipe, gridTicks, outputCount, craftTime);
    return {
      recipe: c.recipe,
      actual: series.actual,
      potential: series.potential,
      cum: series.cum,
      finalCum: series.finalCum,
      peakActual: series.peakActual,
      itemsByLoss: series.itemsByLoss,
      fluidsByLoss: series.fluidsByLoss,
      itemLoss: series.itemLoss,
      fluidLoss: series.fluidLoss,
      statusLoss: series.statusLoss,
    };
  });

  const sumPair = (a, b) => a.map((v, i) => +(v + b[i]).toFixed(2));
  const sumIntPair = (a, b) => a.map((v, i) => v + b[i]);
  const accSum = (key) => components.reduce(
    (acc, c) => sumPair(acc, c[key]),
    new Array(N).fill(0),
  );
  const accSumInt = (key) => components.reduce(
    (acc, c) => sumIntPair(acc, c[key]),
    new Array(N).fill(0),
  );

  const actual    = accSum('actual');
  const potential = accSum('potential');
  const cum       = accSumInt('cum');

  // Merge losses: union the names across components, summing element-wise.
  const mergeLossMap = (key) => {
    const merged = {};
    for (const c of components) {
      for (const [name, arr] of Object.entries(c[key])) {
        if (!merged[name]) merged[name] = new Array(N).fill(0);
        for (let i = 0; i < N; i++) merged[name][i] = +(merged[name][i] + arr[i]).toFixed(2);
      }
    }
    return merged;
  };
  const itemLoss  = mergeLossMap('itemLoss');
  const fluidLoss = mergeLossMap('fluidLoss');

  const totalBy = m => Object.fromEntries(
    Object.entries(m).map(([k, arr]) => [k, arr.reduce((s, v) => s + v, 0)]),
  );
  const itemsByLoss  = Object.entries(totalBy(itemLoss)).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const fluidsByLoss = Object.entries(totalBy(fluidLoss)).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const statusLoss = Object.fromEntries(STATUS_KEYS.map(k => [k, new Array(N).fill(0)]));
  for (const c of components) {
    for (const k of STATUS_KEYS) {
      for (let i = 0; i < N; i++) statusLoss[k][i] = +(statusLoss[k][i] + c.statusLoss[k][i]).toFixed(2);
    }
  }

  const peakActual    = actual.reduce((m, v) => Math.max(m, v), 0);
  const peakPotential = potential.reduce((m, v) => Math.max(m, v), 0);
  const finalCum      = cum[cum.length - 1] ?? 0;

  return {
    ...stub,
    recipe: components[0].recipe,
    chestCount: 0,
    finalCum,
    peakActual: +peakActual.toFixed(2),
    peakPotential: +peakPotential.toFixed(2),
    peakBuffer: 0,
    peakBufferWithInv: 0,
    actual,
    potential,
    itemsByLoss,
    fluidsByLoss,
    itemLoss,
    fluidLoss,
    statusLoss,
    cum,
    buffer: new Array(N).fill(0),
    bufferWithInv: new Array(N).fill(0),
    bufferLimit: null,
    peakBufferLimit: 0,
    showBufferLimit: false,
    components: components.map(c => ({
      recipe: c.recipe,
      actual: c.actual,
      cum: c.cum,
      peakActual: +c.peakActual.toFixed(2),
      finalCum: c.finalCum,
    })),
  };
}
