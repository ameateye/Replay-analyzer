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

export function buildBufferSeries(bufFile, content, gridTicks, type = 'chest', capacityCfg = null) {
  const sources = bufFile.buffers.filter(b => b.type === type && b.content === content);
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

  const series = sources.map(c => c.amounts.slice().sort((a, b) => a[0] - b[0]));
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
