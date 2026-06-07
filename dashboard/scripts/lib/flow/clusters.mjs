// clusters.mjs — machine / furnace / miner / buffer clustering.
//
// A FINALIZE-TIME derivation over the settled flow partition, not a per-tick
// fold. By the time this runs, segments + edges have already finalized, so the
// edge ledger holds every inserter/miner hand-off (machine→belt drains,
// belt→machine feeds, miner drops, direct machine→machine handoffs) with its
// endpoint segment + occupant timelines. Clusters fall straight out of that
// partition — no second state machine, no geometric adjacency guess.
//
// EVERYTHING REPRESENTS ITS CURRENT STATE (see memory feedback_everything_is_
// temporal). A cluster is TIME-VARYING: at any tick it reflects the recipes,
// ports, and membership LIVE AT THAT TICK — never a snapshot (last-alive tick)
// nor a lifetime union. Two furnace rows that briefly share a belt during setup
// are one cluster *for that interval*, then split; a machine that switches
// recipe flows from one cluster into another. We compute the partition at every
// change-point and emit a record per (component × interval its state is
// constant). Each persisted record is therefore a constant-state object over
// its own [tb,tr) — exactly like a belt-segment-state interval — and the map
// renderer tick-filters it for free.
//
// Cluster IDENTITY ACROSS structural change (when a cluster splits/merges, is
// the survivor "the same" cluster? id stability, sustain filtering of churn) is
// a WHOLE-FLOW-MODEL question, deferred. Here, ids are per-record (a membership
// change starts a new record/id); we do not stitch identity across epochs.
//
// Registration is shared, not duplicated: the clusterable-entity set (lifetime,
// recipe/resource/storedItem, footprint) is read from the SAME lossless `merged`
// stream the edge layer registers from, using the SAME game-data/flow-prototypes
// footprints. (The live `state.machines/miners/buffers` registries drop removed
// entities, so `merged` is the complete source for a lifetime model.)
//
// Identity (per docs/specs/flow_promotion.md §Cluster): same `kind`
// (machine|furnace|miner|buffer) + same `recipe` (storedItem for buffers, mined
// resource for miners) + FUNCTIONAL CONTIGUITY on BOTH axes — sharing at least
// one input belt segment AND one output belt segment (an axis with no segments
// on either side is vacuously matched: miners group by output, fill-only chests
// by input). Geometry never enters except for the edgeless fallback.
//
// inputs/outputs are real, segment-based edges harvested from the ledger:
// `{ kind:'segment', id:'S-n', side }` for a cluster↔belt port, or
// `{ kind:'cluster', id:'C-n' }` for a direct inserter handoff between two
// clusters. This is what lib/smelting/lanes.mjs reads.

import { readFileSync } from 'node:fs';
import { dominantItem } from '../buffer.mjs';

const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const MACHINE_FP = PROTO.footprints.machine;   // furnaces live here too (distinguished by name)
const MINER_FP   = PROTO.footprints.miner;
const BUFFER_FP  = PROTO.footprints.buffer;
const FURNACE_NAMES = new Set(['stone-furnace', 'steel-furnace', 'electric-furnace']);

// Persisted segments are `S-<n>`; edge-endpoint `segs` store the raw numeric n.
const numId = (id) => (typeof id === 'number' ? id : Number(String(id).replace(/^S-/, '')));

// ── entry point ──────────────────────────────────────────────
// edges        — finalized edge ledger (edges.finalize().edges)
// beltSegments — finalized segment records (for the valid-segment-id set)
// merged       — the lossless merged-entity stream (registration source)
// durationTick — run end; entities/lifetimes/intervals clip to it
export function buildClusters({ edges, beltSegments, merged, durationTick }) {
  const ents = registerEntities(merged, durationTick);
  const validSeg = new Set((beltSegments ?? []).map((s) => numId(s.id)));
  buildPortTimelines(edges ?? [], ents, validSeg, durationTick);
  const records = partitionOverTime(ents, durationTick);
  return { clusters: records };
}

// ── registration (shared footprints + merged stream) ─────────
// Each entity carries its lifetime [tb, end) and a RECIPE TIMELINE — machines /
// furnaces can re-key over time. Miner resource and buffer role-item don't
// change, so they get a single covering interval.
function registerEntities(merged, durationTick) {
  const ents = new Map();
  for (const m of merged ?? []) {
    const cat = m.category;
    if (cat !== 'machine' && cat !== 'miner' && cat !== 'buffer') continue;
    const tb = m.timeBuilt ?? 0;
    if (tb > durationTick) continue;
    const fpTable = cat === 'miner' ? MINER_FP : cat === 'buffer' ? BUFFER_FP : MACHINE_FP;
    const footprint = fpTable[m.name];
    if (footprint == null) continue;                       // not a clusterable prototype

    const kind = cat === 'buffer' ? 'buffer'
               : cat === 'miner'  ? 'miner'
               : FURNACE_NAMES.has(m.name) ? 'furnace' : 'machine';
    const end = (m.timeRemoved != null && m.timeRemoved <= durationTick) ? m.timeRemoved : durationTick;
    const removed = m.timeRemoved != null && m.timeRemoved <= durationTick;

    const recipes =
        kind === 'buffer' ? [{ recipe: dominantItem(m), tb, tr: end }]
      : kind === 'miner'  ? [{ recipe: Array.isArray(m.resources) ? (m.resources[0] ?? null) : null, tb, tr: end }]
      :                     recipeIntervals(m.recipes, tb, end);

    ents.set(m.unitNumber, {
      unit: m.unitNumber, name: m.name, kind,
      location: m.location, footprint,
      bbox: footprintBBox(m.location, footprint),
      tb, end, removed, recipes,
      inPorts: [],    // [{ seg, side, tb, tr }] — belt → entity over time
      outPorts: [],   // [{ seg, side, tb, tr }] — entity → belt over time
      handoffs: [],   // [{ unit, tb, tr }]      — entity → entity direct hand-off
    });
  }
  return ents;
}

// Split a machine's recipe history into covering [tb,tr) intervals. Each recipe
// runs from when it started until the next one starts (or end of life). The
// recipe active before the first recorded start is taken to be that first
// recipe (machines log the recipe they're set to, not "empty").
function recipeIntervals(recipes, tb, end) {
  const rs = (recipes ?? [])
    .map((r) => ({ recipe: r.recipe, t: r.timeStarted ?? r.startTick ?? tb }))
    .filter((r) => r.recipe != null)
    .sort((a, b) => a.t - b.t);
  if (!rs.length) return [{ recipe: null, tb, tr: end }];
  const out = [];
  for (let i = 0; i < rs.length; i++) {
    const s = Math.max(rs[i].t, tb);
    const e = i + 1 < rs.length ? Math.max(s, rs[i + 1].t) : end;
    if (e > s) out.push({ recipe: rs[i].recipe, tb: s, tr: e });
  }
  if (!out.length) return [{ recipe: rs[0].recipe, tb, tr: end }];
  if (out[0].tb > tb) out.unshift({ recipe: out[0].recipe, tb, tr: out[0].tb });
  return out;
}

function recipeAt(ent, t) {
  for (const iv of ent.recipes) if (iv.tb <= t && t < iv.tr) return iv.recipe ?? null;
  return null;
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

// ── port timelines (no snapshot collapse) ────────────────────
// An owned edge is pickup(from) → drop(to). Whichever end is a cluster entity
// gains the OTHER end as a port, but only for the SUB-INTERVAL where: the edge
// is live, the entity occupies its end, AND (for a belt port) the belt segment
// is live on the other end. Segment/occupant timelines are intersected, never
// sampled — so a furnace that drains to S-52 during setup and S-55 after holds
// BOTH ports, each with its true interval, and the partition sees the right one
// at every tick.
function buildPortTimelines(edges, ents, validSeg, dur) {
  for (const e of edges) {
    if (e.inserterUnit == null && e.minerUnit == null) continue;   // belt↔belt — not a cluster port
    const eb = e.tb ?? 0;
    const er = e.tr == null ? dur : e.tr;

    // entity occupying e.from → its OUTPUT is the e.to belt (or a hand-off).
    for (const occ of e.from.units ?? []) {
      const ent = ents.get(occ.unit);
      if (!ent) continue;
      const a = Math.max(eb, occ.tb), b = Math.min(er, occ.tr == null ? dur : occ.tr);
      if (b <= a) continue;
      const side = e.to.side ?? e.dst?.belt ?? null;
      for (const s of e.to.segs ?? []) {
        if (!validSeg.has(s.seg)) continue;
        const t0 = Math.max(a, s.tb), t1 = Math.min(b, s.tr == null ? dur : s.tr);
        if (t1 > t0) ent.outPorts.push({ seg: s.seg, side, tb: t0, tr: t1 });
      }
      for (const o2 of e.to.units ?? []) {            // belt-less machine→machine hand-off
        if (o2.unit === occ.unit || !ents.has(o2.unit)) continue;
        const t0 = Math.max(a, o2.tb), t1 = Math.min(b, o2.tr == null ? dur : o2.tr);
        if (t1 > t0) ent.handoffs.push({ unit: o2.unit, tb: t0, tr: t1 });
      }
    }

    // entity occupying e.to → its INPUT is the e.from belt.
    for (const occ of e.to.units ?? []) {
      const ent = ents.get(occ.unit);
      if (!ent) continue;
      const a = Math.max(eb, occ.tb), b = Math.min(er, occ.tr == null ? dur : occ.tr);
      if (b <= a) continue;
      const side = e.from.side ?? null;
      for (const s of e.from.segs ?? []) {
        if (!validSeg.has(s.seg)) continue;
        const t0 = Math.max(a, s.tb), t1 = Math.min(b, s.tr == null ? dur : s.tr);
        if (t1 > t0) ent.inPorts.push({ seg: s.seg, side, tb: t0, tr: t1 });
      }
    }
  }
}

// Ports live at tick t: { inSegs:Map seg→Set<side>, outSegs:Map, outUnits:Set }.
function portsAt(ent, t) {
  const inSegs = new Map(), outSegs = new Map(), outUnits = new Set();
  for (const p of ent.inPorts)  if (p.tb <= t && t < p.tr) addSide(inSegs, p.seg, p.side);
  for (const p of ent.outPorts) if (p.tb <= t && t < p.tr) addSide(outSegs, p.seg, p.side);
  for (const h of ent.handoffs) if (h.tb <= t && t < h.tr) outUnits.add(h.unit);
  return { inSegs, outSegs, outUnits };
}

function addSide(map, seg, side) {
  const s = side === 'left' || side === 'right' ? side : 'both';
  let set = map.get(seg);
  if (!set) { set = new Set(); map.set(seg, set); }
  set.add(s);
}

// ── time-varying partition ───────────────────────────────────
// Fallback grouping for entities that touch no belt segment (fluid machines,
// bot-/hand-fed machines, fluid miners): same-identity ISOLATED entities within
// FALLBACK_GAP tiles AND FALLBACK_TIME ticks of each other are one setup.
const FALLBACK_GAP  = 4;       // tiles between footprints to still count as the same block
const FALLBACK_TIME = 18000;   // build-tick window (~5 min) for "placed in the same setup"

function partitionOverTime(ents, dur) {
  // Change-points: any tick where SOME entity's membership, recipe, or port set
  // can change. The partition is constant between consecutive change-points.
  const cuts = new Set([0, dur]);
  for (const e of ents.values()) {
    cuts.add(e.tb); cuts.add(e.end);
    for (const iv of e.recipes) { cuts.add(iv.tb); cuts.add(iv.tr); }
    for (const p of e.inPorts)  { cuts.add(p.tb); cuts.add(p.tr); }
    for (const p of e.outPorts) { cuts.add(p.tb); cuts.add(p.tr); }
    for (const h of e.handoffs) { cuts.add(h.tb); cuts.add(h.tr); }
  }
  const pts = [...cuts].filter((t) => t >= 0 && t <= dur).sort((a, b) => a - b);

  // One slice per (component × interval). Coalesced afterwards by identical state.
  const slices = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    for (const comp of partitionAt(ents, a)) slices.push({ ...comp, a, b });
  }

  return assemble(coalesce(slices, dur), ents, dur);
}

// Static partition of the entities ALIVE at tick t, by current state.
function partitionAt(ents, t) {
  // Snapshot each live entity's current identity + ports at t.
  const live = [];
  for (const e of ents.values()) {
    if (!(e.tb <= t && t < e.end)) continue;
    const recipe = recipeAt(e, t);
    const { inSegs, outSegs, outUnits } = portsAt(e, t);
    live.push({ unit: e.unit, kind: e.kind, recipe, key: `${e.kind}|${recipe ?? '__none__'}`,
                inSegs, outSegs, outUnits, bbox: e.bbox, tb: e.tb });
  }

  const parent = new Map();
  for (const s of live) parent.set(s.unit, s.unit);
  const find = (u) => { while (parent.get(u) !== u) { parent.set(u, parent.get(parent.get(u))); u = parent.get(u); } return u; };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };

  // Entities reachable by a direct (belt-less) hand-off — connected, so the
  // isolated-entity location fallback must NOT sweep them up.
  const handoffTarget = new Set();
  for (const s of live) for (const u of s.outUnits) handoffTarget.add(u);

  const byKey = new Map();
  for (const s of live) { let arr = byKey.get(s.key); if (!arr) byKey.set(s.key, arr = []); arr.push(s); }

  for (const arr of byKey.values()) {
    const seg = [], iso = [];
    for (const s of arr) {
      if (s.inSegs.size || s.outSegs.size) seg.push(s);
      else if (s.outUnits.size === 0 && !handoffTarget.has(s.unit)) iso.push(s);
      // else: connected only by a direct hand-off — its own cluster.
    }
    // Segment-connected: union on BOTH axes matching.
    for (let i = 0; i < seg.length; i++) for (let j = i + 1; j < seg.length; j++) {
      if (find(seg[i].unit) === find(seg[j].unit)) continue;
      if (axisMatch(seg[i].outSegs, seg[j].outSegs) && axisMatch(seg[i].inSegs, seg[j].inSegs))
        union(seg[i].unit, seg[j].unit);
    }
    // Edgeless fallback: group fluid / bot- / hand-fed machines by location + setup time.
    for (let i = 0; i < iso.length; i++) for (let j = i + 1; j < iso.length; j++) {
      if (bboxGap(iso[i].bbox, iso[j].bbox) <= FALLBACK_GAP && Math.abs(iso[i].tb - iso[j].tb) <= FALLBACK_TIME)
        union(iso[i].unit, iso[j].unit);
    }
  }

  // Gather components with their aggregated current state.
  const groups = new Map();
  const sById = new Map(live.map((s) => [s.unit, s]));
  for (const s of live) {
    const r = find(s.unit);
    let g = groups.get(r);
    if (!g) groups.set(r, g = { units: [], kind: s.kind, recipe: s.recipe, inSegs: new Map(), outSegs: new Map(), outUnits: new Set() });
    g.units.push(s.unit);
  }
  for (const g of groups.values()) {
    for (const u of g.units) {
      const s = sById.get(u);
      mergeSegMap(g.inSegs, s.inSegs);
      mergeSegMap(g.outSegs, s.outSegs);
      for (const t of s.outUnits) g.outUnits.add(t);
    }
    g.units.sort((x, y) => x - y);
  }
  return [...groups.values()];
}

// Two segment sets "match" on an axis when they share a segment, OR when neither
// side has any segment on that axis (vacuous — e.g. miners have no belt input).
function axisMatch(a, b) {
  if (a.size === 0 && b.size === 0) return true;
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const k of small.keys()) if (big.has(k)) return true;
  return false;
}

// Coalesce slices: a component whose full state (members + recipe + ports +
// hand-offs) is identical across temporally-adjacent intervals is ONE record.
// Any change ends the record and (if the state recurs) starts a fresh one.
function coalesce(slices, dur) {
  const bySig = new Map();
  for (const s of slices) {
    const sig = `${s.kind}|${s.recipe ?? '__none__'}|M:${s.units.join(',')}`
              + `|I:${segMapSig(s.inSegs)}|O:${segMapSig(s.outSegs)}|H:${[...s.outUnits].sort((a, b) => a - b).join(',')}`;
    let arr = bySig.get(sig); if (!arr) bySig.set(sig, arr = []); arr.push(s);
  }
  const records = [];
  for (const arr of bySig.values()) {
    arr.sort((x, y) => x.a - y.a);
    let cur = null;
    for (const s of arr) {
      if (cur && s.a <= cur.tr) { cur.tr = Math.max(cur.tr, s.b); continue; }  // contiguous → extend
      cur = { kind: s.kind, recipe: s.recipe, units: s.units, inSegs: s.inSegs, outSegs: s.outSegs, outUnits: s.outUnits, tb: s.a, tr: s.b };
      records.push(cur);
    }
  }
  return records;
}

function segMapSig(map) {
  return [...map.entries()]
    .map(([seg, sides]) => `${seg}:${[...sides].sort().join('')}`)
    .sort()
    .join(';');
}

// ── assemble persisted clusters ──────────────────────────────
function assemble(records, ents, dur) {
  records.sort((a, b) => (a.tb - b.tb) || (a.units[0] - b.units[0]));
  records.forEach((c, i) => { c.id = `C-${i}`; });

  // unit → records covering each interval (for cluster↔cluster hand-off edges).
  const unitIndex = new Map();
  for (const c of records) for (const u of c.units) {
    let arr = unitIndex.get(u); if (!arr) unitIndex.set(u, arr = []); arr.push(c);
  }

  for (const c of records) {
    c._inClusters = new Set();
    c._outClusters = new Set();
  }
  for (const c of records) {
    for (const tu of c.outUnits) {
      for (const tc of unitIndex.get(tu) ?? []) {
        if (tc === c) continue;
        if (tc.tb < c.tr && c.tb < tc.tr) {            // co-temporal
          c._outClusters.add(tc.id);
          tc._inClusters.add(c.id);
        }
      }
    }
  }

  return records.map((c) => toPersisted(c, ents, dur));
}

function toPersisted(c, ents, dur) {
  const recs = c.units.map((u) => ents.get(u));
  const members = c.units
    .map((u) => { const e = ents.get(u); const tb = Math.max(e.tb, c.tb); const tr = Math.min(e.end, c.tr);
                  return { unit: u, tb, ...(tr < dur ? { tr } : {}) }; })
    .sort((a, b) => (a.tb - b.tb) || (a.unit - b.unit));

  const inputs  = [...segEdges(c.inSegs),  ...[...c._inClusters].map((id) => ({ kind: 'cluster', id }))];
  const outputs = [...segEdges(c.outSegs), ...[...c._outClusters].map((id) => ({ kind: 'cluster', id }))];

  const o = {
    id: c.id,
    kind: c.kind,
    tb: c.tb,
    members,
    bbox: unionBBox(recs.map((r) => r.bbox)),
    rects: subRects(recs, c.tb, c.tr, dur),
    inputs: dedupEdges(inputs),
    outputs: dedupEdges(outputs),
  };
  if (c.kind === 'buffer') o.storedItem = c.recipe ?? null;
  else o.recipe = c.recipe ?? null;
  if (c.tr < dur) {
    o.tr = c.tr;
    o.endReason = recs.every((r) => r.removed && r.end <= c.tr) ? 'all-members-removed' : 'superseded';
  }
  return o;
}

// A record's members are constant over [tb,tr); partition them into spatially-
// connected sub-blocks (footprints within SUBRECT_GAP tiles) and emit one rect
// per block, each carrying the record's interval so the map layer scrubs. The
// renderer draws every rect of a record in its colour, highlighted together —
// never one bbox spanning end to end.
const SUBRECT_GAP = 3;   // tile gap that still counts as one block (covers an inserter+belt aisle)
function subRects(recs, tb, tr, dur) {
  const n = recs.length;
  const parent = recs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (bboxGap(recs[i].bbox, recs[j].bbox) <= SUBRECT_GAP) { const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb; }

  const comps = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(recs[i]); }

  const rects = [];
  for (const group of comps.values()) {
    const rect = { ...unionBBox(group.map((g) => g.bbox)), tb };
    if (tr < dur) rect.tr = tr;
    rects.push(rect);
  }
  return rects.sort((a, b) => (a.minX - b.minX) || (a.minY - b.minY));
}

// Empty-tile gap between two axis-aligned tile bboxes (0 = touching/overlapping,
// 3 = three empty tiles between — an inserter+belt+inserter aisle). Matches the
// "0 means touching" convention in lib/smelting/lanes.mjs.
function bboxGap(a, b) {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
  return Math.max(dx, dy);
}

function unionBBox(boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function mergeSegMap(into, from) {
  for (const [seg, sides] of from) {
    let set = into.get(seg);
    if (!set) { set = new Set(); into.set(seg, set); }
    for (const s of sides) set.add(s);
  }
}

function segEdges(segMap) {
  const out = [];
  for (const [seg, sides] of segMap) {
    const side = (sides.has('both') || (sides.has('left') && sides.has('right'))) ? 'both'
               : sides.has('left') ? 'left' : sides.has('right') ? 'right' : 'both';
    out.push({ kind: 'segment', id: `S-${seg}`, side });
  }
  return out;
}

function dedupEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = `${e.kind}:${e.id}:${e.side ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || String(a.side).localeCompare(String(b.side)));
}
