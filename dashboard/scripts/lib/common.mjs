// Shared helpers used by every prep module under dashboard/scripts/.
//
// Centralized here so the per-prep files can stay focused on the slice of
// derived data they own, instead of carrying duplicate copies of the
// status-key list, the per-period grid construction, the empty-row
// skeleton, and the path lookup for game-data/recipes.json.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DATA_DIR = path.resolve(SCRIPT_DIR, '..', '..', '..', 'game-data');

// Production-status enumeration matching the data collector's
// machine_status reasons. Stall losses bin into one of these slots and
// stack on the rate chart in this listed order.
export const STATUS_KEYS = [
  'no_ingredients',
  'no_fuel',
  'full_output',
  'low_power',
  'depleted',
  'unknown',
];

// Singleton load of game-data/recipes.json. Every prep needs at least one
// of: outputCount, craftTimes, capacity sizing, the per-phase display
// configs (endGameDisplay / oilPhaseDisplay / fullBuildDisplay /
// burnerPhaseDisplay / manualGatheringDisplay).
export const RECIPES_GAME_DATA = JSON.parse(
  fs.readFileSync(path.join(GAME_DATA_DIR, 'recipes.json'), 'utf8'),
);

// Convert a tick to game minutes (60 ticks/sec, 60 sec/min), rounded to
// the 4-decimal precision the dashboard JSON ships with.
export function tickToMin(tick) {
  return +(tick / 3600).toFixed(4);
}

// Build the per-period sample grid up to and including endTick. Returns
// the raw tick grid, its minute equivalents, and the length so callers
// can pre-allocate aligned series.
export function buildGridTicks(period, endTick) {
  const gridTicks = [];
  for (let t = 0; t <= endTick; t += period) gridTicks.push(t);
  return {
    gridTicks,
    minutes: gridTicks.map(tickToMin),
    N: gridTicks.length,
  };
}

// Recipe-shaped row with every series zeroed out. Phase preps that
// surface a single mode (cum-only, count-only, fluid-buffer-only) start
// from this skeleton, spread it, and override the fields they actually
// populate. Keeps the Recipe type stable across all callers without each
// one re-listing the 18+ fields.
export function emptyRecipeRow(N) {
  const zeros = () => new Array(N).fill(0);
  return {
    chestCount: 0,
    finalCum: 0,
    peakActual: 0,
    peakPotential: 0,
    peakBuffer: 0,
    peakBufferWithInv: 0,
    actual: zeros(),
    potential: zeros(),
    itemsByLoss: [],
    fluidsByLoss: [],
    itemLoss: {},
    fluidLoss: {},
    statusLoss: Object.fromEntries(STATUS_KEYS.map(k => [k, zeros()])),
    cum: zeros(),
    buffer: zeros(),
    bufferWithInv: zeros(),
    bufferLimit: null,
    peakBufferLimit: 0,
    showBufferLimit: false,
  };
}
