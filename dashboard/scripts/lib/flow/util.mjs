// util.mjs — shared pure helpers for the flow pipeline: tile geometry,
// footprints, interval intersection, id forms. Leaf module — imports nothing.

// The one tile-key format, for any module keying a map by tile.
export const tileKey = (x, y) => `${x},${y}`;

// Persisted segment ids are `S-<n>`; edge endpoints / segOf carry the raw
// numeric `<n>`. Normalise either form to the number.
export const numId = (id) => (typeof id === 'number' ? id : Number(String(id).replace(/^S-/, '')));

// ── tile geometry (cardinal dirs only, 16-way encoding; y points down) ──
export const DV   = { 0: { x: 0, y: -1 }, 4: { x: 1, y: 0 }, 8: { x: 0, y: 1 }, 12: { x: -1, y: 0 } }; // N E S W
export const OPP  = { 0: 8, 4: 12, 8: 0, 12: 4 };
export const LEFT = { 0: 12, 4: 0, 8: 4, 12: 8 };
export const floorTile  = (loc) => ({ x: Math.floor(loc.x), y: Math.floor(loc.y) });
export const tileCenter = (t) => ({ x: t.x + 0.5, y: t.y + 0.5 });        // the one +0.5 (1×1 entities centre here)
export const stepTile   = (t, dir, dist) => { const v = DV[dir] ?? { x: 0, y: 0 }; return { x: t.x + v.x * dist, y: t.y + v.y * dist }; };
export const minerDrop  = (loc, dir, fp) => { const v = DV[dir]; if (!v) return null; const r = fp / 2 + 0.5; return { x: Math.floor(loc.x + v.x * r), y: Math.floor(loc.y + v.y * r) }; };

export function footprintTiles(loc, size) {
  const half = size / 2;
  const minX = Math.floor(loc.x - half), maxX = Math.floor(loc.x + half - 1e-6);
  const minY = Math.floor(loc.y - half), maxY = Math.floor(loc.y + half - 1e-6);
  const tiles = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) tiles.push({ x, y });
  return tiles;
}

export function footprintBBox(loc, size) {
  const half = size / 2;
  return {
    minX: Math.floor(loc.x - half),
    minY: Math.floor(loc.y - half),
    maxX: Math.floor(loc.x + half - 1e-6),
    maxY: Math.floor(loc.y + half - 1e-6),
  };
}

// Half-open [tb, tr) intersection of N intervals; null tr ⇒ +∞. Returns [tb, tr] or null.
export function clip(...ivs) {
  const INF = Number.POSITIVE_INFINITY;
  let lo = -INF, hi = INF;
  for (const [a, b] of ivs) {
    if (a > lo) lo = a;
    const B = b == null ? INF : b;
    if (B < hi) hi = B;
  }
  return hi <= lo ? null : [lo, hi === INF ? null : hi];
}
