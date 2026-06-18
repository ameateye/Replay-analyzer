// segments.mjs — edge-based belt-segment lifecycle.
//
// Belt records REGISTER in state.mjs (registerEvent folds each belt event and
// returns its dirty mark); this module owns what is DERIVED from them:
//   1. Classification (sameSegmentNeighbours) — same-segment neighbours read
//      straight from the captured edges. No tile index, no reverse index.
//   2. Segment lifecycle (reconcile / advance / finalize) — maintain live
//      segments over time. The CALLER owns ticks: accumulate a tick's dirty
//      units (the belt deltas registration returned), then call advance()
//      ONCE for that tick. This module never groups events itself.
//
// SAME-SEGMENT (edges alone, no geometry): two belts are same-segment iff joined
// by a STRAIGHT (feeder and consumer face the same way) or a CORNER (perpendicular,
// consumer has a single input), OR they are an underground-belt pair. Splitters
// are their own segment and count toward a consumer's input total. The corner-vs-
// sideload split is just `consumer.beltInputs.size < 2`. UG pairs are read from
// each belt's own `undergroundPair` (symmetric in the data → no reverse index).

import { setEntityTile, clearEntityTile } from './state.mjs';

// Same-segment neighbours of `unit`, derived purely from edges + attributes.
// Symmetric by construction at a SETTLED graph: an edge feeder→consumer is judged
// the same from either end (both test the consumer's direction match / input
// count). (Mid-tick, a captured edge can be transiently one-sided — which is why
// reconcile runs once per tick on the settled graph, not per event.)
export function sameSegmentNeighbours(belts, unit) {
  const out = new Set();
  const u = belts.get(unit);
  if (!u) return out;
  if (u.undergroundPair && belts.has(u.undergroundPair)) out.add(u.undergroundPair);
  // A splitter is its own segment — never same-segment with a belt neighbour.
  if (u.beltType === 'splitter') return out;
  for (const v of u.beltInputs) {        // v feeds u → u is the consumer
    if (!belts.has(v)) continue;
    const feeder = belts.get(v);
    if (feeder.beltType === 'splitter') continue;
    if (feeder.direction === u.direction) { out.add(v); continue; }   // straight (incl. into a UG)
    if (!isUg(u) && u.beltInputs.size < 2) out.add(v);            // corner — never INTO a UG
  }
  for (const v of u.beltOutputs) {       // u feeds v → v is the consumer
    const consumer = belts.get(v);
    if (!consumer) continue;
    if (consumer.beltType === 'splitter') continue;
    if (u.direction === consumer.direction) { out.add(v); continue; } // straight (incl. into a UG)
    if (!isUg(consumer) && consumer.beltInputs.size < 2) out.add(v); // corner — never INTO a UG
  }
  return out;
}

// Perpendicular feed onto an underground belt is always a sideload, never a
// corner — the UG's orientation is fixed (docs/factorio-knowledge/ug-sideload-rule.md).
const isUg = (b) => b.beltType === 'underground-belt';

// ── segment lifecycle ────────────────────────────────────────
// reconcile(state, dirty, tick) maintains live segments off the edge oracle.
// The CALLER drives it: apply a whole tick's events (accumulating their dirty
// units), then call reconcile ONCE for that tick. Reconciling a settled graph —
// not one mid-update — is what avoids the transiently one-sided edge (a partner's
// reciprocal edge lands later in the same tick), so a plain directed flood
// suffices; no symmetrization. The module owns no tick state.
//   Per dirty unit: gone from belts → leave its segment (mark for split); still
//   present and in a segment → mark its segment for split (a rotation may cut it).
//   SPLIT — recompute each touched segment's components; largest keeps the id,
//     the rest peel off as fresh segments.
//   MERGE — each present dirty belt joins its neighbours' segment, unifying
//     several if it bridges them (earliest tb wins, ties → lower id).
// Each segment records, scoped to its own id: per-member tile occupancy (tb/tr),
// merge/split/birth/death lineage, and (splitters) a state timeline.

const isSplitter = (b) => b.beltType === 'splitter';

// Tiles a belt occupies: splitter = 2 (perpendicular to facing), else 1.
function tilesFor(b) {
  const x = b.location.x, y = b.location.y, d = b.direction ?? 0;
  if (!isSplitter(b)) return [{ x: Math.floor(x), y: Math.floor(y), direction: d }];
  let ax = 0, ay = 0, bx = 0, by = 0;
  if (d === 0) { ax = -0.5; bx = 0.5; } else if (d === 4) { ay = -0.5; by = 0.5; }
  else if (d === 8) { ax = 0.5; bx = -0.5; } else if (d === 12) { ay = 0.5; by = -0.5; }
  return [{ x: Math.floor(x + ax), y: Math.floor(y + ay), direction: d },
          { x: Math.floor(x + bx), y: Math.floor(y + by), direction: d }];
}

function join(state, seg, u, tick) {        // u enters seg → open its tile occupancy here
  seg.members.add(u);
  state.segOf.set(u, seg.id);
  const b = state.belts.get(u);
  if (b) {
    // Membership timeline on the belt record — the finalize replay's source
    // for endpoint segment intervals (what updateSegments used to advance
    // live). One entry per tick, LAST join wins: updateSegments ran once per
    // settle with the final segOf, so mid-settle transient hops (a belt
    // passing through a segment that immediately merges away) were invisible.
    const tl = b.segTl, last = tl[tl.length - 1];
    if (last && last.tick === tick) { last.seg = seg.id; last.seq = ++state.seq; }
    else tl.push({ seg: seg.id, tick, seq: ++state.seq });
    const xy = tilesFor(b);
    // A unit can leave and REJOIN the same segment over disjoint windows (churn
    // from transient one-sided belt edges), so tile occupancy is a LIST of
    // intervals — append here, never overwrite, or the earlier interval is lost
    // and the tile reads as unclassified for that whole window. On a same-settle
    // re-entry (last interval still open) refresh its geometry instead of pushing.
    let intervals = seg.tiles.get(u);
    if (!intervals) { intervals = []; seg.tiles.set(u, intervals); }
    const lastIv = intervals[intervals.length - 1];
    if (lastIv && lastIv.tr == null) lastIv.xy = xy;
    else intervals.push({ xy, tb: tick });
    // Belt tiles join the shared tile index here so the finalize replay
    // resolves belts (segments owns belt tiles).
    for (const t of xy) setEntityTile(state, t.x, t.y, { unit: u, category: 'belt', name: b.name });
  }
}

function leave(state, seg, u, tick) {       // u exits seg → close occupancy (entry kept for geometry)
  seg.members.delete(u);
  if (state.segOf.get(u) === seg.id) state.segOf.delete(u);
  const intervals = seg.tiles.get(u);
  const t = intervals && intervals[intervals.length - 1];
  if (t && t.tr == null) {                                          // close the open interval
    t.tr = tick;
    for (const xy of t.xy) clearEntityTile(state, xy.x, xy.y, u);   // drop belt tiles from the shared index
  }
}

// Append a splitter state, skipping a no-op repeat of the last logged one.
function appendSplitter(seg, b, tick) {
  if (!seg || seg.kind !== 'splitter') return;
  const list = (seg.splitterStates ??= []);
  const last = list[list.length - 1];
  const filter = b.splitterFilter ?? null, ip = b.splitterInputPriority ?? null,
        op = b.splitterOutputPriority ?? null, dir = b.direction;
  if (last && last.filter === filter && last.inputPriority === ip && last.outputPriority === op && last.direction === dir) return;
  const t = tilesFor(b);
  list.push({ tick, filter, inputPriority: ip, outputPriority: op, direction: dir,
    tileLeft: t.length >= 2 ? { x: t[0].x, y: t[0].y } : null,
    tileRight: t.length >= 2 ? { x: t[1].x, y: t[1].y } : null });
}

// Components of `members` under the same-segment relation (directed flood —
// valid because reconcile runs on a settled graph).
function componentsWithin(belts, members) {
  const seen = new Set(), comps = [];
  for (const seed of members) {
    if (seen.has(seed)) continue;
    const c = new Set([seed]), st = [seed]; seen.add(seed);
    while (st.length) for (const n of sameSegmentNeighbours(belts, st.pop())) if (members.has(n) && !seen.has(n)) { seen.add(n); c.add(n); st.push(n); }
    comps.push(c);
  }
  return comps;
}

function formSeg(state, members, tick) {
  const id = state.nextSeg++;
  let splitter = null;
  for (const u of members) { const b = state.belts.get(u); if (b && isSplitter(b)) { splitter = b; break; } }
  const seg = { id, tb: tick, members: new Set(), tiles: new Map(), pre: [], suc: [],
                kind: splitter ? 'splitter' : 'belt' };
  state.segs.set(id, seg);
  for (const u of members) join(state, seg, u, tick);
  if (splitter) appendSplitter(seg, splitter, tick);
  return seg;
}

function retireSeg(state, seg, tick) { state.segs.delete(seg.id); seg.tr = tick; state.retired.push(seg); }

// MERGE: belt `u` joins its neighbours' segment; bridged segments unify.
function merge(state, u, tick, events) {
  const ids = new Set();
  for (const n of sameSegmentNeighbours(state.belts, u)) { const s = state.segOf.get(n); if (s != null) ids.add(s); }
  let own = state.segOf.get(u);
  if (own == null) {
    if (ids.size === 0) {
      const seg = formSeg(state, [u], tick);
      seg.pre.push({ id: null, units: 0, tick, outcome: 'birth' });
      events.push({ type: 'segment-created', tick, segId: `S-${seg.id}`, units: [...seg.members] });
      return;
    }
    own = [...ids][0]; join(state, state.segs.get(own), u, tick);     // join in place
  }
  ids.add(own);
  if (ids.size === 1) return;
  const win = [...ids].map(id => state.segs.get(id)).sort((a, b) => (a.tb - b.tb) || (a.id - b.id))[0];
  for (const id of ids) {
    if (id === win.id) continue;
    const lose = state.segs.get(id), moved = [...lose.members], n = moved.length;
    for (const m of moved) { leave(state, lose, m, tick); join(state, win, m, tick); }
    retireSeg(state, lose, tick);
    lose.suc.push({ id: `S-${win.id}`,  units: n, tick, outcome: 'merge' });
    win.pre.push({  id: `S-${lose.id}`, units: n, tick, outcome: 'merge' });
    events.push({ type: 'segment-merged', tick, from: `S-${lose.id}`, into: `S-${win.id}`, units: moved });
  }
}

// SPLIT: segment may have been cut. Recompute its components; the largest keeps
// the id, the rest peel off as fresh segments.
function recut(state, segId, tick, events) {
  const seg = segId != null ? state.segs.get(segId) : null;
  if (!seg) return;
  const comps = componentsWithin(state.belts, seg.members);
  if (comps.length <= 1) return;
  comps.sort((a, b) => b.size - a.size);
  for (let i = 1; i < comps.length; i++) {
    for (const u of comps[i]) leave(state, seg, u, tick);
    const ns = formSeg(state, comps[i], tick);
    seg.suc.push({ id: `S-${ns.id}`,  units: comps[i].size, tick, outcome: 'split' });
    ns.pre.push({  id: `S-${seg.id}`, units: comps[i].size, tick, outcome: 'split' });
    events.push({ type: 'segment-split', tick, from: `S-${seg.id}`, to: `S-${ns.id}`, units: [...comps[i]] });
  }
}

// ── belt edges (cross-segment connections) ───────────────────
// A belt edge is a belt output feeder→consumer NOT classed same-segment — a
// sideload, splitter boundary, or 2-input corner. On the SETTLED graph that's
// `beltOutputs \ sameSegmentNeighbours`, read straight off the captured edges.
// The feeder owns the edge: re-derive u's cross-segment outputs, diff against
// the set stored last tick, emit UNIT→UNIT belt-edge deltas (no segment id —
// the consumer resolves membership itself). The test is pure-local
// (sameSegmentNeighbours reads only u's + its neighbours' own attributes,
// never segOf), so the edge set is independent of merge/split ordering — the
// diff is correct at any point the unit is visited, and the belt-edge changes
// of a dirty unit's CONSUMERS are owned by their feeders, which the dirty mark
// also marked. That is why this runs inline at each dirty unit's
// merge/departure visit in reconcile, with no separate trailing scan.
function edgeDiffFeeder(state, u, tick, events) {
  const { belts, beltEdges } = state;
  const prev = beltEdges.get(u);                 // u's cross-segment outputs last tick
  const b = belts.get(u);
  if (!b) {                                       // feeder gone → retire all it fed
    if (prev) {
      for (const v of prev) events.push({ type: 'belt-edge-removed', tick, feeder: u, consumer: v });
      beltEdges.delete(u);
    }
    return;
  }
  const same = sameSegmentNeighbours(belts, u);
  let wanted = null;
  for (const v of b.beltOutputs) {
    if (!belts.has(v) || same.has(v)) continue;   // missing or same-segment → not an edge
    (wanted ??= new Set()).add(v);
    if (!prev || !prev.has(v)) events.push({ type: 'belt-edge-added', tick, feeder: u, consumer: v });
  }
  if (prev) for (const v of prev) if (!wanted || !wanted.has(v)) {
    events.push({ type: 'belt-edge-removed', tick, feeder: u, consumer: v });
  }
  if (wanted) beltEdges.set(u, wanted); else beltEdges.delete(u);
}

// RECONCILE one tick's accumulated dirty set over the settled belt graph.
// Returns the tick's SegmentEvent[] — the topology deltas the edge layer
// consumes to keep its ledger in step without re-scanning every edge:
//   { type: 'segment-created', segId, units[] }    new segment (belt birth)
//   { type: 'segment-merged',  from, into, units[] } `units` (all of `from`) folded into `into`
//   { type: 'segment-split',   from, to, units[] }  `units` peeled off `from` into `to`
//   { type: 'segment-retired', segId }             segment emptied (death)
// plus the UNIT→UNIT belt-connection deltas (edgeDiffFeeder, folded inline at
// each dirty unit's departure/merge visit):
//   { type: 'belt-edge-added',   feeder, consumer }
//   { type: 'belt-edge-removed', feeder, consumer }
// segId/from/into/to are the public `S-N` form; belt edges carry no segId.
export function reconcile(state, dirty, tick) {
  const { belts, segs, segOf } = state;
  const events = [];
  const touched = new Set();
  for (const u of dirty) {
    const sid = segOf.get(u);
    if (belts.has(u)) { if (sid != null) touched.add(sid); }   // present → its seg may have been cut
    else {                                                      // departed (removed / replaced-away)
      edgeDiffFeeder(state, u, tick, events);                  // retire the edges it owned
      if (sid != null) {
        const seg = segs.get(sid);
        leave(state, seg, u, tick);
        if (seg.members.size === 0) {
          retireSeg(state, seg, tick);
          seg.suc.push({ id: null, units: 1, tick, outcome: 'death' });
          events.push({ type: 'segment-retired', tick, segId: `S-${seg.id}` });
        } else touched.add(sid);
      }
    }
  }
  for (const sid of touched) recut(state, sid, tick, events);
  for (const u of dirty) if (belts.has(u)) {
    merge(state, u, tick, events);
    edgeDiffFeeder(state, u, tick, events);                    // derive its cross-segment outputs
  }
  for (const u of dirty) { const b = belts.get(u); if (b && isSplitter(b)) appendSplitter(segs.get(segOf.get(u)), b, tick); }
  return events;
}

// Per-tick settle. reconcile's belt-edge deltas are appended (seq-stamped, in
// emission order) to state.beltEdgeLog — the finalize replay's mint/retire
// source. Segment lineage is already recorded on the segments themselves and
// belt membership on the belt records (join), so nothing is returned.
export function advance(state, dirty, tick) {
  for (const se of reconcile(state, dirty, tick)) {
    if (se.type === 'belt-edge-added' || se.type === 'belt-edge-removed') {
      state.beltEdgeLog.push({ op: se.type === 'belt-edge-added' ? 'add' : 'rm',
                               feeder: se.feeder, consumer: se.consumer, tick, seq: ++state.seq });
    }
  }
}

// ── finalize ─────────────────────────────────────────────────
export function finalize(state, _durationTick) {
  const all = [...state.segs.values(), ...state.retired].sort((a, b) => (a.tb - b.tb) || (a.id - b.id));
  return { beltSegments: all.map(toRecord) };
}

function toRecord(s) {
  const tileLocations = [];
  let open = 0;
  for (const intervals of s.tiles.values()) for (const { xy, tb, tr } of intervals) for (const t of xy) {
    const e = { x: t.x, y: t.y, direction: t.direction, tb };
    if (tr != null) e.tr = tr; else open++;
    tileLocations.push(e);
  }
  // Emitted order is a contract: gates diff builds byte-for-byte, and s.tiles'
  // Map-insertion order shifts with reconcile internals.
  tileLocations.sort((a, b) => (a.tb - b.tb) || (a.x - b.x) || (a.y - b.y) || ((a.tr ?? Infinity) - (b.tr ?? Infinity)));
  const o = { id: `S-${s.id}`, kind: s.kind, tb: s.tb, tiles: open };
  if (s.tr != null) o.tr = s.tr;
  if (s.kind === 'splitter' && s.splitterStates) o.splitterStates = s.splitterStates;
  if (s.pre.length) o.predecessors = s.pre;
  if (s.suc.length) o.successors = s.suc;
  if (tileLocations.length) o.tileLocations = tileLocations;
  return o;
}
