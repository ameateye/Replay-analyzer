// events.mjs — entity-event synthesis for the flow fold.
//
// Turns the lossless merged-entity stream (lib/layout/merge-entities.mjs) into
// the sorted event stream buildFlow folds: entity-built / entity-mutated /
// entity-removed / entity-replaced / recipe-changed / buffer-content-changed,
// clipped to durationTick, with three normalisations applied (build-tick
// mutate fold, side-effect-mutate drop, quick-replace collapse — see each
// helper). Pure: merged stream in, event array out.

import { heldItems, dominantItem } from '../buffer.mjs';
import { floorTile, tileKey } from './util.mjs';

export function synthesiseEvents(merged, durationTick) {
  const evs = [];
  for (const m of merged) {
    if (m.timeBuilt > durationTick) continue;
    const base = baseFields(m);
    evs.push({
      type: 'entity-built',
      tick: m.timeBuilt ?? 0,
      ...base,
    });
    for (const mu of m.mutations ?? []) {
      if (mu.tick > durationTick) break;
      const evt = { type: 'entity-mutated', tick: mu.tick, unit: m.unitNumber, category: m.category, name: m.name };
      if (mu.direction !== undefined)              evt.direction = mu.direction;
      if (mu.beltToGroundType !== undefined)       evt.beltToGroundType = mu.beltToGroundType;
      if (mu.beltInputs !== undefined)             evt.beltInputs = mu.beltInputs;
      if (mu.beltOutputs !== undefined)            evt.beltOutputs = mu.beltOutputs;
      if (mu.undergroundPair !== undefined)        evt.undergroundPair = mu.undergroundPair;
      if (mu.splitterInputPriority !== undefined)  evt.splitterInputPriority = mu.splitterInputPriority;
      if (mu.splitterOutputPriority !== undefined) evt.splitterOutputPriority = mu.splitterOutputPriority;
      if (mu.splitterFilter !== undefined)         evt.splitterFilter = mu.splitterFilter;
      if (mu.inserterUseFilters !== undefined)     evt.inserterUseFilters = mu.inserterUseFilters;
      if (mu.inserterFilterMode !== undefined)     evt.inserterFilterMode = mu.inserterFilterMode;
      if (mu.inserterFilters !== undefined)        evt.inserterFilters = mu.inserterFilters;
      evs.push(evt);
    }
    if (m.category === 'machine') {
      for (const r of m.recipes ?? []) {
        const ts = r.timeStarted ?? r.startTick ?? null;
        if (ts == null || ts > durationTick) continue;
        evs.push({
          type: 'recipe-changed',
          tick: ts,
          unit: m.unitNumber,
          category: m.category,
          name: m.name,
          recipe: r.recipe,
        });
      }
    }
    if (m.category === 'buffer') {
      // A chest/tank can hold several item types — emit one content event per
      // held item (derived from the diff-compressed `contents` series object).
      for (const item of heldItems(m)) {
        evs.push({
          type: 'buffer-content-changed',
          tick: m.timeBuilt ?? 0,
          unit: m.unitNumber,
          category: m.category,
          name: m.name,
          storedItem: item,
        });
      }
    }
    if (m.timeRemoved !== undefined && m.timeRemoved <= durationTick) {
      evs.push({
        type: 'entity-removed',
        tick: m.timeRemoved,
        unit: m.unitNumber,
        category: m.category,
        name: m.name,
        location: m.location,
      });
    }
  }
  evs.sort((a, b) => (a.tick - b.tick) || eventRank(a) - eventRank(b));
  return collapseQuickReplace(dropSideEffectMutates(foldBuildTickMutates(evs)));
}

// Same-tick atomicity: when a belt is BUILT at tick T and gets an
// entity-mutated event at the SAME tick on the SAME unit (the engine
// populating its beltInputs/Outputs after placement), fold the mutate's
// fields into the BUILD event and drop the mutate. The build event then
// carries the correct connectivity at construction time, and segments.mjs
// sees one event instead of two. This eliminates the transient 1-tile
// "birth then merge" churn that explodes split/merge counts.
function foldBuildTickMutates(evs) {
  const META = new Set(['type', 'tick', 'unit', 'category', 'name', 'location']);
  const buildIdx = new Map();
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.type === 'entity-built' && ev.category === 'belt') {
      buildIdx.set(`${ev.tick}|${ev.unit}`, i);
    }
  }
  const dropped = new Set();
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.type !== 'entity-mutated') continue;
    if (ev.category !== 'belt') continue;
    const bi = buildIdx.get(`${ev.tick}|${ev.unit}`);
    if (bi == null) continue;
    const build = evs[bi];
    for (const k of Object.keys(ev)) {
      if (META.has(k)) continue;
      build[k] = ev[k];
    }
    dropped.add(i);
  }
  if (dropped.size === 0) return evs;
  return evs.filter((_, i) => !dropped.has(i));
}

// Drop belt mutate events that are pure UG-pair clear/attach side-effects.
//
// We keep beltInputs / beltOutputs mutates — segments.mjs uses them as the
// authoritative connectivity source. undergroundPair-only mutates are
// droppable: the OTHER side carries the link (via its own beltInputs/Outputs
// at build time), so dropping a one-sided ugp update is safe and avoids the
// cascading-split artefact from S-239.
function dropSideEffectMutates(evs) {
  const SIDE_EFFECT_ONLY = new Set(['undergroundPair']);
  const META = new Set(['type', 'tick', 'unit', 'category', 'name', 'location']);
  return evs.filter(ev => {
    if (ev.type !== 'entity-mutated') return true;
    if (ev.category !== 'belt') return true;
    for (const k of Object.keys(ev)) {
      if (META.has(k)) continue;
      if (!SIDE_EFFECT_ONLY.has(k)) return true;  // has a real change
    }
    return false;
  });
}

function eventRank(ev) {
  switch (ev.type) {
    case 'entity-replaced':         return 0;
    case 'entity-built':            return 1;
    case 'entity-mutated':          return 2;
    case 'recipe-changed':          return 3;
    case 'buffer-content-changed':  return 4;
    case 'entity-removed':          return 5;
    default:                        return 9;
  }
}

// Pair (entity-removed u_old) + (entity-built u_new) belt events that fire at
// the SAME tick on the SAME tile into a single 'entity-replaced' event.
// This collapses the in-game quick-replace pattern (e.g. transport-belt →
// underground-belt swap, rotation, tier upgrade) so segments.mjs sees one
// atomic swap instead of an intermediate remove that briefly splits the
// segment before the build can restore connectivity. Splitters are skipped
// in V1 (they occupy two tiles and rarely round-trip through quick-replace).
function collapseQuickReplace(evs) {
  const groups = new Map();
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.category !== 'belt') continue;
    if (ev.type !== 'entity-built' && ev.type !== 'entity-removed') continue;
    if (typeof ev.name === 'string' && ev.name.endsWith('splitter')) continue;
    if (!ev.location) continue;
    const t = floorTile(ev.location);
    const k = `${ev.tick}|${tileKey(t.x, t.y)}`;
    if (!groups.has(k)) groups.set(k, { built: [], removed: [] });
    const g = groups.get(k);
    if (ev.type === 'entity-built') g.built.push(i);
    else g.removed.push(i);
  }

  const dropped = new Set();
  const replacements = [];
  for (const g of groups.values()) {
    const n = Math.min(g.built.length, g.removed.length);
    for (let i = 0; i < n; i++) {
      const bi = g.built[i], ri = g.removed[i];
      const builtEv = evs[bi], removedEv = evs[ri];
      if (builtEv.unit === removedEv.unit) continue;  // safety
      dropped.add(bi); dropped.add(ri);
      const base = { ...builtEv };
      delete base.type;
      replacements.push({
        type: 'entity-replaced',
        ...base,
        oldUnit: removedEv.unit,
        newUnit: builtEv.unit,
        unit: builtEv.unit,
      });
    }
  }

  if (dropped.size === 0) return evs;
  const out = [];
  for (let i = 0; i < evs.length; i++) if (!dropped.has(i)) out.push(evs[i]);
  out.push(...replacements);
  out.sort((a, b) => (a.tick - b.tick) || eventRank(a) - eventRank(b));
  return out;
}

function baseFields(m) {
  const out = {
    unit: m.unitNumber,
    name: m.name,
    category: m.category,
    location: m.location,
    direction: m.direction ?? 0,
  };
  if (m.category === 'belt') {
    out.beltType = m.beltType;
    out.beltToGroundType = m.beltToGroundType ?? null;
    out.beltInputs = m.beltInputs ?? {};
    out.beltOutputs = m.beltOutputs ?? {};
    out.undergroundPair = m.undergroundPair ?? null;
    // Splitter-only fields (lossless from merge-entities; undefined when the
    // belt isn't a splitter so addBelt sees null).
    if (m.splitterFilter         !== undefined) out.splitterFilter         = m.splitterFilter;
    if (m.splitterInputPriority  !== undefined) out.splitterInputPriority  = m.splitterInputPriority;
    if (m.splitterOutputPriority !== undefined) out.splitterOutputPriority = m.splitterOutputPriority;
  }
  if (m.category === 'inserter') {
    out.inserterUseFilters = !!m.inserterUseFilters;
    out.inserterFilters    = Array.isArray(m.inserterFilters) ? m.inserterFilters : [];
    out.inserterFilterMode = m.inserterFilterMode ?? null;
  }
  if (m.category === 'machine' || m.category === 'miner') {
    out.recipe = null;
    out.resources = m.resources ?? null;
  }
  if (m.category === 'buffer') {
    // A buffer can hold several item types. `storedItems` is the full list;
    // `storedItem` is the first of those, kept for backward compatibility.
    // `storedItemDominant` (the item the buffer mostly holds) rides the built
    // event so registration stays event-local — clusters keys buffers by it.
    const items = heldItems(m);
    out.storedItem = items[0] ?? null;
    out.storedItems = items;
    out.storedItemDominant = dominantItem(m) ?? null;
  }
  return out;
}
