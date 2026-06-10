// Shared flow state container + the single registrar.
//
// One state object threaded through the flow pipeline. This module owns
// REGISTRATION for every entity category: registerEvent folds entity events
// into per-entity records and maintains the tile→entity index. Node records
// (machines / miners / inserters / buffers) are FULL-HISTORY — a removed
// entity's record stays, with `tr` stamped — so finalize-time derivations
// (clusters) read the whole lifetime here instead of re-registering from the
// merged stream. Belt records keep live-delete semantics (see the belt
// section). Registration is per-entity, event-local folding: this module
// never reads another entity's record and never computes a relation.
// Derivations live elsewhere: segments.mjs owns the belt partition, edges.mjs
// owns the edge ledger. See docs/specs/flow_pipeline_structure.md.
//
// Kept self-contained (no lib/flow imports). `tileKey` is the one tile-key
// format (`${x},${y}`); it's exported so the edge logger keys edgesByTile
// identically instead of re-deriving its own.
import { readFileSync } from 'node:fs';

export const tileKey = (x, y) => `${x},${y}`;

// ── prototypes (loaded once from game-data) ───────────────────
const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const REACH      = PROTO.inserterReach;            // name → 1|2 (keys = inserter-name set)
const INSERTERS  = new Set(Object.keys(REACH));
const MACHINE_FP = PROTO.footprints.machine;       // name → footprint size
const MINER_FP   = PROTO.footprints.miner;
const BUFFER_FP  = PROTO.footprints.buffer;        // name → footprint size (chests / tanks)

// ── registration geometry (cardinal dirs only; y points down) ─
const DV = { 0: { x: 0, y: -1 }, 4: { x: 1, y: 0 }, 8: { x: 0, y: 1 }, 12: { x: -1, y: 0 } }; // N E S W
const floorTile = (loc) => ({ x: Math.floor(loc.x), y: Math.floor(loc.y) });
const minerDrop = (loc, dir, fp) => { const v = DV[dir]; if (!v) return null; const r = fp / 2 + 0.5; return { x: Math.floor(loc.x + v.x * r), y: Math.floor(loc.y + v.y * r) }; };

function footprintTiles(loc, size) {
  const half = size / 2;
  const minX = Math.floor(loc.x - half), maxX = Math.floor(loc.x + half - 1e-6);
  const minY = Math.floor(loc.y - half), maxY = Math.floor(loc.y + half - 1e-6);
  const tiles = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) tiles.push({ x, y });
  return tiles;
}

function footprintBBox(loc, size) {
  const half = size / 2;
  return {
    minX: Math.floor(loc.x - half),
    minY: Math.floor(loc.y - half),
    maxX: Math.floor(loc.x + half - 1e-6),
    maxY: Math.floor(loc.y + half - 1e-6),
  };
}

export function createFlowState() {
  return {
    // ── belt-segment slice (records fold here; partition in segments.mjs) ──
    belts:   new Map(),   // unit → folded belt entity rec (live-delete, see regBelt)
    segOf:   new Map(),   // unit → live segment id
    segs:    new Map(),   // segment id → live segment record
    retired: [],          // segments closed by merge / split / death
    nextSeg: 0,
    // ── belt-edge slice (cross-segment belt connections) ──
    // A belt edge is a belt output feeder→consumer whose two endpoints sit in
    // DIFFERENT live segments — i.e. an output NOT in sameSegmentNeighbours.
    // segments.reconcile re-derives each dirty feeder's cross-segment outputs
    // and emits belt-edge-added / belt-edge-removed; edges.mjs ledgers E-ids +
    // lane side (enriched from belt locations) off that stream. Keyed by feeder
    // because an edge is owned by its feeder's output; a dirty feeder recomputes
    // only its own outputs (dirtyMark makes the feeder dirty whenever a consumer
    // it feeds changes, so the diff stays local).
    beltEdges: new Map(),  // feederUnit → Set<consumerUnit> (live cross-segment outputs)

    // ── node registries (this module) ──
    // FULL-HISTORY records, keyed by unit; `tr` stamped on removal, record kept.
    // Loop-time consumers (edges.mjs) must check `tr == null` where they relied
    // on the old live registry's absence-means-removed semantics.
    machines:  new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, tb, tr, recipes }
    miners:    new Map(),  // unit → { kind, unit, name, location, direction, footprint, tiles, bbox, dropTile, edgeId, tb, tr, resource }
    buffers:   new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, tb, tr, storedItemDominant }
    inserters: new Map(),  // unit → { kind, unit, name, location, tile, direction, reach, edgeId, tb, tr, useFilters, filterMode, filters }
    // Unified tile → entity index over ALL physical categories (belts, machines,
    // miners, buffers). Registration writes every category here so a single
    // findEntityInTile resolves an inserter's pickup/drop without a per-category
    // probe; segments stays tile-index-free. The index is LIVE-state (current
    // occupant), not temporal.
    tileEntities: new Map(),  // tileKey → { unit, category, name }

    // ── edge slice (edges.mjs) ──
    // Edge store + reverse indices. edgesBySegment drives the affected-only
    // segment-event update (never scan every segment).
    edges:      new Map(),  // edgeId → edge (live; tr set when retired)
    nextEdgeId: 0,
    // The ONLY edge index. An edge is identified by its (fromTile → toTile); a
    // machine/belt appearing or leaving a tile looks up the OWNED edges anchored
    // there and opens/closes the endpoint's unit interval in place (a quick-replace
    // gives a new unit but the same edge). Owner→edge is 1:1, so the inserter/miner
    // rec carries its own edgeId — no owner index. Belt-belt edges are stream-managed
    // and not tile-indexed. Segment is resolved on demand (getSegmentFromUnit), not
    // stored, so there's no segment index either.
    edgesByTile: new Map(),  // tileKey → Set<edgeId>  (owned edges' endpoint tiles)
  };
}

// ── registration (the per-event fold) ────────────────────────
// Folds one event into the entity records + tile index. Runs BEFORE the
// edges applier for the same event, so it reads post-fold records; the
// returned delta carries what downstream can no longer see (pre-fold values).
export function registerEvent(state, ev) {
  if (ev.category === 'belt') return regBelt(state, ev);
  switch (ev.type) {
    case 'entity-built':    return regBuilt(state, ev, ev.unit);
    case 'entity-removed':  return regRemoved(state, ev.unit, ev.tick);
    case 'entity-replaced': regRemoved(state, ev.oldUnit, ev.tick); return regBuilt(state, ev, ev.newUnit);
    case 'entity-mutated':  return regMutated(state, ev);
    case 'recipe-changed':  return regRecipe(state, ev);
  }
}

// Unknown prototypes (no footprint / reach entry) don't register at all —
// downstream appliers see no record and skip the entity, as before.
function regBuilt(state, ev, unit) {
  const tick = ev.tick;
  if (ev.category === 'machine') {
    const fp = MACHINE_FP[ev.name];
    if (fp == null) return;
    const tiles = footprintTiles(ev.location, fp);
    state.machines.set(unit, { unit, name: ev.name, location: ev.location, footprint: fp, tiles,
                               bbox: footprintBBox(ev.location, fp), tb: tick, tr: null, recipes: [] });
    writeTiles(state, tiles, unit, 'machine', ev.name);
  } else if (ev.category === 'miner') {
    const fp = MINER_FP[ev.name];
    if (fp == null) return;
    const tiles = footprintTiles(ev.location, fp);
    state.miners.set(unit, { kind: 'miner', unit, name: ev.name, location: ev.location, direction: ev.direction ?? 0,
                             footprint: fp, tiles, bbox: footprintBBox(ev.location, fp),
                             dropTile: minerDrop(ev.location, ev.direction ?? 0, fp), edgeId: null, tb: tick, tr: null,
                             resource: Array.isArray(ev.resources) ? (ev.resources[0] ?? null) : null });
    writeTiles(state, tiles, unit, 'miner', ev.name);
  } else if (ev.category === 'inserter') {
    if (!INSERTERS.has(ev.name)) return;
    state.inserters.set(unit, {
      kind: 'inserter', unit, name: ev.name, location: ev.location, tile: floorTile(ev.location),
      direction: ev.direction ?? 0, reach: REACH[ev.name] ?? 1, edgeId: null, tb: tick, tr: null,
      // Filter spec narrows which of a drained machine's outputs actually rides the belt.
      useFilters: !!ev.inserterUseFilters,
      filterMode: ev.inserterFilterMode ?? null,
      filters: Array.isArray(ev.inserterFilters) ? ev.inserterFilters.slice() : [],
    });
  } else if (ev.category === 'buffer') {
    const fp = BUFFER_FP[ev.name];
    if (fp == null) return;
    const tiles = footprintTiles(ev.location, fp);
    state.buffers.set(unit, { unit, name: ev.name, location: ev.location, footprint: fp, tiles,
                              bbox: footprintBBox(ev.location, fp), tb: tick, tr: null,
                              storedItemDominant: ev.storedItemDominant ?? null });
    writeTiles(state, tiles, unit, 'buffer', ev.name);
  }
}

function regRemoved(state, unit, tick) {
  const r = state.machines.get(unit) ?? state.miners.get(unit) ?? state.inserters.get(unit) ?? state.buffers.get(unit);
  if (!r || r.tr != null) return;
  r.tr = tick;
  // Tile-index clearing mirrors the pre-refactor live registries exactly:
  // machines and buffers clear their tiles; MINERS DO NOT (a removed miner's
  // tiles stay in the index until overwritten — long-standing behavior the
  // byte-identical gate preserves); inserters were never indexed.
  if (state.machines.has(unit) || state.buffers.has(unit)) clearTiles(state, r.tiles, unit);
}

// Fold mutate fields into the record. Returns the delta the edge applier needs:
// it can no longer compare against the pre-fold direction, so the fold reports
// whether the direction changed (a rotation retires + re-mints the owner edge).
function regMutated(state, ev) {
  const r = state.inserters.get(ev.unit) ?? state.miners.get(ev.unit);
  if (!r) return;
  if (r.kind === 'inserter') {
    if (ev.inserterUseFilters !== undefined) r.useFilters = !!ev.inserterUseFilters;
    if (ev.inserterFilterMode !== undefined) r.filterMode = ev.inserterFilterMode;
    if (Array.isArray(ev.inserterFilters))   r.filters = ev.inserterFilters.slice();
  }
  if (ev.direction === undefined || ev.direction === r.direction) return;
  r.direction = ev.direction;
  if (r.kind === 'miner') r.dropTile = minerDrop(r.location, r.direction, r.footprint);
  return { directionChanged: true };
}

// A machine's recipe is kept as a per-machine TIMELINE — edges live across
// recipe changes (they're topological), and contents resolution later
// intersects the timeline with each draining edge's lifetime. Successive
// same-recipe events collapse; a real change closes the prior interval and
// opens a new one. Dead machines don't fold (mirrors the live registry).
function regRecipe(state, ev) {
  const m = state.machines.get(ev.unit);
  if (!m || m.tr != null) return;
  const last = m.recipes[m.recipes.length - 1];
  if (last) {
    if (last.recipe === ev.recipe) return;
    if (last.tr == null) last.tr = ev.tick;
  }
  m.recipes.push({ recipe: ev.recipe, tb: ev.tick, tr: null });
}

// ── belt registration ─────────────────────────────────────────
// Belt records keep LIVE-DELETE semantics (removal deletes the record): the
// partition and edge layers read absence as "gone" throughout
// (sameSegmentNeighbours, reconcile's departure pass, resolveBeltEdge, …).
// Full-history belt records are deferred to the edges→finalize step, which
// is what needs them.
//
// The returned delta is segments' DIRTY MARK — the event's entity plus
// everything in its inputs and outputs, BEFORE and after the fold. A removed
// belt's pre-fold neighbour links are unreachable once the fold lands, which
// is why registration reports them. No reverse scan.
function regBelt(state, ev) {
  const belts = state.belts;
  const dirty = beltDirtyMark(belts, ev);
  switch (ev.type) {
    case 'entity-built':
      addBelt(belts, ev);
      break;
    case 'entity-removed':
      belts.delete(ev.unit);
      break;
    case 'entity-mutated': {
      const b = belts.get(ev.unit);
      if (!b) return;                 // no record → nothing folded, nothing dirty
      if (ev.direction        !== undefined) b.direction = ev.direction;
      if (ev.beltToGroundType !== undefined) b.beltToGroundType = ev.beltToGroundType;
      if (ev.undergroundPair  !== undefined) b.undergroundPair = ev.undergroundPair;
      if (ev.beltInputs       !== undefined) b.beltInputs = toSet(ev.beltInputs);
      if (ev.beltOutputs      !== undefined) b.beltOutputs = toSet(ev.beltOutputs);
      if (ev.splitterFilter         !== undefined) b.splitterFilter = ev.splitterFilter;
      if (ev.splitterInputPriority  !== undefined) b.splitterInputPriority = ev.splitterInputPriority;
      if (ev.splitterOutputPriority !== undefined) b.splitterOutputPriority = ev.splitterOutputPriority;
      break;
    }
    case 'entity-replaced':
      addBelt(belts, { ...ev, unit: ev.newUnit });
      belts.delete(ev.oldUnit);
      break;
  }
  return { dirty };
}

// The folded belt rec. `tb` lives here, not on the segment tile entry, because
// it's the entity's identity — it survives segment churn.
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

function beltDirtyMark(belts, e) {
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

function toSet(v) {
  if (Array.isArray(v) || v instanceof Set) return new Set(v);
  return new Set();
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

// ── shared accessors ─────────────────────────────────────────

// Entity occupying a tile (belt / machine / miner / buffer), or null.
export function findEntityInTile(state, x, y) {
  return state.tileEntities.get(tileKey(x, y)) ?? null;
}

// Index `rec = { unit, category, name }` at tile (x, y). Last writer wins —
// callers clear a unit's tiles on removal before a new entity reuses them.
export function setEntityTile(state, x, y, rec) {
  state.tileEntities.set(tileKey(x, y), rec);
}

// Clear tile (x, y) iff it is still held by `unit` (guards against clobbering a
// tile a newer entity already took over).
export function clearEntityTile(state, x, y, unit) {
  const k = tileKey(x, y);
  const cur = state.tileEntities.get(k);
  if (cur && cur.unit === unit) state.tileEntities.delete(k);
}

// Live segment record a belt unit currently belongs to, or null. Bridges a belt
// endpoint → its segment for edge segment-timeline updates.
export function getSegmentFromUnit(state, unit) {
  const sid = state.segOf.get(unit);
  return sid != null ? (state.segs.get(sid) ?? null) : null;
}
