// contents.mjs — belt-lane AND buffer item contents as a temporal interval ledger.
//
// Post-pass over the finalized flow graph (beltSegments + edges + buffers). It does
// NOT touch the topology; it layers item identity onto it. edges.mjs has already
// resolved each edge to one of two item shapes, on a source→target model:
//   - STATIC source (machine recipe / miner resource): `itemWindows` (the items) +
//     `dst` ({ belt: side } or { buffer: unit }) — a one-shot seed of the target;
//   - DYNAMIC source (a belt's lanes / a buffer's outputs): `src` ('belt' → segments
//     e.from.segs, or { buffer: unit }) + `dst` (+ inserter `transferFilter`) — a
//     propagation edge whose item is whatever the source node carries.
// A belt's lane is { left, right }; a buffer is a single pool — both are nodes here.
//
// SEED belt lanes / buffer pools from the static `itemWindows`, and each buffer's
// stock from its periodic amount samples; then PROPAGATE the dynamic edges (belt↔belt,
// belt→buffer, buffer→belt, buffer→buffer) to a monotone fixed point — folding a
// splitter source's filter/priority routing in per state-window — and write
// seg.contents + return the buffer ledger.
//
// A BUFFER is "what can come out of it": its available stock (sample-and-hold per
// held item over that item's `contents` series — a chest/tank can hold several item
// types, each seeded into the stock ledger) UNION its inputs (items an inserter/drill
// drops in). The union catches a buffer that is flowing — filled and emptied between
// samples, so stock reads ~0 yet an item is actively passing through.
//
// contents.{left,right}.items = [{ item, tb, tr? }] — one continuous presence
// interval per entry (tr omitted ⇒ still present at run end). A buffer record carries
// the same interval shape under stock / inputs / outputs. Consumers slice by tick.
// Intervals are half-open [tb, tr); null/absent tr encodes +∞.
//
// Convergence: the item universe is finite and every propagation only unions in
// sub-intervals contained in an edge/segment/buffer lifetime, so the worklist
// terminates even through belt↔buffer cycles.

import { heldItems, seriesForItem } from '../buffer.mjs';
import { clip, numId } from './util.mjs';

// Belt lanes + the transfer graph key on the numeric segment id (numId); buffer
// nodes key on `B<unit>` (string) so the two node spaces never collide.
const bKey = (unit) => `B${unit}`;

export function attachContents(beltSegments, edges, durationTick, buffers = []) {
  const segById = new Map();   // numeric id → persisted segment record
  const lanes   = new Map();   // numeric id → { left: Map<item, iv[]>, right: Map<item, iv[]> }
  for (const s of beltSegments) {
    const nid = numId(s.id);
    segById.set(nid, s);
    lanes.set(nid, { left: new Map(), right: new Map() });
  }

  // Buffer node per chest/tank: static `stock` (from per-item samples) + accumulated
  // `pool` (inputs). outputs = stock ∪ pool, computed on demand when a buffer feeds
  // out. `items` is every item type the buffer held (a chest/tank can hold several).
  const bufNodes = new Map();  // `B<unit>` → { unit, items, tb, tr, stock, pool }
  for (const b of buffers) {
    const node = {
      unit: b.unitNumber,
      items: heldItems(b),
      tb: b.timeBuilt ?? 0,
      tr: b.timeRemoved != null ? b.timeRemoved : null,
      stock: new Map(),
      pool: new Map(),
    };
    for (const item of node.items) seedStock(node, item, seriesForItem(b, item), durationTick);
    bufNodes.set(bKey(b.unitNumber), node);
  }

  seedStatic(edges, lanes, bufNodes);
  const { incoming, outgoing } = buildTransfers(edges, segById, bufNodes);
  propagate(lanes, bufNodes, segById, incoming, outgoing);

  for (const s of beltSegments) {
    const l = lanes.get(numId(s.id));
    s.contents = {
      left:  { items: intervalsToArray(l.left)  },
      right: { items: intervalsToArray(l.right) },
    };
  }
  return emitBuffers(buffers, bufNodes);
}

// ── seeding (static sources) ─────────────────────────────────────
// An edge with `itemWindows` carries a statically-known item (machine recipe output
// or miner resource). Deposit it onto its `dst`: a belt lane — clipped against the
// drop belt's segment-occupancy timeline (e.to.segs), so a belt that changes segment
// mid-drop seeds each segment it occupied for its own sub-window — or a buffer pool.
function seedStatic(edges, lanes, bufNodes) {
  for (const e of edges) {
    if (!e.itemWindows || !e.dst) continue;
    for (const w of e.itemWindows) {
      if (e.dst.belt) {
        for (const sv of e.to.segs ?? []) {
          const iv = clip([w.tb, w.tr ?? null], [sv.tb, sv.tr ?? null]);
          if (!iv) continue;
          const lane = lanes.get(sv.seg);
          if (lane) insertInterval(lane[e.dst.belt], w.item, iv[0], iv[1]);
        }
      } else if (e.dst.buffer != null) {
        const node = bufNodes.get(bKey(e.dst.buffer));
        if (!node) continue;
        const iv = clip([w.tb, w.tr ?? null], [node.tb, node.tr]);
        if (!iv) continue;
        insertInterval(node.pool, w.item, iv[0], iv[1]);
      }
    }
  }
}

// Buffer stock for one held `item` from its diff-compressed series (`series` =
// [[tick, value], …]). Sample-and-hold forward (the established convention — see
// lib/buffer.mjs): a sample's value holds until the next sample, so `item` is
// "present" over [tick, next) when value > 0. Clipped to the buffer's life and the
// run duration. Called once per held item, so a multi-item buffer seeds every item
// it carried. A buffer with no held items contributes no stock — its pool may still
// carry edge inputs.
function seedStock(node, item, series, durationTick) {
  if (!item) return;
  const samples = (series ?? [])
    .filter((s) => Array.isArray(s) && s.length >= 2)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const cap = node.tr != null ? Math.min(node.tr, durationTick) : durationTick;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i][1] <= 0) continue;
    const start = Math.max(samples[i][0], node.tb);
    const end   = i + 1 < samples.length ? samples[i + 1][0] : cap;
    const lo = start, hi = Math.min(end, cap);
    if (hi > lo) insertInterval(node.stock, item, lo, hi);
  }
}

// ── propagation graph ────────────────────────────────────────────
// Each dynamic-source edge (`src` + `dst`) becomes per-window transfers between two
// nodes, keyed numeric (belt segment) or `B<unit>` (buffer). `src` is 'belt' (walk its
// segment timeline e.from.segs) or { buffer }; `dst` is { belt: side } (walk e.to.segs)
// or { buffer }. A transfer is tagged with its mode, the lane side (belt targets), the
// CONSUMER tile (belt sources, for splitter output-side resolution — a splitter's own
// tile is shared by both outputs, so only the consumer's position reveals which half
// this edge leaves), and an optional inserter filter.
//
// Modes:
//   'both'    belt → belt, collinear merge (both lanes carry through)
//   'side'    belt → belt sideload / inserter belt→belt (both source lanes → one)
//   'buf-in'  belt → buffer (both source lanes → buffer pool)
//   'buf-out' buffer → belt (buffer outputs → one drop lane)
//   'buf2buf' buffer → buffer (source outputs → target pool)
function buildTransfers(edges, segById, bufNodes) {
  const incoming = new Map();   // dstKey → [{ src, mode, side?, outTile?, filter?, tb, tr }]
  const outgoing = new Map();   // srcKey → Set<dstKey>
  const add = (src, dst, rec) => {
    if (!incoming.has(dst)) incoming.set(dst, []);
    incoming.get(dst).push({ src, ...rec });
    if (!outgoing.has(src)) outgoing.set(src, new Set());
    outgoing.get(src).add(dst);
  };

  for (const e of edges) {
    if (!e.src || !e.dst) continue;            // dynamic-source edges only
    const life = [e.tb, e.tr ?? null];
    const filter = e.transferFilter ?? null;
    const outTile = e.to?.tile ? { x: e.to.tile.x, y: e.to.tile.y } : null;

    if (e.src === 'belt') {                     // belt source: walk its segment timeline
      const fromTile = e.from.tile ? { x: e.from.tile.x, y: e.from.tile.y } : null;
      for (const fv of e.from.segs ?? []) {
        if (e.dst.belt) {                       // → belt
          for (const tv of e.to.segs ?? []) {
            if (fv.seg === tv.seg) continue;
            const iv = clip(life, [fv.tb, fv.tr ?? null], [tv.tb, tv.tr ?? null]);
            if (!iv) continue;
            // Side preserved INTO a splitter: a feeder lands on the input half it sits
            // behind (left input → splitter left lane), not the perpendicular near-lane.
            let side = e.dst.belt;
            const tgt = segById.get(tv.seg);
            if (tgt?.kind === 'splitter') {
              const half = splitterOutputSide(splitterStateAt(tgt, iv[0]), fromTile);
              if (half) side = half;
            }
            const mode = side === 'both' ? 'both' : 'side';
            add(fv.seg, tv.seg, { mode, side: side === 'both' ? null : side, outTile, filter, tb: iv[0], tr: iv[1] });
          }
        } else if (e.dst.buffer != null) {      // → buffer
          const node = bufNodes.get(bKey(e.dst.buffer));
          if (!node) continue;
          const iv = clip(life, [fv.tb, fv.tr ?? null], [node.tb, node.tr]);
          if (!iv) continue;
          add(fv.seg, bKey(e.dst.buffer), { mode: 'buf-in', outTile, filter, tb: iv[0], tr: iv[1] });
        }
      }
    } else if (e.src.buffer != null) {          // buffer source
      const sNode = bufNodes.get(bKey(e.src.buffer));
      if (!sNode) continue;
      if (e.dst.belt === 'left' || e.dst.belt === 'right') {   // → belt drop lane
        for (const tv of e.to.segs ?? []) {
          const iv = clip(life, [sNode.tb, sNode.tr], [tv.tb, tv.tr ?? null]);
          if (!iv) continue;
          add(bKey(e.src.buffer), tv.seg, { mode: 'buf-out', side: e.dst.belt, filter, tb: iv[0], tr: iv[1] });
        }
      } else if (e.dst.buffer != null && e.dst.buffer !== e.src.buffer) {   // → buffer
        const dNode = bufNodes.get(bKey(e.dst.buffer));
        if (!dNode) continue;
        const iv = clip(life, [sNode.tb, sNode.tr], [dNode.tb, dNode.tr]);
        if (!iv) continue;
        add(bKey(e.src.buffer), bKey(e.dst.buffer), { mode: 'buf2buf', filter, tb: iv[0], tr: iv[1] });
      }
    }
  }
  return { incoming, outgoing };
}

function propagate(lanes, bufNodes, segById, incoming, outgoing) {
  const dirty = new Set();
  for (const k of lanes.keys())    dirty.add(k);
  for (const k of bufNodes.keys()) dirty.add(k);
  while (dirty.size > 0) {
    const key = dirty.values().next().value;
    dirty.delete(key);
    const list = incoming.get(key);
    if (!list) continue;
    let changed = false;
    for (const t of list) {
      if (depositTransfer(lanes, bufNodes, segById, key, t)) changed = true;
    }
    if (changed) { const ds = outgoing.get(key); if (ds) for (const d of ds) dirty.add(d); }
  }
}

// Apply one transfer into its destination node, unioning in source intervals over
// the transfer window. Returns true iff the destination grew. Belt sources replay
// their splitter routing per state-window; buffer sources emit their outputs
// (stock ∪ pool) over the single transfer window.
function depositTransfer(lanes, bufNodes, segById, dstKey, t) {
  let changed = false;
  const intoLane = (laneKey, map, tb, tr) => {
    const dst = lanes.get(dstKey);
    if (dst && propagateIntervals(dst[laneKey], map, tb, tr)) changed = true;
  };
  const intoPool = (map, tb, tr) => {
    const dst = bufNodes.get(dstKey);
    if (dst && propagateIntervals(dst.pool, map, tb, tr)) changed = true;
  };

  if (typeof t.src === 'number') {                       // belt source
    const source = lanes.get(t.src);
    if (!source) return false;
    for (const win of splitterWindows(segById.get(t.src), source, t.outTile, t.tb, t.tr)) {
      const pool = t.filter ? filterPool(win.pool, t.filter) : win.pool;
      if (t.mode === 'both') {
        intoLane('left',  pool.left,  win.tb, win.tr);
        intoLane('right', pool.right, win.tb, win.tr);
      } else if (t.mode === 'side') {
        intoLane(t.side, pool.left,  win.tb, win.tr);
        intoLane(t.side, pool.right, win.tb, win.tr);
      } else if (t.mode === 'buf-in') {
        intoPool(pool.left,  win.tb, win.tr);
        intoPool(pool.right, win.tb, win.tr);
      }
    }
  } else {                                               // buffer source
    const src = bufNodes.get(t.src);
    if (!src) return false;
    let out = mergeMaps(src.stock, src.pool);
    if (t.filter) out = filterMap(out, t.filter);
    if (t.mode === 'buf-out')      intoLane(t.side, out, t.tb, t.tr);
    else if (t.mode === 'buf2buf') intoPool(out, t.tb, t.tr);
  }
  return changed;
}

// ── buffer emit ──────────────────────────────────────────────────
// One record per buffer: stock (sampled), inputs (edge deposits), outputs (the union
// — what can leave). All three are the same {item, tb, tr?} interval-ledger shape and
// already carry every item type the buffer held (the ledgers are item-keyed). A buffer
// can hold several item types: `storedItems` is the full list; `storedItem` is kept as
// the first of those for backward compatibility (null when the buffer held nothing).
function emitBuffers(buffers, bufNodes) {
  const out = [];
  for (const b of buffers) {
    const node = bufNodes.get(bKey(b.unitNumber));
    if (!node) continue;
    const rec = {
      unit: b.unitNumber,
      name: b.name,
      tile: { x: Math.floor(b.location.x), y: Math.floor(b.location.y) },
      tb: node.tb,
      storedItem: node.items[0] ?? null,
      storedItems: node.items,
      stock:   { items: intervalsToArray(node.stock) },
      inputs:  { items: intervalsToArray(node.pool) },
      outputs: { items: intervalsToArray(mergeMaps(node.stock, node.pool)) },
    };
    if (node.tr != null) rec.tr = node.tr;
    out.push(rec);
  }
  out.sort((a, b) => (a.tb - b.tb) || (a.unit - b.unit));
  return out;
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

// Union N item→intervals maps into a fresh map, merging overlaps via insertInterval.
// Used to fold a buffer's stock and pool into its output set. Inputs not mutated.
function mergeMaps(...maps) {
  const out = new Map();
  for (const m of maps) for (const [item, ivs] of m) for (const [a, b] of ivs) insertInterval(out, item, a, b);
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

// Restrict an item→intervals map to the items an inserter filter will move
// (whitelist keeps listed items; blacklist drops them). Used for inserter transfers.
function filterMap(m, { mode, items }) {
  const set = new Set(items);
  const out = new Map();
  for (const [item, iv] of m) if ((mode === 'blacklist') !== set.has(item)) out.set(item, iv);
  return out;
}
function filterPool(pool, filter) {
  return { left: filterMap(pool.left, filter), right: filterMap(pool.right, filter) };
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

// Upper-bound intersection where null ⇒ +∞.
function clipMin(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
