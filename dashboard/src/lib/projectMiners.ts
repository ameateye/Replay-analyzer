// Render-time projection from the lifted miners dataset onto a per-period
// chart grid. Mirrors the build-time logic the old burner-phase-prep.mjs
// used: per-grid-period count of miners with `name` matching the filter
// AND `resources[0]` matching the resource, with timeBuilt / timeRemoved
// bracketing inclusion.

import type { Miner, MinersDataset } from './runDatasets';

export type MinerCountSlice = {
  count: number[];        // per-grid count of matching miners alive
  peak: number;            // peak count across the slice
  runningMin: number;      // total minutes count > 0 (period × samples / 3600)
};

// Build a per-grid count series for miners matching {name, resource}.
// `gridTicks` is the dense per-period sample grid (gridTicks[i] = i × period).
export function projectMinerCounts(
  miners: Miner[],
  opts: {
    name: string;
    resource: string;
    gridTicks: number[];
    period: number;
  },
): MinerCountSlice {
  const { name, resource, gridTicks, period } = opts;
  const N = gridTicks.length;
  const count = new Array(N).fill(0);
  for (const m of miners) {
    if (m.name !== name) continue;
    if (m.resources?.[0] !== resource) continue;
    const fromIdx = Math.max(0, Math.ceil(m.timeBuilt / period));
    const toIdx = m.timeRemoved != null
      ? Math.min(N, Math.ceil(m.timeRemoved / period))
      : N;
    for (let i = fromIdx; i < toIdx; i++) count[i]++;
  }
  let peak = 0;
  let active = 0;
  for (const v of count) {
    if (v > peak) peak = v;
    if (v > 0) active++;
  }
  const runningMin = +((active * period) / 3600).toFixed(2);
  return { count, peak, runningMin };
}

// Compute the burner-phase x-axis upper bound: latest burner-mining-drill
// removal + a fixed tail pad, capped by rocket launch (or burner-phase end
// when no burner was ever removed). Replicates the heuristic the old
// burner-phase-prep.mjs applied at build time.
export function burnerPhaseXMaxTick(
  miners: MinersDataset,
  opts: {
    rocketLaunchTick: number;
    burnerPhaseEndTick: number | null;
    postPhasePadTicks?: number;
  },
): number {
  const padTicks = opts.postPhasePadTicks ?? 5 * 60 * 60;
  let lastRemoved = 0;
  for (const m of miners.miners) {
    if (m.name !== 'burner-mining-drill') continue;
    if (m.timeRemoved != null && m.timeRemoved > lastRemoved) lastRemoved = m.timeRemoved;
  }
  const baseEnd = lastRemoved > 0 ? lastRemoved : (opts.burnerPhaseEndTick ?? opts.rocketLaunchTick);
  return Math.min(opts.rocketLaunchTick, baseEnd + padTicks);
}
