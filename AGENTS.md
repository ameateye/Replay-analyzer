# Agent guide

This file is an orientation document for AI coding agents (Claude Code, Cursor, Codex, etc.) working in this repo. Human contributors should start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) — those are more pleasant to read. This file is denser, structured for fast retrieval.

## What this project is

Replay Analyzer is a **pacing‑analysis lens for Factorio speedruns** — both a curated showcase of top runs and an open utility runners can apply to their own saves. The deployable surface is a React + Vite single‑run dashboard at https://ameateye.github.io/Replay-analyzer/, currently shipping three top DS runs (Zaspar's). Data is collected by [ameateye/factorio-replay-analysis](https://github.com/ameateye/factorio-replay-analysis) — a fork of GlassBricks's original tool that injects a `control.lua` into a save zip (no Factorio mod required). This repo connects to that data collection layer via a Windows runner so the inject‑and‑extract workflow doesn't need bash or `zip`.

**The lens is currently calibrated for Zaspar's plan.** Specifically:
- **Phases** — the way phase *ends* are detected is tuned to Zaspar's strategy (e.g. "first sustained leave‑base after pumpjack appears" depends on his build pattern).
- **Widgets** — the choice of which widgets appear reflects Zaspar's common bottlenecks; most widgets are also relevant to other plans.
- **Charts** — chart design is mostly generic.

The category‑specific surfaces are `dashboard/scripts/phase-boundaries.mjs`, `game-data/build-phases.json`, `game-data/recipes.json`, and the widget set in `dashboard/src/components/`. Don't assume a request is "DS‑only" just because every committed run currently is DS — but DO assume that phase‑boundary heuristics are Zaspar‑shaped.

There are four contribution shapes, in increasing depth: (1) PR a new run to the published dashboard, (2) fork and self‑host a personal dashboard, (3) add a chart / widget / category, (4) modify the data layer or extractor.

The audience is Factorio speedrunners. Assume domain fluency: ticks, science packs, DSMP, base‑machine vocabulary, etc. Don't write content explaining what a tick is.

## Tech stack (stick to these)

- **React 18** + **visx** (`@visx/scale`, `@visx/axis`, `@visx/group`, `@visx/shape`) + `d3-array` / `d3-shape`. Don't introduce recharts, echarts, Chart.js, etc. — visx was chosen because it gives D3 flexibility with React; lower‑level libraries can't surface the level of detail this lens needs.
- **Plain CSS** in component‑local `.css` files, plus tokens from `dashboard/src/theme.ts`. **No Tailwind, no styled‑components, no CSS‑in‑JS.**
- **React‑local `useState`** + one `Context` for cross‑run game‑data. **No Redux / Zustand / Jotai.**
- **Plain ESM Node** scripts under `dashboard/scripts/` for the offline build. No bundler for preps.
- **Vite** with `base: './'` (relative paths) — works under any subpath without configuration.

## Report structure

Dashboard reads **top‑to‑bottom: overview → deep dive.** Layout is fixed:

```
Header (run name, picker, total duration)
RunOverview            ← research ribbon, lab saturation, time axis, phase strip (one shared x-scale)
PhaseAnalyzer          ← swaps based on phase strip selection
```

The phase strip is the navigation. New widgets that align horizontally with the overview share `MARGIN_LEFT = 120` (px) so plot regions land at the same offset. Don't break the top‑to‑bottom flow.

## Styling

Two rules: "make it look good" and "Factorio look and feel."

- Palette tokens for chrome live in `dashboard/src/theme.ts` (`COLORS`). Use them; don't hardcode hex.
- **Neutral in‑game grays** (NOT factorio.com warm browns). Cream caption color (`textStrong: '#ffe6c0'`) for headings/important labels — matches Factorio's `caption_color`. Brand orange (`accent: '#e39827'`) used sparingly for accents/active markers — never as a surface color.
- **Data colors** (per‑pack, per‑recipe, per‑phase) come from `useGameData()` helpers (`packColor`, `phaseColor`, `recipeMeta`, `phaseRowDisplay`). Don't hardcode data colors in components.
- Font: Titillium Web (`FONT` in `theme.ts`).
- Time formatting: `fmtTime` / `fmtTimeNoSec` from `theme.ts`.

## Data flow (one screen)

```
.zip save (factorioSavesFolder)
  │  replay-tool install <save>           inject control.lua, copy into Factorio saves
  ▼
Factorio loads save, /export-replay-data writes JSONs to script-output/
  │  replay-tool process <name> <save>    extract + clean + rebuild dashboard data
  ▼
extracted-data/<name>/{bufferAmounts,labContents,machineProduction,…}.json
  │  npm run data ../extracted-data/<name>   (dashboard/scripts/build-run-data.mjs)
  ▼
dashboard/src/data/<name>.json              (committed; the dashboard reads from here)
  │  vite build / vite dev
  ▼
React app reads:
  - dashboard/src/data/<name>.json         per-run derived series
  - /game-data/*.json                      cross-run reference data (loaded once)
```

Two layers of derived data: **per‑run, build‑time** (`dashboard/src/data/<run>.json` — heavy computation, run once via `npm run data`, committed) and **cross‑run, runtime** (`game-data/*.json` — lookups, loaded once at app start via `GameDataProvider`). Don't bake game‑data into per‑run JSONs.

## Per‑run JSON shape (semantics)

Top‑level fields written by `build-run-data.mjs`:

| Field | Semantics |
|---|---|
| `runName` | `path.basename(runDir)` with `Actual-` prefix stripped |
| `durationTicks` / `durationMin` | First rocket launch tick. **All series are clipped to this point.** |
| `peakActiveLabs` / `peakLabs` / `packsUsed` | Header summary metrics |
| `points` | Per‑sample lab saturation: `{minute, total, active, missingByPack}` |
| `idleRects` | Bands where labs are idle: `{startMin, widthMin}` |
| `researchIntervals` | Completed tech research: `{name, startMin, endMin}`. Augmented at runtime with `iconUrl` and `requiredPacks` from game‑data |
| `phases` | Strategic build‑phase boundaries: `{name, startMin, endMin}`. Names must match `game-data/build-phases.json` |
| `production` | Per‑(recipe × buildPhase) production cube. ~52 MB raw → ~1.5 MB grouped/columnar at the cube's native 5 s period. Four phase widgets (Oil / Mixed / Full build / Late game) project from this at render time. See [docs/architecture/per_run_data.md](docs/architecture/per_run_data.md). |
| `stocks` | Per‑(item × source) change‑event series, sample‑and‑hold reconstructed at render time. Unifies `bufferAmounts.json` + `playerInventory.json`. |
| `burnerPhase`, `manualGathering` | Widget‑shaped preps that don't fit the cube (different data source / shape). |

The `Run` type is `typeof r0` from `dashboard/src/data/index.ts`. Adding a top‑level field means adding it to all runs (or guarding with `?.` in components).

**Adding or modifying anything that touches `production` / `stocks` / the render‑time projection / phase boundaries / the parity tests: read [docs/architecture/per_run_data.md](docs/architecture/per_run_data.md) first.** It documents the dataset shapes, invariants, extension recipes (new row / new widget / new dataset), and the parity contract the `npm test` + `npm run test:visual` suites guard.

## Repo map

```
dashboard/                    React + Vite app — only deployed surface
  src/components/               Visx-based widgets (RunOverview, EndGameWidgets, …)
  src/data/<run>.json           Pre-built per-run input (committed)
  src/data/index.ts             Auto-generated run index, mtime-newest first
  src/server/gameData.ts        Fetches /game-data/* once at startup
  src/theme.ts                  Color tokens, time formatters
  scripts/build-run-data.mjs    Offline builder: extracted JSONs → src/data/<run>.json
  scripts/{lab-saturation,phase-boundaries,end-game-production,oil-phase,full-build}-prep.mjs
  vite.config.ts                Has /game-data middleware mirroring the prod path
game-data/                    Cross-run reference, served at /game-data/*
  factorio-tech-icons.json    factorio-tech-requirements.json
  recipes.json                science-packs.json    build-phases.json
  build-tech-icons.js         parse-tech.js
tools/replay-tool.ps1         Windows wrapper: install / process / extract / clean / list…
replay-tool.cmd               Shim for cmd / Git Bash
config.example.json           Template; copy to config.json (gitignored)
.github/workflows/deploy-dashboard.yml   Auto-deploy to GitHub Pages on push to main
```

Submodules (cloned via `git submodule update --init --recursive`):

- `factorio-replay-analysis/` → `ameateye/factorio-replay-analysis` — data collection layer fork.
- `Factorio-FBSR/`, `Java-Factorio-Data-Wrapper/` — FBSR render chain forks on `replay-analyzer` branches.

Gitignored, present locally but not in PRs:

- `extracted-data/` — per‑run JSONs
- `analysis/`, `charts/` — superseded D3/standalone scripts (see "deprecated paths" below)
- `dashboard-mock.html` — early UI mockup
- `config.json`, `.claude/`

## Hard rules

1. **Visx‑native dashboard.** Charts in `dashboard/src/components/` render SVG via React + visx (`@visx/scale`, `@visx/axis`, `@visx/group`, `@visx/shape`) plus `d3-array` / `d3-shape` for path math. Do **not** wrap pre‑built D3 SVGs as `<img>` tags or add new standalone scripts under `analysis/`.
2. **`analysis/*.ts` is deprecated.** It is gitignored and not maintained. If a request says "extend the lab‑saturation chart", the answer is to edit `dashboard/src/components/LabSaturationChart.tsx` and `dashboard/scripts/lab-saturation-prep.mjs`, not to add to `analysis/`.
3. **Game‑data lives in `game-data/`, not in per‑run JSONs.** Tech icons, tech requirements, science‑pack tiers/colors, recipe metadata, phase metadata are all loaded once at runtime via `useGameData()`. Don't duplicate them into `src/data/<run>.json`.
4. **Game‑data URL contract is `${import.meta.env.BASE_URL}game-data/*`.** `vite.config.ts` uses `base: './'` (relative paths), so the build works under any subpath without configuration — including the Pages subpath `/Replay-analyzer/` and any fork‑deployed subpath. `vite.config.ts` mirrors the `/game-data/*` URL in dev with a middleware that serves the sibling `../game-data/` directory.
5. **Time is game minutes derived from ticks at 60 ticks/sec.** Series are clipped to rocket launch (`rocketLaunchTick`) at build time so the x‑axis ends cleanly. Use `fmtTime` / `fmtTimeNoSec` from `dashboard/src/theme.ts`.
6. **`machineProduction.machines[*].count` is recipe cycles, not items.** Multiply by `outputCount[recipe]` from `game-data/recipes.json` for item totals (e.g. purple science = ×3, copper cable = ×2). Existing prep modules handle this; new code must follow the same pattern.
7. **`extract` writes JSONs flat into `script-output/`.** The upstream repo's docs claim a `replay-data/` subfolder; that is wrong for this pipeline. The PowerShell wrapper already accounts for it — don't change paths to "fix" it.
8. **npm install on the data collection layer requires `--ignore-scripts`** on Node 20. `factoriomod-debug` has a `.ts` postinstall script Node 20's loader can't run. The TSTL build itself works.
9. **Single‑run UI.** `App.tsx` selects one run at a time via the run picker. Cross‑run comparison is not implemented — if a request implies it, surface that gap rather than implementing a half‑version.
10. **Default run is build‑mtime‑newest.** `build-run-data.mjs` rewrites `src/data/index.ts` ordered by mtime descending; the most recently rebuilt run becomes `defaultRun`.
11. **Parity tests guard the cube/stocks projection.** Any change touching `production-cube-prep.mjs`, `stocks-prep.mjs`, `dashboard/src/lib/{recipeRow,projectProduction,projectStocks,phaseSets,runDatasets}.ts`, smoothing/period constants, or the four converted widgets (EndGame / Mixed / Oil / FullBuild) MUST keep `npm test` green and visually equivalent under `npm run test:visual`. If you intentionally drift, widen the tolerance with a comment explaining *why*. Architecture + invariants live in [docs/architecture/per_run_data.md](docs/architecture/per_run_data.md).

## Where to make common changes

| Task | Files |
|---|---|
| Add a chart series or modify chart geometry | `dashboard/src/components/<Component>.tsx` (+ prep module if new derived series; if the series already exists in the production cube, no prep change needed — see [docs/architecture/per_run_data.md](docs/architecture/per_run_data.md#how-to-extend)) |
| Add a phase widget that reads from `production` + `stocks` | Add a `*Display` config in `game-data/recipes.json` → new component under `dashboard/src/components/` calling `buildRecipeRow` from `src/lib/recipeRow.ts` → register in `phaseRegistry.ts` with `dataKey: 'production'`. **No prep file or `build-run-data.mjs` change needed.** Full recipe in [docs/architecture/per_run_data.md](docs/architecture/per_run_data.md#add-a-new-widget-that-uses-cube--stocks). |
| Add a phase widget that needs data the cube doesn't carry | New `dashboard/scripts/<thing>-prep.mjs` (different data source or shape) → wire into `build-run-data.mjs` → new component → register in `phaseRegistry.ts` with its own `dataKey` (key must match `game-data/build-phases.json` phase name) |
| Add or extend a run category | Fork `dashboard/scripts/phase-boundaries.mjs` heuristics, edit `game-data/build-phases.json` (phase set + base machines) and `game-data/recipes.json` (display config), then either reuse existing widgets or add new ones via `phaseRegistry.ts` |
| Add a published run (PR path) | Run extractor pipeline → `cd dashboard && npm run data ../extracted-data/<run>` → commit `src/data/<run>.json` and `src/data/index.ts` → PR. Also valid: web‑edit `src/data/<run>.json` + `index.ts` directly on a fork without cloning. See CONTRIBUTING §1 |
| Add a published run (self‑host path) | Same as above but on a fork; the fork's GitHub Pages auto‑deploys at `https://<user>.github.io/<fork-name>/`. No PR. See CONTRIBUTING §2 |
| Change pack/recipe/phase color or label | `game-data/recipes.json` (or `science-packs.json` / `build-phases.json`); no per‑run rebuild needed |
| Change a chart's chrome (panel, axis, text, grid colors) | `dashboard/src/theme.ts` |
| Add a new metric from the game | Edit `factorio-replay-analysis/src/main.ts` (the data collection layer fork), `replay-tool build`, then add a prep module |
| Refresh tech icon URLs | `node game-data/build-tech-icons.js` |
| Replay tool subcommand or path logic | `tools/replay-tool.ps1` |

## Conventions and patterns

- Prep modules under `dashboard/scripts/` are plain ESM Node modules that take a `runDir` (and sometimes phase boundaries / rocket‑launch tick) and return a JSON‑serialisable object. They never write to disk themselves — `build-run-data.mjs` aggregates and writes. Follow that boundary; don't add file I/O to a prep module.
- Per‑run JSON shape is anchored by `dashboard/src/data/index.ts`'s `Run = typeof r0` type. Adding a top‑level field to one run means adding it to all (or guarding component access with `?.`).
- Color lookups go through helpers in `dashboard/src/server/gameData.ts` (`packColor`, `phaseColor`, `recipeMeta`, `phaseRowDisplay`). Don't read the gameData object's nested fields directly from components; the helpers exist so the shape can change without rippling everywhere.
- Phase boundaries (`dashboard/scripts/phase-boundaries.mjs`) detect "leaving the base" against an axis‑aligned bbox over base‑machine builds with a sustain filter. The boundary heuristics are documented at the top of that file and are intentional — don't tweak the constants without understanding the failure modes they prevent (train teleports being read as base exits, etc.).
- `RunOverview.tsx` and `EndGameWidgets.tsx` share `MARGIN_LEFT = 120` so their plot regions align horizontally. If you add another widget meant to align with these, match the margin.

## Deprecated paths to leave alone

- `analysis/*-d3.ts`, `analysis/*-data.ts` — pre‑dashboard standalone D3 + Veasy generators, gitignored, not deployed.
- `charts/*.svg` — outputs from the deprecated path.
- `dashboard-mock.html` — early HTML mockup, kept for reference only.

If a task requests work on these, push back: those surfaces don't ship anywhere.

## Environment and tooling

- Windows‑only for the replay tool (Factorio paths + PowerShell). The dashboard runs on any platform.
- Node 20+. The dashboard's `package-lock.json` is on Node 20 in CI.
- The deploy job in `.github/workflows/deploy-dashboard.yml` uses `working-directory: dashboard`, runs `npm ci` then `npm run build`, and uploads `dashboard/dist/` to Pages. Don't move the dashboard out of its subfolder without updating the workflow.
- `replay-tool.ps1` auto‑discovers Node when fnm is in use (looks under `%APPDATA%\fnm\node-versions\`); a `nodePath` config key overrides this.

## Things that look like bugs but aren't

- The repo has no top‑level `package.json`. Only `dashboard/` is a Node package; `game-data/build-tech-icons.js` runs without one.
- `dashboard/src/data/index.ts` is auto‑generated. Edits there will be overwritten by the next `npm run data`.
- `extracted-data/`, `analysis/`, `charts/`, `config.json`, `.claude/` are all in `.gitignore`. Files you see in those directories locally won't appear in PRs — that's intentional.
- The `extract`/`process` PowerShell commands look up the save by glob in the Factorio saves folder. If multiple zips match, the wrapper errors and lists matches — that is intended behavior, not a regression.
