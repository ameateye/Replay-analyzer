// Project the (item × source) stocks groups into per-period series for a
// single item, sample-and-holding across grid ticks. Mirrors what the
// build-time `buildBufferSeries` / `buildPlayerInventorySeries` produced
// at the same time resolution.
//
// All output arrays are aligned to `gridTicks`: arr[i] is the value at
// `gridTicks[i]`. `gridTicks` is expected to be the same period-aligned
// grid the production projection uses.

import type { StocksDataset, StocksGroup, StocksSource } from './runDatasets';

// Game-data needed to derive per-tick buffer capacity from the entity list.
// Solids: capacity[entity] = chestSlots[entity.name] * stackSizes[item].
// Fluids: capacity[entity] = tankCapacity. Discriminated at render time by
// checking stackSizes membership (solids have a stack size; fluids don't).
export type CapacityCfg = {
  chestSlots: Record<string, number>;
  stackSizes: Record<string, number>;
  tankCapacity: number;
};

export type StocksSlice = {
  buffer: number[];
  inventory: number[];
  bufferWithInv: number[];
  peakBuffer: number;
  peakInventory: number;
  peakBufferWithInv: number;
  // chestCount = number of buffer entities holding `item`, regardless of
  // timeBuilt — matches the legacy "X chests + inv" / "X tanks" headline.
  chestCount: number;
  // capacity[i] = sum of per-entity capacities for entities with
  // timeBuilt <= gridTicks[i]. null when capacityCfg is omitted, or when
  // any contributing entity can't be sized (unknown chest entity, or
  // stack-size missing for the item).
  capacity: number[] | null;
  peakCapacity: number;
};

export type ProjectStocksOpts = {
  item: string;
  // If provided, restrict to listed sources. null / omitted = include both.
  sources?: ReadonlySet<StocksSource> | null;
  gridTicks: number[];
  // Optional game-data capacities. When omitted, capacity/peakCapacity
  // are null/0 and chestCount counts entities regardless.
  capacityCfg?: CapacityCfg | null;
};

export function projectStocks(
  stocks: StocksDataset,
  opts: ProjectStocksOpts,
): StocksSlice {
  const { item, sources, gridTicks, capacityCfg } = opts;
  const N = gridTicks.length;

  const buffer = new Array(N).fill(0);
  const inventory = new Array(N).fill(0);

  // Buffer-entity bookkeeping for chestCount + capacity derivation.
  const bufferEntities: Array<{ name: string; timeBuilt: number }> = [];
  const includeBuffer = !sources || sources.has('buffer');

  for (const group of stocks.groups) {
    if (group.item !== item) continue;
    if (sources && !sources.has(group.source)) continue;
    const target = group.source === 'buffer' ? buffer : inventory;
    addSampleAndHold(target, group, gridTicks);
    if (group.source === 'buffer' && group.entities) {
      for (const e of group.entities) bufferEntities.push(e);
    }
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

  const chestCount = includeBuffer ? bufferEntities.length : 0;

  // Capacity series: per-entity capacity from game-data, gated by timeBuilt.
  // Bail to null if any contributing entity can't be sized — the chart
  // suppresses the buffer-limit line in that case (matches legacy behavior).
  let capacity: number[] | null = null;
  let peakCapacity = 0;
  if (capacityCfg && includeBuffer && bufferEntities.length > 0) {
    const isFluid = capacityCfg.stackSizes[item] == null;
    const stack = capacityCfg.stackSizes[item];
    const tank = capacityCfg.tankCapacity;
    const perEntity: number[] = [];
    let allSized = true;
    for (const e of bufferEntities) {
      if (isFluid) {
        if (tank > 0) perEntity.push(tank);
        else { allSized = false; break; }
      } else {
        const slots = capacityCfg.chestSlots[e.name];
        if (slots != null && stack != null) perEntity.push(slots * stack);
        else { allSized = false; break; }
      }
    }
    if (allSized) {
      const cap = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        const t = gridTicks[i];
        let sum = 0;
        for (let e = 0; e < bufferEntities.length; e++) {
          if (bufferEntities[e].timeBuilt <= t) sum += perEntity[e];
        }
        cap[i] = sum;
        if (sum > peakCapacity) peakCapacity = sum;
      }
      capacity = cap;
    }
  }

  return {
    buffer, inventory, bufferWithInv,
    peakBuffer, peakInventory, peakBufferWithInv,
    chestCount, capacity, peakCapacity,
  };
}

// Returns true when the buffer reaches >= 50% of capacity at any sampled
// tick. Used to gate the buffer-limit reference line — only show it when
// "approaches the limit" is actually true. Mirrors the legacy
// bufferApproachesCapacity threshold in dashboard/scripts/lib/buffer.mjs.
const APPROACH_THRESHOLD = 0.5;
export function bufferApproachesCapacity(buffer: number[], capacity: number[] | null): boolean {
  if (!capacity) return false;
  for (let i = 0; i < buffer.length; i++) {
    if (capacity[i] > 0 && buffer[i] / capacity[i] >= APPROACH_THRESHOLD) return true;
  }
  return false;
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
