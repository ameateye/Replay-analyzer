# Per-run data architecture

**Status:** Reference, current as of commit `e5bd8de` (parity tests). The design rationale and migration history live in [docs/concepts/per_run_data_redesign.md](../concepts/per_run_data_redesign.md) — read that if you're wondering *why* the architecture looks the way it does.

This document describes what's there now and how to extend it without breaking the rest. If you're adding a chart, a row to an existing chart, a new dataset, or modifying the cube, start here.

---

## The two data layers

| Layer | Where | Scope | Built by |
|---|---|---|---|
| **Per-run** | `dashboard/src/data/<run>.json` (committed) | One file per run, computed once from `extracted-data/<run>/*.json`. ~2 MB. | `dashboard/scripts/build-run-data.mjs` orchestrator + the prep modules under `dashboard/scripts/` |
| **Cross-run** | `game-data/*.json` (committed) | Tech requirements, recipe metadata, science-pack tiers, build-phase metadata, widget *display* config (which recipes appear in which widget). Loaded once at app start. | Mostly hand-authored, plus `game-data/build-tech-icons.js` |

Per-run JSON top-level shape:

```jsonc
{
  // Run facts
  "runName":      "DS-2_14_45",
  "durationTicks": 482181,
  "durationMin":   133.94,
  "peakActiveLabs": 49,
  "peakLabs":       52,
  "packsUsed":      [/* ... */],

  // Time-domain summaries
  "points":             [/* per-period lab saturation */],
  "idleRects":          [/* lab-idle bands */],
  "researchIntervals":  [/* completed tech */],
  "phases":             [/* strategic build-phase boundaries */],

  // Phase-widget data that doesn't fit the cube (different data source
  // or shape) — kept as widget-specific preps:
  "burnerPhase":     {/* minerActivity-based */},
  "manualGathering": {/* derived from inventory deltas */},

  // The two datasets every other phase widget projects from at render time
  "production": { /* production cube — see below */ },
  "stocks":     { /* stocks dataset — see below */ }
}
```

The `Run` TypeScript type is anchored as `typeof r0` in `dashboard/src/data/index.ts` (auto-generated). Adding or removing a top-level field changes the type for every consumer.

---

## The production cube

**Purpose:** aggregate `machineProduction.json` (the ~52 MB raw file) into something the browser can load — at the same time resolution the existing widgets render at (5 s per period), with enough fidelity to reproduce smoothed rate lines, potential lines, and per-status / per-ingredient loss breakdowns.

**Built by:** [dashboard/scripts/production-cube-prep.mjs](../../dashboard/scripts/production-cube-prep.mjs)
**Read by:** [dashboard/src/lib/projectProduction.ts](../../dashboard/src/lib/projectProduction.ts), consumed by [dashboard/src/lib/recipeRow.ts](../../dashboard/src/lib/recipeRow.ts)
**Type:** `ProductionCube` in [dashboard/src/lib/runDatasets.ts](../../dashboard/src/lib/runDatasets.ts)

### Shape

```jsonc
{
  "period": 300,                          // cube's sample period (ticks = 60/sec)
  "groups": [
    {
      "recipe":     "copper-plate",
      "buildPhase": "Mixed",              // phase name (incl. "Earlier" sentinel)
      "firstTick":  297600,               // tick of items[0]; leading/trailing zeros trimmed
      "items":      [42, 50, 65, /*…*/],  // items produced in this period (integer)
      "potential":  [71.2, 71.2, /*…*/],  // sum of per-machine rate (items/period, 4 decimals)
      "statusLoss": { "no_fuel": [/*…*/], "no_ingredients": [/*…*/] },  // optional
      "itemLoss":   { "iron-plate": [/*…*/] },                          // optional
      "fluidLoss":  {/*…*/}                                              // optional
    }
    /* … one entry per (recipe × buildPhase) pair with any production */
  ]
}
```

### Invariants

- **One group per (recipe × buildPhase).** A machine's `buildPhase` is determined once at build time by `lib/phase-lookup.mjs`, which has a 1-period slack at phase boundaries (matches the legacy filter convention).
- **`period === 300` ticks (5 s).** Smaller would bloat the JSON; larger would lose the resolution chart smoothing needs.
- **Per-period loss totals ≤ `max(0, potential[i] - items[i])`.** Same gap-clamp the legacy applied to smoothed series, repeated here per-period.
- **Non-aligned samples (`tick % period !== 0`) are dropped.** They're end-of-life / recipe-transition markers from the data collector; including them double-counts when an aligned sample exists in the same period.
- **`firstTick` trims leading and trailing zero periods.** Saves space on recipes that only fire late in the run.

### What the cube doesn't carry

- Per-machine drilldown (e.g. "which specific furnace stalled")
- Spatial filters (machines by position rather than build phase)
- Buffer-entity metadata (capacity, chest count)

If you need any of those, you're outside the cube — add a sibling prep with its own dataset shape (see [Adding a new dataset](#adding-a-new-dataset) below).

---

## The stocks dataset

**Purpose:** unified per-item stock series across chests, tanks, and player inventory, packed compactly enough to ship in the per-run JSON.

**Built by:** [dashboard/scripts/stocks-prep.mjs](../../dashboard/scripts/stocks-prep.mjs)
**Read by:** [dashboard/src/lib/projectStocks.ts](../../dashboard/src/lib/projectStocks.ts)
**Type:** `StocksDataset` in [dashboard/src/lib/runDatasets.ts](../../dashboard/src/lib/runDatasets.ts)

### Shape

```jsonc
{
  "period": 300,
  "groups": [
    {
      "item":   "iron-plate",
      "source": "buffer",                  // "buffer" (chests+tanks) | "inventory" (player)
      "ticks":  [3600, 3900, 4200, /*…*/], // change-event ticks
      "counts": [120, 140, 95, /*…*/]      // count effective from ticks[i] (inclusive) until ticks[i+1] (exclusive)
    }
    /* … */
  ]
}
```

### Invariants

- **Sample-and-hold semantics.** Render-time walkers reconstruct a dense series by holding `counts[i]` from `ticks[i]` to `ticks[i+1] - 1`.
- **Leading zeros dropped, return-to-zero events kept.** So a series for "speed-module" that goes 0→5→0→5 stores three events, not four.

---

## Render-time projection

Widgets don't read raw cube groups — they call helpers that filter, smooth, and shape into a Recipe row.

| File | Job |
|---|---|
| [src/lib/runDatasets.ts](../../dashboard/src/lib/runDatasets.ts) | Types + the `SMOOTH_HALF_WINDOW = 12` constant (±12-period = ±1 min centred moving average) |
| [src/lib/phaseSets.ts](../../dashboard/src/lib/phaseSets.ts) | `phasesBefore(phases, anchor)` and `phasesFrom(phases, anchor)` — convert phase boundaries to sets of phase names for `buildPhases` filtering |
| [src/lib/projectProduction.ts](../../dashboard/src/lib/projectProduction.ts) | `projectProduction(cube, { recipe, buildPhases?, gridTicks })` — sums matching groups, converts items/period → items/min, smooths, gap-clamps losses. Returns a `ProductionSlice` |
| [src/lib/projectStocks.ts](../../dashboard/src/lib/projectStocks.ts) | `projectStocks(stocks, { item, sources?, gridTicks })` — sample-and-hold across the grid. Returns a `StocksSlice` |
| [src/lib/recipeRow.ts](../../dashboard/src/lib/recipeRow.ts) | `buildRecipeRow`, `buildCombinedRecipeRow`, `buildFluidBufferRow` — combine projections into the row shape `ProductionRow` consumes |

Widget code is therefore short: pull the row config from game-data, iterate, call the right `build*RecipeRow`, hand to `ProductionRow`. Compare `dashboard/src/components/OilPhaseWidget.tsx` (~30 lines of data plumbing) to the legacy `oil-phase-prep.mjs` (~150 lines).

---

## How to extend

### Add a new row to an existing widget

Editing `game-data/recipes.json` is enough — no code change, no run rebuild.

1. Open `game-data/recipes.json`.
2. Find the right `*Display` block (`endGameDisplay`, `oilPhaseDisplay`, `fullBuildDisplay`, …).
3. Append a row entry. Minimal example:
   ```json
   { "key": "my-row", "recipe": "blue-something", "label": "Blue stuff", "color": "#5fbff4", "mode": "rate" }
   ```
4. Reload the dev server.
5. Run `npm test` — the parity test will fail with a count mismatch (legacy doesn't have the new row). Add a guard or skip the new row in the test until a legacy reference exists.

### Add a new widget that uses cube + stocks

1. **Game-data config.** Add a `*Display` block in `game-data/recipes.json` with a `rows` array.
2. **Component.** Create `dashboard/src/components/MyPhaseWidget.tsx`. Mirror `OilPhaseWidget.tsx`:
   - Pull `gameData.recipes.myPhaseDisplay` from `useGameData()`.
   - Build `gridTicks` from `cube.period` and `run.durationTicks`.
   - For each row config, call `buildRecipeRow` (or `buildCombinedRecipeRow` / `buildFluidBufferRow` for stacks / fluids).
   - Render via `<ProductionRow>` inside a `<section className="end-game">` for the shared chrome / CSS.
3. **Registry.** Add to `dashboard/src/components/phaseRegistry.ts` with `dataKey: 'production'`. The phase name must match `game-data/build-phases.json`.
4. **Type updates.** Add the display block to `GameData['recipes']` in `dashboard/src/server/gameData.ts`.
5. **Parity test.** If the widget has a legacy series committed somewhere, add a case to `dashboard/src/__tests__/parity.test.ts`. Otherwise, hold off until you have a baseline.

You should not need to touch the build pipeline at all.

### Extend the cube schema

Examples: adding a new stall-status bucket, capturing per-machine module config.

1. Update the emit side (`production-cube-prep.mjs`).
2. Update the read side (`projectProduction.ts`).
3. Update the type (`runDatasets.ts`).
4. Re-run `npm run data <run>` for each committed run and commit the regenerated JSONs.
5. Re-run `npm test` and chase any drift.

If the change widens the schema (new optional fields), older JSONs stay valid. If it changes existing fields' semantics, you must regenerate every committed run.

### Add a new dataset

When cube + stocks don't fit (e.g. per-machine timeline, spatial query, per-belt flow), add a parallel prep:

1. Create `dashboard/scripts/my-thing-prep.mjs`. It exports `buildMyThing(runDir, ...args): MyThing`. Don't write to disk from the prep — return a plain object; the orchestrator writes.
2. Wire it into `dashboard/scripts/build-run-data.mjs`: import, call, add to the `output` object, log one summary line.
3. Add the type to `Run` (implicitly, by adding the field — `Run = typeof r0` picks it up after `npm run data`).
4. Add a render-time helper under `dashboard/src/lib/` if widgets need shaped access.
5. Document the shape with a comment block at the top of the prep file.

If your dataset is too large for the per-run JSON (>5 MB), follow the map-data pattern: write a sibling `<run>.<thing>.json` and load it lazily via Vite `?url` imports. See [dashboard/scripts/map-prep.mjs](../../dashboard/scripts/map-prep.mjs) for an example.

---

## The parity contract

Two test suites (`npm test` + `npm run test:visual`) anchor the architecture against the published dashboard so any change that drifts gets caught:

| Suite | What it checks |
|---|---|
| [src/__tests__/parity.test.ts](../../dashboard/src/__tests__/parity.test.ts) (vitest) | For each (run × converted widget), feed `run.production` + `run.stocks` through the render-time projection and diff against the legacy widget rows stored at `git show HEAD:dashboard/src/data/<run>.json`. Catches drift in cube prep, projection, smoothing, gap-clamping, phase-lookup. |
| [e2e/visual-parity.spec.ts](../../dashboard/e2e/visual-parity.spec.ts) (Playwright) | Screenshots each phase widget against the live published site (`https://ameateye.github.io/Replay-analyzer/`) and pixel-diffs. Catches drift in chrome (axis labels, swatches, colors) the numeric suite can't see. |

**When the parity tests fail:**
- If the drift is real (the cube path now produces different numbers), either fix the underlying code or document the divergence by widening the test tolerance with a comment explaining *why*.
- If the chrome shifted intentionally (e.g. you redesigned the legend), update the `DRIFT_PCT_THRESHOLD` for the affected case and ideally accompany it with a screenshot under `e2e/screenshots/` showing the new look.

**When you delete a published widget's legacy series:**
- Drop its case from `parity.test.ts`. The visual suite already self-discovers from the `(run, phase)` matrix.

**Known accepted divergences** (documented in [parity.test.ts](../../dashboard/src/__tests__/parity.test.ts) tolerance comments):

1. **4-decimal cube precision** vs legacy full-precision smoothing — ~0.05 abs drift on smoothed rates.
2. **Per-filter rate recomputation**: legacy's `buildRecipeRow` re-ran `computePerRunRates` on the filtered subset, so the heuristic-fallback rate shifts; the cube uses one global rate map. On filtered widgets like `mixed.copper-plate`, late-built machines can fall back to a different value in legacy vs cube — bounded at ~2 % relative.

---

## Quick reference

| Looking for… | Read… |
|---|---|
| The cube's bucketing rules | `dashboard/scripts/production-cube-prep.mjs` (top comment + `lib/phase-lookup.mjs`) |
| How items/cycles become items/min | `dashboard/scripts/lib/production.mjs` (`computePerRunRates`) |
| What a widget needs to render a row | `dashboard/src/lib/recipeRow.ts` |
| Why a specific tolerance is in the parity test | `dashboard/src/__tests__/parity.test.ts` (comments near `RATE_TOL_ABS` / `PEAK_REL`) |
| Why the architecture looks like this | [docs/concepts/per_run_data_redesign.md](../concepts/per_run_data_redesign.md) |
| How the map pipeline integrates | `dashboard/scripts/map-prep.mjs` (`buildMapData` + `mapPrepInputsReady`) |
