// edges.mjs — the edge ledger, derived at finalize by replaying recorded history.
//
// An edge is a long-lived record: from-endpoint → to-endpoint, each endpoint a
// tile with a unit-occupancy timeline (units: [{unit, category, tb, tr}]). It
// is minted by its OWNER — an inserter or a miner, one edge per direction
// interval (a rotation retires + re-mints) — or wholesale by the belt-edge
// delta log (belt↔belt). Any entity landing on or leaving an endpoint tile
// opens or closes that endpoint's interval, so an endpoint follows whatever
// occupies its tile.
//
// Nothing edge-shaped runs inside the per-tick loop. state records seq-stamped
// histories (tile occupancy intervals, passive open/close/rotate moments,
// owner + belt direction timelines, belt segment-membership timelines, the
// belt-edge delta log) and finalize() REPLAYS them:
//   1. SHELLS — which edges ever existed, in mint order (seq), so ids
//      reproduce the live logger's numbering. No-op mints (a belt-edge delta
//      whose belt was already gone) consume no id, as before.
//   2. ENDPOINT REPLAY — seed from the tile interval containing the mint seq,
//      then fold the tile's passive moments over the shell's lifetime:
//      `units` gets one interval per occupant, `side` is the last side-write,
//      `segs` overlays each occupying belt's membership timeline.
//   3. annotateContents — item facts layered on at the end, as before.
// The replay reproduces the pre-rewrite live ledger byte-for-byte — including
// its preserved data-loss quirks (spec §8 / "Quirks" section); each is marked
// QUIRK where reproduced.

import { readFileSync } from 'node:fs';
import { tileKey, clip, DV, OPP, LEFT, floorTile, tileCenter, stepTile, minerDrop } from './util.mjs';

// ── prototypes (loaded once from game-data) ───────────────────
const PROTO = JSON.parse(
  readFileSync(new URL('../../../../game-data/flow-prototypes.json', import.meta.url)),
);
const RECIPE_OVERRIDE = PROTO.recipeOutputOverride;          // recipe → item (mismatched-name recipes)
const FLUID_ONLY      = new Set(PROTO.fluidOnlyRecipes);     // recipes whose output is a fluid → no belt item

// Which side of a vector (dx,dy) relative to facing `dir`: 'left' / 'right' when the
// perpendicular (across) component dominates, else 'center' — the vector lies on the
// facing axis (collinear), so there is no near side. Callers resolve the collinear case.
function sideAlong(dir, dx, dy) {
  const f = DV[dir], l = DV[LEFT[dir]];
  if (!f) return 'center';
  const across = dx * l.x + dy * l.y, along = dx * f.x + dy * f.y;
  if (Math.abs(across) > Math.abs(along)) return across > 0 ? 'left' : 'right';
  return 'center';
}

// Belt lane the owner at `ownerLoc` touches, for a belt facing `dir`. A perpendicular
// owner resolves to a near side; an INLINE/collinear owner (drop on the belt's centre
// line) resolves to 'center'. mode 'drop' = inserter drop: perpendicular → FAR lane
// (flip near→far); collinear → the belt's RIGHT lane (Factorio's centre-line
// tie-breaker — verified vs. Wube dev + wiki). 'pickup'/'miner' = near lane; a
// collinear pickup defaults to 'right'.
function resolveSideDir(dir, beltTile, ownerLoc, mode) {
  const c = tileCenter(beltTile);
  const s = sideAlong(dir, ownerLoc.x - c.x, ownerLoc.y - c.y);
  if (mode === 'drop') {
    if (s === 'center') return 'right';
    return s === 'left' ? 'right' : 'left';
  }
  return s === 'center' ? 'right' : s;
}

// Which CONSUMER lane a belt→belt hand-off feeds, from the two belts'
// directions at `dirAt(·, seq)`. Collinear (same-direction inline) merge →
// 'both'. Otherwise a perpendicular sideload: the feeder pushes into the
// consumer's cell from directly behind it, so only the directions matter.
function beltToBeltSideAt(f, c, seq) {
  if (!f || !c) return 'right';
  const fd = dirAt(f, seq), cd = dirAt(c, seq);
  if (fd === cd) return 'both';
  const v = DV[fd];
  if (!v) return 'right';
  const s = sideAlong(cd, -v.x, -v.y);   // ⟂ feeder → a real side; 'center' n/a here, default right
  return s === 'center' ? 'right' : s;
}

// ── timeline reads ────────────────────────────────────────────
function dirAt(rec, seq) {            // direction at seq (records carry `dirs`)
  let d;
  for (const e of rec.dirs) { if (e.seq > seq) break; d = e.dir; }
  return d;
}

function segMembershipAt(rec, seq) {  // belt's segment at seq, null pre-first-join
  let s = null;
  for (const e of rec.segTl) { if (e.seq > seq) break; s = e.seg; }
  return s;
}

const liveAtSeq = (rec, seq) => !!rec && rec.seqB <= seq && (rec.trSeq == null || rec.trSeq > seq);

// Tile occupant interval containing `seq`, or null (intervals are seq-ordered).
function occupantAt(state, tile, seq) {
  const log = state.tileEntities.get(tileKey(tile.x, tile.y));
  if (!log) return null;
  for (const iv of log) {
    if (iv.seqB > seq) break;
    if (iv.seqR == null || iv.seqR > seq) return iv;
  }
  return null;
}

const EMPTY = [];
const passiveAt = (state, tile) => state.passive.get(tileKey(tile.x, tile.y)) ?? EMPTY;

// Endpoint segment-interval writes (shared by both endpoint builders): open a
// new segment interval (closing the prior one unless it's the same segment) /
// close the open one.
const openSegW = (ep, seg, tick) => {
  if (seg == null) return;
  const last = ep.segs?.[ep.segs.length - 1];
  if (last && last.tr == null) { if (last.seg === seg) return; last.tr = tick; }
  (ep.segs ??= []).push({ seg, tb: tick, tr: null });
};
const closeSegW = (ep, tick) => { const l = ep.segs?.[ep.segs.length - 1]; if (l && l.tr == null) l.tr = tick; };

// ── shells: which edges ever existed, in mint order ───────────
function collectShells(state) {
  const shells = [];
  const ownerShells = (r, kind) => {
    for (let i = 0; i < r.dirs.length; i++) {
      const d = r.dirs[i], nx = r.dirs[i + 1];
      // Removal closes the open interval only if it came after the interval
      // opened: the live logger re-minted on a post-removal rotation and
      // nothing ever retired that edge (QUIRK).
      const closed = !nx && r.trSeq != null && r.trSeq > d.seq;
      shells.push({ kind, r, dir: d.dir, tb: d.tick, seqB: d.seq,
                    tr: nx ? nx.tick : (closed ? r.tr : null),
                    seqR: nx ? nx.seq : (closed ? r.trSeq : null) });
    }
  };
  for (const r of state.inserters.values()) ownerShells(r, 'inserter');
  for (const r of state.miners.values())    ownerShells(r, 'miner');
  const open = new Map();                                  // "feeder>consumer" → open shell
  for (const le of state.beltEdgeLog) {
    const k = `${le.feeder}>${le.consumer}`;
    if (le.op === 'add') {
      const f = state.beltHist.get(le.feeder), c = state.beltHist.get(le.consumer);
      if (!liveAtSeq(f, le.seq) || !liveAtSeq(c, le.seq)) continue;  // no-op mint: consumed no id
      const s = { kind: 'belt', feeder: le.feeder, consumer: le.consumer,
                  tb: le.tick, seqB: le.seq, tr: null, seqR: null };
      shells.push(s); open.set(k, s);
    } else {
      const s = open.get(k);
      if (s) { s.tr = le.tick; s.seqR = le.seq; open.delete(k); }
    }
  }
  shells.sort((a, b) => a.seqB - b.seqB);
  return shells;
}

// ── endpoint replay (owned edges) ─────────────────────────────
// Replays one endpoint tile over the shell's lifetime. Seeded with the tile's
// occupant at mint (endpointAt semantics), then each passive moment in
// (seqB, seqR) is folded with the live logger's exact behavior:
//   'o' open  — close the displaced interval (its seg interval stays open —
//               only a leave or the retire closes segs: QUIRK), push the new
//               occupant; a belt write resolves `side` and opens its segment
//               interval; a non-belt write nulls `side`.
//   'c' close — only if the leaver IS the current occupant (same-tick
//               build+remove must not clobber the fresh interval).
//   'r' rotate — re-resolve `side` if the current occupant is a belt.
// A current belt's membership timeline is overlaid (flushSegs) up to each
// boundary — what updateSegments used to apply at settle time.
function replayEndpoint(state, shell, tile, mode) {
  const ep = { tile, units: [] };
  let cur = null;                     // { unit, category, rec (belts), startSeq }
  const setCur = (unit, category, seq) =>
    (cur = { unit, category, rec: category === 'belt' ? state.beltHist.get(unit) : null, startSeq: seq });
  const flushSegs = (uptoSeq) => {    // current belt's membership in (startSeq, uptoSeq)
    if (!cur?.rec) return;
    for (const me of cur.rec.segTl) {
      if (me.seq <= cur.startSeq) continue;
      if (me.seq >= uptoSeq) break;
      openSegW(ep, me.seg, me.tick);
    }
  };
  const sideOf = (seq) => {           // sideForEndpoint: belt-belt edges have no owner → null
    if (shell.kind === 'belt') return null;
    const dir = (cur?.rec ? dirAt(cur.rec, seq) : undefined) ?? 0;
    return resolveSideDir(dir, tile, shell.r.location, mode);
  };

  // 1 · seed — the occupant at mint
  const occ = occupantAt(state, tile, shell.seqB);
  if (occ) {
    ep.units.push({ unit: occ.unit, category: occ.category, tb: seedTb(state, occ, shell) });
    setCur(occ.unit, occ.category, shell.seqB);
    if (occ.category === 'belt') {
      ep.side = sideOf(shell.seqB);
      openSegW(ep, cur.rec ? segMembershipAt(cur.rec, shell.seqB) : null, shell.tb);
    }
  }

  // 2 · fold the passive moments within the shell's life
  for (const pe of passiveAt(state, tile)) {
    if (pe.seq <= shell.seqB) continue;
    if (shell.seqR != null && pe.seq >= shell.seqR) break;
    if (pe.op === 'o') {
      flushSegs(pe.seq);
      const last = ep.units[ep.units.length - 1];
      if (!(last && last.tr == null && last.unit === pe.unit)) {
        if (last && last.tr == null) last.tr = pe.tick;
        ep.units.push({ unit: pe.unit, category: pe.category, tb: pe.tick });
      }
      setCur(pe.unit, pe.category, pe.seq);
      if (pe.category === 'belt') {
        ep.side = sideOf(pe.seq);
        openSegW(ep, cur.rec ? segMembershipAt(cur.rec, pe.seq) : null, pe.tick);
      } else ep.side = null;
    } else if (pe.op === 'c') {
      const last = ep.units[ep.units.length - 1];
      if (last && last.tr == null && last.unit === pe.unit) {
        flushSegs(pe.seq);
        last.tr = pe.tick;
        closeSegW(ep, pe.tick);
        cur = null;
      }
    } else if (cur && cur.category === 'belt') {  // 'r'
      ep.side = sideOf(pe.seq);
    }
  }

  // 3 · trailing membership, then the retire clamp (closeUnit + closeSeg)
  flushSegs(shell.seqR ?? Infinity);
  if (shell.tr != null) {
    const last = ep.units[ep.units.length - 1];
    if (last && last.tr == null) last.tr = shell.tr;
    closeSegW(ep, shell.tr);
  }
  return ep;
}

// Seed interval's tb: a LIVE record opens at its own build tick; a dead entity
// lingering in the tile index (removed miners — QUIRK) opens at the mint tick.
// Buffers were never in the old recTb registry → always mint tick (QUIRK).
function seedTb(state, occ, shell) {
  const reg = occ.category === 'belt' ? state.beltHist
            : occ.category === 'machine' ? state.machines
            : occ.category === 'miner' ? state.miners : null;
  const r = reg?.get(occ.unit);
  const live = r && (r.trSeq == null || r.trSeq > shell.seqB);
  return (live ? r.tb : null) ?? shell.tb;
}

// ── edge builders ─────────────────────────────────────────────
// Field insertion order matters: the output is byte-diffed, so each object is
// assembled in the live logger's key order (id, tb, from, to, owner, tr —
// `tr` was stamped after mint).
function buildOwnedEdge(state, shell, id) {
  const r = shell.r;
  let e;
  if (shell.kind === 'inserter') {
    e = { id, tb: shell.tb,
          from: replayEndpoint(state, shell, stepTile(r.tile, shell.dir, r.reach), 'pickup'),
          to:   replayEndpoint(state, shell, stepTile(r.tile, OPP[shell.dir] ?? shell.dir, r.reach), 'drop'),
          inserterUnit: r.unit };
  } else {
    // A miner's from-endpoint is itself (no tile); its drop tile follows the
    // shell's direction. A non-cardinal direction has no drop → empty endpoint.
    const drop = minerDrop(r.location, shell.dir, r.footprint);
    const from = { units: [{ unit: r.unit, category: 'miner', tb: r.tb }] };
    if (shell.tr != null) from.units[0].tr = shell.tr;
    e = { id, tb: shell.tb,
          from,
          to: drop ? replayEndpoint(state, shell, drop, 'miner') : { units: [] },
          minerUnit: r.unit };
  }
  if (shell.tr != null) e.tr = shell.tr;
  return e;
}

// Belt↔belt edge: both endpoints are FIXED belts (the live logger never
// tile-morphed them) — a single unit interval each, segment intervals overlaid
// from the belt's membership timeline, and the consumer-side lane resolved at
// mint. Rotations at an endpoint tile null the side: the live refreshSidesAt
// had no owner to resolve against (QUIRK — annotateContents re-derives `dst`
// from final directions when both belts are still live).
function buildBeltEdge(state, shell, id) {
  const f = state.beltHist.get(shell.feeder), c = state.beltHist.get(shell.consumer);
  const from = { tile: floorTile(f.location), units: [{ unit: f.unit, category: 'belt', tb: f.tb ?? shell.tb }] };
  const to   = { tile: floorTile(c.location), units: [{ unit: c.unit, category: 'belt', tb: c.tb ?? shell.tb }] };
  to.side = beltToBeltSideAt(f, c, shell.seqB);
  const e = { id, tb: shell.tb, from, to };
  if (shell.tr != null) e.tr = shell.tr;
  finishBeltEndpoint(state, shell, from, f);
  finishBeltEndpoint(state, shell, to, c);
  return e;
}

function finishBeltEndpoint(state, shell, ep, rec) {
  // mint: openSeg with the belt's segment as of the mint seq
  openSegW(ep, segMembershipAt(rec, shell.seqB), shell.tb);
  // membership overlay — but NOT entries from the retire settle itself: the
  // live updateSegments ran after the tick's belt-edge retires and skipped
  // retired edges
  for (const me of rec.segTl) {
    if (me.seq <= shell.seqB) continue;
    if (shell.seqR != null && (me.seq >= shell.seqR || me.tick === shell.tr)) break;
    openSegW(ep, me.seg, me.tick);
  }
  // rotations at the endpoint tile during the edge's life null the side
  for (const pe of passiveAt(state, ep.tile)) {
    if (pe.seq <= shell.seqB) continue;
    if (shell.seqR != null && pe.seq >= shell.seqR) break;
    if (pe.op === 'r') ep.side = null;
  }
  // retire clamp
  if (shell.tr != null) {
    const lastU = ep.units[ep.units.length - 1];
    if (lastU.tr == null) lastU.tr = shell.tr;
    const lastS = ep.segs?.[ep.segs.length - 1];
    if (lastS && lastS.tr == null) lastS.tr = shell.tr;
  }
}

// ── finalize: shells → endpoint replay → contents ─────────────
// The shipped edge ledger: every edge ever minted, build-ordered. Each record
// is plain JSON — { id, tb, tr?, from, to, inserterUnit?|minerUnit?,
// itemWindows? (static source), src?/dst? (dynamic source → target),
// transferFilter? }, each endpoint a { tile?, units[], segs?, side? }.
// Owner-less records are belt↔belt edges. Consumers slice the timelines by tick.
export function finalize(state) {
  const shells = collectShells(state);
  const edges = shells.map((s, i) =>
    s.kind === 'belt' ? buildBeltEdge(state, s, `E-${i}`) : buildOwnedEdge(state, s, `E-${i}`));
  for (const e of edges) annotateContents(state, e);
  return { edges: edges.sort((a, b) => (a.tb - b.tb) || a.id.localeCompare(b.id)) };
}

// ── contents resolution (turn recorded state into per-edge item facts) ──
// Edges stay item-free through the replay (purely topological); item identity is
// layered on once at finalize, while `state` (recipes / filters / resources / belt
// directions) is still alive — contents.mjs only ever sees the serialized arrays.
// An inserter has ONE pickup and ONE drop, so each endpoint resolves to a single
// role, and every edge reduces to one of three shapes on two independent axes —
// what the source PROVIDES and where the target GETS it:
//   • static source (machine recipe output, miner resource) → `itemWindows` + `dst`
//   • dynamic source (a belt's lanes, a buffer's outputs)   → `src` + `dst` (+ filter)
//   • drop into a machine (FEED)                            → nothing (dead end)
// `src` is 'belt' (its segments are e.from.segs) or { buffer: unit }; `dst` is
// { belt: side } (segments e.to.segs; side may be 'both' for a collinear belt merge)
// or { buffer: unit }. contents.mjs seeds the statics and propagates the dynamics.
function annotateContents(state, e) {
  if (e.minerUnit != null)    return resolveMinerEdge(state, e);
  if (e.inserterUnit != null) return resolveInserterEdge(state, e);
  return resolveBeltEdge(state, e);
}

// One pickup, one drop. Classify the drop first (where items GO) and bail if it's a
// machine — a feed, the item is consumed, nothing rides out. Then classify the pickup
// (what it PROVIDES): a machine is a static recipe source; a belt or buffer is a
// dynamic node contents.mjs resolves by propagation.
function resolveInserterEdge(state, e) {
  const dst = targetOf(e.to);
  if (!dst) return;                                            // drop into a machine → feed
  e.dst = dst;
  if (e.from.units.some(u => u.category === 'machine')) return resolveDrainWindows(state, e);  // static source
  const filter = filterSpec(liveRec(state.inserters, e.inserterUnit));
  if (filter) e.transferFilter = filter;
  if (e.from.units.some(u => u.category === 'belt')) { e.src = 'belt'; return; }   // dynamic: belt lanes
  const bu = bufferUnitOf(e.from);
  if (bu != null) e.src = { buffer: bu };                                          // dynamic: buffer outputs
}

// Miner → its drop: the drill's mined resource rides the drop for the edge's whole
// life (the edge retires with the miner, so the resource is constant). Same static
// shape as a machine drain — `itemWindows` + `dst` (a belt lane or a buffer).
function resolveMinerEdge(state, e) {
  const res = liveRec(state.miners, e.minerUnit)?.resource;
  if (!res) return;
  const dst = targetOf(e.to);
  if (!dst) return;
  e.dst = dst;
  e.itemWindows = [{ item: res, tb: e.tb, tr: e.tr ?? null }];
}

// Cross-segment belt hand-off: a dynamic belt→belt transfer. Recompute the drop lane
// from the final feeder/consumer belts when BOTH are still live (robust if a late
// rotation left mint-time `to.side` stale); a retired edge's belts are gone from
// state.belts, so keep its mint-time `to.side` rather than fall back to 'right'.
// side 'both' = a collinear inline merge (both lanes carry through).
function resolveBeltEdge(state, e) {
  const fu = lastUnit(e.from), cu = lastUnit(e.to);
  const fr = state.belts.get(fu), cr = state.belts.get(cu);
  const side = (fr && cr)
    ? beltToBeltSideAt(fr, cr, Infinity)
    : (e.to.side ?? 'right');
  e.src = 'belt';
  e.dst = { belt: side };
}

// Where a drop endpoint delivers: a belt lane (a concrete left/right — an inserter or
// miner never drops onto 'both'), a buffer pool, or nothing (a machine consumes feed).
function targetOf(ep) {
  if (ep.units.some(u => u.category === 'belt')) {
    return ep.side === 'left' || ep.side === 'right' ? { belt: ep.side } : null;
  }
  const bu = bufferUnitOf(ep);
  return bu != null ? { buffer: bu } : null;
}

// The buffer unit on an endpoint, or null. A tile holds one entity, so it's a single
// lookup, not a set (`.find` over the timeline tolerates a same-tile chest replace).
function bufferUnitOf(ep) {
  const u = ep.units.find(u => u.category === 'buffer');
  return u ? u.unit : null;
}

// Inserter filter as a content gate (which items it will move), or null when it
// passes everything.
function filterSpec(r) {
  if (!r || !r.useFilters || !r.filters?.length) return null;
  const items = r.filters.map(filterEntryToItem).filter(Boolean);
  if (!items.length) return null;
  return { mode: r.filterMode ?? 'whitelist', items };
}

// Machine drain: pickup(from) is a machine, the item is its recipe output. Overlay
// each occupying machine's recipe timeline on the edge lifetime, map recipe → output
// item, narrow by the inserter's filter. `dst` (belt lane or buffer) is set by the caller.
function resolveDrainWindows(state, e) {
  const spec = filterSpec(liveRec(state.inserters, e.inserterUnit));
  const windows = [];
  for (const fu of e.from.units) {
    if (fu.category !== 'machine') continue;
    const m = liveRec(state.machines, fu.unit);
    if (!m) continue;
    const fTr = fu.tr ?? (e.tr ?? null);
    for (const rc of (m.recipes ?? [])) {
      const item = recipeOutputItem(rc.recipe);
      if (item == null || !passesFilter(item, spec)) continue;
      const w = clip([e.tb, e.tr ?? null], [fu.tb, fTr], [rc.tb, rc.tr ?? null]);
      if (w) windows.push({ item, tb: w[0], tr: w[1] });
    }
  }
  if (windows.length) e.itemWindows = windows;
}

function recipeOutputItem(recipe) {
  if (!recipe) return null;
  if (FLUID_ONLY.has(recipe)) return null;
  return RECIPE_OVERRIDE[recipe] ?? recipe;
}

function filterEntryToItem(f) {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') return f.name ?? f.item ?? null;
  return null;
}

// Apply a filterSpec (null passes everything; unknown modes pass everything).
function passesFilter(item, spec) {
  if (!spec) return true;
  if (spec.mode === 'whitelist') return spec.items.includes(item);
  if (spec.mode === 'blacklist') return !spec.items.includes(item);
  return true;
}

const lastUnit = (ep) => ep.units[ep.units.length - 1]?.unit ?? null;

// Node record iff still live. The registries are full-history (state keeps a
// removed entity's record, `tr` stamped), but contents resolution mirrors the
// old live-registry semantics: an entity removed before finalize contributes
// nothing — a removed machine's drain windows, a removed miner's resource and a
// removed inserter's filter are all dropped, exactly as when absence-from-the-
// registry encoded "removed". (Arguably a data-loss quirk; fixing it is a
// behavior change for a separate fork — the byte-identical gate preserves it.)
const liveRec = (reg, unit) => { const r = reg.get(unit); return r && r.tr == null ? r : null; };
