// Shared flow state container.
//
// One state object threaded through the flow pipeline. The belt-segment slice
// below is owned by segments.mjs; the edge layer's entity registry + edge
// ledger join this container when the edges module lands on shared state (see
// docs/refactors/segments-edge-rewrite.md). Each module reads/writes only its
// own slice — the container just unifies ownership so the orchestrator threads
// one object, and so cross-tier lookups (edges reading the belt graph) need no
// ctx indirection.
export function createFlowState() {
  return {
    // ── belt-segment slice (segments.mjs) ──
    belts:   new Map(),   // unit → folded belt entity rec
    segOf:   new Map(),   // unit → live segment id
    segs:    new Map(),   // segment id → live segment record
    retired: [],          // segments closed by merge / split / death
    nextSeg: 0,
  };
}
