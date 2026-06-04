// probe-events (--unit N | --seg S | --from T --to T | --type K) [--run <name>]
//               [--until <tick>] [--limit N]
//
// Temporal entry point. With --unit it builds a UNIFIED timeline for one entity,
// interleaving every layer's time series: synthesised flow events, the raw
// machineProduction / minerActivity / bufferAmounts transitions, and edge
// births/retires. With --seg it lists the events of a segment's member belts;
// otherwise it filters the synthesised event stream. One run; defaults to newest.
//
//   node dashboard/scripts/diagnostics/probe-events.mjs --unit 36
//   node dashboard/scripts/diagnostics/probe-events.mjs --seg S-159 --from 139000 --to 140000
import { selectRun, loadLayers, fullOr, parseArgs, membersOf, edgesForUnit, segOfUnit, emit } from './probe-lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const unit = flags.unit != null && flags.unit !== true ? +flags.unit : null;
const from = flags.from != null && flags.from !== true ? +flags.from : null;
const to = flags.to != null && flags.to !== true ? +flags.to : null;
const type = flags.type && flags.type !== true ? String(flags.type) : null;
const limit = flags.limit && flags.limit !== true ? +flags.limit : 60;
if (unit == null && !flags.seg && from == null && to == null && !type) {
  console.error('usage: probe-events (--unit N | --seg S | --from T --to T | --type K) [--run <name>] [--limit N]');
  process.exit(1);
}

const ABBR = { 'entity-built': 'built', 'entity-mutated': 'mutated', 'entity-removed': 'removed', 'recipe-changed': 'recipe', 'buffer-content-changed': 'buffer', 'segment-retired': 'seg-retire' };
const fmtv = v => Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' && v ? '{…}' : String(v);
function evtSummary(e) {
  switch (e.type) {
    case 'entity-built': return `${e.name ?? ''}${e.location ? ` (${e.location.x},${e.location.y})` : ''}${e.direction != null ? ` d${e.direction}` : ''}`;
    case 'entity-mutated': { const f = []; for (const k of ['direction', 'beltToGroundType', 'undergroundPair', 'splitterOutputPriority', 'splitterInputPriority', 'splitterFilter']) if (e[k] !== undefined) f.push(`${k}=${fmtv(e[k])}`); return f.join(' ') || '(mutated)'; }
    case 'recipe-changed': return e.recipe ?? '';
    case 'buffer-content-changed': return `${e.storedItem ?? e.content ?? ''}`;
    case 'segment-retired': return e.segId ?? '';
    default: return '';
  }
}
const inWindow = t => (from == null || t >= from) && (to == null || t <= to);

const run = selectRun(flags);
const L = loadLayers(run, fullOr(flags));
console.log(`# run ${run}`);

// ── unified per-unit timeline across every layer ────────────────
if (unit != null) {
  const pts = [];
  for (const e of L.events) if (e.unit === unit && inWindow(e.tick)) pts.push([e.tick, 'evt', `${ABBR[e.type] ?? e.type} ${evtSummary(e)}`]);
  const mp = L.raw.machine.get(unit);
  for (const r of mp?.recipes ?? []) {
    if (inWindow(r.timeStarted)) pts.push([r.timeStarted, 'mach', `recipe ${r.recipe} start`]);
    if (r.timeStopped != null && inWindow(r.timeStopped)) pts.push([r.timeStopped, 'mach', `recipe ${r.recipe} stop (${r.stoppedReason ?? '?'})`]);
    let prev = null;
    for (const s of r.production ?? []) { const st = s[4]; if (st !== prev) { if (inWindow(s[0])) pts.push([s[0], 'mach', `status ${st}`]); prev = st; } }
  }
  const mn = L.raw.miner.get(unit);
  for (const [t, st] of mn?.statuses ?? []) if (inWindow(t)) pts.push([t, 'mine', `status ${st}`]);
  const bf = L.raw.buffer.get(unit);
  { let prev = null; for (const [t, a] of bf?.amounts ?? []) { if (a !== prev) { if (inWindow(t)) pts.push([t, 'buf', `amount ${a}`]); prev = a; } } }
  for (const e of edgesForUnit(L, unit)) {
    if (inWindow(e.tb)) pts.push([e.tb, 'edge', `${e.id} born`]);
    if (e.tr != null && inWindow(e.tr)) pts.push([e.tr, 'edge', `${e.id} retire`]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (!pts.length) { console.log(`(no timeline for u#${unit})`); process.exit(0); }
  console.log(`timeline u#${unit} (seg ${segOfUnit(L, unit) ?? '—'}):`);
  emit(pts.map(([t, src, txt]) => `  ${t}  ${src.padEnd(4)} ${txt}`), limit);
  process.exit(0);
}

// ── segment member belts, or a plain filtered event stream ──────
let members = null;
if (flags.seg) { members = membersOf(L.seg, flags.seg); if (!members) { console.log(`(no ${flags.seg} in ${run})`); process.exit(0); } }
const hits = L.events.filter(e =>
  (members == null || members.has(e.unit)) && inWindow(e.tick) &&
  (!type || e.type === type || ABBR[e.type] === type));
if (!hits.length) { console.log('(no matching events)'); process.exit(0); }
emit(hits.map(e => `${e.tick}  ${(ABBR[e.type] ?? e.type).padEnd(10)} u#${e.unit ?? '—'} ${segOfUnit(L, e.unit) ? `[${segOfUnit(L, e.unit)}] ` : ''}${evtSummary(e)}`), limit);
