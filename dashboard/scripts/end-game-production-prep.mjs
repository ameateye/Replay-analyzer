// End-game production wrapper: combines per-recipe production + buffer +
// player-inventory series into the structure consumed by the dashboard's
// end-game widgets, on a shared per-period grid clipped to rocket launch.
//
// Per-recipe metadata (output count, display label/color, which recipes to
// surface) lives in game-data/recipes.json so it can be reused by the React
// app and across runs.
//
// Inputs:
//   <runDir>/machineProduction.json
//   <runDir>/bufferAmounts.json
//   <runDir>/playerInventory.json
//   game-data/recipes.json (resolved relative to this file)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildProductionSeries } from './end-game/production.mjs';
import { buildBufferSeries } from './end-game/buffer.mjs';
import { buildPlayerInventorySeries } from './end-game/inventory.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = path.resolve(SCRIPT_DIR, '..', '..', 'game-data', 'recipes.json');
const RECIPES_GAME_DATA = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));

// Builds a single Recipe-shaped row used by ProductionRow on the React side.
// The optional `machineFilter` lets callers restrict production to a subset
// of machines (e.g. only the copper smelters built during the Mixed phase).
export function buildRecipeRow(mp, buf, inv, recipe, gridTicks, machineFilter = null) {
  const outputCount = RECIPES_GAME_DATA.outputCount[recipe] ?? 1;
  const craftTime = RECIPES_GAME_DATA.craftTimes?.[recipe] ?? null;
  const mpForRate = machineFilter
    ? { ...mp, machines: mp.machines.filter(machineFilter) }
    : mp;
  const rate = buildProductionSeries(mpForRate, recipe, gridTicks, outputCount, craftTime);
  const buffer = buildBufferSeries(buf, recipe, gridTicks);
  const player = buildPlayerInventorySeries(inv, recipe, gridTicks);
  const bufferWithInv = buffer.buffer.map((b, i) => b + player.inv[i]);
  const peakBufferWithInv = bufferWithInv.reduce((m, v) => Math.max(m, v), 0);

  return {
    recipe,
    chestCount: buffer.chestCount,
    finalCum: rate.finalCum,
    peakActual: rate.peakActual,
    peakPotential: rate.peakPotential,
    peakBuffer: Math.round(buffer.peak),
    peakBufferWithInv: Math.round(peakBufferWithInv),

    actual: rate.actual,
    potential: rate.potential,
    itemsByLoss: rate.itemsByLoss,
    fluidsByLoss: rate.fluidsByLoss,
    itemLoss: rate.itemLoss,
    fluidLoss: rate.fluidLoss,
    statusLoss: rate.statusLoss,

    cum: rate.cum,
    buffer: buffer.buffer.map(v => Math.round(v)),
    bufferWithInv: bufferWithInv.map(v => Math.round(v)),
  };
}

export function buildEndGameProduction(runDir, rocketLaunchTick) {
  const mp = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const gridTicks = [];
  for (let t = 0; t <= rocketLaunchTick; t += mp.period) gridTicks.push(t);
  const minutes = gridTicks.map(t => +(t / 3600).toFixed(4));

  const recipes = RECIPES_GAME_DATA.endGameDisplay.map(({ recipe }) =>
    buildRecipeRow(mp, buf, inv, recipe, gridTicks),
  );

  return { durationMin: +(rocketLaunchTick / 3600).toFixed(4), minutes, recipes };
}
