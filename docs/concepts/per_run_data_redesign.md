# Concept: Per-Run Data Redesign

**Status:** Implemented (2026-05-11). Four of the six widget-shaped preps (`end-game-production-prep`, `mixed-segment-prep`, `oil-phase-prep`, `full-build-prep`) are deleted and their widgets project from the new `production` cube + `stocks` dataset at render time. Three preps were intentionally retained: `burner-phase-prep` (uses `minerActivity.json`, a different data source than the cube), `manual-gathering-prep` (depends on the burner phase), and `front-side-prep` (kept as-is per scoping; can be folded in later when a region-axis is added to the cube).
**Date:** 2026-05-11
**Context:** Restructure `dashboard/src/data/<run>.json` from a bag of widget-specific slices into a small set of named datasets that widgets project from at render time.

---

## Problem

Today's `<run>.json` is built by ~10 prep modules under `dashboard/scripts/`, six of which are widget-shaped: `mixed-segment-prep`, `oil-phase-prep`, `full-build-prep`, `burner-phase-prep`, `manual-gathering-prep`, `end-game-production-prep`. Each is bespoke widget configuration written as a JavaScript module — it picks recipes, modes, machine filters, calls a shared `buildRecipeRow` helper, and emits a top-level field on the run JSON.

Three downstream effects:

1. **Schema grows per widget.** Each new widget adds a top-level field; `Run = typeof r0` drifts as the newest run defines the shape.
2. **Adding a widget touches the pipeline.** New `.mjs` file, new import in `build-run-data.mjs`, new field in the output. None of this is widget logic — it's wiring.
3. **"Ad-hoc joined preps for no clear purpose."** Each prep does the same shape of work; the differences are 5–10 lines of widget config inside a 50–100 line file.

Underneath, raw `extracted-data/` is heavy — `machineProduction.json` alone is 52 MB per run. The current preps' real work is twofold: pre-aggregate the 52 MB down to widget-sized slices, *and* configure the widget. This concept separates the two jobs: aggregate once into a named dataset; let widgets project from it.

---

## Key Decisions & Rationale

### Datasets, not widget slices

`<run>.json` becomes a small set of named datasets, each with a documented shape and a single purpose. Widgets project from these at render time. The current widget-shaped top-level fields disappear.

### Aggregation is mandatory only for `production`

Of the raw inputs, only `machineProduction` (52 MB) is large enough that shipping near-raw is infeasible. Everything else can be lifted with minor transformation. So the only build-time *aggregation* is the production cube. Other preps either lift (`research`), compute (`phases`, `labs`), or transform (`map`).

### Granularity matches the existing chart grid

Both `production` and `stocks` ship at the data collector's native period (`mp.period`, typically 300 ticks = 5s) — the same time resolution every chart already rendered before the redesign. This was a deliberate choice: a coarser per-minute granularity was considered and rejected, because the existing widgets use ±12-period smoothing for their rate lines, and at per-minute resolution there's nothing to smooth — chart lines visibly degrade. Per-period storage preserves the existing visual fidelity exactly while still being aggregable to coarser views at render time.

### Production cube is grouped per (recipe × buildPhase), dense per period

Each `groups[]` entry holds dense per-period arrays for one `(recipe, buildPhase)` pair, with a `firstTick` offset that trims leading and trailing zero periods. Format is columnar — `items[]`, `potential[]`, and optional `statusLoss` / `itemLoss` / `fluidLoss` keyed by stall reason / ingredient name — so JSON field-name overhead is paid once per group, not per period. Per-period loss totals are clamped so their sum ≤ max(0, potential - items) at write time (matches `buildProductionSeries`'s gap-clamp on smoothed series).

Spatial filters and per-machine drilldown are intentionally not in this cube — those fall back to a separate prep when needed.

### Stocks are grouped per (item × source), sparse change-event with sample-and-hold

Each `groups[]` entry is one `(item, source)` series of `ticks[]` + `counts[]` change events. `counts[i]` is the aggregated count from `ticks[i]` (inclusive) until `ticks[i+1]` (exclusive). Render-time walkers sample-and-hold across the grid to reconstruct a dense per-period series. This compresses player-inventory dramatically (most items don't tick every period) while keeping buffer series — which change continuously as items flow — at roughly one event per period.

Box-level (per-chest) detail and capacity / `chestCount` metadata are not in v1 — they need per-buffer-entity information that would inflate the dataset. Widgets that need the buffer-limit reference line back should extend stocks-prep (e.g. a sibling capacity series, or a metadata block), not regenerate raw bufferAmounts at render time.

### Labs stay computed

Lab processing is relatively heavy: per-minute aggregation, missing-pack join against tech requirements, idle-band heuristic. The loss vs raw is minimal (per-lab identity is not used by any chart). Keep at build time.

### Map keeps a separate data payload, but shares the build pipeline

The map's per-run payload (`<run>.map.json`) stays in its own file — it's multi-MB, includes the FBSR-rendered entity manifest, and ships as a lazy-loaded Vite asset rather than bundled with the per-run summary. That data split is deliberate.

But the *pipeline* aligns with the chart side: `map-prep.mjs` exports a callable `buildMapData(runName, { phases })` that `build-run-data.mjs` invokes inline when the Java FBSR step's outputs are ready in `tools/output/`. One build command produces both stats and map. When FBSR output isn't ready the map step is skipped silently and the user falls back to running `map-prep` standalone after they've re-rendered.

The map.json now carries `phases` (passed in from the chart-side `computePhases` output) so the React player can snap its timeline to phase boundaries — the map is no longer phase-blind. Phase membership across both datasets uses a single source of truth (`scripts/lib/phase-lookup.mjs`), so any change to the phase-boundary semantics (e.g. the 1-period slack) updates both pipelines together.

### Widget-specific preps are deleted (partial)

The four production-cube-shaped widget preps are gone: `mixed-segment-prep`, `oil-phase-prep`, `full-build-prep`, `end-game-production-prep`. Their widget logic (recipe lists, modes, machine filters) moved into the corresponding React components and they project from `production` + `stocks` at render time. `buildRecipeRow` and its combined / fluid-buffer variants live at `dashboard/src/lib/recipeRow.ts` now.

Three of the original six widget-shaped preps remain in the pipeline:
- `burner-phase-prep` — uses `minerActivity.json`, a separate data source that the cube doesn't aggregate today.
- `manual-gathering-prep` — depends on the burner phase output.
- `front-side-prep` — kept as-is. The widget needs region/position filtering, which the cube's `buildPhase` axis can't express; folding it in is deferred to a future region-axis extension.

---

## Proposed Approach

### Per-run payload shape

`<run>.json`:

```jsonc
{
  // Run facts
  "runName":          "DS-2_14_45",
  "durationTicks":    482181,
  "durationMin":      133.94,
  "rocketLaunchTick": 482181,

  // Phase boundaries
  "phases": [
    { "name": "Burner", "startTick": 0, "startMin": 0, "endTick": 11000, "endMin": 3.06 },
    // ...
  ],

  // Production cube. Period is the cube's native sample period (ticks). Each
  // group holds dense items/potential arrays for one (recipe, buildPhase)
  // pair, indexed from firstTick. statusLoss / itemLoss / fluidLoss are
  // optional; keys with all-zero series are omitted.
  "production": {
    "period": 300,
    "groups": [
      {
        "recipe": "copper-plate",
        "buildPhase": "Mixed",
        "firstTick": 297600,
        "items":      [0, 0, 12, 18, ...],
        "potential":  [71.2, 71.2, 71.2, 71.2, ...],
        "statusLoss": { "no_fuel": [40.1, 32.4, ...], "no_ingredients": [...] },
        "itemLoss":   { "electronic-circuit": [...] }
      },
      // ...
    ]
  },

  // Stocks (buffers + player inventory unified). Per-(item × source) change-
  // event series — counts[i] is effective from ticks[i] inclusive until
  // ticks[i+1] exclusive. Render-time walkers sample-and-hold across the grid.
  "stocks": {
    "period": 300,
    "groups": [
      { "item": "iron-plate", "source": "buffer",    "ticks": [3600, 3900, ...], "counts": [120, 140, ...] },
      { "item": "iron-plate", "source": "inventory", "ticks": [3600, 7200, ...], "counts": [80, 50, ...] },
      // ...
    ]
  },

  // Lab activity
  "labs": {
    "perMinute": [
      { "minute": 12.5, "total": 8, "active": 7, "missingByPack": { "automation-science-pack": 0 } }
      // ...
    ],
    "idleBands": [{ "startMin": 45.2, "widthMin": 1.3 } /* ... */]
  },

  // Research timeline (units normalized to minutes)
  "research": [{ "name": "automation-2", "startMin": 14.3, "endMin": 15.8 } /* ... */],

  // Header summaries
  "summary": { "peakLabs": 24, "peakActiveLabs": 22, "packsUsed": 7 }
}
```

Plus the existing `<run>.map.json` sibling (separate concern; see "Map is intentionally separate" above).

### Output reference

| Output | Process | Gain vs shipping raw | Loss vs shipping raw |
|---|---|---|---|
| `phases` | **Compute** — heuristic over machine-build events | Heuristic runs once; Zaspar tuning encapsulated | Boundaries frozen at build time |
| `production` | **Aggregate** — per-period `items` (`cycles × outputCount`), `potential` (per-machine rate × periods), and `statusLoss` / `itemLoss` / `fluidLoss` decomposition; clamp losses to `max(0, potential - items)`. Grouped per (recipe × buildPhase) with dense arrays + `firstTick` offset (leading/trailing zeros trimmed). | 52 MB → ~3 MB; mandatory because browser can't load 52 MB. Carries the full rate-and-loss decomposition today's widgets render, at the same time resolution. | Per-machine drilldown unavailable; spatial filters need fallback. Rate-snapshot used for `potential` is fixed at the moment the data collector captured the recipe — module/beacon changes applied later aren't reflected. |
| `stocks` | **Aggregate** — `bufferAmounts` + `playerInventory` → grouped per (item × source) change-event series with sample-and-hold semantics | ~6 MB → ~1 MB; unified schema | Box-level (per-chest) detail and capacity / `chestCount` metadata gone. Widgets needing the buffer-limit reference line should extend stocks-prep. |
| `labs` | **Compute** — idle bands + missing-pack join; per-minute activity | Heavy heuristic + join run once; 6.4 MB → small series | Per-tick lab state gone; interpretation frozen |
| `research` | **Lift** — tick → minute normalization only | Consistent units | None |
| Run facts / `summary` | **Compute** — scalar derivation | Convenience | None |
| `<run>.map.json` (separate) | **Trim + render + combine** — entity timeline trim + FBSR terrain render | FBSR render needs Java + Factorio; not viable at runtime | None for playback — entity timestamps preserve time |

### Surviving preps

```
dashboard/scripts/
  build-run-data.mjs              orchestrator — runs every prep below and
                                                 invokes map-prep inline when
                                                 FBSR output is ready
  phase-boundaries.mjs            → phases
  production-cube-prep.mjs        → production         (new — replaces 4 widget preps)
  stocks-prep.mjs                 → stocks             (new — merges buffer + inventory)
  lab-saturation-prep.mjs         → points, idleRects, researchIntervals, packsUsed
  burner-phase-prep.mjs           → burnerPhase        (kept — minerActivity-based)
  manual-gathering-prep.mjs       → manualGathering    (kept — depends on burner phase)
  front-side-prep.mjs             → frontSidePhase     (kept — region-shaped widget)
  flow-prep.mjs / smelting-prep.mjs → flow / smelting  (separate concept; see flow_smelting_promotion.md)
  map-prep.mjs + fbsr-prep.mjs    → <run>.map.json     (refactored to export
                                                       buildMapData; now embeds
                                                       phases for timeline snap)
  lib/phase-lookup.mjs            shared phase-membership helper consumed by
                                  production-cube-prep and (optionally) map-prep
  lib/recipe-row.mjs              still used by front-side-prep at build time;
                                  its render-time twin is dashboard/src/lib/recipeRow.ts
```

### What widgets do

Widget components in `dashboard/src/components/` read `production` and `stocks` directly, filter to their concern, and aggregate with d3-array at render time. The render-time helpers that used to live in `dashboard/scripts/lib/` (notably `buildRecipeRow`, `recipe-row.mjs`) move to a parallel `dashboard/src/lib/` so they can be imported from components.

### Migration sketch (completed 2026-05-11)

1. ✅ Build `production-cube-prep` and `stocks-prep`. Landed them as new top-level fields alongside the existing widget fields — no breaking change.
2. ✅ Render-time helpers landed at `dashboard/src/lib/recipeRow.ts` (with `buildCombinedRecipeRow` + `buildFluidBufferRow` siblings) and `dashboard/src/lib/projectProduction.ts` / `projectStocks.ts`. The build-time `lib/recipe-row.mjs` stays because `front-side-prep` still uses it.
3. ✅ Converted four widget components to read from `production` + `stocks`: `EndGameWidgets`, `MixedSegmentWidget`, `OilPhaseWidget`, `FullBuildWidget`. Numeric equivalence verified per widget (exact match modulo the 1-period slack in phase-membership, which is now codified in `lib/phase-lookup.mjs`).
4. ✅ Deleted the four converted widget-shaped preps (`end-game-production-prep`, `mixed-segment-prep`, `oil-phase-prep`, `full-build-prep`) and removed their top-level fields (`endGame`, `mixedSegment`, `oilPhase`, `fullBuildPhase`) from `<run>.json`. `phaseRegistry.ts`'s `dataKey` for these widgets now points at `production`.
5. ✅ Regenerated all five committed run JSONs. File size dropped from ~4.4 MB to ~2.6 MB per run.

---

## Open Questions

- **Time granularity.** ~~Per-minute is assumed throughout `production`, `stocks`, and `labs`.~~ **Resolved 2026-05-11:** `production` and `stocks` ship at the data collector's native period (~5s), matching the existing chart grid — per-minute degraded rate-line smoothness (±12-period smoothing collapses when each "period" is already a minute). `labs` keeps its existing per-period sampling (already minute-ish in practice since lab snapshots come from `labContents`'s sparse periodic dump).
- **`buildPhase` semantics for pre-existing machines.** ~~Need a sentinel.~~ **Resolved 2026-05-11:** the literal phase name `"Earlier"` (`PRE_PHASE_SENTINEL` in `lib/phase-lookup.mjs`) is used for machines built before any tracked phase. Render-time `phasesBefore(phases, anchor)` adds `"Earlier"` to "before X" filter sets so early-phase widgets still see those machines.
- **Sparse vs dense.** ~~Pending.~~ **Resolved:** dense per-period arrays inside per-`(recipe, buildPhase)` groups with `firstTick` trimming of leading/trailing zeros. Naive per-period cells hit ~10 MB per run; columnar grouping brought a complete run to ~2.6 MB.
- **Spatial filters.** `front-side-prep` needs machines filtered by position, not buildPhase. Deferred — see the survival rationale under "Widget-specific preps are deleted (partial)" above. Folding it in needs a `region` axis on the cube or a small region-shaped sibling dataset.
- **Integration with flow/smelting promotion.** The flow concept doc proposes inlining `flow` and `smelting` into `<run>.json`. Under this redesign, do they stay inline or follow `map` into a sibling file? Re-evaluate after flow's redesign settles its size.

---

## References

- [`dashboard/scripts/build-run-data.mjs`](../../dashboard/scripts/build-run-data.mjs) — orchestrator after the redesign
- [`dashboard/scripts/production-cube-prep.mjs`](../../dashboard/scripts/production-cube-prep.mjs) — production cube builder
- [`dashboard/scripts/stocks-prep.mjs`](../../dashboard/scripts/stocks-prep.mjs) — stocks dataset builder
- [`dashboard/scripts/lib/phase-lookup.mjs`](../../dashboard/scripts/lib/phase-lookup.mjs) — shared phase-membership helper used by production-cube-prep and map-prep
- [`dashboard/src/lib/recipeRow.ts`](../../dashboard/src/lib/recipeRow.ts) — render-time `buildRecipeRow` (+ combined + fluid-buffer variants)
- [`dashboard/src/lib/projectProduction.ts`](../../dashboard/src/lib/projectProduction.ts) / [`projectStocks.ts`](../../dashboard/src/lib/projectStocks.ts) — render-time projections from cube / stocks onto the chart grid
- [`docs/concepts/flow_smelting_promotion.md`](./flow_smelting_promotion.md) — sibling concept; flow + smelting promotion to first-class production data
- [`dashboard/src/data/DS-2_14_45.json`](../../dashboard/src/data/DS-2_14_45.json) — current run payload (~2.6 MB after step 4)
- Raw `extracted-data/` shape — `machineProduction` (52 MB), `labContents` (6.4 MB), `bufferAmounts` (1.3 MB), `playerInventory` (5 MB), `researchTiming` (11 KB), `rocketLaunchTime` (30 bytes)
