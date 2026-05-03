// Total of a given item across all players' inventory snapshots, sampled at
// each grid tick. Each player's inventory is a periodic array; we pick the
// snapshot whose period covers the requested tick (clamped to last available).

export function buildPlayerInventorySeries(invFile, item, gridTicks) {
  const period = invFile.period;
  const players = Object.values(invFile.players ?? {});
  if (players.length === 0) {
    return { inv: gridTicks.map(() => 0), peak: 0 };
  }
  const inv = new Array(gridTicks.length);
  let peak = 0;
  for (let i = 0; i < gridTicks.length; i++) {
    const sampleIdx = Math.min(
      Math.floor(gridTicks[i] / period),
      ...players.map(p => (p.inventory?.length ?? 1) - 1),
    );
    let total = 0;
    for (const p of players) {
      const snap = p.inventory?.[sampleIdx];
      if (snap) total += snap[item] ?? 0;
    }
    inv[i] = total;
    if (total > peak) peak = total;
  }
  return { inv, peak };
}
