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
import { buildEndGameProduction } from './end-game-production-prep.mjs';

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

const endGame = buildEndGameProduction(runDir, rocketLaunchTick);

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
  endGame,
};

const outDir = path.join(DASHBOARD_ROOT, 'src', 'data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${runName}.json`);
fs.writeFileSync(outPath, JSON.stringify(output));
const indexPath = path.join(outDir, 'index.ts');
fs.writeFileSync(indexPath, `import data from './${runName}.json';\nexport { data as run };\nexport type Run = typeof data;\n`);

const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`  ${points.length} points, ${idleRects.length} idle bands, ${researchIntervals.length} research intervals`);
console.log(`  peak active=${peakActiveLabs} peak labs=${peakLabs} duration=${rocketLaunchMin.toFixed(2)} min`);
console.log(`  end-game recipes: ${endGame.recipes.map(r => `${r.recipe} (${r.finalCum})`).join(', ')}`);
console.log(`Wrote ${outPath} (${sizeKB} KB)`);
