// Offline data build for the dashboard.
//
// Reads the raw extracted JSONs for a run, computes the derived series the
// dashboard needs, and writes a compact JSON to built-data/<run>.json at
// the repo root (gitignored). A separate `npm run install:local` /
// `install:url` step decides what to do with the built artifact — copy it
// into dashboard/public/data/ or register an external URL in the manifest.
//
// Game-data (tech icons, tech requirements) is intentionally NOT baked in:
// it lives behind /game-data/* and is loaded once at runtime by the React app
// so it can be reused across runs and across charts.
//
// Usage:  node scripts/build-run-data.mjs <run-dir>
//   <run-dir> may be absolute, or relative to dashboard/.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { prepareLabSaturationData } from './lab-saturation-prep.mjs';
import { computePhases, computeRocketLaunchTick } from './phase-boundaries.mjs';
import { buildManualGathering } from './manual-gathering-prep.mjs';
import { buildProductionCube } from './production-cube-prep.mjs';
import { buildStocks } from './stocks-prep.mjs';
import { buildMiners } from './miners-prep.mjs';
import { buildMapData } from './map-prep.mjs';
import { buildMergedEntities } from './lib/layout/merge-entities.mjs';
import { buildFlow } from './flow-prep.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');

const argRun = process.argv[2];
if (!argRun) {
  console.error('Usage: node scripts/build-run-data.mjs <run-dir>');
  process.exit(1);
}
const runDir = path.resolve(DASHBOARD_ROOT, argRun);
// Tech requirements are still consumed at build time (the saturation
// computation needs them per tick) but never emitted into the per-run JSON.
const techReqPath = path.join(REPO_ROOT, 'game-data', 'factorio-tech-requirements.json');

const runName = path.basename(runDir).replace(/^Actual-/, '');

console.log(`Building dashboard data for run "${runName}" from ${runDir}`);

const lab = prepareLabSaturationData(runDir, techReqPath);
const phases = computePhases(runDir);
const rocketLaunchTick = computeRocketLaunchTick(runDir);
const rocketLaunchMin = rocketLaunchTick / 3600;

// Clip everything to rocket launch (consistent with lab-saturation-d3.ts).
const perMinute = lab.points
  .filter(p => p.minute <= rocketLaunchMin)
  .map(p => ({
    minute: +p.minute.toFixed(4),
    total: p.total,
    active: p.active,
    missingByPack: p.missingByPack,
  }));

const idleBands = lab.idleRects
  .filter(r => r.startMin < rocketLaunchMin)
  .map(r => ({
    startMin: +r.startMin.toFixed(4),
    widthMin: +(Math.min(r.startMin + r.widthMin, rocketLaunchMin) - r.startMin).toFixed(4),
  }));

const research = lab.researchIntervals
  .filter(iv => iv.startMin < rocketLaunchMin)
  .map(iv => ({
    name: iv.name,
    startMin: +iv.startMin.toFixed(4),
    endMin: +Math.min(iv.endMin, rocketLaunchMin).toFixed(4),
  }));

const peakActiveLabs = perMinute.reduce((m, p) => Math.max(m, p.active ?? 0), 0);
const peakLabs = perMinute.reduce((m, p) => Math.max(m, p.total ?? 0), 0);

const miners = buildMiners(runDir);
const burnerEndTick = phases.find(p => p.name === 'Burner')?.endTick ?? null;

// Manual gathering's x-axis follows the burner-phase widget, which now
// derives its bound at render time from `miners`. Reproduce the same
// heuristic here so the build-time prep sees the same window.
const POST_PHASE_PAD_TICKS = 5 * 60 * 60;
let burnerWidgetXMaxTick = null;
if (miners) {
  let lastRemoved = 0;
  for (const m of miners.miners) {
    if (m.name !== 'burner-mining-drill') continue;
    if (m.timeRemoved != null && m.timeRemoved > lastRemoved) lastRemoved = m.timeRemoved;
  }
  const baseEnd = lastRemoved > 0 ? lastRemoved : (burnerEndTick ?? rocketLaunchTick);
  burnerWidgetXMaxTick = Math.min(rocketLaunchTick, baseEnd + POST_PHASE_PAD_TICKS);
}
const manualGathering = burnerWidgetXMaxTick != null
  ? buildManualGathering(runDir, burnerWidgetXMaxTick, burnerEndTick)
  : null;

// Per-run-data redesign step 4 complete: the four widget-shaped preps
// (end-game / mixed-segment / oil-phase / full-build) are gone. Their
// widgets project from these two datasets at render time. See
// docs/concepts/per_run_data_redesign.md.
const production = buildProductionCube(runDir, phases, rocketLaunchTick);
const stocks = buildStocks(runDir, rocketLaunchTick);

// Build the lossless merged-entity stream once and share it with map-prep
// and flow-prep so both consume the same upstream slice.
let merged = null;
try {
  merged = buildMergedEntities(runDir, rocketLaunchTick, { externalMiners: miners });
} catch (err) {
  console.warn(`  merge-entities: failed (${err?.message ?? err}) — flow/map will rebuild themselves`);
}

let flow = null;
try {
  flow = buildFlow(runDir, rocketLaunchTick, { merged });
} catch (err) {
  console.warn(`  flow-prep: failed (${err?.message ?? err}) — flow=null`);
}

const output = {
  runName,
  durationTicks: rocketLaunchTick,
  durationMin: +rocketLaunchMin.toFixed(4),
  summary: {
    peakLabs,
    peakActiveLabs,
    packsUsed: lab.packsUsed,
  },
  phases,
  labs: { perMinute, idleBands },
  research,
  miners,
  manualGathering,
  production,
  stocks,
  flow,
};

const outDir = path.join(REPO_ROOT, 'built-data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${runName}.json`);
fs.writeFileSync(outPath, JSON.stringify(output));

const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`  labs: ${perMinute.length} samples, ${idleBands.length} idle bands · research: ${research.length} intervals`);
console.log(`  peak active=${peakActiveLabs} peak labs=${peakLabs} duration=${rocketLaunchMin.toFixed(2)} min`);
if (miners) {
  const byName = {};
  for (const m of miners.miners) byName[m.name] = (byName[m.name] ?? 0) + 1;
  const tally = Object.entries(byName).map(([k, n]) => `${k}×${n}`).join(', ');
  console.log(`  miners: ${miners.miners.length} entries (${tally})`);
} else {
  console.log('  miners: minerActivity.json missing — burner widget will fall back');
}
if (manualGathering) {
  console.log(`  manual gathering: ${manualGathering.rows.map(r => `${r.recipe}=${r.finalCum}`).join(', ')}`);
}
{
  const recipes = new Set(production.groups.map(g => g.recipe));
  const phaseSet = new Set(production.groups.map(g => g.buildPhase));
  let totalEntries = 0;
  for (const g of production.groups) totalEntries += g.items.length;
  console.log(`  production cube: ${production.groups.length} groups (~${totalEntries} period entries) across ${recipes.size} recipe(s) × ${phaseSet.size} phase(s) (period=${production.period})`);
}
{
  const items = new Set(stocks.groups.map(g => g.item));
  const bufN = stocks.groups.reduce((n, g) => n + (g.source === 'buffer' ? 1 : 0), 0);
  let totalEvents = 0;
  for (const g of stocks.groups) totalEvents += g.ticks.length;
  console.log(`  stocks: ${stocks.groups.length} groups (${bufN} buffer + ${stocks.groups.length - bufN} inventory, ~${totalEvents} change events) across ${items.size} item(s) (period=${stocks.period})`);
}
if (flow) {
  console.log(`  flow: ${flow.summary.beltSegmentCount} belt segments (${JSON.stringify(flow.summary.segmentsByKind)})`);
} else {
  console.log('  flow: null (required inputs missing)');
}
// Map data is built event-driven via the Java ReplaySidecar inside
// map-prep — see docs/specs/fbsr_event_driven_pipeline.md. The sidecar
// grows game-data/map-sprites.json monotonically as new entity variants
// appear, so no separate gap-fill step is needed. Sharing `phases` and
// `miners` from this build keeps a single source of truth for those
// datasets between the chart and map sides.
try {
  console.log(`  map-prep: running for ${runName}`);
  buildMapData(runName, { phases, miners, merged });
} catch (err) {
  console.warn(`  map-prep: failed (${err?.message ?? err}) — skipping`);
}

console.log(`Wrote ${outPath} (${sizeKB} KB)`);
