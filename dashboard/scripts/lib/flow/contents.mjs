// contents.mjs — belt-lane item contents as a temporal interval ledger.
//
// Post-pass over the finalized flow graph (beltSegments + edges). It does NOT touch
// the topology; it layers item identity onto it. Edges arrive item-aware from
// edges.mjs:
//   - owned drain/miner edges carry `itemWindows` — what an inserter/drill drops
//     onto a belt, over which sub-intervals;
//   - belt↔belt edges carry `contentSide` — which consumer lane a cross-segment
//     hand-off feeds ('both' for a collinear forward merge, else 'left'/'right').
//
// SEED each segment's lanes from the drop windows, then PROPAGATE across belt↔belt
// edges to a monotone fixed point — folding a splitter source's filter/priority
// routing in per state-window — and write seg.contents.
//
// contents.{left,right}.items = [{ item, tb, tr? }] — one continuous presence
// interval per entry (tr omitted ⇒ still present at run end). Consumers slice by
// tick. Intervals are half-open [tb, tr); null tr encodes +∞.
//
// Convergence: the item universe is finite and every propagation only unions in
// sub-intervals contained in an edge/segment lifetime, so the worklist terminates
// even through belt cycles.

// Persisted segments are id'd `S-<n>`; edge endpoint `segs` store the raw numeric
// `<n>` (state.segOf values). Lanes + the transfer graph key on the numeric id.
const numId = (id) => (typeof id === 'number' ? id : Number(String(id).replace(/^S-/, '')));

export function attachContents(beltSegments, edges, _durationTick) {
  const segById = new Map();   // numeric id → persisted segment record
  const lanes   = new Map();   // numeric id → { left: Map<item, iv[]>, right: Map<item, iv[]> }
  for (const s of beltSegments) {
    const nid = numId(s.id);
    segById.set(nid, s);
    lanes.set(nid, { left: new Map(), right: new Map() });
  }

  seedFromEdges(edges, lanes);
  const { incoming, outgoing } = buildTransfers(edges, segById);
  propagate(lanes, segById, incoming, outgoing);

  for (const s of beltSegments) {
    const l = lanes.get(numId(s.id));
    s.contents = {
      left:  { items: intervalsToArray(l.left)  },
      right: { items: intervalsToArray(l.right) },
    };
  }
}

// ── seeding ──────────────────────────────────────────────────────
// Owned drain/miner edges deposit their itemWindows onto the DROP belt (e.to),
// clipped against the belt's segment-occupancy timeline (e.to.segs) on the resolved
// drop lane (e.to.side). A belt that changes segment mid-drop seeds each segment it
// occupied for its own sub-window.
function seedFromEdges(edges, lanes) {
  for (const e of edges) {
    if (!e.itemWindows || !e.to?.segs) continue;
    const side = e.to.side;
    if (side !== 'left' && side !== 'right') continue;
    for (const w of e.itemWindows) {
      for (const sv of e.to.segs) {
        const iv = clip([w.tb, w.tr ?? null], [sv.tb, sv.tr ?? null]);
        if (!iv) continue;
        const lane = lanes.get(sv.seg);
        if (lane) insertInterval(lane[side], w.item, iv[0], iv[1]);
      }
    }
  }
}

// ── propagation graph ────────────────────────────────────────────
// Every edge carrying `contentSide` is a content-propagation edge: belt↔belt
// cross-segment hand-offs AND inserter belt→belt transfers (an inserter ferrying
// one belt's lanes onto another). Each becomes per-window transfers: source segment
// → target segment over every overlap of the two endpoints' segment timelines and
// the edge lifetime, tagged with the lane mode, the CONSUMER tile (for splitter
// output-side resolution — a splitter's own tile is shared by both outputs, so only
// the consumer's position reveals which output half this edge leaves), and an
// optional inserter filter (which items move).
function buildTransfers(edges, segById) {
  const incoming = new Map();   // tgtSeg → [{ src, side, tb, tr, outTile, filter }]
  const outgoing = new Map();   // srcSeg → Set<tgtSeg>
  for (const e of edges) {
    if (!e.contentSide || !e.from?.segs || !e.to?.segs) continue;
    const baseSide = e.contentSide;
    const life = [e.tb, e.tr ?? null];
    const outTile  = e.to.tile   ? { x: e.to.tile.x,   y: e.to.tile.y }   : null;
    const fromTile = e.from.tile ? { x: e.from.tile.x, y: e.from.tile.y } : null;
    const filter = e.transferFilter ?? null;
    for (const fv of e.from.segs) for (const tv of e.to.segs) {
      if (fv.seg === tv.seg) continue;
      const iv = clip(life, [fv.tb, fv.tr ?? null], [tv.tb, tv.tr ?? null]);
      if (!iv) continue;
      // Side preserved INTO a splitter: a feeder lands on the input half it sits
      // behind (left input → splitter left lane), not the perpendicular near-lane.
      // The half is the feeder tile vs the splitter's tileLeft/tileRight (state at
      // the window start — input half only moves if the splitter is rotated).
      let side = baseSide;
      const tgt = segById.get(tv.seg);
      if (tgt?.kind === 'splitter') {
        const half = splitterOutputSide(splitterStateAt(tgt, iv[0]), fromTile);
        if (half) side = half;
      }
      if (!incoming.has(tv.seg)) incoming.set(tv.seg, []);
      incoming.get(tv.seg).push({ src: fv.seg, side, tb: iv[0], tr: iv[1], outTile, filter });
      if (!outgoing.has(fv.seg)) outgoing.set(fv.seg, new Set());
      outgoing.get(fv.seg).add(tv.seg);
    }
  }
  return { incoming, outgoing };
}

function propagate(lanes, segById, incoming, outgoing) {
  const dirty = new Set(lanes.keys());
  while (dirty.size > 0) {
    const sid = dirty.values().next().value;
    dirty.delete(sid);
    const target = lanes.get(sid);
    const list = incoming.get(sid);
    if (!target || !list) continue;
    let changed = false;
    for (const { src, side, tb, tr, outTile, filter } of list) {
      const source = lanes.get(src);
      if (!source) continue;
      for (const win of splitterWindows(segById.get(src), source, outTile, tb, tr)) {
        const pool = filter ? filterPool(win.pool, filter) : win.pool;
        if (side === 'both') {
          if (propagateIntervals(target.left,  pool.left,  win.tb, win.tr)) changed = true;
          if (propagateIntervals(target.right, pool.right, win.tb, win.tr)) changed = true;
        } else {
          // sideload / inserter transfer: both source lanes collapse onto the one target lane.
          if (propagateIntervals(target[side], pool.left,  win.tb, win.tr)) changed = true;
          if (propagateIntervals(target[side], pool.right, win.tb, win.tr)) changed = true;
        }
      }
    }
    if (changed) { const ds = outgoing.get(sid); if (ds) for (const t of ds) dirty.add(t); }
  }
}

// ── splitter routing ─────────────────────────────────────────────
// A splitter source carries a state TIMELINE (filter / priority / orientation can
// change mid-run). Split the transfer window at the splitter's state boundaries and
// apply the state active in each sub-window, so contents reflect historical routing.
// Non-splitter sources resolve to one window = the transfer, pool passed through.
function splitterWindows(srcSeg, source, outTile, tb, tr) {
  const states = srcSeg?.splitterStates;
  if (!srcSeg || srcSeg.kind !== 'splitter' || !states || states.length === 0) {
    return [{ tb, tr, pool: source }];
  }
  const out = [];
  for (let i = 0; i < states.length; i++) {
    const wtb = states[i].tick;
    const wtr = i + 1 < states.length ? states[i + 1].tick : null;
    const a = wtb > tb ? wtb : tb;
    const b = clipMin(wtr, tr);
    if (b !== null && b <= a) continue;
    out.push({ tb: a, tr: b, pool: applySplitterFilterPerLane(source, states[i], outTile) });
  }
  return out;
}

// Output routing for ONE splitter state. No filter → output = splitter content (pass
// both lanes through). With a filter, route by ITEM over the splitter's COMBINED
// content (a splitter mixes its inputs, so it isn't a per-lane decision): the
// priority output carries ONLY the filter item (when present); the other output
// carries everything EXCEPT it. Output side = the consumer tile vs this state's
// tileLeft / tileRight (they move when the splitter is rotated).
function applySplitterFilterPerLane(pool, st, outTile) {
  const filter = st.filter;
  if (!filter) return pool;
  const outSide = splitterOutputSide(st, outTile);
  if (!outSide) return pool;
  const combined = combineLanes(pool);
  if (st.outputPriority === outSide) {
    const only = combined.has(filter) ? new Map([[filter, combined.get(filter)]]) : new Map();
    return { left: only, right: new Map(only) };
  }
  combined.delete(filter);
  return { left: combined, right: new Map(combined) };
}

// Union both lanes of a pool into one item → intervals map (intervals concatenated;
// insertInterval merges any overlap on deposit). Source arrays are not mutated.
function combineLanes(pool) {
  const out = new Map();
  for (const m of [pool.left, pool.right]) {
    for (const [item, ivs] of m) {
      const cur = out.get(item);
      out.set(item, cur ? cur.concat(ivs) : ivs.slice());
    }
  }
  return out;
}

// The splitter state in effect at `tick` (last state whose tick ≤ tick).
function splitterStateAt(seg, tick) {
  const states = seg?.splitterStates;
  if (!states || states.length === 0) return null;
  let s = states[0];
  for (const st of states) { if (st.tick <= tick) s = st; else break; }
  return s;
}

// Restrict a source pool to the items an inserter filter will move (whitelist keeps
// listed items; blacklist drops them). Used for inserter belt→belt transfers.
function filterPool(pool, { mode, items }) {
  const set = new Set(items);
  const keep = (m) => {
    const out = new Map();
    for (const [item, iv] of m) if ((mode === 'blacklist') !== set.has(item)) out.set(item, iv);
    return out;
  };
  return { left: keep(pool.left), right: keep(pool.right) };
}

// Which output half a consumer leaves by, from its tile. The two output halves
// (tileLeft / tileRight) differ only on the axis ⟂ to the splitter's facing — x for
// a N/S splitter, y for E/W. The consumer sits in front of (straight) or beside
// (sideload) one half, so the nearer half on that axis is the output side.
function splitterOutputSide(st, outTile) {
  if (!outTile || !st.tileLeft || !st.tileRight) return null;
  const horiz = st.direction === 0 || st.direction === 8;   // N or S → halves differ in x
  const c = horiz ? outTile.x : outTile.y;
  const l = horiz ? st.tileLeft.x  : st.tileLeft.y;
  const r = horiz ? st.tileRight.x : st.tileRight.y;
  return Math.abs(c - l) <= Math.abs(c - r) ? 'left' : 'right';
}

// ── interval algebra (half-open [tb, tr); null tr ⇒ +∞) ──────────
// Touching intervals (tr === nextTb) merge: one continuous presence, no gap.
function insertInterval(laneMap, item, tb, tr) {
  let intervals = laneMap.get(item);
  if (!intervals) { intervals = []; laneMap.set(item, intervals); }
  const INF = Number.POSITIVE_INFINITY;
  const newTr = tr === null ? INF : tr;
  if (newTr <= tb) return false;
  const before = intervalsKey(intervals);
  let lo = tb, hi = newTr;
  const kept = [];
  for (const [a, b] of intervals) {
    const B = b === null ? INF : b;
    if (B < lo || a > hi) kept.push([a, b]);
    else { if (a < lo) lo = a; if (B > hi) hi = B; }
  }
  kept.push([lo, hi === INF ? null : hi]);
  kept.sort((x, y) => x[0] - y[0]);
  intervals.length = 0;
  intervals.push(...kept);
  return intervalsKey(intervals) !== before;
}

function intervalsKey(intervals) {
  return intervals.map(([a, b]) => `${a}:${b === null ? 'I' : b}`).join('|');
}

// Intersect every (item, srcInterval) in sourceMap with [tb, tr) and union the
// survivor into targetMap. Returns true iff the union grew.
function propagateIntervals(targetMap, sourceMap, tb, tr) {
  let changed = false;
  const INF = Number.POSITIVE_INFINITY;
  const ETR = tr === null ? INF : tr;
  for (const [item, srcIntervals] of sourceMap) {
    for (const [stb, str] of srcIntervals) {
      const STR = str === null ? INF : str;
      const a = stb > tb ? stb : tb;
      const b = STR < ETR ? STR : ETR;
      if (b <= a) continue;
      if (insertInterval(targetMap, item, a, b === INF ? null : b)) changed = true;
    }
  }
  return changed;
}

function intervalsToArray(laneMap) {
  const out = [];
  for (const item of [...laneMap.keys()].sort()) {
    for (const [tb, tr] of laneMap.get(item)) {
      const entry = { item, tb };
      if (tr !== null) entry.tr = tr;
      out.push(entry);
    }
  }
  return out;
}

// Half-open intersection of N intervals; null tr ⇒ +∞. Returns [tb, tr] or null.
function clip(...ivs) {
  const INF = Number.POSITIVE_INFINITY;
  let lo = -INF, hi = INF;
  for (const [a, b] of ivs) {
    if (a > lo) lo = a;
    const B = b == null ? INF : b;
    if (B < hi) hi = B;
  }
  return hi <= lo ? null : [lo, hi === INF ? null : hi];
}

// Upper-bound intersection where null ⇒ +∞.
function clipMin(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
