// Lossless merged-entity stream — the shared upstream layer that map-prep
// and flow-prep both consume. Joins the five extracted JSONs (entityLayout,
// minerActivity, machineProduction, labContents, bufferAmounts) into one
// unified per-entity record without folding direction, without dropping the
// belt graph, and without collapsing per-tick mutations.
//
// Two exports:
//
//   buildMergedEntities(runDir, durationTick, { externalMiners } = {})
//     → MergedEntity[]
//     The lossless view. Each record carries:
//       - category    'belt' | 'inserter' | 'machine' | 'miner' | 'lab' | 'buffer'
//       - identity    name, unitNumber, location { x, y }, direction (BUILD-TIME)
//       - lifecycle   timeBuilt, timeRemoved?
//       - raw         mutations[] (verbatim from entityLayout.json — direction,
//                     beltInputs/beltOutputs, undergroundPair, splitterFilter,
//                     inserterFilters, etc., per mutation; tick-stamped)
//       - belts       beltType, beltToGroundType?, beltInputs, beltOutputs,
//                     undergroundPair? at build time (mutations carry the deltas)
//       - splitters   splitterInputPriority, splitterOutputPriority,
//                     splitterFilter at build time
//       - inserters   inserterUseFilters, inserterFilterMode, inserterFilters
//                     at build time
//       - machines    recipes[] timeline (verbatim from machineProduction.json)
//       - labs        labPacks (per-tick pack-content samples), labPeriod
//                     (shared across labs in the run)
//       - buffers     content (storedItem), amounts[] (per-tick stock samples)
//
//     durationTick is informational — the lossless view DOES NOT clip
//     mutations or entities to it. Downstream consumers clip as needed.
//
//   foldForMap(merged, durationTick) → MapMergedEntity[]
//     Folds the lossless view down to the shape map-prep historically built
//     itself: end-of-run direction (`dir`) + beltToGroundType (`bgt`),
//     splitterTimeline (only when the splitter is non-default at some point),
//     inserterTimeline (only when useFilters=true with non-empty filter set),
//     recipeTimeline. Drops belt-graph fields, raw mutations, and the lab /
//     buffer sample arrays — those are not part of map.json.
//
//     This fold is what map-prep applies *on top of* the lossless stream so
//     map.json's shape stays byte-identical to the pre-lift output.
//
// Pure module — no file I/O outside the input JSON reads, no writes.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// LAYOUT_SCOPE — only these entity names participate in the merged stream
// from entityLayout.json. Mirrors map-prep's prior scope, which mirrored the
// old fbsr-prep. Poles and other out-of-render entities are excluded.
export const LAYOUT_SCOPE = new Set([
  'transport-belt', 'fast-transport-belt', 'express-transport-belt',
  'underground-belt', 'fast-underground-belt', 'express-underground-belt',
  'splitter', 'fast-splitter', 'express-splitter',
  'burner-inserter', 'inserter', 'long-handed-inserter',
  'fast-inserter', 'filter-inserter', 'stack-inserter', 'stack-filter-inserter',
  'bulk-inserter',
]);

const INSERTER_NAMES = new Set([
  'inserter', 'burner-inserter', 'long-handed-inserter', 'fast-inserter',
  'filter-inserter', 'stack-inserter', 'stack-filter-inserter', 'bulk-inserter',
]);

function readJsonOrNull(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}
function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

// Lab timeRemoved heuristic — labContents doesn't currently record removal,
// so a lab whose last periodic sample is well before the latest sample seen
// across any lab was removed shortly after that last sample. Preserved
// verbatim from the previous map-prep behaviour.
function deriveLabRemovedTick(lab, maxSample, period) {
  if (lab.timeRemoved !== undefined) return lab.timeRemoved;
  const last = lab.packs[lab.packs.length - 1];
  if (last && last[0] + period * 2 < maxSample) return last[0] + period;
  return undefined;
}

// Machine timeRemoved heuristic — machineProduction doesn't always set
// timeRemoved, but stoppedReason=mined|entity_died on the active recipe
// signals removal. Mirrors the legacy fbsr-prep / map-prep behaviour.
function deriveMachineRemovedTick(machine) {
  if (machine.timeRemoved !== undefined) return machine.timeRemoved;
  let tr;
  for (const r of machine.recipes ?? []) {
    if ((r.stoppedReason === 'mined' || r.stoppedReason === 'entity_died')
        && r.timeStopped !== undefined) {
      if (tr === undefined || r.timeStopped > tr) tr = r.timeStopped;
    }
  }
  return tr;
}

export function buildMergedEntities(runDir, durationTick, { externalMiners } = {}) {
  const merged = [];

  // 1) entityLayout (belts, UBs, splitters, inserters — poles excluded).
  const layout = readJson(resolve(runDir, 'entityLayout.json'));
  for (const e of layout.entities) {
    if (!LAYOUT_SCOPE.has(e.name)) continue;
    const isBelt     = e.category === 'belt';
    const isSplitter = e.name.endsWith('splitter');
    const isInserter = INSERTER_NAMES.has(e.name);
    const rec = {
      category: e.category,
      name: e.name,
      unitNumber: e.unitNumber,
      location: { x: e.location.x, y: e.location.y },
      direction: e.direction ?? 0,
      timeBuilt: e.timeBuilt ?? 0,
      mutations: e.mutations ?? [],
    };
    if (e.timeRemoved !== undefined) rec.timeRemoved = e.timeRemoved;
    if (isBelt) {
      rec.beltType = e.beltType;
      if (e.beltToGroundType !== undefined) rec.beltToGroundType = e.beltToGroundType;
      // Preserve `undefined` for v1 schema (no belt-graph captured) so the
      // map-side topology rule can detect v1 and fall back to safe default.
      // Use `?? null` only as a "captured but empty" marker so {} (Lua empty
      // table) and [] (Lua array) flow through unchanged.
      rec.beltInputs  = e.beltInputs;
      rec.beltOutputs = e.beltOutputs;
      if (e.undergroundPair !== undefined) rec.undergroundPair = e.undergroundPair;
    }
    if (isSplitter) {
      rec.splitterInputPriority  = e.splitterInputPriority  ?? 'none';
      rec.splitterOutputPriority = e.splitterOutputPriority ?? 'none';
      rec.splitterFilter         = e.splitterFilter         ?? '';
    }
    if (isInserter) {
      rec.inserterUseFilters = e.inserterUseFilters ?? false;
      rec.inserterFilterMode = e.inserterFilterMode;
      rec.inserterFilters    = Array.isArray(e.inserterFilters) ? e.inserterFilters : [];
    }
    merged.push(rec);
  }

  // 2) Miners (prefer caller-supplied lifted view to share source-of-truth
  //    with build-run-data; falls back to reading minerActivity.json).
  const minerList = externalMiners?.miners
    ?? readJsonOrNull(resolve(runDir, 'minerActivity.json'))?.miners
    ?? [];
  for (const m of minerList) {
    const rec = {
      category: 'miner',
      name: m.name,
      unitNumber: m.unitNumber,
      location: { x: m.location.x, y: m.location.y },
      direction: m.direction ?? 0,
      timeBuilt: m.timeBuilt ?? 0,
      mutations: m.mutations ?? [],
    };
    if (m.timeRemoved !== undefined) rec.timeRemoved = m.timeRemoved;
    if (m.resources !== undefined)   rec.resources = m.resources;
    merged.push(rec);
  }

  // 3) Machines (recipe timeline drives the recipeMachines overlay and
  //    later feeds flow-prep's cluster recipe identity).
  const mp = readJsonOrNull(resolve(runDir, 'machineProduction.json'));
  for (const m of mp?.machines ?? []) {
    const rec = {
      category: 'machine',
      name: m.name,
      unitNumber: m.unitNumber,
      location: { x: m.location.x, y: m.location.y },
      direction: m.direction ?? 0,
      timeBuilt: m.timeBuilt ?? 0,
      mutations: m.mutations ?? [],
      recipes: m.recipes ?? [],
    };
    const tr = deriveMachineRemovedTick(m);
    if (tr !== undefined) rec.timeRemoved = tr;
    merged.push(rec);
  }

  // 4) Labs.
  const labData = readJsonOrNull(resolve(runDir, 'labContents.json'));
  if (labData) {
    let maxSample = 0;
    for (const l of labData.labs) {
      const last = l.packs[l.packs.length - 1];
      if (last && last[0] > maxSample) maxSample = last[0];
    }
    for (const l of labData.labs) {
      const rec = {
        category: 'lab',
        name: l.name,
        unitNumber: l.unitNumber,
        location: { x: l.location.x, y: l.location.y },
        direction: 0,
        timeBuilt: l.timeBuilt ?? 0,
        mutations: [],
        labPeriod: labData.period,
        labPacks: l.packs ?? [],
      };
      const tr = deriveLabRemovedTick(l, maxSample, labData.period);
      if (tr !== undefined) rec.timeRemoved = tr;
      merged.push(rec);
    }
  }

  // 5) Buffers (chests + tanks). content = storedItem semantically.
  const ba = readJsonOrNull(resolve(runDir, 'bufferAmounts.json'));
  for (const b of ba?.buffers ?? []) {
    const rec = {
      category: 'buffer',
      name: b.name,
      unitNumber: b.unitNumber,
      location: { x: b.location.x, y: b.location.y },
      direction: 0,
      timeBuilt: b.timeBuilt ?? 0,
      mutations: [],
      content: b.content ?? null,
      amounts: b.amounts ?? [],
    };
    if (b.type !== undefined)        rec.bufferType  = b.type;
    if (b.timeRemoved !== undefined) rec.timeRemoved = b.timeRemoved;
    merged.push(rec);
  }

  return merged;
}

// --- Map-side fold helpers ----------------------------------------------------

function foldDirectionAndBgt(rec, cutoff) {
  let dir = rec.direction ?? 0;
  let bgt = rec.beltToGroundType ?? null;
  for (const m of rec.mutations ?? []) {
    if (m.tick > cutoff) break;
    if (m.direction !== undefined)        dir = m.direction;
    if (m.beltToGroundType !== undefined) bgt = m.beltToGroundType;
  }
  return { dir, bgt };
}

function buildSplitterTimeline(rec) {
  let ip = rec.splitterInputPriority  ?? 'none';
  let op = rec.splitterOutputPriority ?? 'none';
  let f  = rec.splitterFilter         ?? '';
  const events = [{ ts: rec.timeBuilt ?? 0, ip, op, f }];
  for (const m of rec.mutations ?? []) {
    let changed = false;
    if (m.splitterInputPriority  !== undefined && m.splitterInputPriority  !== ip) { ip = m.splitterInputPriority;  changed = true; }
    if (m.splitterOutputPriority !== undefined && m.splitterOutputPriority !== op) { op = m.splitterOutputPriority; changed = true; }
    if (m.splitterFilter         !== undefined && m.splitterFilter         !== f)  { f  = m.splitterFilter;         changed = true; }
    if (changed) events.push({ ts: m.tick, ip, op, f });
  }
  const anyOverlay = events.some(ev => ev.ip !== 'none' || ev.op !== 'none' || ev.f !== '');
  return anyOverlay ? events : [];
}

function sameStrArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildInserterTimeline(rec) {
  const asArr = (v) => Array.isArray(v) ? v : [];
  let u = rec.inserterUseFilters ?? false;
  let m = rec.inserterFilterMode;
  let f = asArr(rec.inserterFilters);
  const events = [{ ts: rec.timeBuilt ?? 0, u, m, f }];
  for (const mu of rec.mutations ?? []) {
    let changed = false;
    if (mu.inserterUseFilters !== undefined && mu.inserterUseFilters !== u) { u = mu.inserterUseFilters; changed = true; }
    if (mu.inserterFilterMode !== undefined && mu.inserterFilterMode !== m) { m = mu.inserterFilterMode; changed = true; }
    if (mu.inserterFilters    !== undefined) {
      const next = asArr(mu.inserterFilters);
      if (!sameStrArr(next, f)) { f = next; changed = true; }
    }
    if (changed) events.push({ ts: mu.tick, u, m, f });
  }
  const anyOverlay = events.some(ev => ev.u && ev.f.length > 0);
  return anyOverlay ? events : [];
}

// Fold the lossless stream to the legacy map-side record shape. Field names
// match what map-prep historically constructed inline (`ux`/`uy`/`dir`/`bgt`/
// `tb`/`tr`/`un`/recipeTimeline/splitterTimeline/inserterTimeline).
export function foldForMap(merged, durationTick) {
  const out = [];
  for (const rec of merged) {
    const isBelt     = rec.category === 'belt';
    const isSplitter = rec.name.endsWith('splitter');
    const isInserter = INSERTER_NAMES.has(rec.name);

    // Only entityLayout-sourced records carry direction mutations; miners /
    // machines / labs / buffers always used `m.direction ?? 0` with bgt=null
    // in the legacy map-prep, so leave those alone.
    let dir = rec.direction ?? 0;
    let bgt = null;
    if (isBelt || isInserter) {
      const folded = foldDirectionAndBgt(rec, durationTick);
      dir = folded.dir;
      bgt = folded.bgt;
    }

    const m = {
      name: rec.name,
      ux: rec.location.x,
      uy: rec.location.y,
      dir,
      bgt,
      tb: rec.timeBuilt ?? 0,
      un: rec.unitNumber,
    };
    if (rec.timeRemoved !== undefined) m.tr = rec.timeRemoved;
    if (rec.category === 'machine') {
      const timeline = (rec.recipes ?? [])
        .filter(r => r && r.recipe)
        .map(r => ({ ts: r.timeStarted ?? 0, n: r.recipe }));
      if (timeline.length > 0) m.recipeTimeline = timeline;
    }
    if (isSplitter) {
      const evs = buildSplitterTimeline(rec);
      if (evs.length > 0) m.splitterTimeline = evs;
    }
    if (isInserter) {
      const evs = buildInserterTimeline(rec);
      if (evs.length > 0) m.inserterTimeline = evs;
    }
    out.push(m);
  }
  return out;
}
