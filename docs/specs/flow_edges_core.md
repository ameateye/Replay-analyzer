# Flow edges — core rewrite (Commit D)

**Status:** in development. Supersedes the orphaned `dashboard/scripts/lib/flow/edges.mjs`
(the pre-rewrite version that depended on `ctx.beltAt`/`getSideloadsForBelt` and a
per-event full-scan). Builds on the edge-based `segments.mjs` + shared `state.mjs`
(see [segments-edge-rewrite.md](../refactors/segments-edge-rewrite.md)).

Scope is the **edges module + its verification test**. Production wiring (shipping
`flow.edges` from `flow-prep.mjs` + the downstream propagation/`contents` pass) is a
**separate later commit**, not this one.

## Edge contract

An edge is a temporal record with **three independent lifetimes**:

| Field | Meaning |
|---|---|
| `tb` / `tr` (edge) | This *relationship* exists. A **rotation ends the edge and starts a new one.** |
| `from` / `to` **unit** (each `tb`/`tr`) | The endpoint *entity's own* lifetime, denormalised onto the edge. |
| `from` / `to` **segment** (each a `{segId, tb, tr}` timeline) | Which segment the belt endpoint is in. A segment **renumber (merge/split) appends an interval — it does NOT mint a new edge.** |
| `from` / `to` **tile** | Source tile → target tile. **Excluded on the `from` side for miners.** Fixed within an edge (rotation ⇒ new edge). |
| info | (a) belt sides (b) throughput (c) filters. **`item` placement (3) and `throughput` (4) deferred — reserved fields for now.** |

The segment-as-timeline is the crux: it turns the segId "drift" the dirty-only
detector can't chase into a first-class in-place update, driven by segment events.

## Edge kinds

- **drain** — machine → belt (via inserter). `from` = machine, `to` = belt segment.
- **feed** — belt → machine (via inserter). `from` = belt segment, `to` = machine.
- **miner** — miner → belt (direct drop). `from` = miner (no from-tile), `to` = belt segment.
- **belt** — belt → belt cross-segment connection (the unit→unit `belt-edge-*` stream
  from `segments.reconcile`). `from`/`to` both belt segments.

## Helpers (Commit D.1)

In `state.mjs` (shared container grows the edge slice; segments stays connectivity-pure):

- **Registries** — `machines`, `miners`, `buffers`, `inserters` (Maps, keyed by unit).
- **Tile index** — `tileEntities: Map<tileKey, {unit, category, name}>`. **The edges
  logger writes every physical category into it, belts included** — segments keeps its
  "no tile index" ethos. `findEntityInTile(state, x, y)` reads it; `setEntityTile` /
  `clearEntityTile` mutate it.
- **`getSegmentFromUnit(state, unit)`** — `segOf` → live segment record (or `null`).
- **Edge store** — `edges: Map<edgeId, edge>`, `nextEdgeId`, and reverse indices
  `edgesByInserter` / `edgesByMiner` / `edgesByMachine` / **`edgesBySegment`** (the last
  drives the affected-only segment-event update — never scan all segments).

## Logger (Commit D.2)

Per category, on entity events:

- **Inserter** — (1) register into state; (2) classify pickup/drop tiles via geometry
  (`step`/`reach` from `geometry.mjs` + `flow-prototypes.json`) → mint/update a drain or
  feed edge. Pending queue kept (a target tile may be filled thousands of ticks later).
- **Miner** — (1) register; (2) resolve drop tile → mint/update a miner edge. Pending kept.
- **Machine / buffer** — (1) register + write tile index. No edges of their own.
- **Belt** — belts' connectivity is owned by `segments.mjs`; the logger writes belt tiles
  to the index and consumes the **`belt-edge-added` / `belt-edge-removed`** unit→unit
  stream to mint/retire **belt** edges.

## Process (Commit D.3)

Per tick, the orchestrator:

1. **Log** in order: belts (segments) → machines → miners → inserters.
2. After `segments.reconcile`, **update edge segment timelines from the segment events**
   (`segment-merged` / `segment-split` / `segment-retired`) — for each event, walk only
   `edgesBySegment[changed]` and append/close the endpoint's segment interval. Mint/retire
   belt edges from the `belt-edge-*` events. Drain pending inserters/miners on relevant
   topology deltas.

## Invariants + verification test (ships with D.3)

A test driving segments+edges together over a run asserts:

1. **No hanging edge** — every *live* edge endpoint that is a belt unit resolves to a live
   segment (`getSegmentFromUnit` ≠ null); no edge references a belt with no segment.
2. **No classifier contradiction** — for every belt unit an edge points at, the edge's
   recorded `to`/`from` segment (current interval) equals `segOf` for that unit. The edge
   classifier and the segment partition never disagree.

Validate against the same run set the segment oracle uses (`DS-2_14_45` first).

## Commit plan

- **D.1 helpers** — state registries + tile index + `findEntityInTile` /
  `getSegmentFromUnit` + `edgesBySegment`. Validate: `flow-prep` still builds unchanged.
- **D.2 logger** — per-category registration + edge mint/update. The four loggers
  (inserter / miner / machine-buffer / belt) are largely independent → candidates to
  develop in parallel over a shared edge-primitive base.
- **D.3 process** — orchestration + segment-event-driven timeline update + the
  verification test.
