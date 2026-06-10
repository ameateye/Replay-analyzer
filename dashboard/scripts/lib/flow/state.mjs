// Shared flow state container + the single registrar.
//
// One state object threaded through the flow pipeline. This module owns
// REGISTRATION for every entity category: registerEvent folds entity events
// into per-entity records and the per-tile histories. Records are
// FULL-HISTORY — a removed entity's record stays, with `tr` stamped — so
// finalize-time derivations (edges, clusters) read whole lifetimes here.
// (`state.belts` is additionally kept as a live-delete VIEW of the belt
// records for the partition — see the belt section.)
//
// Everything recorded carries `seq` — one monotone counter bumped per
// recorded action. Ticks order the run; seqs order WITHIN a tick: mid-tick
// state is observable (an edge minted at event k seeds from the tile state as
// of event k), so the finalize replay needs sub-tick ordering.
//
// Registration is per-entity, event-local folding: this module never reads
// another entity's record and never computes a relation. Derivations live
// elsewhere: segments.mjs owns the belt partition, edges.mjs derives the edge
// ledger at finalize. See docs/specs/flow_pipeline_structure.md.
import { readFileSync } from 'node:fs';
import { tileKey, floorTile, minerDrop, footprintTiles, footprintBBox } from './util.mjs';

// ── prototypes (loaded once from game-data) ───────────────────
const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const REACH      = PROTO.inserterReach;            // name → 1|2 (keys = inserter-name set)
const INSERTERS  = new Set(Object.keys(REACH));
const MACHINE_FP = PROTO.footprints.machine;       // name → footprint size
const MINER_FP   = PROTO.footprints.miner;
const BUFFER_FP  = PROTO.footprints.buffer;        // name → footprint size (chests / tanks)

export function createFlowState() {
  return {
    seq: 0,               // monotone action counter (sub-tick ordering; see header)
    // ── belt-segment slice (records fold here; partition in segments.mjs) ──
    belts:    new Map(),  // unit → folded belt rec — LIVE view (delete on removal)
    beltHist: new Map(),  // unit → the same rec objects, full-history (`tr` stamped)
    segOf:    new Map(),  // unit → live segment id
    segs:     new Map(),  // segment id → live segment record
    retired:  [],         // segments closed by merge / split / death
    nextSeg: 0,
    // ── belt-edge slice (cross-segment belt connections) ──
    // A belt edge is a belt output feeder→consumer whose two endpoints sit in
    // DIFFERENT live segments — i.e. an output NOT in sameSegmentNeighbours.
    // segments.reconcile re-derives each dirty feeder's cross-segment outputs
    // and emits belt-edge-added / belt-edge-removed deltas; `beltEdges` is the
    // live diff baseline (keyed by feeder: an edge is owned by its feeder's
    // output, and dirtyMark makes the feeder dirty whenever a consumer it feeds
    // changes, so the diff stays local). `beltEdgeLog` is the seq-stamped delta
    // history segments.advance appends — the finalize replay's mint/retire source.
    beltEdges:   new Map(),  // feederUnit → Set<consumerUnit> (live cross-segment outputs)
    beltEdgeLog: [],         // { op: 'add'|'rm', feeder, consumer, tick, seq }

    // ── node registries (this module) ──
    // FULL-HISTORY records, keyed by unit; `tr`/`trSeq` stamped on removal,
    // record kept. Owners (inserters / miners) carry a direction timeline
    // `dirs` — each direction interval is one edge shell at finalize.
    machines:  new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, tb, tr, trSeq, recipes }
    miners:    new Map(),  // unit → { kind, unit, name, location, direction, dirs, footprint, tiles, bbox, dropTile, tb, tr, trSeq, resource }
    buffers:   new Map(),  // unit → { unit, name, location, footprint, tiles, bbox, tb, tr, trSeq, storedItemDominant }
    inserters: new Map(),  // unit → { kind, unit, name, location, tile, direction, dirs, reach, tb, tr, trSeq, useFilters, filterMode, filters }

    // ── per-tile histories (the finalize replay's ground truth) ──
    // tileEntities: occupancy INTERVALS per tile, written by exactly the old
    // live-index call sites (node registration here; belt join/leave in
    // segments). Current occupant = last open interval; the replay seeds an
    // endpoint from the interval containing the mint seq.
    tileEntities: new Map(),  // tileKey → [{ unit, category, name, tb, seqB, tr?, seqR? }]
    // passive: the moments where the live edge logger morphed endpoints in
    // place — machines+buffers open/close their footprint tiles at build /
    // remove; belts open ('o') at build/replace, close ('c') at remove, and
    // log rotations ('r') at floorTile(location). Miners never log: they were
    // owner-only (their lingering-tile seed behavior rides tileEntities).
    passive: new Map(),  // tileKey → [{ op: 'o'|'c'|'r', unit, category?, tick, seq }]
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
// downstream sees no record and skips the entity, as before.
// Owners (inserters / miners) start their direction timeline `dirs` here: each
// direction interval becomes one edge shell at finalize (rotation = retire +
// mint, as the live logger did).
function regBuilt(state, ev, unit) {
  const tick = ev.tick;
  if (ev.category === 'machine') {
    const fp = MACHINE_FP[ev.name];
    if (fp == null) return;
    const tiles = footprintTiles(ev.location, fp);
    state.machines.set(unit, { unit, name: ev.name, location: ev.location, footprint: fp, tiles,
                               bbox: footprintBBox(ev.location, fp), tb: tick, tr: null, trSeq: null, recipes: [] });
    writeTiles(state, tiles, unit, 'machine', ev.name);
    passiveOpen(state, tiles, unit, 'machine', tick);
  } else if (ev.category === 'miner') {
    const fp = MINER_FP[ev.name];
    if (fp == null) return;
    const tiles = footprintTiles(ev.location, fp);
    const dir = ev.direction ?? 0;
    writeTiles(state, tiles, unit, 'miner', ev.name);
    state.miners.set(unit, { kind: 'miner', unit, name: ev.name, location: ev.location, direction: dir,
                             dirs: [{ dir, tick, seq: ++state.seq }],
                             footprint: fp, tiles, bbox: footprintBBox(ev.location, fp),
                             dropTile: minerDrop(ev.location, dir, fp), tb: tick, tr: null, trSeq: null,
                             resource: Array.isArray(ev.resources) ? (ev.resources[0] ?? null) : null });
  } else if (ev.category === 'inserter') {
    if (!INSERTERS.has(ev.name)) return;
    const dir = ev.direction ?? 0;
    state.inserters.set(unit, {
      kind: 'inserter', unit, name: ev.name, location: ev.location, tile: floorTile(ev.location),
      direction: dir, dirs: [{ dir, tick, seq: ++state.seq }],
      reach: REACH[ev.name] ?? 1, tb: tick, tr: null, trSeq: null,
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
                              bbox: footprintBBox(ev.location, fp), tb: tick, tr: null, trSeq: null,
                              storedItemDominant: ev.storedItemDominant ?? null });
    writeTiles(state, tiles, unit, 'buffer', ev.name);
    passiveOpen(state, tiles, unit, 'buffer', tick);
  }
}

function regRemoved(state, unit, tick) {
  const r = state.machines.get(unit) ?? state.miners.get(unit) ?? state.inserters.get(unit) ?? state.buffers.get(unit);
  if (!r || r.tr != null) return;
  r.tr = tick;
  r.trSeq = ++state.seq;
  // Tile clearing mirrors the pre-refactor live registries exactly: machines
  // and buffers clear their tiles (and close their passive intervals); MINERS
  // DO NOT (a removed miner's tiles stay in the index until overwritten —
  // long-standing behavior the byte-identical gate preserves); inserters were
  // never indexed.
  if (state.machines.has(unit) || state.buffers.has(unit)) {
    clearTiles(state, r.tiles, unit);
    passiveClose(state, r.tiles, unit, tick);
  }
}

// Fold mutate fields into the record; a real direction change extends the
// owner's direction timeline (one shell per interval at finalize).
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
  r.dirs.push({ dir: ev.direction, tick: ev.tick, seq: ++state.seq });
  if (r.kind === 'miner') r.dropTile = minerDrop(r.location, r.direction, r.footprint);
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
// One record object, two views: `state.belts` is the partition's LIVE working
// set (removal deletes the entry — the partition and the live belt-edge diff
// read absence as "gone"); `state.beltHist` keeps every record, `tr`/`trSeq`
// stamped, for the finalize replay. Belt records carry a direction timeline
// (`dirs` — lane sides are evaluated at a seq) and a segment-membership
// timeline (`segTl` — appended by segments' join).
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
      addBelt(state, ev, ev.unit);
      passivePush(state, floorTile(ev.location), { op: 'o', unit: ev.unit, category: 'belt', tick: ev.tick, seq: ++state.seq });
      break;
    case 'entity-removed': {
      const b = belts.get(ev.unit);
      belts.delete(ev.unit);
      if (b) { b.tr = ev.tick; b.trSeq = ++state.seq; }
      passivePush(state, floorTile(ev.location), { op: 'c', unit: ev.unit, tick: ev.tick, seq: ++state.seq });
      break;
    }
    case 'entity-mutated': {
      const b = belts.get(ev.unit);
      if (!b) return;                 // no record → nothing folded, nothing dirty
      if (ev.direction !== undefined) {
        if (ev.direction !== b.direction) b.dirs.push({ dir: ev.direction, tick: ev.tick, seq: ++state.seq });
        b.direction = ev.direction;
        // the live logger re-resolved lane sides on EVERY direction mutation,
        // value-changed or not — log the rotation unconditionally
        passivePush(state, floorTile(b.location), { op: 'r', unit: ev.unit, tick: ev.tick, seq: ++state.seq });
      }
      if (ev.beltToGroundType !== undefined) b.beltToGroundType = ev.beltToGroundType;
      if (ev.undergroundPair  !== undefined) b.undergroundPair = ev.undergroundPair;
      if (ev.beltInputs       !== undefined) b.beltInputs = toSet(ev.beltInputs);
      if (ev.beltOutputs      !== undefined) b.beltOutputs = toSet(ev.beltOutputs);
      if (ev.splitterFilter         !== undefined) b.splitterFilter = ev.splitterFilter;
      if (ev.splitterInputPriority  !== undefined) b.splitterInputPriority = ev.splitterInputPriority;
      if (ev.splitterOutputPriority !== undefined) b.splitterOutputPriority = ev.splitterOutputPriority;
      break;
    }
    case 'entity-replaced': {
      addBelt(state, ev, ev.newUnit);
      const old = belts.get(ev.oldUnit);
      belts.delete(ev.oldUnit);
      if (old) { old.tr = ev.tick; old.trSeq = ++state.seq; }
      // a replace opens the new unit in place; the live logger never closed the
      // old one (openUnit's implicit displacement covers it)
      passivePush(state, floorTile(ev.location), { op: 'o', unit: ev.newUnit, category: 'belt', tick: ev.tick, seq: ++state.seq });
      break;
    }
  }
  return { dirty };
}

// The folded belt rec. `tb` lives here, not on the segment tile entry, because
// it's the entity's identity — it survives segment churn.
function addBelt(state, e, unit) {
  const seq = ++state.seq;
  const rec = {
    unit,
    name: e.name,
    beltType: e.beltType,
    direction: e.direction ?? 0,
    location: e.location,
    tb: e.tick ?? null,
    tr: null,
    beltToGroundType: e.beltToGroundType ?? null,
    undergroundPair: e.undergroundPair ?? null,
    beltInputs: toSet(e.beltInputs),
    beltOutputs: toSet(e.beltOutputs),
    splitterFilter: e.splitterFilter ?? null,
    splitterInputPriority: e.splitterInputPriority ?? null,
    splitterOutputPriority: e.splitterOutputPriority ?? null,
    seqB: seq, trSeq: null,
    dirs: [{ dir: e.direction ?? 0, tick: e.tick ?? null, seq }],
    segTl: [],
  };
  state.belts.set(unit, rec);
  state.beltHist.set(unit, rec);
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
  for (const t of tiles) setEntityTile(state, t.x, t.y, { unit, category, name });
}

function clearTiles(state, tiles, unit) {
  for (const t of tiles) clearEntityTile(state, t.x, t.y, unit);
}

function passivePush(state, tile, entry) {
  const k = tileKey(tile.x, tile.y);
  let l = state.passive.get(k);
  if (!l) state.passive.set(k, l = []);
  l.push(entry);
}

function passiveOpen(state, tiles, unit, category, tick) {
  for (const t of tiles) passivePush(state, t, { op: 'o', unit, category, tick, seq: ++state.seq });
}

function passiveClose(state, tiles, unit, tick) {
  for (const t of tiles) passivePush(state, t, { op: 'c', unit, tick, seq: ++state.seq });
}

// ── tile occupancy (interval log; live semantics preserved) ───

// Open an occupancy interval at (x, y), closing the current one — last writer
// wins, as in the old live map.
export function setEntityTile(state, x, y, rec) {
  const k = tileKey(x, y);
  let log = state.tileEntities.get(k);
  if (!log) state.tileEntities.set(k, log = []);
  const seq = ++state.seq;
  const last = log[log.length - 1];
  if (last && last.seqR == null) last.seqR = seq;
  log.push({ unit: rec.unit, category: rec.category, name: rec.name, seqB: seq });
}

// Close the open interval at (x, y) iff it is still held by `unit` (guards
// against clobbering a tile a newer entity already took over).
export function clearEntityTile(state, x, y, unit) {
  const log = state.tileEntities.get(tileKey(x, y));
  const last = log?.[log.length - 1];
  if (last && last.seqR == null && last.unit === unit) last.seqR = ++state.seq;
}
