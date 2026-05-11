// Stocks dataset: per-(item × source) change-event series. Unifies
// bufferAmounts.json (chests + tanks) and playerInventory.json under one
// schema at the data collector's native period (~5s) — the same time
// resolution the existing buffer charts use.
//
// Shape:
//   {
//     period: 300,
//     groups: [
//       {
//         item:     "iron-plate",
//         source:   "buffer" | "inventory",
//         ticks:    [3600, 3900, 4200, ...],  // aligned-period change ticks
//         counts:   [120,  140,  165,  ...],  // count effective from `ticks[i]`
//         entities: [{ name: "steel-chest", timeBuilt: 12345 }, ...]
//                   // only on `source: "buffer"` groups; needed at render
//                   // time to derive chestCount / bufferLimit by joining
//                   // with game-data capacities (chestSlots × stackSizes
//                   // for solids, tankCapacity for fluids).
//       },
//       ...
//     ]
//   }
//
// Sample-and-hold semantics: counts[i] is the aggregated count from
// ticks[i] (inclusive) until ticks[i+1] (exclusive), or to the end of the
// run for the last entry. Render-time walkers reconstruct a dense series
// by holding the last emitted value forward across grid ticks until the
// next change event.
//
// We aggregate first (sum across buffer entities for `buffer`, sum across
// players for `inventory`), then emit only when the aggregated total
// changes — that's where the compression vs raw comes from, especially for
// player inventory where most items don't tick every period. Leading
// zero-runs are dropped (sample-and-hold defaults to 0); returns-to-zero
// later in the run ARE emitted so the walker can drain correctly.

import * as fs from 'fs';
import * as path from 'path';

export function buildStocks(runDir, rocketLaunchTick) {
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const period = buf.period ?? 300;
  const lastTick = Math.floor(rocketLaunchTick / period) * period;
  const grid = [];
  for (let t = 0; t <= lastTick; t += period) grid.push(t);

  const groups = [];

  // --- Buffers: sample-and-hold across entities, aggregated per item ---
  const buffersByItem = new Map();
  for (const entity of buf.buffers ?? []) {
    if (!entity.content) continue;
    const arr = buffersByItem.get(entity.content) ?? [];
    arr.push(entity);
    buffersByItem.set(entity.content, arr);
  }
  for (const [item, buffers] of buffersByItem) {
    const sampleSeries = buffers.map(entity => (entity.amounts ?? []).slice().sort((a, b) => a[0] - b[0]));
    const cursors = new Array(buffers.length).fill(0);
    const lastVal = new Array(buffers.length).fill(0);
    const ticks = [], counts = [];
    let prevEmitted = null;
    for (const t of grid) {
      let total = 0;
      for (let c = 0; c < buffers.length; c++) {
        const samples = sampleSeries[c];
        while (cursors[c] < samples.length && samples[cursors[c]][0] <= t) {
          lastVal[c] = samples[cursors[c]][1];
          cursors[c]++;
        }
        total += lastVal[c];
      }
      const rounded = Math.round(total);
      if (rounded !== prevEmitted) {
        ticks.push(t);
        counts.push(rounded);
        prevEmitted = rounded;
      }
    }
    while (ticks.length && counts[0] === 0) { ticks.shift(); counts.shift(); }
    if (ticks.length) {
      // Per-entity metadata for render-time capacity / chestCount. Order
      // doesn't matter — render-time derivation is order-independent.
      const entities = buffers.map(b => ({ name: b.name, timeBuilt: b.timeBuilt }));
      groups.push({ item, source: 'buffer', ticks, counts, entities });
    }
  }

  // --- Player inventory ---
  const invPeriod = inv.period ?? 60;
  const players = Object.values(inv.players ?? {});
  if (players.length > 0) {
    const snapsPerPlayer = players.map(p => p.inventory ?? []);
    const items = new Set();
    for (const snaps of snapsPerPlayer) {
      for (const s of snaps) {
        if (!s) continue;
        for (const k of Object.keys(s)) items.add(k);
      }
    }
    for (const item of items) {
      const ticks = [], counts = [];
      let prevEmitted = null;
      for (const t of grid) {
        const targetIdx = Math.floor(t / invPeriod);
        let total = 0;
        for (let p = 0; p < players.length; p++) {
          const snaps = snapsPerPlayer[p];
          if (snaps.length === 0) continue;
          const idx = Math.min(targetIdx, snaps.length - 1);
          const snap = snaps[idx];
          if (!snap) continue;
          total += snap[item] ?? 0;
        }
        if (total !== prevEmitted) {
          ticks.push(t);
          counts.push(total);
          prevEmitted = total;
        }
      }
      while (ticks.length && counts[0] === 0) { ticks.shift(); counts.shift(); }
      if (ticks.length) groups.push({ item, source: 'inventory', ticks, counts });
    }
  }

  groups.sort((a, b) =>
    a.item.localeCompare(b.item)
    || a.source.localeCompare(b.source),
  );
  return { period, groups };
}
