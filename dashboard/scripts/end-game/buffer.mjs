// Sum of buffer-chest contents for a given item, sample-and-hold across the
// master grid (chest snapshots only fire when non-empty, so the last-known
// value is held forward until the next sample).

export function buildBufferSeries(bufFile, item, gridTicks) {
  const chests = bufFile.buffers.filter(b => b.type === 'chest' && b.content === item);
  if (chests.length === 0) {
    return { buffer: gridTicks.map(() => 0), peak: 0, chestCount: 0 };
  }
  const series = chests.map(c => c.amounts.slice().sort((a, b) => a[0] - b[0]));
  const cursors = new Array(chests.length).fill(0);
  const lastVal = new Array(chests.length).fill(0);
  const buffer = new Array(gridTicks.length);
  let peak = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const t = gridTicks[i];
    let total = 0;
    for (let c = 0; c < chests.length; c++) {
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
  return { buffer, peak, chestCount: chests.length };
}
