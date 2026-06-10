// edges.mjs — durable, tile-anchored edge logger.
//
// An edge is a long-lived record: from-endpoint → to-endpoint, each endpoint a
// tile with a unit-occupancy timeline (units: [{unit, category, tb, tr}]). It is
// minted by its OWNER — an inserter or a miner — and retired only when that owner
// is removed or rotates. Any entity landing on or leaving an endpoint tile just
// opens or closes that endpoint's interval; because the interval carries the
// entity's category, an endpoint follows whatever occupies its tile (a machine
// replaced by a belt morphs the edge in place — same edge, new occupant). Belt↔belt
// edges are minted/retired wholesale by segments' belt-edge-* stream.
//
// There is no drain/feed "kind": an edge is from-entity → to-entity, and machine-
// vs-belt is just the current interval's category. Node RECORDS (machines /
// miners / inserters / buffers) are registered by state.registerEvent before
// this applier sees the same event — applyEvent reads the post-fold record and
// does only the edge work. "What entity is at this tile" is answered once, by
// state (findEntityInTile); segment and belt-lane `side` are resolved through
// single helpers. Throughput and filters are deferred.

import { readFileSync } from 'node:fs';
import { findEntityInTile, getSegmentFromUnit, tileKey } from './state.mjs';

// ── prototypes (loaded once from game-data) ───────────────────
const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const RECIPE_OVERRIDE = PROTO.recipeOutputOverride;          // recipe → item (mismatched-name recipes)
const FLUID_ONLY      = new Set(PROTO.fluidOnlyRecipes);     // recipes whose output is a fluid → no belt item

// ── geometry (cardinal dirs only, 16-way; y points down) ──────
const DV   = { 0: { x: 0, y: -1 }, 4: { x: 1, y: 0 }, 8: { x: 0, y: 1 }, 12: { x: -1, y: 0 } }; // N E S W
const OPP  = { 0: 8, 4: 12, 8: 0, 12: 4 };
const LEFT = { 0: 12, 4: 0, 8: 4, 12: 8 };
const floorTile  = (loc) => ({ x: Math.floor(loc.x), y: Math.floor(loc.y) });
const tileCenter = (t) => ({ x: t.x + 0.5, y: t.y + 0.5 });        // the one +0.5 (1×1 entities centre here)
const sameTile   = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const stepTile   = (t, dir, dist) => { const v = DV[dir] ?? { x: 0, y: 0 }; return { x: t.x + v.x * dist, y: t.y + v.y * dist }; };

// Which side of a vector (dx,dy) relative to facing `dir`. Collinear → 'right'.
function sideAlong(dir, dx, dy) {
  const f = DV[dir], l = DV[LEFT[dir]];
  if (!f) return 'right';
  const across = dx * l.x + dy * l.y, along = dx * f.x + dy * f.y;
  return Math.abs(across) > Math.abs(along) ? (across > 0 ? 'left' : 'right') : 'right';
}

// Belt lane the owner at `ownerLoc` touches. mode 'drop' = inserter drop (far lane
// → flip); 'pickup'/'miner' = near lane.
function resolveSide(state, beltUnit, beltTile, ownerLoc, mode) {
  const dir = state.belts.get(beltUnit)?.direction ?? 0;
  const c = tileCenter(beltTile);
  const s = sideAlong(dir, ownerLoc.x - c.x, ownerLoc.y - c.y);
  return mode === 'drop' ? (s === 'left' ? 'right' : 'left') : s;
}

// Which CONSUMER lane a belt→belt hand-off feeds (cross-segment connection).
// Collinear (same-direction inline) merge → 'both' lanes carry through. Otherwise
// it's a perpendicular sideload. A belt only outputs straight ahead, so the feeder
// always pushes into the consumer's cell from directly behind it — i.e. the feeder
// sits on the consumer side OPPOSITE the feeder's travel direction, in the
// consumer's frame. This depends only on the two directions, not on either centre:
// using the floored centre broke for 2-tile splitter feeders, whose origin tile is
// diagonal to the consumer and tie-broke sideAlong to the wrong lane.
function beltToBeltSide(state, feeder, consumer) {
  const f = state.belts.get(feeder), c = state.belts.get(consumer);
  if (!f || !c) return 'right';
  if (f.direction === c.direction) return 'both';
  const v = DV[f.direction];
  if (!v) return 'right';
  return sideAlong(c.direction, -v.x, -v.y);
}

// ── dispatch ──────────────────────────────────────────────────
// `delta` is state.registerEvent's report of what the fold changed (pre-fold
// values this applier can no longer see, e.g. a direction change).
export function applyEvent(state, ev, delta) {
  switch (ev.type) {
    case 'entity-built':    return onBuilt(state, ev);
    case 'entity-removed':  return onRemoved(state, ev);
    case 'entity-mutated':  return onMutated(state, ev, delta);
    case 'entity-replaced': return onReplaced(state, ev);
  }
}

function onBuilt(state, ev) {
  if (ev.category === 'belt') return openEndpointAt(state, floorTile(ev.location), ev.unit, 'belt', ev.tick);
  openNode(state, ev.category, ev.unit, ev.tick);
}

function onRemoved(state, ev) {
  if (ev.category === 'belt') return closeEndpointAt(state, floorTile(ev.location), ev.unit, ev.tick);
  closeNode(state, ev.unit, ev.tick);
}

// A registered node landed: owners (inserter / miner) mint their one edge;
// passive tile occupants (machine / buffer) open the unit interval on any owned
// edge already anchored to their tiles (fills an endpoint waiting on the tile;
// reopens edges on a replace). Unregistered prototypes have no record → no-op.
function openNode(state, category, unit, tick) {
  if (category === 'inserter' || category === 'miner') {
    const r = (category === 'inserter' ? state.inserters : state.miners).get(unit);
    if (r) mintOwnerEdge(state, r, tick);
    return;
  }
  const r = category === 'machine' ? state.machines.get(unit)
          : category === 'buffer'  ? state.buffers.get(unit) : null;
  if (r) for (const t of r.tiles) openEndpointAt(state, t, unit, category, tick);
}

// A registered node left: owners retire their edge; passive occupants close
// their tile intervals (the edge persists — the endpoint just goes empty).
function closeNode(state, unit, tick) {
  const owner = state.inserters.get(unit) ?? state.miners.get(unit);
  if (owner) return retireEdge(state, owner.edgeId, tick);
  const r = state.machines.get(unit) ?? state.buffers.get(unit);
  if (r) for (const t of r.tiles) closeEndpointAt(state, t, unit, tick);
}

function onMutated(state, ev, delta) {
  if (ev.category === 'belt') {
    const b = state.belts.get(ev.unit);
    if (ev.direction !== undefined && b) refreshSidesAt(state, floorTile(b.location));
    return;
  }
  // A rotation moves an owner's tiles → retire the old edge and mint a fresh
  // one off the already-folded record (state recomputed direction / dropTile).
  if (!delta?.directionChanged) return;
  const r = state.inserters.get(ev.unit) ?? state.miners.get(ev.unit);
  if (!r) return;
  retireEdge(state, r.edgeId, ev.tick);
  mintOwnerEdge(state, r, ev.tick);
}

// A replace is same-tile, new unit (state already folded both records).
// Endpoints (machine/belt/buffer) re-open in place; owners (inserter/miner)
// are a fresh owner, so the old edge retires and a new one mints.
function onReplaced(state, ev) {
  if (ev.category === 'belt') return openEndpointAt(state, floorTile(ev.location), ev.newUnit, 'belt', ev.tick);
  closeNode(state, ev.oldUnit, ev.tick);
  openNode(state, ev.category, ev.newUnit, ev.tick);
}

// ── owners (inserter / miner): mint + retire their own edge ───

// Mint an owner's one edge, anchored to its endpoint tiles. An inserter spans
// pickup→drop tiles; a miner goes from itself (no tile) to its drop tile. A target
// tile may be empty right now — the endpoint still holds the tile, with an empty
// unit timeline, and openEndpointAt fills it when a belt or machine lands there.
// So an owner placed before its target needs no retry: the edge waits on the tile.
function mintOwnerEdge(state, r, tick) {
  let from, to, ownerField;
  if (r.kind === 'inserter') {
    from = endpointAt(state, stepTile(r.tile, r.direction, r.reach), tick);
    to   = endpointAt(state, stepTile(r.tile, OPP[r.direction] ?? r.direction, r.reach), tick);
    ownerField = { inserterUnit: r.unit };
  } else {
    from = { units: [{ unit: r.unit, category: 'miner', tb: r.tb }] };   // no from-tile for miners
    to   = r.dropTile ? endpointAt(state, r.dropTile, tick) : { units: [] };
    ownerField = { minerUnit: r.unit };
  }
  r.edgeId = mintEdge(state, { from, to, ...ownerField }, tick).id;
}

// ── endpoints (machine/buffer/belt): passive tile occupants ───
// An entity (`unit`, `category`) landed at `tile` → open the unit interval on every
// owned edge anchored there, refreshing belt-lane side. The interval carries the
// category, so an endpoint follows a tile that changes type.
function openEndpointAt(state, tile, unit, category, tick) {
  forEdgesAt(state, tile, (e) => {
    if (!isOwned(e)) return;                        // belt↔belt edges are stream-managed, not tile-morphed
    for (const ep of [e.from, e.to]) {
      if (!ep.tile || !sameTile(ep.tile, tile)) continue;
      openUnit(ep, unit, category, tick);
      if (category === 'belt') { ep.side = sideForEndpoint(state, e, ep); openSeg(ep, state.segOf.get(unit), tick); }
      else ep.side = null;
    }
  });
}

// The entity holding `tile` left → close the interval whose CURRENT unit is it.
// (Unit guard: a same-tick build(new)+remove(old) where remove lands last must not
// clobber the freshly-opened interval.)
function closeEndpointAt(state, tile, unit, tick) {
  forEdgesAt(state, tile, (e) => {
    if (!isOwned(e)) return;                        // belt↔belt edges retire via the stream, not on belt-leave
    for (const ep of [e.from, e.to]) if (sameTile(ep.tile, tile) && curUnit(ep) === unit) { closeUnit(ep, tick); closeSeg(ep, tick); }
  });
}

// Belt at `tile` rotated → re-resolve the lane for any belt endpoint there.
function refreshSidesAt(state, tile) {
  forEdgesAt(state, tile, (e) => {
    for (const ep of [e.from, e.to]) if (ep.tile && sameTile(ep.tile, tile) && curCat(ep) === 'belt') ep.side = sideForEndpoint(state, e, ep);
  });
}

// Segment topology changed this tick → for each belt that moved between segments
// (the units carried by segment-created / -merged / -split), walk its tile to the
// edges anchored there and advance every endpoint holding that belt to its now-current
// segment. The one index this rides is edgesByTile; segments hands us the moved units.
function updateSegments(state, movedUnits, tick) {
  for (const unit of movedUnits) {
    const b = state.belts.get(unit);
    if (!b) continue;
    const seg = state.segOf.get(unit);
    forEdgesAt(state, floorTile(b.location), (e) => {
      for (const ep of [e.from, e.to]) if (curUnit(ep) === unit) openSeg(ep, seg, tick);
    });
  }
}

function forEdgesAt(state, tile, fn) {
  const ids = state.edgesByTile.get(tileKey(tile.x, tile.y));
  if (!ids) return;
  for (const id of [...ids]) {
    const e = state.edges.get(id);
    if (e && e.tr == null) fn(e);
  }
}

// The one belt-lane resolver: side of edge `e`'s belt endpoint `ep`.
function sideForEndpoint(state, e, ep) {
  const bu = curUnit(ep);
  if (bu == null) return null;
  const owner = e.inserterUnit != null ? state.inserters.get(e.inserterUnit) : state.miners.get(e.minerUnit);
  if (!owner) return null;
  const mode = e.minerUnit != null ? 'miner' : ep === e.to ? 'drop' : 'pickup';
  return resolveSide(state, bu, ep.tile, owner.location, mode);
}

// ── endpoint construction + unit timeline ─────────────────────
// Endpoint anchored at `tile`. Its unit timeline opens with whatever currently
// occupies the tile (at that entity's own build tick), or empty if nothing does —
// openEndpointAt fills it when an entity lands. Side is set by mint / openEndpointAt;
// segment is resolved on demand via endpointSegment, never stored.
function endpointAt(state, tile, tick) {
  const e = findEntityInTile(state, tile.x, tile.y);
  const units = e ? [{ unit: e.unit, category: e.category, tb: recTb(state, e.unit, e.category) ?? tick }] : [];
  return { tile, units };
}

// Build tick of the LIVE record only — a dead entity lingering in the tile
// index (removed miners keep their tiles, see state.regRemoved) must fall back
// to the mint tick, as when the live registries dropped removed records.
function recTb(state, unit, category) {
  const reg = category === 'belt' ? state.belts
            : category === 'machine' ? state.machines
            : category === 'miner' ? state.miners : null;
  const r = reg?.get(unit);
  return r && r.tr == null ? r.tb : null;
}

const curEntry = (ep) => { const u = ep.units[ep.units.length - 1]; return u && u.tr == null ? u : null; };
const curUnit  = (ep) => curEntry(ep)?.unit ?? null;
const curCat   = (ep) => curEntry(ep)?.category ?? null;

function openUnit(ep, unit, category, tick) {
  const last = ep.units[ep.units.length - 1];
  if (last && last.tr == null) {
    if (last.unit === unit) return;
    last.tr = tick;
  }
  ep.units.push({ unit, category, tb: tick });
}

function closeUnit(ep, tick) {
  const last = ep.units[ep.units.length - 1];
  if (last && last.tr == null) last.tr = tick;
}

const isOwned = (e) => e.inserterUnit != null || e.minerUnit != null;

// Segment occupancy timeline on a belt endpoint, parallel to its unit timeline:
// which live segment the endpoint's current belt sits in. Opened when a belt lands
// or an edge mints onto a belt, advanced by updateSegments when a merge/split
// renumbers that belt, closed when the belt leaves. A null seg (a belt not yet
// assigned a segment, pre-reconcile) is skipped — updateSegments opens the interval
// once segment-created assigns one.
function openSeg(ep, seg, tick) {
  if (seg == null) return;
  const last = ep.segs?.[ep.segs.length - 1];
  if (last && last.tr == null) {
    if (last.seg === seg) return;
    last.tr = tick;
  }
  (ep.segs ??= []).push({ seg, tb: tick, tr: null });
}

function closeSeg(ep, tick) {
  const last = ep.segs?.[ep.segs.length - 1];
  if (last && last.tr == null) last.tr = tick;
}

// Belt endpoint's live segment id, resolved on demand.
export function endpointSegment(state, ep) {
  const u = curUnit(ep);
  return u == null ? null : (getSegmentFromUnit(state, u)?.id ?? null);
}

// ── belt↔belt edges (driven by segments' belt-edge stream) ────

// Consume a tick's segment changes (the value segments.advance returned):
// ledger belt↔belt edges in emission order, then advance the segment timeline
// on every endpoint anchored to a belt that moved between segments.
export function advance(state, segChanges, tick) {
  for (const ch of segChanges.beltEdges) {
    if (ch.op === 'added') mintBeltEdge(state, ch.feeder, ch.consumer, tick);
    else                   retireBeltEdge(state, ch.feeder, ch.consumer, tick);
  }
  updateSegments(state, segChanges.moved, tick);
}

function mintBeltEdge(state, feeder, consumer, tick) {
  const from = beltEndpoint(state, feeder, tick), to = beltEndpoint(state, consumer, tick);
  if (!from || !to) return;
  to.side = beltToBeltSide(state, feeder, consumer);
  mintEdge(state, { from, to }, tick);                  // no owner; tile-indexed for the segment walk only
}

function retireBeltEdge(state, feeder, consumer, tick) {
  for (const e of state.edges.values())
    if (e.inserterUnit == null && e.minerUnit == null && e.tr == null && curUnit(e.from) === feeder && curUnit(e.to) === consumer) {
      retireEdge(state, e.id, tick);
      return;
    }
}

function beltEndpoint(state, unit, tick) {
  const b = state.belts.get(unit);
  if (!b) return null;
  return { tile: floorTile(b.location), units: [{ unit, category: 'belt', tb: b.tb ?? tick }] };
}

// ── edge store + the one tile index ───────────────────────────
function mintEdge(state, fields, tick) {
  const edge = { id: `E-${state.nextEdgeId++}`, tb: tick, ...fields };
  state.edges.set(edge.id, edge);
  const owned = isOwned(edge);
  for (const ep of [edge.from, edge.to]) {
    if (ep.tile) addTile(state, ep.tile, edge.id);                 // every belt endpoint is reachable by the segment walk
    if (curCat(ep) === 'belt') {
      if (owned) ep.side = sideForEndpoint(state, edge, ep);       // belt↔belt side is set by mintBeltEdge
      openSeg(ep, state.segOf.get(curUnit(ep)), tick);
    }
  }
  return edge;
}

function retireEdge(state, id, tick) {
  const e = state.edges.get(id);
  if (!e || e.tr != null) return;
  e.tr = tick;
  const owner = e.inserterUnit != null ? state.inserters.get(e.inserterUnit)
              : e.minerUnit   != null ? state.miners.get(e.minerUnit) : null;
  if (owner) owner.edgeId = null;
  for (const ep of [e.from, e.to]) {
    closeUnit(ep, tick);
    closeSeg(ep, tick);
    if (ep.tile) state.edgesByTile.get(tileKey(ep.tile.x, ep.tile.y))?.delete(id);
  }
}

function addTile(state, t, id) {
  const k = tileKey(t.x, t.y);
  let s = state.edgesByTile.get(k);
  if (!s) state.edgesByTile.set(k, s = new Set());
  s.add(id);
}

// ── from-scratch rebuild oracle (used by _diagnostics) ────────
// liveEdgeKeys — the incremental ledger (current unit per endpoint).
// rebuildLiveEdgeKeys — recomputed from the state snapshot alone. Diffing the two
// pinpoints incremental bugs. Key = owner (inserter/miner) or belt pair; detail =
// current from-unit, to-unit, and belt-lane side.
const beltSide = (e) => (curCat(e.from) === 'belt' ? e.from.side : curCat(e.to) === 'belt' ? e.to.side : null) ?? null;

export function liveEdgeKeys(state) {
  const out = new Map();
  for (const e of state.edges.values()) {
    if (e.tr != null) continue;
    const fu = curUnit(e.from), tu = curUnit(e.to);
    if (e.inserterUnit != null) {
      if (fu == null || tu == null) continue;
      out.set(`i${e.inserterUnit}`, { from: fu, to: tu, side: beltSide(e) });
    } else if (e.minerUnit != null) {
      if (tu == null) continue;
      out.set(`m${e.minerUnit}`, { from: e.minerUnit, to: tu, side: curCat(e.to) === 'belt' ? e.to.side : null });
    } else {
      if (fu == null || tu == null) continue;
      out.set(`b${fu}>${tu}`, { from: fu, to: tu, side: e.to.side ?? null });
    }
  }
  return out;
}

export function rebuildLiveEdgeKeys(state) {
  const out = new Map();
  for (const r of state.inserters.values()) {
    if (r.tr != null) continue;                                  // full-history registry: live records only
    const pickup = stepTile(r.tile, r.direction, r.reach), drop = stepTile(r.tile, OPP[r.direction] ?? r.direction, r.reach);
    const from = findEntityInTile(state, pickup.x, pickup.y), to = findEntityInTile(state, drop.x, drop.y);
    if (!from || !to) continue;
    const side = from.category === 'belt' ? resolveSide(state, from.unit, pickup, r.location, 'pickup')
               : to.category   === 'belt' ? resolveSide(state, to.unit,   drop,   r.location, 'drop') : null;
    out.set(`i${r.unit}`, { from: from.unit, to: to.unit, side });
  }
  for (const r of state.miners.values()) {
    if (r.tr != null) continue;                                  // full-history registry: live records only
    const to = r.dropTile && findEntityInTile(state, r.dropTile.x, r.dropTile.y);
    if (!to) continue;
    const side = to.category === 'belt' ? resolveSide(state, to.unit, r.dropTile, r.location, 'miner') : null;
    out.set(`m${r.unit}`, { from: r.unit, to: to.unit, side });
  }
  for (const [f, set] of state.beltEdges) for (const c of set) out.set(`b${f}>${c}`, { from: f, to: c, side: beltToBeltSide(state, f, c) });
  return out;
}

// ── contents resolution (turn live state into per-edge item facts) ──
// Edges stay item-free during the fold (purely topological); item identity is layered
// on once at finalize, while `state` (recipes / filters / resources / belt directions)
// is still alive — contents.mjs only ever sees the serialized arrays. An inserter has
// ONE pickup and ONE drop, so each endpoint resolves to a single role, and every edge
// reduces to one of three shapes on two independent axes — what the source PROVIDES
// and where the target GETS it:
//   • static source (machine recipe output, miner resource) → `itemWindows` + `dst`
//   • dynamic source (a belt's lanes, a buffer's outputs)   → `src` + `dst` (+ filter)
//   • drop into a machine (FEED)                            → nothing (dead end)
// `src` is 'belt' (its segments are e.from.segs) or { buffer: unit }; `dst` is
// { belt: side } (segments e.to.segs; side may be 'both' for a collinear belt merge)
// or { buffer: unit }. contents.mjs seeds the statics and propagates the dynamics.
function annotateContents(state, e) {
  if (e.minerUnit != null)    return resolveMinerEdge(state, e);
  if (e.inserterUnit != null) return resolveInserterEdge(state, e);
  return resolveBeltEdge(state, e);
}

// One pickup, one drop. Classify the drop first (where items GO) and bail if it's a
// machine — a feed, the item is consumed, nothing rides out. Then classify the pickup
// (what it PROVIDES): a machine is a static recipe source; a belt or buffer is a
// dynamic node contents.mjs resolves by propagation. Source identity needs `state`, so
// it's read here; the routing is left to contents.mjs.
function resolveInserterEdge(state, e) {
  const dst = targetOf(e.to);
  if (!dst) return;                                            // drop into a machine → feed
  e.dst = dst;
  if (e.from.units.some(u => u.category === 'machine')) return resolveDrainWindows(state, e);  // static source
  const filter = filterSpec(liveRec(state.inserters, e.inserterUnit));
  if (filter) e.transferFilter = filter;
  if (e.from.units.some(u => u.category === 'belt')) { e.src = 'belt'; return; }   // dynamic: belt lanes
  const bu = bufferUnitOf(e.from);
  if (bu != null) e.src = { buffer: bu };                                          // dynamic: buffer outputs
}

// Miner → its drop: the drill's mined resource rides the drop for the edge's whole
// life (the edge retires with the miner, so the resource is constant). Same static
// shape as a machine drain — `itemWindows` + `dst` (a belt lane or a buffer).
function resolveMinerEdge(state, e) {
  const res = liveRec(state.miners, e.minerUnit)?.resource;
  if (!res) return;
  const dst = targetOf(e.to);
  if (!dst) return;
  e.dst = dst;
  e.itemWindows = [{ item: res, tb: e.tb, tr: e.tr ?? null }];
}

// Cross-segment belt hand-off: a dynamic belt→belt transfer. Recompute the drop lane
// from the final feeder/consumer belts when BOTH are still live (robust if a late
// rotation left mint-time `to.side` stale); a retired edge's belts are gone from
// state.belts, so keep its mint-time `to.side` rather than fall back to 'right'.
// side 'both' = a collinear inline merge (both lanes carry through).
function resolveBeltEdge(state, e) {
  const fu = lastUnit(e.from), cu = lastUnit(e.to);
  const side = (state.belts.get(fu) && state.belts.get(cu))
    ? beltToBeltSide(state, fu, cu)
    : (e.to.side ?? 'right');
  e.src = 'belt';
  e.dst = { belt: side };
}

// Where a drop endpoint delivers: a belt lane (a concrete left/right — an inserter or
// miner never drops onto 'both'), a buffer pool, or nothing (a machine consumes feed).
function targetOf(ep) {
  if (ep.units.some(u => u.category === 'belt')) {
    return ep.side === 'left' || ep.side === 'right' ? { belt: ep.side } : null;
  }
  const bu = bufferUnitOf(ep);
  return bu != null ? { buffer: bu } : null;
}

// The buffer unit on an endpoint, or null. A tile holds one entity, so it's a single
// lookup, not a set (`.find` over the timeline tolerates a same-tile chest replace).
function bufferUnitOf(ep) {
  const u = ep.units.find(u => u.category === 'buffer');
  return u ? u.unit : null;
}

// Inserter filter as a content gate (which items it will move), or null when it
// passes everything.
function filterSpec(r) {
  if (!r || !r.useFilters || !r.filters?.length) return null;
  const items = r.filters.map(filterEntryToItem).filter(Boolean);
  if (!items.length) return null;
  return { mode: r.filterMode ?? 'whitelist', items };
}

// Machine drain: pickup(from) is a machine, the item is its recipe output. Overlay
// each occupying machine's recipe timeline on the edge lifetime, map recipe → output
// item, narrow by the inserter's filter. `dst` (belt lane or buffer) is set by the caller.
function resolveDrainWindows(state, e) {
  const r = liveRec(state.inserters, e.inserterUnit);
  const windows = [];
  for (const fu of e.from.units) {
    if (fu.category !== 'machine') continue;
    const m = liveRec(state.machines, fu.unit);
    if (!m) continue;
    const fTr = fu.tr ?? (e.tr ?? null);
    for (const rc of (m.recipes ?? [])) {
      const item = recipeOutputItem(rc.recipe);
      if (item == null || !passesFilter(item, r)) continue;
      const w = intersectIvs([e.tb, e.tr ?? null], [fu.tb, fTr], [rc.tb, rc.tr ?? null]);
      if (w) windows.push({ item, tb: w[0], tr: w[1] });
    }
  }
  if (windows.length) e.itemWindows = windows;
}

function recipeOutputItem(recipe) {
  if (!recipe) return null;
  if (FLUID_ONLY.has(recipe)) return null;
  return RECIPE_OVERRIDE[recipe] ?? recipe;
}

function filterEntryToItem(f) {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') return f.name ?? f.item ?? null;
  return null;
}

function passesFilter(item, r) {
  if (!r || !r.useFilters || !r.filters?.length) return true;
  const items = r.filters.map(filterEntryToItem).filter(Boolean);
  if (items.length === 0) return true;
  const mode = r.filterMode ?? 'whitelist';
  if (mode === 'whitelist') return items.includes(item);
  if (mode === 'blacklist') return !items.includes(item);
  return true;
}

const lastUnit = (ep) => ep.units[ep.units.length - 1]?.unit ?? null;

// Node record iff still live. The registries are full-history (state keeps a
// removed entity's record, `tr` stamped), but contents resolution mirrors the
// old live-registry semantics: an entity removed before finalize contributes
// nothing — a removed machine's drain windows, a removed miner's resource and a
// removed inserter's filter are all dropped, exactly as when absence-from-the-
// registry encoded "removed". (Arguably a data-loss quirk; fixing it is a
// behavior change for a separate fork — the byte-identical gate preserves it.)
const liveRec = (reg, unit) => { const r = reg.get(unit); return r && r.tr == null ? r : null; };

// Half-open [tb, tr) intersection of N intervals; null tr ⇒ +∞. Returns [tb, tr] or null.
function intersectIvs(...ivs) {
  const INF = Number.POSITIVE_INFINITY;
  let lo = -INF, hi = INF;
  for (const [a, b] of ivs) {
    if (a > lo) lo = a;
    const B = b == null ? INF : b;
    if (B < hi) hi = B;
  }
  return hi <= lo ? null : [lo, hi === INF ? null : hi];
}

// The shipped edge ledger: every edge ever minted, build-ordered. Each record
// is already plain JSON — { id, tb, tr?, from, to, inserterUnit?|minerUnit?,
// itemWindows? (static source), src?/dst? (dynamic source → target), transferFilter? },
// each endpoint a { tile?, units[], segs?, side? }. Owner-less records are belt↔belt
// edges. Consumers slice the timelines by tick.
export function finalize(state) {
  for (const e of state.edges.values()) annotateContents(state, e);
  return { edges: [...state.edges.values()].sort((a, b) => (a.tb - b.tb) || a.id.localeCompare(b.id)) };
}
