// Verification test for the tile-anchored edge ledger (edges.mjs) driven
// against a real run alongside the belt-segment partition (segments.mjs).
//
// Two independent checks:
//   1. ENGINE — drive segments+edges incrementally to the end of the run, then
//      assert the live incremental edge set equals a from-scratch rebuild off
//      the final state (no dropped / stale / mis-endpointed edges) AND the two
//      edge invariants hold on live state:
//        a. no hanging edge — every live belt endpoint resolves to a live
//           segment (segOf ≠ null);
//        b. no classifier contradiction — that endpoint's open segment-timeline
//           interval equals segOf for the belt it currently holds.
//   2. WIRING — call the production buildFlow and confirm the SERIALIZED
//      flow.edges carries an open segment interval on every live belt endpoint
//      (the orchestration in flow-prep actually advances the timeline).
//
// Gated on extracted-data/<run> (gitignored): skips when the run isn't present
// locally, mirroring the production-data gate in parity.test.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { buildFlow, synthesiseEventsForRun } from '../../scripts/flow-prep.mjs';
import { createFlowState } from '../../scripts/lib/flow/state.mjs';
import * as segments from '../../scripts/lib/flow/segments.mjs';
import * as edges from '../../scripts/lib/flow/edges.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const RUN = 'DS-2_14_45';
const RUN_DIR = path.join(REPO_ROOT, 'extracted-data', RUN);
const HAVE_RUN = fs.existsSync(RUN_DIR);

// Drive segments + edges to the end of the run on one shared state, exactly as
// the production buildFlow orchestration does. Returns the settled state so the
// invariants can read segOf and the live edge ledger.
function driveRun(runDir: string): any {
  const evs = synthesiseEventsForRun(runDir);
  const st = createFlowState();
  let cur: number | null = null;
  let dirty = new Set<number>();
  const settle = (tick: number) => {
    const moved = new Set<number>(dirty);
    for (const se of segments.reconcile(st, dirty, tick)) {
      if (se.type === 'belt-edge-added') edges.mintBeltEdge(st, se.feeder, se.consumer, tick);
      else if (se.type === 'belt-edge-removed') edges.retireBeltEdge(st, se.feeder, se.consumer, tick);
      else if (se.units) for (const u of se.units) moved.add(u);
    }
    edges.updateSegments(st, moved, tick);
    dirty = new Set();
  };
  for (const e of evs) {
    if (cur !== null && e.tick !== cur) settle(cur);
    cur = e.tick;
    const d = segments.applyEvent(st, e);
    if (d) for (const u of d) dirty.add(u);
    edges.applyEvent(st, e);
  }
  if (cur !== null) settle(cur);
  return st;
}

const curEntry = (ep: any) => {
  const u = ep.units[ep.units.length - 1];
  return u && u.tr == null ? u : null;
};

(HAVE_RUN ? describe : describe.skip)(`flow edges — ${RUN}`, () => {
  let st: any;
  beforeAll(() => {
    st = driveRun(RUN_DIR);
  });

  it('live ledger equals a from-scratch rebuild (no dropped / stale / mis-endpointed edges)', () => {
    const live = edges.liveEdgeKeys(st);
    const rebuilt = edges.rebuildLiveEdgeKeys(st);
    const same = (a: any, b: any) => a.from === b.from && a.to === b.to && a.side === b.side;

    const missing: string[] = [];
    const mismatch: string[] = [];
    for (const [k, d] of rebuilt) {
      const l = live.get(k);
      if (!l) missing.push(k);
      else if (!same(d, l)) mismatch.push(k);
    }
    const extra: string[] = [];
    for (const k of live.keys()) if (!rebuilt.has(k)) extra.push(k);

    expect({ missing: missing.length, extra: extra.length, mismatch: mismatch.length }).toEqual({
      missing: 0,
      extra: 0,
      mismatch: 0,
    });
  });

  it('every live belt endpoint resolves to a live segment that matches its timeline', () => {
    let beltEnds = 0;
    let hanging = 0;
    let segMissing = 0;
    let segMismatch = 0;
    for (const e of st.edges.values()) {
      if (e.tr != null) continue;
      for (const ep of [e.from, e.to]) {
        const cur = curEntry(ep);
        if (!cur || cur.category !== 'belt') continue;
        beltEnds++;
        const liveSeg = st.segOf.get(cur.unit);
        if (liveSeg == null) { hanging++; continue; }          // belt endpoint with no live segment
        const open = ep.segs && ep.segs[ep.segs.length - 1];
        if (!open || open.tr != null) { segMissing++; continue; } // no open segment interval
        if (open.seg !== liveSeg) segMismatch++;                  // timeline disagrees with the partition
      }
    }
    expect(beltEnds).toBeGreaterThan(0);
    expect({ hanging, segMissing, segMismatch }).toEqual({ hanging: 0, segMissing: 0, segMismatch: 0 });
  });

  it('serialized flow.edges carries an open segment interval on every live belt endpoint', () => {
    const flow = buildFlow(RUN_DIR, Number.MAX_SAFE_INTEGER);
    expect(flow).toBeTruthy();
    let beltEnds = 0;
    let segMissing = 0;
    for (const e of flow.edges) {
      if (e.tr != null) continue;
      for (const ep of [e.from, e.to]) {
        const cur = curEntry(ep);
        if (!cur || cur.category !== 'belt') continue;
        beltEnds++;
        const open = ep.segs && ep.segs[ep.segs.length - 1];
        if (!open || open.tr != null) segMissing++;
      }
    }
    expect(beltEnds).toBeGreaterThan(0);
    expect(segMissing).toBe(0);
  });
});
