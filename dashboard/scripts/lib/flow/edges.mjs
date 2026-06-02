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
// vs-belt is just the current interval's category. applyEvent only DISPATCHES;
// register/mutate/unregister own their edge work. "What entity is at this tile" is
// answered once, by state (findEntityInTile); segment and belt-lane `side` are
// resolved through single helpers. Throughput and filters are deferred.

import { readFileSync } from 'node:fs';
import { findEntityInTile, getSegmentFromUnit, tileKey } from './state.mjs';

// ── prototypes (loaded once from game-data) ───────────────────
const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const REACH      = PROTO.inserterReach;            // name → 1|2 (keys = inserter-name set)
const INSERTERS  = new Set(Object.keys(REACH));
const MACHINE_FP = PROTO.footprints.machine;       // name → footprint size
const MINER_FP   = PROTO.footprints.miner;

// ── geometry (cardinal dirs only, 16-way; y points down) ──────
const DV   = { 0: { x: 0, y: -1 }, 4: { x: 1, y: 0 }, 8: { x: 0, y: 1 }, 12: { x: -1, y: 0 } }; // N E S W
const OPP  = { 0: 8, 4: 12, 8: 0, 12: 4 };
const LEFT = { 0: 12, 4: 0, 8: 4, 12: 8 };
const floorTile  = (loc) => ({ x: Math.floor(loc.x), y: Math.floor(loc.y) });
const tileCenter = (t) => ({ x: t.x + 0.5, y: t.y + 0.5 });        // the one +0.5 (1×1 entities centre here)
const sameTile   = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const stepTile   = (t, dir, dist) => { const v = DV[dir] ?? { x: 0, y: 0 }; return { x: t.x + v.x * dist, y: t.y + v.y * dist }; };
const minerDrop  = (loc, dir, fp) => { const v = DV[dir]; if (!v) return null; const r = fp / 2 + 0.5; return { x: Math.floor(loc.x + v.x * r), y: Math.floor(loc.y + v.y * r) }; };

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

// Side of the consumer relative to a belt→belt feeder (cross-segment connection).
function beltToBeltSide(state, feeder, consumer) {
  const f = state.belts.get(feeder), c = state.belts.get(consumer);
  if (!f || !c || f.direction === c.direction) return 'right';
  const fc = tileCenter(floorTile(f.location)), cc = tileCenter(floorTile(c.location));
  return sideAlong(f.direction, cc.x - fc.x, cc.y - fc.y);
}

// ── dispatch ──────────────────────────────────────────────────
export function applyEvent(state, ev) {
  switch (ev.type) {
    case 'entity-built':    return onBuilt(state, ev);
    case 'entity-removed':  return onRemoved(state, ev);
    case 'entity-mutated':  return onMutated(state, ev);
    case 'entity-replaced': return onReplaced(state, ev);
  }
}

function onBuilt(state, ev) {
  if (ev.category === 'machine')  return registerMachine(state, ev);
  if (ev.category === 'miner')    return registerMiner(state, ev);
  if (ev.category === 'inserter') return registerInserter(state, ev);
  if (ev.category === 'belt')     return openEndpointAt(state, floorTile(ev.location), ev.unit, 'belt', ev.tick);
}

function onRemoved(state, ev) {
  if (ev.category === 'belt')        return closeEndpointAt(state, floorTile(ev.location), ev.unit, ev.tick);
  if (state.machines.has(ev.unit))   return unregisterMachine(state, ev.unit, ev.tick);
  if (state.miners.has(ev.unit))     return unregisterMiner(state, ev.unit, ev.tick);
  if (state.inserters.has(ev.unit))  return unregisterInserter(state, ev.unit, ev.tick);
}

function onMutated(state, ev) {
  if (ev.category === 'belt') {
    const b = state.belts.get(ev.unit);
    if (ev.direction !== undefined && b) refreshSidesAt(state, floorTile(b.location));
    return;
  }
  if (state.inserters.has(ev.unit)) return mutateInserter(state, ev);
  if (state.miners.has(ev.unit))    return mutateMiner(state, ev);
}

// A replace is same-tile, new unit. Endpoints (machine/belt) re-open in place;
// owners (inserter/miner) are a fresh owner, so retire the old and register anew.
function onReplaced(state, ev) {
  if (ev.category === 'belt')     return openEndpointAt(state, floorTile(ev.location), ev.newUnit, 'belt', ev.tick);
  if (ev.category === 'machine')  { unregisterMachine(state, ev.oldUnit, ev.tick); return registerMachine(state, { ...ev, unit: ev.newUnit }); }
  if (ev.category === 'miner')    { unregisterMiner(state, ev.oldUnit, ev.tick);   return registerMiner(state, { ...ev, unit: ev.newUnit }); }
  if (ev.category === 'inserter') { unregisterInserter(state, ev.oldUnit, ev.tick); return registerInserter(state, { ...ev, unit: ev.newUnit }); }
}

// ── owners (inserter / miner): mint + retire their own edge ───
function registerInserter(state, ev) {
  if (!INSERTERS.has(ev.name)) return;
  const r = {
    kind: 'inserter', unit: ev.unit, name: ev.name, location: ev.location, tile: floorTile(ev.location),
    direction: ev.direction ?? 0, reach: REACH[ev.name] ?? 1, edgeId: null, tb: ev.tick,
  };
  state.inserters.set(ev.unit, r);
  mintOwnerEdge(state, r, ev.tick);
}

function registerMiner(state, ev) {
  const fp = MINER_FP[ev.name];
  if (fp == null) return;
  const { tiles } = footprint(ev.location, fp);
  const r = {
    kind: 'miner', unit: ev.unit, name: ev.name, location: ev.location, direction: ev.direction ?? 0,
    footprint: fp, tiles, dropTile: minerDrop(ev.location, ev.direction ?? 0, fp), edgeId: null, tb: ev.tick,
  };
  state.miners.set(ev.unit, r);
  writeTiles(state, tiles, ev.unit, 'miner', ev.name);
  mintOwnerEdge(state, r, ev.tick);
}

function mutateInserter(state, ev) {
  rotateOwner(state, state.inserters.get(ev.unit), ev);
}

function mutateMiner(state, ev) {
  const r = state.miners.get(ev.unit);
  if (r && ev.direction !== undefined && ev.direction !== r.direction) r.dropTile = minerDrop(r.location, ev.direction, r.footprint);
  rotateOwner(state, r, ev);
}

// A rotation moves an owner's tiles → retire the old edge and mint a fresh one.
function rotateOwner(state, r, ev) {
  if (!r || ev.direction === undefined || ev.direction === r.direction) return;
  r.direction = ev.direction;
  retireEdge(state, r.edgeId, ev.tick);
  mintOwnerEdge(state, r, ev.tick);
}

function unregisterInserter(state, unit, tick) {
  const r = state.inserters.get(unit);
  if (!r) return;
  retireEdge(state, r.edgeId, tick);
  state.inserters.delete(unit);
}

function unregisterMiner(state, unit, tick) {
  const r = state.miners.get(unit);
  if (!r) return;
  retireEdge(state, r.edgeId, tick);
  state.miners.delete(unit);
}

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

// ── endpoints (machine/belt): passive tile occupants ──────────
function registerMachine(state, ev) {
  const fp = MACHINE_FP[ev.name];
  if (fp == null) return;
  const { tiles } = footprint(ev.location, fp);
  state.machines.set(ev.unit, { unit: ev.unit, name: ev.name, location: ev.location, footprint: fp, tiles, tb: ev.tick });
  writeTiles(state, tiles, ev.unit, 'machine', ev.name);
  for (const t of tiles) openEndpointAt(state, t, ev.unit, 'machine', ev.tick);   // reopen edges if this is a replace
}

function unregisterMachine(state, unit, tick) {
  const r = state.machines.get(unit);
  if (!r) return;
  clearTiles(state, r.tiles, unit);
  for (const t of r.tiles) closeEndpointAt(state, t, unit, tick);                 // close the interval; the edge persists
  state.machines.delete(unit);
}

// An entity (`unit`, `category`) landed at `tile` → open the unit interval on every
// owned edge anchored there, refreshing belt-lane side. The interval carries the
// category, so an endpoint follows a tile that changes type.
function openEndpointAt(state, tile, unit, category, tick) {
  forEdgesAt(state, tile, (e) => {
    for (const ep of [e.from, e.to]) {
      if (!ep.tile || !sameTile(ep.tile, tile)) continue;
      openUnit(ep, unit, category, tick);
      ep.side = category === 'belt' ? sideForEndpoint(state, e, ep) : null;
    }
  });
}

// The entity holding `tile` left → close the interval whose CURRENT unit is it.
// (Unit guard: a same-tick build(new)+remove(old) where remove lands last must not
// clobber the freshly-opened interval.)
function closeEndpointAt(state, tile, unit, tick) {
  forEdgesAt(state, tile, (e) => {
    for (const ep of [e.from, e.to]) if (sameTile(ep.tile, tile) && curUnit(ep) === unit) closeUnit(ep, tick);
  });
}

// Belt at `tile` rotated → re-resolve the lane for any belt endpoint there.
function refreshSidesAt(state, tile) {
  forEdgesAt(state, tile, (e) => {
    for (const ep of [e.from, e.to]) if (ep.tile && sameTile(ep.tile, tile) && curCat(ep) === 'belt') ep.side = sideForEndpoint(state, e, ep);
  });
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

function recTb(state, unit, category) {
  const reg = category === 'belt' ? state.belts
            : category === 'machine' ? state.machines
            : category === 'miner' ? state.miners : null;
  return reg?.get(unit)?.tb ?? null;
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

// Belt endpoint's live segment id, resolved on demand.
export function endpointSegment(state, ep) {
  const u = curUnit(ep);
  return u == null ? null : (getSegmentFromUnit(state, u)?.id ?? null);
}

// ── belt↔belt edges (driven by segments' belt-edge stream) ────
export function mintBeltEdge(state, feeder, consumer, tick) {
  const from = beltEndpoint(state, feeder, tick), to = beltEndpoint(state, consumer, tick);
  if (!from || !to) return;
  to.side = beltToBeltSide(state, feeder, consumer);
  mintEdge(state, { from, to }, tick);                  // no owner → not tile-indexed
}

export function retireBeltEdge(state, feeder, consumer, tick) {
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
  if (edge.inserterUnit != null || edge.minerUnit != null) {       // owned edges are tile-indexed for replace updates
    for (const ep of [edge.from, edge.to]) {
      if (ep.tile) addTile(state, ep.tile, edge.id);
      if (curCat(ep) === 'belt') ep.side = sideForEndpoint(state, edge, ep);
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
    if (ep.tile) state.edgesByTile.get(tileKey(ep.tile.x, ep.tile.y))?.delete(id);
  }
}

function addTile(state, t, id) {
  const k = tileKey(t.x, t.y);
  let s = state.edgesByTile.get(k);
  if (!s) state.edgesByTile.set(k, s = new Set());
  s.add(id);
}

// ── footprint + tile index writes ─────────────────────────────
function footprint(loc, size) {
  const half = size / 2;
  const minX = Math.floor(loc.x - half), maxX = Math.floor(loc.x + half - 1e-6);
  const minY = Math.floor(loc.y - half), maxY = Math.floor(loc.y + half - 1e-6);
  const tiles = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) tiles.push({ x, y });
  return { tiles };
}

function writeTiles(state, tiles, unit, category, name) {
  for (const t of tiles) state.tileEntities.set(tileKey(t.x, t.y), { unit, category, name });
}

function clearTiles(state, tiles, unit) {
  for (const t of tiles) {
    const k = tileKey(t.x, t.y);
    if (state.tileEntities.get(k)?.unit === unit) state.tileEntities.delete(k);
  }
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
    const pickup = stepTile(r.tile, r.direction, r.reach), drop = stepTile(r.tile, OPP[r.direction] ?? r.direction, r.reach);
    const from = findEntityInTile(state, pickup.x, pickup.y), to = findEntityInTile(state, drop.x, drop.y);
    if (!from || !to) continue;
    const side = from.category === 'belt' ? resolveSide(state, from.unit, pickup, r.location, 'pickup')
               : to.category   === 'belt' ? resolveSide(state, to.unit,   drop,   r.location, 'drop') : null;
    out.set(`i${r.unit}`, { from: from.unit, to: to.unit, side });
  }
  for (const r of state.miners.values()) {
    const to = r.dropTile && findEntityInTile(state, r.dropTile.x, r.dropTile.y);
    if (!to) continue;
    const side = to.category === 'belt' ? resolveSide(state, to.unit, r.dropTile, r.location, 'miner') : null;
    out.set(`m${r.unit}`, { from: r.unit, to: to.unit, side });
  }
  for (const [f, set] of state.beltEdges) for (const c of set) out.set(`b${f}>${c}`, { from: f, to: c, side: beltToBeltSide(state, f, c) });
  return out;
}

// Provisional — the process commit owns the real finalize + serialisation.
export function finalize(state) {
  return { edges: [...state.edges.values()].sort((a, b) => (a.tb - b.tb) || a.id.localeCompare(b.id)) };
}
