// Post-collection gate: belt_neighbours reciprocity over RAW collector data
// (extracted-data/<run>/entityLayout.json). A physical feed edge f->c (f feeds c)
// is RECIPROCAL at a tick iff f.beltOutputs has c AND c.beltInputs has f; it is
// ONE-SIDED if exactly one side claims it. We check BOTH directions at EVERY tick
// of each edge's shared lifetime, because an edge can be reciprocal at birth, go
// one-sided mid-life (one endpoint's neighbours get re-read, its partner's don't),
// then heal. Those mid-life one-sided windows are what break the segment flood
// (asymmetric same-segment relation -> seed-order split).
//
// Factorio keeps belt_neighbours reciprocal at every tick (verified headless:
// docs/factorio-knowledge + the belt-replace experiment), so ANY one-sided edge
// is a collector read/update-timing bug, not game behaviour. This gate exits
// non-zero when it finds one, so it can run after a collection as a regression
// check (replay-tool wires it into `extract`).
//
//   node check-belt-reciprocity.mjs <run-name | run-folder | path/to/entityLayout.json>
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = process.argv[2] || 'DS-2_02_56';

function resolveLayout(a) {
  if (existsSync(a) && statSync(a).isFile()) return a; // explicit file
  if (existsSync(a) && statSync(a).isDirectory()) return join(a, 'entityLayout.json'); // run folder
  return join(repoRoot, 'extracted-data', a, 'entityLayout.json'); // run name
}
const layoutPath = resolveLayout(arg);
if (!existsSync(layoutPath)) {
  console.error(`entityLayout.json not found for "${arg}" (looked at ${layoutPath})`);
  process.exit(2);
}

const data = JSON.parse(readFileSync(layoutPath, 'utf8'));
const idn = (v) => (Array.isArray(v) ? v.map(Number) : []);

const tl = new Map(); // unit -> {snaps:[{tick,in:Set,out:Set}], built, removed, ghost}
for (const e of data.entities) {
  if (!/belt/.test(e.category)) continue;
  let i = idn(e.beltInputs), o = idn(e.beltOutputs);
  const snaps = [{ tick: e.timeBuilt ?? 0, in: new Set(i), out: new Set(o) }];
  for (const mu of e.mutations ?? []) {
    if (mu.beltInputs === undefined && mu.beltOutputs === undefined) continue;
    if (mu.beltInputs !== undefined) i = idn(mu.beltInputs);
    if (mu.beltOutputs !== undefined) o = idn(mu.beltOutputs);
    snaps.push({ tick: mu.tick, in: new Set(i), out: new Set(o) });
  }
  tl.set(e.unitNumber, { snaps, built: e.timeBuilt ?? 0, removed: e.timeRemoved ?? Infinity, ghost: !!e.ghost });
}
const stateAt = (u, t) => { const e = tl.get(u); if (!e) return null; let cur = null; for (const s of e.snaps) { if (s.tick <= t) cur = s; else break; } return cur; };

// distinct feed edges f->c, from BOTH sides' claims, anywhere in time
const edges = new Set();
for (const [A, { snaps }] of tl) for (const s of snaps) { for (const B of s.out) edges.add(A + '>' + B); for (const B of s.in) edges.add(B + '>' + A); }

let alwaysOk = 0, oneSidedSome = 0, healed = 0, neverRecip = 0, ghostInvolved = 0, oneSidedTickInstances = 0;
let maxDur = 0, maxDurEdge = '';
const exLong = [];
for (const k of edges) {
  const [f, c] = k.split('>').map(Number);
  const ef = tl.get(f), ec = tl.get(c);
  if (!ef || !ec) continue;
  const lo = Math.max(ef.built, ec.built), hi = Math.min(ef.removed, ec.removed);
  if (!(lo < hi)) continue;
  const ticks = new Set([lo]);
  for (const s of ef.snaps) if (s.tick >= lo && s.tick < hi) ticks.add(s.tick);
  for (const s of ec.snaps) if (s.tick >= lo && s.tick < hi) ticks.add(s.tick);
  const ordered = [...ticks].sort((a, b) => a - b);
  let sawOne = false, sawRecip = false, oneStart = null, dur = 0;
  for (const t of ordered) {
    const so = stateAt(f, t), si = stateAt(c, t);
    const fHasC = !!so && so.out.has(c), cHasF = !!si && si.in.has(f);
    if (fHasC && cHasF) { sawRecip = true; if (oneStart != null) { dur = Math.max(dur, t - oneStart); oneStart = null; } }
    else if (fHasC || cHasF) { sawOne = true; oneSidedTickInstances++; if (oneStart == null) oneStart = t; }
    else { if (oneStart != null) { dur = Math.max(dur, t - oneStart); oneStart = null; } }
  }
  if (oneStart != null) dur = Math.max(dur, hi === Infinity ? 0 : hi - oneStart);
  if (!sawOne) { alwaysOk++; continue; }
  oneSidedSome++;
  if (ef.ghost || ec.ghost) ghostInvolved++;
  if (sawRecip) healed++; else neverRecip++;
  if (dur > maxDur) { maxDur = dur; maxDurEdge = k; }
  if (dur >= 300 && exLong.length < 10) exLong.push(`${k}: one-sided ~${dur} ticks${ef.ghost || ec.ghost ? ' (ghost)' : ''}`);
}

const runLabel = arg;
console.log(`RUN ${runLabel} — RAW belt reciprocity (both directions, full lifetime)`);
console.log(`  belts: ${tl.size}   distinct feed edges: ${edges.size}`);
console.log(``);
console.log(`  edges reciprocal for their whole life       : ${alwaysOk}`);
console.log(`  edges ONE-SIDED at some point in life       : ${oneSidedSome}`);
console.log(`     ├─ healed (reciprocal at some other tick) : ${healed}   <-- temporary one-sided window = the churn driver`);
console.log(`     └─ NEVER reciprocal                       : ${neverRecip}`);
console.log(`     (ghost endpoint involved in ${ghostInvolved})`);
console.log(`  total one-sided (edge,tick) instances        : ${oneSidedTickInstances}`);
console.log(`  longest single one-sided window              : ${maxDur} ticks  (edge ${maxDurEdge})`);
if (exLong.length) {
  console.log(``);
  console.log(`  long (>=300t) one-sided windows:`);
  for (const e of exLong) console.log(`    ${e}`);
}

console.log(``);
if (oneSidedSome > 0) {
  console.log(`  RESULT: FAIL — ${oneSidedSome} one-sided edge(s). The game is reciprocal every tick, so this is a collector read/update-timing bug.`);
  process.exit(1);
}
console.log(`  RESULT: PASS — all ${edges.size} feed edges reciprocal for their whole lifetime.`);
process.exit(0);
