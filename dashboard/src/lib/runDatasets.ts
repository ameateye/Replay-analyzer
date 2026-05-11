// Type declarations for the two datasets the per-run JSON now carries
// (see docs/concepts/per_run_data_redesign.md and the matching prep
// modules: dashboard/scripts/production-cube-prep.mjs and stocks-prep.mjs).
//
// JSON imports give nominal types per file, so `run.production` /
// `run.stocks` end up as huge structural unions inferred from one specific
// run's literal contents. We declare the proper types here and cast at the
// component boundary so projection helpers can be sound.

// ---------- Production cube ----------

// Per-(recipe × buildPhase) dense series. `items[i]` and `potential[i]` cover
// the period whose first tick is `firstTick + i × period`. Loss decomposition
// keys (status / ingredient name) may be absent entirely when zero across
// the slice; when present each series has the same length as `items`.
export type ProductionGroup = {
  recipe: string;
  buildPhase: string;
  firstTick: number;
  items: number[];
  potential: number[];
  statusLoss?: Record<string, number[]>;
  itemLoss?: Record<string, number[]>;
  fluidLoss?: Record<string, number[]>;
};

export type ProductionCube = {
  period: number;
  groups: ProductionGroup[];
};

// ---------- Stocks ----------

export type StocksSource = 'buffer' | 'inventory';

// Per-entity metadata for a `source: 'buffer'` group. Joined with
// game-data capacities (chestSlots × stackSizes for solids, tankCapacity
// for fluids) at render time to derive chestCount + per-tick bufferLimit.
// `timeBuilt` gates an entity's contribution to capacity to ticks after it
// was placed.
export type StocksBufferEntity = {
  name: string;
  timeBuilt: number;
};

// Change-event series with sample-and-hold semantics. `counts[i]` is the
// aggregated count effective from `ticks[i]` (inclusive) until `ticks[i+1]`
// (exclusive), or to the end of the run for the last entry. Render-time
// walkers reconstruct dense per-period series.
// `entities` is only emitted for `source: 'buffer'` groups.
export type StocksGroup = {
  item: string;
  source: StocksSource;
  ticks: number[];
  counts: number[];
  entities?: StocksBufferEntity[];
};

export type StocksDataset = {
  period: number;
  groups: StocksGroup[];
};

// ---------- Common ----------

// STATUS_KEYS mirror the data-collector enum and the build-time STATUS_KEYS
// in dashboard/scripts/lib/common.mjs. Each is a possible stall reason
// attributed in cube cells' `statusLoss` map.
export const STATUS_KEYS = [
  'no_ingredients',
  'no_fuel',
  'full_output',
  'low_power',
  'depleted',
  'unknown',
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

// ±12-period centred moving-average half-window — matches
// SMOOTH_HALF_WINDOW in dashboard/scripts/lib/production.mjs. Applied to
// rate / potential / loss series at projection time so chart lines visually
// match the pre-redesign rendering (which smoothed at build time).
export const SMOOTH_HALF_WINDOW = 12;
