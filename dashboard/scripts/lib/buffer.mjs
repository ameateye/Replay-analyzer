// Sum of buffer contents for a given content (item or fluid), sample-and-hold
// across the master grid (snapshots only fire when non-empty, so the last-
// known value is held forward until the next sample).
// `type` is the buffer entity type — 'chest' for solid items, 'tank' for
// fluids. Tanks built later contribute zero before they exist, so series
// naturally start at 0 and rise as buffers come online.
//
// `capacityCfg` (optional) supplies game data for the capacity series:
//   { chestSlots: { name: slots }, stackSizes: { item: stack }, tankCapacity }
// When every contributing buffer can be sized, capacity[i] is the sum of
// per-buffer capacities for buffers that exist at tick i (timeBuilt <= t),
// and hasCapacity is true. If any buffer can't be sized (unknown chest /
// item), capacity is left null and hasCapacity is false — callers then skip
// the buffer-limit reference line.

// --- bufferAmounts shape helpers -------------------------------------------
// A buffer carries `contents`: { [item]: [[tick, amount], ...] }, one diff-
// compressed series per item type it held (sample-and-hold between samples).

// Normalize an old- or new-shape bufferAmounts file to the new `contents` shape.
// Old runs (schemaVersion 2) carried a single { content, amounts } per buffer;
// map that to { contents: { [content]: amounts } } so every consumer can assume
// `contents`. Idempotent — new-shape buffers pass through untouched. The multi-
// item detail old runs discarded is unrecoverable; they degrade to the one item
// the old collector resolved. Mutates and returns the file.
export function normalizeBufferFile(bufFile) {
  for (const b of bufFile?.buffers ?? []) {
    if (b.contents) continue;
    b.contents = b.content ? { [b.content]: b.amounts ?? [] } : {};
  }
  return bufFile;
}

// Item names a buffer held at any point.
export function heldItems(buffer) {
  return Object.keys(buffer.contents ?? {});
}

// The diff-compressed [time, amount] series for one item in a buffer ([] if absent).
export function seriesForItem(buffer, item) {
  return buffer.contents?.[item] ?? [];
}

// Sample-and-hold the amount of `item` in `buffer` at tick `t` (0 before the
// first sample). Series are assumed sorted ascending by time.
export function amountAt(buffer, item, t) {
  const s = seriesForItem(buffer, item);
  let v = 0;
  for (let i = 0; i < s.length && s[i][0] <= t; i++) v = s[i][1];
  return v;
}

// The single item a multi-item buffer most substantially held — the one whose
// series reaches the highest amount. A representative identity for places that
// still want one scalar item per buffer (e.g. cluster keys). For single-item
// buffers this is just that item; null for an empty buffer.
export function dominantItem(buffer) {
  let best = null;
  let bestPeak = -1;
  for (const [item, series] of Object.entries(buffer.contents ?? {})) {
    let peak = 0;
    for (const s of series) if (s[1] > peak) peak = s[1];
    if (peak > bestPeak) {
      bestPeak = peak;
      best = item;
    }
  }
  return best;
}

export function buildBufferSeries(bufFile, content, gridTicks, type = 'chest', capacityCfg = null) {
  normalizeBufferFile(bufFile); // accept old- or new-shape input
  const sources = bufFile.buffers.filter(b => b.type === type && b.contents[content]);
  if (sources.length === 0) {
    return {
      buffer: gridTicks.map(() => 0),
      capacity: null,
      peak: 0,
      peakCapacity: 0,
      hasCapacity: false,
      chestCount: 0,
    };
  }

  let perBufferCapacity = null;
  if (capacityCfg) {
    const caps = sources.map(b => {
      if (type === 'tank') return capacityCfg.tankCapacity ?? null;
      const slots = capacityCfg.chestSlots?.[b.name];
      const stack = capacityCfg.stackSizes?.[content];
      if (slots == null || stack == null) return null;
      return slots * stack;
    });
    if (caps.every(c => c != null && c > 0)) perBufferCapacity = caps;
  }

  const series = sources.map(c => c.contents[content].slice().sort((a, b) => a[0] - b[0]));
  const cursors = new Array(sources.length).fill(0);
  const lastVal = new Array(sources.length).fill(0);
  const buffer = new Array(gridTicks.length);
  const capacity = perBufferCapacity ? new Array(gridTicks.length) : null;
  let peak = 0;
  let peakCapacity = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const t = gridTicks[i];
    let total = 0;
    let cap = 0;
    for (let c = 0; c < sources.length; c++) {
      const samples = series[c];
      while (cursors[c] < samples.length && samples[cursors[c]][0] <= t) {
        lastVal[c] = samples[cursors[c]][1];
        cursors[c]++;
      }
      total += lastVal[c];
      if (perBufferCapacity && t >= sources[c].timeBuilt) cap += perBufferCapacity[c];
    }
    buffer[i] = total;
    if (capacity) capacity[i] = cap;
    if (total > peak) peak = total;
    if (cap > peakCapacity) peakCapacity = cap;
  }
  return {
    buffer,
    capacity,
    peak,
    peakCapacity,
    hasCapacity: !!perBufferCapacity,
    chestCount: sources.length,
  };
}

// Returns true when the buffer reaches >= APPROACH_THRESHOLD of capacity at
// any sampled tick. Used to gate the buffer-limit reference line: only show
// it when "approaches the limit" is actually true for this run.
const APPROACH_THRESHOLD = 0.5;
export function bufferApproachesCapacity(buffer, capacity) {
  if (!capacity) return false;
  for (let i = 0; i < buffer.length; i++) {
    if (capacity[i] > 0 && buffer[i] / capacity[i] >= APPROACH_THRESHOLD) return true;
  }
  return false;
}
