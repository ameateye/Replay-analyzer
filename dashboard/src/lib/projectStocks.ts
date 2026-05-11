// Project the (item × source) stocks groups into per-period series for a
// single item, sample-and-holding across grid ticks. Mirrors what the
// build-time `buildBufferSeries` / `buildPlayerInventorySeries` produced
// at the same time resolution.
//
// All output arrays are aligned to `gridTicks`: arr[i] is the value at
// `gridTicks[i]`. `gridTicks` is expected to be the same period-aligned
// grid the production projection uses.

import type { StocksDataset, StocksGroup, StocksSource } from './runDatasets';

export type StocksSlice = {
  buffer: number[];
  inventory: number[];
  bufferWithInv: number[];
  peakBuffer: number;
  peakInventory: number;
  peakBufferWithInv: number;
};

export type ProjectStocksOpts = {
  item: string;
  // If provided, restrict to listed sources. null / omitted = include both.
  sources?: ReadonlySet<StocksSource> | null;
  gridTicks: number[];
};

export function projectStocks(
  stocks: StocksDataset,
  opts: ProjectStocksOpts,
): StocksSlice {
  const { item, sources, gridTicks } = opts;
  const N = gridTicks.length;

  const buffer = new Array(N).fill(0);
  const inventory = new Array(N).fill(0);

  for (const group of stocks.groups) {
    if (group.item !== item) continue;
    if (sources && !sources.has(group.source)) continue;
    const target = group.source === 'buffer' ? buffer : inventory;
    addSampleAndHold(target, group, gridTicks);
  }

  const bufferWithInv = new Array(N);
  let peakBuffer = 0, peakInventory = 0, peakBufferWithInv = 0;
  for (let i = 0; i < N; i++) {
    const bwi = buffer[i] + inventory[i];
    bufferWithInv[i] = bwi;
    if (buffer[i] > peakBuffer) peakBuffer = buffer[i];
    if (inventory[i] > peakInventory) peakInventory = inventory[i];
    if (bwi > peakBufferWithInv) peakBufferWithInv = bwi;
  }

  return { buffer, inventory, bufferWithInv, peakBuffer, peakInventory, peakBufferWithInv };
}

// Walk a change-event series and sample-and-hold its values across the
// grid into `target` (adding — multiple groups may contribute to the same
// target, e.g. two `inventory` groups for the same item).
function addSampleAndHold(target: number[], group: StocksGroup, gridTicks: number[]): void {
  const { ticks, counts } = group;
  if (ticks.length === 0) return;
  let cursor = 0;
  let held = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const t = gridTicks[i];
    while (cursor < ticks.length && ticks[cursor] <= t) {
      held = counts[cursor];
      cursor++;
    }
    target[i] += held;
  }
}
