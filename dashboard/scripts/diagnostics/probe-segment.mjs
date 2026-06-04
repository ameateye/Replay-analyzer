// probe-segment <segId> [--run <name>] [--until <tick>] [--verbose]
//
// Topology entry point. One belt segment in a run: its record (lifetime, tile
// bbox, lineage), each MEMBER belt shown across the data layers (raw layout /
// merged / segment / edges, with divergences), and the edges feeding / draining
// the segment. One run; defaults to the newest.
//
//   node dashboard/scripts/diagnostics/probe-segment.mjs S-159
//   node dashboard/scripts/diagnostics/probe-segment.mjs 159 --run DS-2_14_45 --verbose
import { selectRun, loadLayers, fullOr, parseArgs, membersOf, fmtLife, bboxOf, dossierLine, dossierBlock, emit } from './probe-lib.mjs';

const { positionals, flags } = parseArgs(process.argv.slice(2));
const target = positionals[0];
if (!target) { console.error('usage: probe-segment <segId> [--run <name>] [--verbose]'); process.exit(1); }
const num = String(target).replace(/^S-/, '');
const idMatch = v => String(v).replace(/^S-/, '') === num;
const segNum = s => String(s).replace(/^S-/, '');

const run = selectRun(flags);
const L = loadLayers(run, fullOr(flags));
console.log(`# run ${run}`);

const seg = L.segRecords.find(s => idMatch(s.id));
if (!seg) {
  const sample = L.segRecords.slice(0, 8).map(s => s.id).join(' ');
  console.log(`(no S-${num} in ${run}; ${L.segRecords.length} segments, e.g. ${sample})`);
  process.exit(0);
}

console.log(`${seg.id} ${seg.kind} ${fmtLife(seg.tb, seg.tr)} tiles=${seg.tiles} bbox=${bboxOf(seg.tileLocations) ?? '?'}`);
if (seg.predecessors?.length) console.log(`  pred: ${seg.predecessors.map(p => `${p.id ?? '∅'}[${p.outcome}@${p.tick}]`).join(' ')}`);
if (seg.successors?.length) console.log(`  suc:  ${seg.successors.map(p => `${p.id ?? '∅'}[${p.outcome}@${p.tick}]`).join(' ')}`);

const members = membersOf(L.seg, target) ?? new Set();
console.log(`members (${members.size}):`);
const us = [...members].sort((a, b) => a - b);
if (flags.verbose) for (const u of us) emit(dossierBlock(L, u));
else emit(us.map(u => '  ' + dossierLine(L, u)), 40);

const ins = L.edges.filter(e => e.to?.segs?.some(s => segNum(s.seg) === num));
const outs = L.edges.filter(e => e.from?.segs?.some(s => segNum(s.seg) === num));
console.log(`edges in=${ins.length} out=${outs.length}`);
if (flags.verbose) {
  const ep = e => (e.inserterUnit ? `ins#${e.inserterUnit}` : e.minerUnit ? `mine#${e.minerUnit}` : 'belt');
  emit(ins.map(e => `  in  ${e.id} ${ep(e)} ${fmtLife(e.tb, e.tr)}`), 12);
  emit(outs.map(e => `  out ${e.id} ${ep(e)} ${fmtLife(e.tb, e.tr)}`), 12);
}
