// Flow prep — event-driven belt-segment graph + tile-anchored edge ledger.
//
// Reads the lossless merged-entity stream (lib/layout/merge-entities.mjs),
// synthesises a sorted event stream (lib/flow/events.mjs), and folds it
// through the pipeline modules sharing one state container:
//
//   segments.mjs  — connected belt-tile components (lifetime topology).
//                   state.registerEvent returns each belt event's dirty mark;
//                   the caller accumulates a tick's dirty belt units, then
//                   segments.advance() settles the tick ONCE on the settled
//                   graph (appending belt-edge deltas to the state's log).
//   edges.mjs     — durable, tile-anchored edges (inserter / miner / belt↔belt),
//                   each endpoint a tile with unit + segment occupancy
//                   timelines. Derived ENTIRELY at finalize by replaying the
//                   seq-stamped histories state recorded during the loop —
//                   nothing edge-shaped runs per tick.
//
// Output shape: { durationTick, summary, clusters, beltSegments, edges } as the
// `flow` top-level field on the per-run JSON. `null` when inputs are missing.
// Clusters are derived at finalize from the settled partition (see clusters.mjs).

import { existsSync } from 'node:fs';

import { buildMergedEntities } from './lib/layout/merge-entities.mjs';
import { createFlowState, registerEvent } from './lib/flow/state.mjs';
import { synthesiseEvents } from './lib/flow/events.mjs';
import * as segments from './lib/flow/segments.mjs';
import * as edges from './lib/flow/edges.mjs';
import { attachContents } from './lib/flow/contents.mjs';
import { buildClusters } from './lib/flow/clusters.mjs';

export function buildFlow(runDir, durationTick, { merged } = {}) {
  if (!existsSync(runDir)) return null;
  if (typeof durationTick !== 'number' || !Number.isFinite(durationTick) || durationTick <= 0) return null;

  const mergedStream = merged ?? buildMergedEntities(runDir, durationTick);
  if (!mergedStream || mergedStream.length === 0) return null;

  const state = createFlowState();

  const events = synthesiseEvents(mergedStream, durationTick);

  // Drive the fold — two calls: register every event (per event, accumulating
  // dirty belt units), then settle each tick ONCE. Events are tick-sorted, so
  // a tick's events are contiguous. Everything else derives at finalize.
  let curTick = null;
  let dirty = new Set();
  for (const ev of events) {
    if (curTick !== null && ev.tick !== curTick) { segments.advance(state, dirty, curTick); dirty = new Set(); }
    curTick = ev.tick;
    const delta = registerEvent(state, ev);
    if (delta?.dirty) for (const u of delta.dirty) dirty.add(u);
  }
  if (curTick !== null) segments.advance(state, dirty, curTick);

  const { beltSegments } = segments.finalize(state, durationTick);
  const { edges: edgeList } = edges.finalize(state);

  // Item-aware post-pass: seed belt-lane contents from drain/miner item windows and
  // propagate across belt↔belt, belt↔buffer and buffer↔buffer edges (splitter routing
  // folded in). Writes seg.contents and returns the per-buffer item ledger. Buffers
  // come straight off the merged stream (content + periodic stock samples), clipped
  // to the run like the synthesised events.
  const buffers = mergedStream.filter(m => m.category === 'buffer' && (m.timeBuilt ?? 0) <= durationTick);
  const bufferContents = attachContents(beltSegments, edgeList, durationTick, buffers);

  // Cluster pass: derive machine/furnace/miner/buffer clusters from the settled
  // partition (edge ledger + segments). The clusterable-entity set is read from
  // state's full-history node records — registered once, by state.registerEvent.
  const { clusters } = buildClusters({ edges: edgeList, beltSegments, state, durationTick });

  const summary = buildSummary(beltSegments, edgeList, bufferContents, clusters);

  return {
    durationTick,
    summary,
    clusters,
    beltSegments,
    edges: edgeList,
    buffers: bufferContents,
  };
}

// Test/diagnostic hook: returns the EXACT synthesised event stream buildFlow
// folds for a runDir. Defaults to no clipping so the whole run's events are
// exposed. Used by the diagnostics parity checks; not part of the production path.
export function synthesiseEventsForRun(runDir, durationTick = Number.MAX_SAFE_INTEGER) {
  const merged = buildMergedEntities(runDir, durationTick);
  if (!merged || merged.length === 0) return [];
  return synthesiseEvents(merged, durationTick);
}

function buildSummary(beltSegments, edges, buffers = [], clusters = []) {
  const segmentsByKind = { belt: 0, splitter: 0 };
  for (const s of beltSegments) {
    const k = s.kind ?? 'belt';
    if (segmentsByKind[k] !== undefined) segmentsByKind[k] += 1;
  }
  // Edges by owner: inserter / miner / belt (belt↔belt cross-segment).
  const edgesByKind = { inserter: 0, miner: 0, belt: 0 };
  let liveEdges = 0;
  for (const e of edges) {
    const k = e.inserterUnit != null ? 'inserter' : e.minerUnit != null ? 'miner' : 'belt';
    edgesByKind[k] += 1;
    if (e.tr == null) liveEdges += 1;
  }
  const clustersByKind = { machine: 0, furnace: 0, miner: 0, buffer: 0 };
  for (const c of clusters) if (clustersByKind[c.kind] !== undefined) clustersByKind[c.kind] += 1;
  return {
    clusterCount: clusters.length,
    clustersByKind,
    beltSegmentCount: beltSegments.length,
    segmentsByKind,
    edgeCount: edges.length,
    liveEdgeCount: liveEdges,
    edgesByKind,
    bufferCount: buffers.length,
  };
}
