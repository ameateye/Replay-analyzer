// Canonical Recipe-shaped row builder, shared across every phase prep that
// surfaces the production + buffer + player-inventory triplet on a common
// grid: end-game, oil-phase, full-build, and mixed-segment all call this
// with their own machine subset / recipe / grid / optional filter.
//
// Phase preps that surface only one of those signals (cum-only, count-only,
// fluid-buffer-only) build their row from `emptyRecipeRow` in lib/common.mjs
// instead — same shape, no production / buffer joining work.

import { RECIPES_GAME_DATA } from './common.mjs';
import { buildProductionSeries } from './production.mjs';
import { buildBufferSeries, bufferApproachesCapacity } from './buffer.mjs';
import { buildPlayerInventorySeries } from './inventory.mjs';

// Capacity sizing for buffers; passed into buildBufferSeries to enable the
// per-buffer capacity reference line. Tanks have a fixed cap; chests are
// slots × per-item stack size.
export const CAPACITY_CFG = {
  chestSlots: RECIPES_GAME_DATA.chestSlots ?? {},
  stackSizes: RECIPES_GAME_DATA.stackSizes ?? {},
  tankCapacity: RECIPES_GAME_DATA.tankCapacity ?? 25000,
};

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
  const buffer = buildBufferSeries(buf, recipe, gridTicks, 'chest', CAPACITY_CFG);
  const player = buildPlayerInventorySeries(inv, recipe, gridTicks);
  const bufferWithInv = buffer.buffer.map((b, i) => b + player.inv[i]);
  const peakBufferWithInv = bufferWithInv.reduce((m, v) => Math.max(m, v), 0);
  const showBufferLimit = bufferApproachesCapacity(buffer.buffer, buffer.capacity);

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
    bufferLimit: showBufferLimit ? buffer.capacity.map(v => Math.round(v)) : null,
    peakBufferLimit: showBufferLimit ? Math.round(buffer.peakCapacity) : 0,
    showBufferLimit,
  };
}
