// Offline data build for the dashboard.
//
// Reads the raw extracted JSONs for a run, computes the derived series the
// dashboard needs, and writes a compact JSON to src/data/<run>.json. Run
// before dev / build (npm scripts wire it).
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
import { buildBurnerPhase } from './burner-phase-prep.mjs';
import { buildManualGathering } from './manual-gathering-prep.mjs';
import { buildProductionCube } from './production-cube-prep.mjs';
import { buildStocks } from './stocks-prep.mjs';
import { buildMapData, mapPrepInputsReady } from './map-prep.mjs';

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
const points = lab.points
  .filter(p => p.minute <= rocketLaunchMin)
  .map(p => ({
    minute: +p.minute.toFixed(4),
    total: p.total,
    active: p.active,
    missingByPack: p.missingByPack,
  }));

const idleRects = lab.idleRects
  .filter(r => r.startMin < rocketLaunchMin)
  .map(r => ({
    startMin: +r.startMin.toFixed(4),
    widthMin: +(Math.min(r.startMin + r.widthMin, rocketLaunchMin) - r.startMin).toFixed(4),
  }));

const researchIntervals = lab.researchIntervals
  .filter(iv => iv.startMin < rocketLaunchMin)
  .map(iv => ({
    name: iv.name,
    startMin: +iv.startMin.toFixed(4),
    endMin: +Math.min(iv.endMin, rocketLaunchMin).toFixed(4),
  }));

const peakActiveLabs = points.reduce((m, p) => Math.max(m, p.active ?? 0), 0);
const peakLabs = points.reduce((m, p) => Math.max(m, p.total ?? 0), 0);

const burnerPhase = buildBurnerPhase(runDir, rocketLaunchTick, phases);
const burnerEndTick = phases.find(p => p.name === 'Burner')?.endTick ?? null;
const manualGathering = burnerPhase
  ? buildManualGathering(runDir, burnerPhase.xMaxTick, burnerEndTick)
  : null;

// Per-run-data redesign step 4 complete: the four widget-shaped preps
// (end-game / mixed-segment / oil-phase / full-build) are gone. Their
// widgets project from these two datasets at render time. See
// docs/concepts/per_run_data_redesign.md.
const production = buildProductionCube(runDir, phases, rocketLaunchTick);
const stocks = buildStocks(runDir, rocketLaunchTick);

const output = {
  runName,
  durationTicks: rocketLaunchTick,
  durationMin: +rocketLaunchMin.toFixed(4),
  peakActiveLabs,
  peakLabs,
  packsUsed: lab.packsUsed,
  points,
  idleRects,
  researchIntervals,
  phases,
  burnerPhase,
  manualGathering,
  production,
  stocks,
};

const outDir = path.join(DASHBOARD_ROOT, 'src', 'data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${runName}.json`);
fs.writeFileSync(outPath, JSON.stringify(output));

// Regenerate the run-index. Lists every <name>.json in src/data/ ordered by
// most-recently-built first, so the freshly-built run becomes the default
// without any extra step. App.tsx exposes a picker over `runs[]`.
// Only the per-run summary JSONs participate in the bundle. Per-run map data
// (`<run>.map.json`) is fetched at runtime via Vite ?url imports — see
// `maps.ts` — and must be excluded here.
const allJsons = fs.readdirSync(outDir)
  .filter(n => n.endsWith('.json') && !n.endsWith('.map.json'))
  .map(n => ({ name: n, mtime: fs.statSync(path.join(outDir, n)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .map(e => e.name.replace(/\.json$/, ''));

// JSON imports preserve literal types per file, so runs have nominally
// distinct types even though their structural shape is identical. Anchor the
// shared `Run` type on the first (newest) run and cast the others through
// `unknown` so consumers see a single Run type.
const indexPath = path.join(outDir, 'index.ts');
const imports = allJsons.map((n, i) => `import r${i} from './${n}.json';`).join('\n');
const items = allJsons.map((_, i) => i === 0 ? 'r0' : `r${i} as unknown as Run`).join(', ');
fs.writeFileSync(
  indexPath,
  `${imports}\n\nexport type Run = typeof r0;\nexport const runs: Run[] = [${items}];\nexport const defaultRun = runs[0];\n`,
);

const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`  ${points.length} points, ${idleRects.length} idle bands, ${researchIntervals.length} research intervals`);
console.log(`  peak active=${peakActiveLabs} peak labs=${peakLabs} duration=${rocketLaunchMin.toFixed(2)} min`);
if (burnerPhase) {
  console.log(`  burner xMax=${burnerPhase.xMaxMin.toFixed(1)} min · rows: ${burnerPhase.rows.map(r => `${r.key} peak=${r.peakBufferWithInv} run=${r.runningMin}m`).join(', ')}`);
} else {
  console.log('  burner: minerActivity.json missing — phase widget skipped');
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
// Map data is generated by a separate pipeline (fbsr-prep → Java FBSR →
// map-prep). When its inputs are ready in tools/output/ we run map-prep
// inline so a successful chart-side build also produces the map's
// per-run JSON, with `phases` embedded for the timeline player. When
// the inputs aren't ready we skip silently — map data lives independently
// and the user invokes it themselves via replay-tool / map-prep CLI.
if (mapPrepInputsReady(runName)) {
  try {
    console.log(`  map-prep: running for ${runName} (FBSR output ready)`);
    buildMapData(runName, { phases });
  } catch (err) {
    console.warn(`  map-prep: failed (${err?.message ?? err}) — skipping`);
  }
} else {
  console.log('  map-prep: skipped (no FBSR output in tools/output/ for this run)');
}

console.log(`Wrote ${outPath} (${sizeKB} KB)`);
