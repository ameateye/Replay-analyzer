// Verification test for the replay-derived edge ledger (edges.mjs) driven
// against a real run alongside the belt-segment partition (segments.mjs).
//
// Two independent checks:
//   1. ENGINE — drive the two-call loop (register + advance) to the end of the
//      run, derive the ledger with edges.finalize, and assert the edge
//      invariants against the live partition:
//        a. no hanging edge — every live belt endpoint resolves to a live
//           segment (segOf ≠ null);
//        b. no classifier contradiction — that endpoint's open segment-timeline
//           interval equals segOf for the belt it currently holds.
//   2. WIRING — call the production buildFlow and confirm the SERIALIZED
//      flow.edges carries an open segment interval on every live belt endpoint
//      (the orchestration in flow-prep actually feeds the replay's histories).
//
// Gated on extracted-data/<run> (gitignored): skips when the run isn't present
// locally, mirroring the production-data gate in parity.test.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { buildFlow, synthesiseEventsForRun } from '../../scripts/flow-prep.mjs';
import { createFlowState, registerEvent } from '../../scripts/lib/flow/state.mjs';
import * as segments from '../../scripts/lib/flow/segments.mjs';
import * as edges from '../../scripts/lib/flow/edges.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const RUN = 'DS-2_14_45';
const RUN_DIR = path.join(REPO_ROOT, 'extracted-data', RUN);
const HAVE_RUN = fs.existsSync(RUN_DIR);

// Drive the loop to the end of the run on one shared state, exactly as the
// production buildFlow orchestration does. Returns the settled state so the
// invariants can read segOf and derive the ledger.
function driveRun(runDir: string): any {
  const evs = synthesiseEventsForRun(runDir);
  const st = createFlowState();
  let cur: number | null = null;
  let dirty = new Set<number>();
  for (const e of evs) {
    if (cur !== null && e.tick !== cur) { segments.advance(st, dirty, cur); dirty = new Set(); }
    cur = e.tick;
    const delta = registerEvent(st, e);
    if (delta?.dirty) for (const u of delta.dirty) dirty.add(u);
  }
  if (cur !== null) segments.advance(st, dirty, cur);
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

  it('every live belt endpoint of the derived ledger resolves to a live segment that matches its timeline', () => {
    const { edges: ledger } = edges.finalize(st);
    let beltEnds = 0;
    let hanging = 0;
    let segMissing = 0;
    let segMismatch = 0;
    for (const e of ledger) {
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
