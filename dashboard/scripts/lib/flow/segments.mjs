// segments.mjs — edge-based belt-segment lifecycle (replaces segments-old.mjs).
//
// Two responsibilities, cleanly split:
//   1. Belt state + classification (applyEvent / sameSegmentNeighbours) — take an
//      event, update `state.belts` (one map: unit → folded belt rec), return the
//      dirty mark, and classify same-segment neighbours straight from the
//      captured edges. No tile index, no reverse index, no plans.
//   2. Segment lifecycle (reconcile / finalize) — maintain live segments over
//      time. The CALLER owns ticks: apply a whole tick's events (accumulating
//      their dirty units), then call reconcile() ONCE for that tick. This module
//      never groups events itself.
//
// SAME-SEGMENT (edges alone, no geometry): two belts are same-segment iff joined
// by a STRAIGHT (feeder and consumer face the same way) or a CORNER (perpendicular,
// consumer has a single input), OR they are an underground-belt pair. Splitters
// are their own segment and count toward a consumer's input total. The corner-vs-
// sideload split is just `consumer.beltInputs.size < 2`. UG pairs are read from
// each belt's own `undergroundPair` (symmetric in the data → no reverse index).
//
// DIRTY MARK — the event's entity plus everything in its inputs and outputs,
// before and after. (entity includes oldUnit on a replace.) No reverse scan.
//
// No geometry: same-segment is read straight off each belt's captured
// beltInputs / beltOutputs / undergroundPair, so its classification imports
// nothing from lib/flow/ (only the shared state container, see state.mjs). The
// old geometric model is kept as segments-old.mjs.

import { createFlowState, setEntityTile, clearEntityTile } from './state.mjs';

// 'belt' category tag. TODO(refactor): source entity-name constants from the
// game-data payload rather than hardcoding — see docs/refactors/segments-edge-rewrite.md.
const BELT_CATEGORY = 'belt';

// State now lives in the shared flow-state container (state.mjs). Re-exported
// so existing callers (the _diagnostics parity tools) keep working unchanged;
// flow-prep imports createFlowState directly.
export { createFlowState as createState };

function toSet(v) {
  if (Array.isArray(v)) return new Set(v);
  if (v instanceof Set) return new Set(v);
  return new Set();
}

// The folded rec, field-for-field identical to the frozen _addBelt, plus `tb`
// (the belt's build tick) so the edge layer can denormalise each belt
// endpoint's own lifetime onto its edges. tb lives here, not on the segment
// tile entry, because it's the entity's identity — it survives segment churn.
function addBelt(belts, e) {
  belts.set(e.unit, {
    unit: e.unit,
    name: e.name,
    beltType: e.beltType,
    direction: e.direction ?? 0,
    location: e.location,
    tb: e.tick ?? null,
    beltToGroundType: e.beltToGroundType ?? null,
    undergroundPair: e.undergroundPair ?? null,
    beltInputs: toSet(e.beltInputs),
    beltOutputs: toSet(e.beltOutputs),
    splitterFilter: e.splitterFilter ?? null,
    splitterInputPriority: e.splitterInputPriority ?? null,
    splitterOutputPriority: e.splitterOutputPriority ?? null,
  });
}

// Dirty = entity + its inputs + its outputs, before and after. No reverse scan.
function dirtyMark(belts, e) {
  const d = new Set();
  for (const u of [e.unit, e.oldUnit, e.newUnit]) {   // entity (old+new on replace)
    if (u == null) continue;
    d.add(u);
    const b = belts.get(u);                   // before
    if (b) {
      for (const x of b.beltInputs)  d.add(x);
      for (const x of b.beltOutputs) d.add(x);
      if (b.undergroundPair) d.add(b.undergroundPair);
    }
  }
  for (const x of toSet(e.beltInputs))  d.add(x);   // after
  for (const x of toSet(e.beltOutputs)) d.add(x);
  if (e.undergroundPair) d.add(e.undergroundPair);
  return d;
}

// Apply one event: compute dirty (before mutating), then update belts. Pure
// belt-state + dirty mark — NO segment lifecycle. The caller accumulates dirty
// across a tick's events and calls reconcile() once per tick.
export function applyEvent(state, e) {
  if (e.category !== BELT_CATEGORY) return null;
  const belts = state.belts;
  const dirty = dirtyMark(belts, e);
  switch (e.type) {
    case 'entity-built':
      addBelt(belts, e);
      break;
    case 'entity-removed':
      belts.delete(e.unit);
      break;
    case 'entity-mutated': {
      const b = belts.get(e.unit);
      if (!b) return null;
      if (e.direction        !== undefined) b.direction = e.direction;
      if (e.beltToGroundType !== undefined) b.beltToGroundType = e.beltToGroundType;
      if (e.undergroundPair  !== undefined) b.undergroundPair = e.undergroundPair;
      if (e.beltInputs       !== undefined) b.beltInputs = toSet(e.beltInputs);
      if (e.beltOutputs      !== undefined) b.beltOutputs = toSet(e.beltOutputs);
      if (e.splitterFilter         !== undefined) b.splitterFilter = e.splitterFilter;
      if (e.splitterInputPriority  !== undefined) b.splitterInputPriority = e.splitterInputPriority;
      if (e.splitterOutputPriority !== undefined) b.splitterOutputPriority = e.splitterOutputPriority;
      break;
    }
    case 'entity-replaced':
      addBelt(belts, { ...e, unit: e.newUnit });
      belts.delete(e.oldUnit);
      break;
  }
  return dirty;
}

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

// Flood-fill the same-segment relation over every belt currently in the map.
// Returns an array of component Sets (the partition oracle — used to validate
// the incrementally-maintained segments).
export function components(belts) {
  const seen = new Set();
  const comps = [];
  for (const seed of belts.keys()) {
    if (seen.has(seed)) continue;
    const comp = new Set();
    const stack = [seed];
    while (stack.length) {
      const u = stack.pop();
      if (seen.has(u)) continue;
      seen.add(u);
      comp.add(u);
      for (const n of sameSegmentNeighbours(belts, u)) if (!seen.has(n)) stack.push(n);
    }
    comps.push(comp);
  }
  return comps;
}

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
    const xy = tilesFor(b);
    seg.tiles.set(u, { xy, tb: tick });
    // Belt tiles join the shared tile index here so edges' findEntityInTile
    // resolves belts (segments owns belt tiles; edges only queries them).
    for (const t of xy) setEntityTile(state, t.x, t.y, { unit: u, category: 'belt', name: b.name });
  }
}

function leave(state, seg, u, tick) {       // u exits seg → close occupancy (entry kept for geometry)
  seg.members.delete(u);
  if (state.segOf.get(u) === seg.id) state.segOf.delete(u);
  const t = seg.tiles.get(u);
  if (t) {
    if (t.tr == null) t.tr = tick;
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

// Components of `members` under the same-segment relation (directed flood — same
// rule as components(), so a segment's partition always agrees with the oracle).
// Valid because reconcile runs on a settled graph.
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
// `beltOutputs \ sameSegmentNeighbours`, read straight off the captured edges —
// no geometry, no segOf bookkeeping. The feeder owns the edge; dirtyMark marks a
// feeder dirty whenever a consumer it feeds changes, so every affected edge is
// re-derived from its feeder side and the diff stays local. Because the test is
// purely local (never reads segOf), the diff is correct at any point the unit is
// visited — so it runs inline in reconcile's merge/departure passes (which
// already visit every dirty unit), not as a separate trailing scan.
// Per-feeder edge diff: re-derive u's cross-segment outputs (beltOutputs \
// sameSegmentNeighbours) and diff against the set stored last tick, emitting
// UNIT→UNIT belt-edge deltas. The test is pure-local (sameSegmentNeighbours
// reads only u's + its neighbours' own attributes, never segOf), so the edge
// SET is independent of merge/split ordering — which is why this can run inline
// at each unit's merge/departure visit (below) with no separate trailing scan,
// and why no segment id is attached: the edge is a unit pair, and segment
// membership is resolved by whoever consumes the stream.
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
// plus the UNIT→UNIT belt-connection deltas (edgeDiffFeeder, folded inline):
//   { type: 'belt-edge-added',   feeder, consumer }
//   { type: 'belt-edge-removed', feeder, consumer }
// segId/from/into/to are the public `S-N` form; belt edges carry no segId — they
// are a unit pair, and the consumer resolves segment membership itself.
//
// The belt-edge diff is folded into the two passes that already visit every
// dirty unit — departed units in the departure pass, present units in the merge
// pass — so there is NO separate trailing scan. This is sound because the edge
// test is purely local (sameSegmentNeighbours never reads segOf): every edge
// change is owned by a feeder whose attributes (or whose consumer's attributes)
// changed, and dirtyMark marks both endpoints, so the merge/departure visits
// cover every affected feeder. See edgeDiffFeeder.
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

// Per-tick settle, returned as one value (the seam edges.advance consumes —
// the driver never inspects segment-event types). `beltEdges` preserves
// reconcile's emission order; `moved` is the belts that may have changed
// segment this tick: the directly-dirty belts (covers join-in-place, which
// emits no event) plus the units carried by segment-created / -merged /
// -split (merge-losers and split-peeled belts that aren't individually dirty).
export function advance(state, dirty, tick) {
  const moved = new Set(dirty);
  const beltEdges = [];
  for (const se of reconcile(state, dirty, tick)) {
    if (se.type === 'belt-edge-added')        beltEdges.push({ op: 'added', feeder: se.feeder, consumer: se.consumer });
    else if (se.type === 'belt-edge-removed') beltEdges.push({ op: 'removed', feeder: se.feeder, consumer: se.consumer });
    else if (se.units) for (const u of se.units) moved.add(u);
  }
  return { beltEdges, moved };
}

// ── finalize ─────────────────────────────────────────────────
export function finalize(state, _durationTick) {
  const all = [...state.segs.values(), ...state.retired].sort((a, b) => (a.tb - b.tb) || (a.id - b.id));
  return { beltSegments: all.map(toRecord) };
}

function toRecord(s) {
  const tileLocations = [];
  let open = 0;
  for (const { xy, tb, tr } of s.tiles.values()) for (const t of xy) {
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
