// Shared flow state container.
//
// One state object threaded through the flow pipeline. The belt-segment slice
// is owned by segments.mjs; the edge slice (entity registries + tile index +
// edge ledger) is owned by edges.mjs. Each module reads/writes only its own
// slice — the container just unifies ownership so the orchestrator threads one
// object, and so cross-tier lookups (edges reading the belt graph, or resolving
// a belt unit's segment) need no ctx indirection. See docs/specs/flow_edges_core.md.
//
// Kept self-contained (no lib/flow imports). `tk` matches geometry.mjs's tileKey
// format (`${x},${y}`) so the shared tile index keys identically to the logger.
const tk = (x, y) => `${x},${y}`;

export function createFlowState() {
  return {
    // ── belt-segment slice (segments.mjs) ──
    belts:   new Map(),   // unit → folded belt entity rec
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

    // ── edge slice (edges.mjs) ──
    // Entity registries, keyed by unit. Belts live in `belts` above (segments
    // owns them); machines/miners/buffers/inserters are the edge layer's.
    machines:  new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, currentRecipe, tb, tr? }
    miners:    new Map(),  // unit → { unit, name, location, direction, footprint, tiles, bbox, resource, dropTile, tb, tr? }
    buffers:   new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, currentStoredItem, tb, tr? }
    inserters: new Map(),  // unit → { unit, name, location, tile, direction, reach, useFilters, filterMode, filters, tb, tr? }
    // Unified tile → entity index over ALL physical categories (belts, machines,
    // miners, buffers). The edges logger writes every category here so a single
    // findEntityInTile resolves an inserter's pickup/drop without a per-category
    // probe; segments stays tile-index-free.
    tileEntities: new Map(),  // tileKey → { unit, category, name }
    // Edge store + reverse indices. edgesBySegment drives the affected-only
    // segment-event update (never scan every segment).
    edges:           new Map(),  // edgeId → edge (live; tr set when retired)
    nextEdgeId:      0,
    edgesByInserter: new Map(),  // unit  → Set<edgeId>
    edgesByMiner:    new Map(),  // unit  → Set<edgeId>
    edgesByMachine:  new Map(),  // unit  → Set<edgeId>
    edgesBySegment:  new Map(),  // segId → Set<edgeId>
  };
}

// ── shared accessors ─────────────────────────────────────────

// Entity occupying a tile (belt / machine / miner / buffer), or null.
export function findEntityInTile(state, x, y) {
  return state.tileEntities.get(tk(x, y)) ?? null;
}

// Index `rec = { unit, category, name }` at tile (x, y). Last writer wins —
// callers clear a unit's tiles on removal before a new entity reuses them.
export function setEntityTile(state, x, y, rec) {
  state.tileEntities.set(tk(x, y), rec);
}

// Clear tile (x, y) iff it is still held by `unit` (guards against clobbering a
// tile a newer entity already took over).
export function clearEntityTile(state, x, y, unit) {
  const k = tk(x, y);
  const cur = state.tileEntities.get(k);
  if (cur && cur.unit === unit) state.tileEntities.delete(k);
}

// Live segment record a belt unit currently belongs to, or null. Bridges a belt
// endpoint → its segment for edge segment-timeline updates.
export function getSegmentFromUnit(state, unit) {
  const sid = state.segOf.get(unit);
  return sid != null ? (state.segs.get(sid) ?? null) : null;
}
