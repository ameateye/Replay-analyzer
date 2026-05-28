// Numeric parity between the legacy widget-shaped run JSON (pinned to
// 9485b47^ — the last commit with the old `endGame` / `mixedSegment` /
// `oilPhase` / `fullBuildPhase` top-level fields, and the snapshot the
// published dashboard was built from) and the render-time projection of
// the new production/stocks datasets.
//
// Why this test exists: the per-run data redesign deleted four widget-shaped
// preps (`end-game-production-prep`, `mixed-segment-prep`, `oil-phase-prep`,
// `full-build-prep`) and moved their work into render-time helpers in
// `src/lib/recipeRow.ts`. The new path is supposed to reproduce the legacy
// numbers exactly — same period grid, same ±12-period smoothing, same
// gap-clamp on losses, same 1-period slack on phase membership.
//
// Strategy: for each committed run, retrieve the pre-refactor <run>.json
// via `git show 9485b47^:…` (legacy widget fields, no production/stocks),
// load the working-tree's <run>.json (new production + stocks, no legacy
// fields), feed the new datasets through `buildRecipeRow` /
// `buildCombinedRecipeRow` / `buildFluidBufferRow` mirroring each widget's
// runtime config, and diff the projected rows against the legacy rows. Both
// come from the same `extracted-data/` source so the comparison is
// apples-to-apples.
//
// Known caveats (excluded from the diff):
//   - bufferLimit, peakBufferLimit, showBufferLimit: derived at render time
//     from game-data capacities + the new stocks `entities` field, but the
//     "approaches capacity" heuristic + integer rounding doesn't always
//     match the legacy series tick-for-tick (legacy emitted the limit even
//     for some rows that didn't approach 50%, e.g.). chestCount IS checked.
//   - `excludeInventory` rows collapse bufferWithInv onto buffer in the
//     new path; the test honors the same collapse before comparing.

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildRecipeRow,
  buildCombinedRecipeRow,
  buildFluidBufferRow,
  type RecipeRow,
} from '../lib/recipeRow';
import { phasesBefore, phasesFrom } from '../lib/phaseSets';
import type { ProductionCube, StocksDataset } from '../lib/runDatasets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');

const RUNS = ['DS-2_09_42', 'DS-2_14_45', 'DS-2_16_04', 'DS-2_17_29', 'DS-2_19_20'];

// Last commit with the pre-redesign widget-shaped JSON. Pinning to this
// SHA (rather than HEAD) keeps the test working after the refactor commits
// land — HEAD no longer has the legacy widget fields. Using `~1` instead
// of `^`: on Windows execSync routes through cmd.exe, which treats `^` as
// an escape character and silently strips it (so `9485b47^` resolves to
// 9485b47, not its parent).
const LEGACY_REF = '9485b47~1';

function readLegacyJson(runName: string): any {
  const out = execSync(`git show ${LEGACY_REF}:dashboard/src/data/${runName}.json`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function readCurrentJson(runName: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'built-data', `${runName}.json`), 'utf8'),
  );
}

// The dashboard's per-run JSONs no longer live in the repo — they're either
// in built-data/ (a fresh local build, gitignored) or hosted externally
// (e.g. R2). The parity check needs file-level access to current-vs-legacy
// JSON for the same set of runs, so it skips when built-data/ isn't
// populated. Re-enable by running `npm run data ../extracted-data/<run>`
// for each run in RUNS.
const HAVE_BUILT_DATA = RUNS.every(r =>
  fs.existsSync(path.join(REPO_ROOT, 'built-data', `${r}.json`))
);

// Use the legacy-pinned recipes.json so the display config matches the
// pipeline that produced the legacy widget fields. Working-tree recipes.json
// may have added new sections (e.g. frontSideDisplay) but the four converted
// widgets' configs are unchanged at LEGACY_REF — belt-and-braces.
function readLegacyRecipes(): any {
  const out = execSync(`git show ${LEGACY_REF}:game-data/recipes.json`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function makeGridTicks(durationTicks: number, period: number): number[] {
  const arr: number[] = [];
  for (let t = 0; t <= durationTicks; t += period) arr.push(t);
  return arr;
}

// Hardcoded widget config from MixedSegmentWidget — duplicated here so any
// drift between the test and the widget is immediately visible. `fromMixed`
// means "every machine built from Mixed onward", mirroring the legacy
// `builtDuringMixed` predicate (`m.timeBuilt >= mixed.startTick - period`),
// which had no upper bound.
const MIXED_ROWS: Array<{
  recipe: string;
  fromMixed?: boolean;
}> = [
  { recipe: 'copper-plate',          fromMixed: true },
  { recipe: 'iron-plate'                             },
  { recipe: 'plastic-bar',           fromMixed: true },
  { recipe: 'low-density-structure'                  },
  { recipe: 'processing-unit'                        },
];

const ARRAY_FIELDS: Array<keyof RecipeRow> = [
  'actual', 'potential', 'cum', 'buffer', 'bufferWithInv',
];
const SCALAR_FIELDS: Array<keyof RecipeRow> = [
  'finalCum', 'peakActual', 'peakPotential', 'peakBuffer', 'peakBufferWithInv',
  // chestCount derives from `stocks.entities` × game-data capacities at
  // render time. Same source the legacy prep used (the entity list in
  // bufferAmounts.json), so an exact integer match is expected.
  'chestCount',
];

// Tolerances:
//   - Smoothed rate series (actual/potential) round to 2 decimals. Exact
//     match is the goal, but allow ~0.5 absolute to absorb tiny float-order
//     drift from the cube storing per-period potential at 4 decimals.
//   - Cumulative + buffer series are integers in both paths — exact match.
//   - peakActual / peakPotential additionally allow ~2 % relative drift to
//     absorb a known semantic divergence: legacy `buildRecipeRow` recomputed
//     per-machine rates against the *filtered* machine subset, so the
//     heuristic fallback rate (longest "working" stretch / fallback) shifts.
//     The cube computes rates once on the unfiltered data, which is more
//     stable and arguably more accurate, but the legacy values are what
//     shipped. The 2 % envelope covers cases like DS-2_14_45 copper-plate
//     (2 machines at the Mixed-phase boundary fall back to a higher
//     heuristic in the legacy filtered context).
const RATE_TOL_ABS = 0.5;
const PEAK_REL = 0.02;
const INT_TOL = 0;

// Per-point tolerance is max(absTol, relTol * |want[i]|). Without a
// relative term, the per-filter heuristic-fallback drift (documented near
// RATE_TOL_ABS / PEAK_REL above) can produce ~1 % series drift on filtered
// rate rows where late-built machines fall back differently in the legacy
// per-filter rate context vs the cube's global one. The smoothing window
// dilutes the drift across neighbours, so the per-point envelope is
// usually well under the peak's.
function assertArrayClose(got: number[], want: number[], absTol: number, relTol: number, label: string) {
  expect(got.length, `${label}.length`).toBe(want.length);
  let maxDelta = 0;
  let maxIdx = -1;
  let maxAllowed = 0;
  for (let i = 0; i < got.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    const allowed = Math.max(absTol, relTol * Math.abs(want[i]));
    const overshoot = d - allowed;
    if (overshoot > maxDelta - maxAllowed) {
      maxDelta = d;
      maxIdx = i;
      maxAllowed = allowed;
    }
  }
  expect(
    maxDelta - maxAllowed,
    `${label}: max delta ${maxDelta.toFixed(4)} at i=${maxIdx} (got=${got[maxIdx]}, want=${want[maxIdx]}, allowed ${maxAllowed.toFixed(4)})`,
  ).toBeLessThanOrEqual(0);
}

function tolFor(field: keyof RecipeRow, wantValue: number): number {
  if (field === 'finalCum' || field === 'peakBuffer' || field === 'peakBufferWithInv'
      || field === 'chestCount'
      || field === 'cum' || field === 'buffer' || field === 'bufferWithInv') {
    return INT_TOL;
  }
  if (field === 'peakActual' || field === 'peakPotential') {
    return Math.max(RATE_TOL_ABS, PEAK_REL * Math.abs(wantValue));
  }
  return RATE_TOL_ABS;
}

function assertRowParity(got: RecipeRow, want: any, label: string, opts: { excludeInventory?: boolean } = {}) {
  // `excludeInventory` collapses bufferWithInv → buffer (and the scalar
  // peakBufferWithInv → peakBuffer) in the widget so the row tracks
  // chest-only stock. Apply the same collapse to `got` here before
  // comparing, mirroring what FullBuildWidget.tsx does at render time.
  const gotEff: RecipeRow = opts.excludeInventory
    ? { ...got, bufferWithInv: got.buffer.slice(), peakBufferWithInv: got.peakBuffer }
    : got;

  for (const f of SCALAR_FIELDS) {
    const wantVal = want[f] as number;
    const gotVal = (gotEff as any)[f] as number;
    expect(
      Math.abs(gotVal - wantVal),
      `${label}.${f}: got=${gotVal} want=${wantVal}`,
    ).toBeLessThanOrEqual(tolFor(f, wantVal));
  }
  for (const f of ARRAY_FIELDS) {
    const wantArr = want[f] as number[];
    const gotArr = (gotEff as any)[f] as number[];
    if (f === 'cum' || f === 'buffer' || f === 'bufferWithInv') {
      assertArrayClose(gotArr, wantArr, INT_TOL, 0, `${label}.${f}`);
    } else {
      assertArrayClose(gotArr, wantArr, RATE_TOL_ABS, PEAK_REL, `${label}.${f}`);
    }
  }
}

let LEGACY_RECIPES: any;
let CAPACITY_CFG: { chestSlots: Record<string, number>; stackSizes: Record<string, number>; tankCapacity: number };
beforeAll(() => {
  LEGACY_RECIPES = readLegacyRecipes();
  CAPACITY_CFG = {
    chestSlots: LEGACY_RECIPES.chestSlots,
    stackSizes: LEGACY_RECIPES.stackSizes,
    tankCapacity: LEGACY_RECIPES.tankCapacity,
  };
});

(HAVE_BUILT_DATA ? describe.each(RUNS) : describe.skip.each(RUNS))('Run %s', (runName) => {
  let legacy: any;
  let current: any;
  let cube: ProductionCube;
  let stocks: StocksDataset;
  let gridTicks: number[];

  beforeAll(() => {
    legacy = readLegacyJson(runName);
    current = readCurrentJson(runName);
    cube = current.production as ProductionCube;
    stocks = current.stocks as StocksDataset;
    gridTicks = makeGridTicks(current.durationTicks, cube.period);
  });

  it('endGame parity (5 recipes)', () => {
    const display = LEGACY_RECIPES.endGameDisplay as Array<{ recipe: string }>;
    expect(display.length).toBe(legacy.endGame.recipes.length);

    for (let i = 0; i < display.length; i++) {
      const want = legacy.endGame.recipes[i];
      const got = buildRecipeRow(cube, stocks, { recipe: display[i].recipe, gridTicks, capacityCfg: CAPACITY_CFG });
      expect(got.recipe, `row ${i}: recipe id`).toBe(want.recipe);
      assertRowParity(got, want, `endGame[${got.recipe}]`);
    }
  });

  it('mixedSegment parity (5 rows, from-Mixed filter on copper + plastic)', () => {
    expect(MIXED_ROWS.length).toBe(legacy.mixedSegment.recipes.length);
    const fromMixed = phasesFrom(current.phases, 'Mixed');

    for (let i = 0; i < MIXED_ROWS.length; i++) {
      const cfg = MIXED_ROWS[i];
      const want = legacy.mixedSegment.recipes[i];
      const got = buildRecipeRow(cube, stocks, {
        recipe: cfg.recipe,
        gridTicks,
        buildPhases: cfg.fromMixed ? fromMixed : null,
        capacityCfg: CAPACITY_CFG,
      });
      expect(got.recipe, `row ${i}: recipe id`).toBe(want.recipe);
      assertRowParity(got, want, `mixed[${got.recipe}]`);
    }
  });

  it('oilPhase parity (10 rows, mixed modes incl. fluid-buffer + components)', () => {
    const rows = LEGACY_RECIPES.oilPhaseDisplay.rows as Array<any>;
    expect(rows.length).toBe(legacy.oilPhase.rows.length);

    const beforeMixed = phasesBefore(current.phases, 'Mixed');

    for (let i = 0; i < rows.length; i++) {
      const cfg = rows[i];
      const want = legacy.oilPhase.rows[i];
      const buildPhases = cfg.machineFilter === 'before-mixed' ? beforeMixed : null;
      let got: RecipeRow;
      if (cfg.mode === 'fluid-buffer') {
        got = buildFluidBufferRow(stocks, { item: cfg.recipe, gridTicks, capacityCfg: CAPACITY_CFG });
      } else if (cfg.components && cfg.components.length > 0) {
        got = buildCombinedRecipeRow(cube, {
          rowRecipe: cfg.components[0].recipe,
          components: cfg.components.map((c: { recipe: string }) => ({ recipe: c.recipe, buildPhases })),
          gridTicks,
        });
      } else {
        got = buildRecipeRow(cube, stocks, { recipe: cfg.recipe, gridTicks, buildPhases, capacityCfg: CAPACITY_CFG });
      }
      assertRowParity(got, want, `oil[${cfg.key}]`);
    }
  });

  it('fullBuildPhase parity (8 rows, after-full-build-start filter + excludeInventory)', () => {
    const rows = LEGACY_RECIPES.fullBuildDisplay.rows as Array<any>;
    expect(rows.length).toBe(legacy.fullBuildPhase.rows.length);

    const fromFullBuild = phasesFrom(current.phases, 'Full build');

    for (let i = 0; i < rows.length; i++) {
      const cfg = rows[i];
      const want = legacy.fullBuildPhase.rows[i];
      const buildPhases = cfg.machineFilter === 'after-full-build-start' ? fromFullBuild : null;
      let got: RecipeRow;
      if (cfg.components && cfg.components.length > 0) {
        got = buildCombinedRecipeRow(cube, {
          rowRecipe: cfg.components[0].recipe,
          components: cfg.components.map((c: { recipe: string }) => ({ recipe: c.recipe, buildPhases })),
          gridTicks,
        });
      } else {
        got = buildRecipeRow(cube, stocks, { recipe: cfg.recipe, gridTicks, buildPhases, capacityCfg: CAPACITY_CFG });
      }
      assertRowParity(got, want, `fullBuild[${cfg.key}]`, { excludeInventory: !!cfg.excludeInventory });
    }
  });
});
