// probe-at <x> <y> [w] [h] [--run <name>] [--until <tick>] [--verbose]
//
// Spatial entry point. Every entity at a tile (or w×h region anchored at x,y),
// each shown across ALL data layers of the run: raw entityLayout, merged,
// machineProduction / minerActivity / bufferAmounts, the belt segment, the
// edges — with divergences flagged (e.g. in layout but missing from merged,
// or a belt linking to a non-existent unit). One run; defaults to the newest.
//
//   node dashboard/scripts/diagnostics/probe-at.mjs 90 0
//   node dashboard/scripts/diagnostics/probe-at.mjs 88 -4 10 24 --run DS-2_14_45 --verbose
//
// Entities match by anchor location; a multi-tile machine/splitter is reported
// at its anchor, not every tile it covers.
import { selectRun, loadLayers, fullOr, parseArgs, dossierLine, dossierBlock, emit } from './probe-lib.mjs';

const { positionals, flags } = parseArgs(process.argv.slice(2));
if (positionals.length < 2) { console.error('usage: probe-at <x> <y> [w] [h] [--run <name>] [--verbose]'); process.exit(1); }
const x0 = +positionals[0], y0 = +positionals[1];
const w = positionals[2] ? +positionals[2] : 1, h = positionals[3] ? +positionals[3] : 1;
const inRegion = (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

const run = selectRun(flags);
const L = loadLayers(run, fullOr(flags));
console.log(`# run ${run}  region (${x0},${y0}) ${w}×${h}`);

// Union of units present in the region across the merged layer AND the raw layout
// (a unit in layout but not merged is itself a finding).
const units = new Map();
for (const m of L.mergedArr) if (m.location && inRegion(m.location.x, m.location.y)) units.set(m.unitNumber, m.location);
for (const [u, lay] of L.raw.layout) if (lay.location && inRegion(lay.location.x, lay.location.y)) units.set(u, lay.location);
if (!units.size) { console.log('(nothing here)'); process.exit(0); }

const sorted = [...units.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(e => e[0]);
if (flags.verbose) for (const u of sorted) emit(dossierBlock(L, u));
else emit(sorted.map(u => dossierLine(L, u)), 60);
