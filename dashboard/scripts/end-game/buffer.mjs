// Sum of buffer contents for a given content (item or fluid), sample-and-hold
// across the master grid (snapshots only fire when non-empty, so the last-
// known value is held forward until the next sample).
// `type` is the buffer entity type — 'chest' for solid items, 'tank' for
// fluids. Tanks built later contribute zero before they exist, so series
// naturally start at 0 and rise as buffers come online.

export function buildBufferSeries(bufFile, content, gridTicks, type = 'chest') {
  const sources = bufFile.buffers.filter(b => b.type === type && b.content === content);
  if (sources.length === 0) {
    return { buffer: gridTicks.map(() => 0), peak: 0, chestCount: 0 };
  }
  const series = sources.map(c => c.amounts.slice().sort((a, b) => a[0] - b[0]));
  const cursors = new Array(sources.length).fill(0);
  const lastVal = new Array(sources.length).fill(0);
  const buffer = new Array(gridTicks.length);
  let peak = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const t = gridTicks[i];
    let total = 0;
    for (let c = 0; c < sources.length; c++) {
      const samples = series[c];
      while (cursors[c] < samples.length && samples[cursors[c]][0] <= t) {
        lastVal[c] = samples[cursors[c]][1];
        cursors[c]++;
      }
      total += lastVal[c];
    }
    buffer[i] = total;
    if (total > peak) peak = total;
  }
  return { buffer, peak, chestCount: sources.length };
}
