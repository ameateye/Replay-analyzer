// Shared helpers for the diagnostic probes (probe-at / probe-segment / probe-events).
//
// "Across datasets" = across the data LAYERS a single run produces, not across
// runs. One save fans out into many datasets — the raw collector JSONs
// (entityLayout / machineProduction / minerActivity / bufferAmounts) and the
// derived flow stack (merged entities → events → segments → edges). The probes
// take ONE target (a unit / tile / segment) and show what every layer says about
// it, joined on `unitNumber`, surfacing where the layers diverge.
//
// Output is meant to land in an agent's context: terse by default (one line per
// unit), full per-layer breakdown behind --verbose, lists capped with "+N more".
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildFlow, synthesiseEventsForRun } from '../flow-prep.mjs';
import { buildMergedEntities } from '../lib/layout/merge-entities.mjs';
import { normalizeBufferFile, heldItems } from '../lib/buffer.mjs';
import { createState, applyEvent, reconcile, finalize } from '../lib/flow/segments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'extracted-data');

// ── run selection (single run; cross-LAYER, not cross-run) ──────
export function listRuns() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
}
export function selectRun(flags) {
  const all = listRuns();
  if (!all.length) { console.error('no runs under extracted-data/'); process.exit(1); }
  if (flags.run && flags.run !== true) {
    const r = all.find(x => x === flags.run);
    if (!r) { console.error(`run "${flags.run}" not found. available: ${all.join(', ')}`); process.exit(1); }
    return r;
  }
  let best = all[0], bt = -1;            // default: newest dataset by mtime
  for (const r of all) { const t = fs.statSync(path.join(DATA_DIR, r)).mtimeMs; if (t > bt) { bt = t; best = r; } }
  return best;
}
export function runDir(name) { return path.join(DATA_DIR, name); }

// Probes read the FULL save by default; --until <tick> clips (e.g. rocket launch).
export function fullOr(flags) { return flags.until != null && flags.until !== true ? +flags.until : Number.MAX_SAFE_INTEGER; }

// ── argv ────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const positionals = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; } }
    else positionals.push(a);
  }
  return { positionals, flags };
}

// ── load every layer for one run ────────────────────────────────
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const indexBy = (arr, k = 'unitNumber') => { const m = new Map(); for (const r of arr ?? []) m.set(r[k], r); return m; };
const asIds = v => Array.isArray(v) ? v : [];   // belt in/out is [ids] OR {} when empty
// entityLayout only collects the belt network — belts, inserters, poles. Machines
// / miners / buffers live in their own collectors, so "absent from layout" is only
// a divergence for these categories.
const LAYOUT_CATS = new Set(['belt', 'inserter', 'pole']);

export function loadLayers(run, dur) {
  const dir = runDir(run);
  const raw = {
    layout: indexBy(readJson(path.join(dir, 'entityLayout.json'))?.entities),
    machine: indexBy(readJson(path.join(dir, 'machineProduction.json'))?.machines),
    miner: indexBy(readJson(path.join(dir, 'minerActivity.json'))?.miners),
    buffer: indexBy(normalizeBufferFile(readJson(path.join(dir, 'bufferAmounts.json')))?.buffers),
  };
  const mergedArr = buildMergedEntities(dir, dur);
  const merged = indexBy(mergedArr);
  const events = synthesiseEventsForRun(dir, dur);
  const seg = segStateFromEvents(events, dur);
  const flow = buildFlow(dir, dur, { merged: mergedArr });
  return { run, dir, dur, raw, merged, mergedArr, events, seg, edges: flow?.edges ?? [], segRecords: flow?.beltSegments ?? [] };
}

// ── segment pipeline (exposes state.segOf / .belts / .segs / .retired) ──
export function segStateFromEvents(events, dur) {
  const st = createState();
  let dirty = new Set(), cur = null;
  for (const e of events) {
    if (cur !== null && e.tick !== cur) { reconcile(st, dirty, cur); dirty = new Set(); }
    cur = e.tick;
    const d = applyEvent(st, e); if (d) for (const u of d) dirty.add(u);
  }
  if (cur !== null) reconcile(st, dirty, cur);
  finalize(st, dur);
  return st;
}
export function membersOf(state, segId) {
  const num = Number(String(segId).replace(/^S-/, ''));
  for (const s of [...state.segs.values(), ...state.retired]) if (s.id === num) return s.members;
  return null;
}
export const segOfUnit = (L, unit) => L.seg.segOf.has(unit) ? `S-${L.seg.segOf.get(unit)}` : null;

// ── edges touching a unit (directly, or via its belt segment) ───
const segNum = s => String(s).replace(/^S-/, '');
function edgeHitsUnit(e, unit) {
  if (e.inserterUnit === unit || e.minerUnit === unit) return true;
  for (const ep of [e.from, e.to]) if (ep?.units?.some(u => u.unit === unit)) return true;
  return false;
}
function edgeHitsSeg(e, sNum) {
  for (const ep of [e.from, e.to]) if (ep?.segs?.some(s => segNum(s.seg) === sNum)) return true;
  return false;
}
export function edgesForUnit(L, unit) {
  const s = L.seg.segOf.has(unit) ? String(L.seg.segOf.get(unit)) : null;
  return L.edges.filter(e => edgeHitsUnit(e, unit) || (s && edgeHitsSeg(e, s)));
}
function endpoint(ep) {
  const p = [];
  if (ep?.segs?.length) p.push(ep.segs.map(s => `S-${segNum(s.seg)}`).join(','));
  if (ep?.units?.length) p.push(ep.units.map(u => `${(u.category || '?')[0]}#${u.unit}`).join(','));
  if (ep?.tile) p.push(`@${ep.tile.x},${ep.tile.y}`);
  if (ep?.side) p.push(ep.side);
  return p.join(' ') || '?';
}
const edgeOwner = e => e.inserterUnit ? `ins#${e.inserterUnit}` : e.minerUnit ? `mine#${e.minerUnit}` : 'belt';

// ── divergences: where the layers disagree about a unit ─────────
export function divergences(L, unit) {
  const out = [];
  const lay = L.raw.layout.get(unit), m = L.merged.get(unit);
  const cat = m?.category ?? lay?.category;
  if (LAYOUT_CATS.has(cat)) {
    if (lay && !m) out.push('in layout, absent from merged');
    if (!lay && m) out.push('in merged, absent from layout');
  }
  if (m?.category === 'machine' && !L.raw.machine.has(unit)) out.push('merged machine, absent from machineProduction');
  if (L.raw.machine.has(unit) && !m) out.push('in machineProduction, absent from merged');
  if (L.raw.miner.has(unit) && !m) out.push('in minerActivity, absent from merged');
  if (L.raw.buffer.has(unit) && !m) out.push('in bufferAmounts, absent from merged');
  // ghost belt connections: belt in/out ids that have no entity record
  if (lay && (lay.category === 'belt')) {
    const ids = new Set();
    for (const v of [lay.beltInputs, lay.beltOutputs]) for (const id of asIds(v)) ids.add(id);
    for (const mut of lay.mutations ?? []) for (const v of [mut.beltInputs, mut.beltOutputs]) for (const id of asIds(v)) ids.add(id);
    const ghosts = [...ids].filter(id => !L.raw.layout.has(id));
    if (ghosts.length) out.push(`belt links to non-existent unit(s): ${ghosts.map(g => 'u#' + g).join(',')}`);
  }
  if (m && m.category === 'belt' && !segOfUnit(L, unit) && m.timeRemoved == null) out.push('live belt in no segment');
  return out;
}

// ── the per-unit cross-layer dossier ────────────────────────────
function identity(L, unit) {
  const m = L.merged.get(unit), lay = L.raw.layout.get(unit);
  const name = m?.name ?? lay?.name ?? '?';
  const cat = m?.category ?? lay?.category ?? '?';
  const loc = m?.location ?? lay?.location;
  const dir = m?.direction ?? lay?.direction;
  const tb = m?.timeBuilt ?? lay?.timeBuilt;
  const tr = m?.timeRemoved ?? lay?.timeRemoved;
  return { name, cat, loc, dir, tb, tr };
}

// One compact line (default): identity + which layers hold it + key facts + divergence.
export function dossierLine(L, unit) {
  const { name, cat, loc, dir, tb, tr } = identity(L, unit);
  const mp = L.raw.machine.get(unit), mn = L.raw.miner.get(unit), bf = L.raw.buffer.get(unit);
  const tags = [`mrg${L.merged.has(unit) ? '✓' : '✗'}`];
  if (LAYOUT_CATS.has(cat)) tags.push(`lay${L.raw.layout.has(unit) ? '✓' : '✗'}`);
  if (mp) tags.push(`mach:${[...new Set((mp.recipes ?? []).map(r => r.recipe))].join('>') || '—'}`);
  if (mn) tags.push(`mine:${(mn.resources ?? []).join(',') || '—'}`);
  if (bf) tags.push(`buf:${heldItems(bf).join('+') || '—'}`);
  const seg = segOfUnit(L, unit); if (seg) tags.push(`seg:${seg}`);
  const ne = edgesForUnit(L, unit).length; if (ne) tags.push(`edges:${ne}`);
  const div = divergences(L, unit);
  return `u#${unit} ${name} ${cat} @(${loc?.x},${loc?.y}) d${dir ?? '?'} ${fmtLife(tb, tr)}  ${tags.join(' ')}${div.length ? '  ! ' + div.join('; ') : ''}`;
}

// Full per-layer breakdown (--verbose).
export function dossierBlock(L, unit) {
  const { name, cat, loc, dir, tb, tr } = identity(L, unit);
  const lines = [`u#${unit} ${name} ${cat} @(${loc?.x},${loc?.y}) d${dir ?? '?'} ${fmtLife(tb, tr)}`];
  const lay = L.raw.layout.get(unit);
  if (lay) {
    let s = `  layout    built=${lay.timeBuilt}${lay.timeRemoved != null ? ` removed=${lay.timeRemoved}` : ''}`;
    if (cat === 'belt') s += ` in[${asIds(lay.beltInputs).join(',')}] out[${asIds(lay.beltOutputs).join(',')}]${lay.mutations?.length ? ` mut=${lay.mutations.length}` : ''}`;
    lines.push(s);
  }
  const m = L.merged.get(unit);
  if (m) lines.push(`  merged    ${m.category}${m.recipes?.length ? ` recipes:${[...new Set(m.recipes.map(r => r.recipe))].join('>')}` : ''}${m.resources?.length ? ` mines:${m.resources.join(',')}` : ''}${m.contents && heldItems(m).length ? ` buf:${heldItems(m).join('+')}` : ''}${m.mutations?.length ? ` mut=${m.mutations.length}` : ''}`);
  const mp = L.raw.machine.get(unit);
  if (mp) for (const r of mp.recipes ?? []) lines.push(`  machineP  ${r.recipe} start=${r.timeStarted}${r.timeStopped != null ? ` stop=${r.timeStopped}(${r.stoppedReason ?? '?'})` : ''} samples=${r.production?.length ?? 0}`);
  const mn = L.raw.miner.get(unit);
  if (mn) lines.push(`  minerA    ${(mn.resources ?? []).join(',')} statuses=${(mn.statuses ?? []).length}`);
  const bf = L.raw.buffer.get(unit);
  if (bf) lines.push(`  bufferA   ${heldItems(bf).join('+') || '?'} samples=${Object.values(bf.contents ?? {}).reduce((n, s) => n + s.length, 0)}`);
  const seg = segOfUnit(L, unit);
  lines.push(`  segment   ${seg ?? '—'}`);
  lines.push(`  cluster   (pending: clusters.mjs not yet wired into buildFlow)`);
  const es = edgesForUnit(L, unit);
  for (const e of es.slice(0, 12)) {
    const incoming = e.to?.units?.some(u => u.unit === unit) || e.to?.segs?.some(s => segNum(s.seg) === String(L.seg.segOf.get(unit)));
    lines.push(`  edge      ${e.id} ${edgeOwner(e)} ${incoming ? '<-' : '->'} ${endpoint(incoming ? e.from : e.to)} ${fmtLife(e.tb, e.tr)}`);
  }
  if (es.length > 12) lines.push(`  edge      +${es.length - 12} more`);
  for (const d of divergences(L, unit)) lines.push(`  ! ${d}`);
  return lines;
}

// ── formatting ──────────────────────────────────────────────────
export function fmtLife(tb, tr) { return `life=[${tb ?? '?'},${tr ?? 'end'})`; }
export function bboxOf(t = []) {
  if (!t.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of t) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return `${x0},${y0}..${x1},${y1}`;
}
export function emit(lines, cap = Infinity) {
  for (const l of lines.slice(0, cap)) console.log(l);
  if (lines.length > cap) console.log(`    +${lines.length - cap} more`);
}
