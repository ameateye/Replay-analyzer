# Contributing

Replay Analyzer is a curated lens + open utility. Contributions span four shapes, in roughly increasing depth:

1. [Add your run to the published dashboard](#add-your-run-to-the-published-dashboard) — runner contribution. PR a built run JSON.
2. [Fork and self‑host](#fork-and-self-host) — your own dashboard on your own GitHub Pages. No PR.
3. [Add a chart, widget, or category](#add-a-chart-widget-or-category) — extend the analytical surface.
4. [Modify the data collection layer](#add-a-new-metric-to-the-data-collection-layer) — change what gets extracted from the replay.

If you only want to look at runs, you don't need this — the [live dashboard](https://ameateye.github.io/Replay-analyzer/) covers it. If you only want to use the tool on your own replay, the project [README.md](README.md) covers it.

> **The doc you're reading is for contributing to *this* dashboard.** If you fork (path 2), you can disregard most of the conventions below — build it your way. The conventions only matter when you're working in this repo and want your changes to land.

---

## What "the lens" is

> **TODO (author):** This section needs the project author's analytical thesis — what each widget is *for*, what each chart's diagnostic role is, why the lens is shaped the way it is. The current curation is calibrated specifically for Zaspar's plan; that calibration is part of the thesis. Contributors who want to extend the dashboard coherently need this section before they can make good design choices.

The lens currently calibrates to **Zaspar's plan** along three axes, in decreasing specificity:

- **Phases** — phase‑end detection (especially: when does Front side end? when does Mixed end?) is tuned to Zaspar's strategy. Other plans will hit phase boundaries at different observable cues.
- **Widgets** — the choice of which widgets appear (oil routing, mixed segment, full build, end game) reflects Zaspar's common bottlenecks. Most are common to other plans, but "common bottleneck for Zaspar" is the selection criterion.
- **Charts** — chart design is mostly generic and transfers to any DS run.

If your contribution touches phase boundaries, expect to think about Zaspar‑specific assumptions. If it touches charts, those should generalize.

---

## Tech stack & architecture

### Tech stack

| Layer | Choice | Why |
|---|---|---|
| UI framework | **React 18** | Component model, ecosystem |
| Charting | **visx** (`@visx/scale`, `@visx/axis`, `@visx/group`, `@visx/shape`) + `d3-array`, `d3-shape` for path math | D3 flexibility coupled with React. recharts/echarts can't surface the level of detail this lens needs |
| Styling | **Plain CSS** in component‑local `.css` files + tokens from `dashboard/src/theme.ts` | No Tailwind, no styled‑components, no CSS‑in‑JS. (No deep reason for "no Tailwind" — just hasn't happened.) |
| State | React‑local `useState` + one `Context` for cross‑run game‑data | No Redux / Zustand / Jotai. The app is small enough that local state + one Context covers it |
| Build pipeline (offline) | **Plain ESM Node** scripts under `dashboard/scripts/` | No bundler for the prep step — these are pure data transforms |
| Bundler | **Vite** | Standard dev server + build. Configured with `base: './'` (relative paths) so forks deploy under any subpath without configuration |

**Stick to these choices when contributing.** Coherence across charts is a higher value than picking your favorite library.

### Data flow

```
.zip save
  │  replay-tool install <save>          inject control.lua, copy into Factorio saves folder
  ▼
Factorio plays the save, /export-replay-data writes JSONs to script-output/
  │  replay-tool process <name> <save>   move JSONs + clean save + npm run data
  ▼
extracted-data/<name>/{bufferAmounts, labContents, machineProduction, …}.json
  │  dashboard/scripts/build-run-data.mjs  reads, derives series, writes a single per-run JSON
  ▼
dashboard/src/data/<name>.json           (committed; the dashboard reads from here)
  │  vite build / vite dev
  ▼
React app loads:
  - dashboard/src/data/<name>.json       per-run derived series
  - /game-data/*.json                    cross-run reference (loaded once at startup)
```

Two layers of derived data live in this repo:

- **Per‑run, build‑time** (`dashboard/src/data/<run>.json`) — heavy computation: per‑tick aggregation, phase detection, series clipping. Runs once per run via `npm run data`. Committed.
- **Cross‑run, runtime** (`game-data/*.json`) — lookups: tech icons, tech requirements, recipe metadata (output counts, display config), science‑pack tiers/colors, phase definitions. Loaded once at app start via `GameDataProvider`. Don't bake this into per‑run JSONs.

### Report structure

The dashboard reads **top‑to‑bottom: overview → deep dive.**

```
┌─────────────────────────────────────────────────┐
│ Header — run name, total duration               │
│ Run picker (when multiple runs published)       │
├─────────────────────────────────────────────────┤
│ RunOverview                                     │
│   - Research ribbon (tech icons over time)      │
│   - Lab saturation plot                         │
│   - Game-time x-axis                            │
│   - Phase strip (Burner/Front/Oil/Mixed/Full…)  │
│     ↑ click a phase to drive the panel below    │
├─────────────────────────────────────────────────┤
│ PhaseAnalyzer                                   │
│   - Widget for the active phase                 │
│     (OilPhaseWidget, MixedSegmentWidget,        │
│      FullBuildWidget, EndGameWidgets, …)        │
└─────────────────────────────────────────────────┘
```

The phase strip is the navigation. Selecting a phase swaps the analyzer pane. The four sections of `RunOverview` (ribbon → plot → axis → strip) share a single x‑scale so they line up exactly.

**Alignment rule.** `RunOverview` and `EndGameWidgets` share `MARGIN_LEFT = 120` (px) so their plot regions land at the same horizontal offset. New widgets meant to align with these should match the margin. Visual continuity from the overview down into the phase analyzer is part of the lens's "feel."

### Directory layout (high‑level)

```
dashboard/                    React + Vite app — the deployed surface
  src/components/               Visx widgets (RunOverview, EndGameWidgets, etc.)
  src/data/<run>.json           Pre-built per-run input (committed)
  src/data/index.ts             Auto-generated run index (newest mtime first)
  src/server/gameData.ts        Loads /game-data/* once at startup
  src/theme.ts                  Color tokens, font, time formatters
  scripts/                      Offline build pipeline
    build-run-data.mjs          Entrypoint (called by `npm run data <run-dir>`)
    *-prep.mjs                  Per-section preps (lab saturation, phases, end game, oil, full build)
  vite.config.ts                Has /game-data middleware mirroring the prod path
game-data/                    Cross-run reference, served at /game-data/*
tools/replay-tool.ps1         Windows wrapper for the data collection layer
```

A few directories live on disk but are gitignored — they exist locally and won't appear in PRs:

- `factorio-replay-analysis/` (or `factorio-replay-data-collection/`) — the data collection layer, cloned per machine
- `extracted-data/` — your per‑run JSONs from the data collection step
- `analysis/`, `charts/` — superseded local prototypes from before the dashboard existed
- `dashboard-mock.html` — early UI mockup

If you find yourself wanting to extend `analysis/` instead of `dashboard/`, stop — those scripts are not deployed and not maintained.

---

## Conventions

### Data prep modules (`dashboard/scripts/*-prep.mjs`)

Prep modules are **pure ESM functions**:

- **Input**: a `runDir` path (and sometimes context like phase boundaries or the rocket‑launch tick).
- **Output**: a JSON‑serialisable object that becomes one top‑level field of the per‑run JSON.
- **No I/O**: prep modules never write to disk. `build-run-data.mjs` aggregates their outputs and does the single `writeFileSync`. Don't add file I/O inside a prep — it breaks the orchestration.
- **No game‑data lookups**: prep modules don't fetch tech icons or recipe display config. That stuff is loaded at runtime from `/game-data/*` and joined to per‑run series in the React layer (see `augmentResearchIntervals` for the pattern). Keeps per‑run JSONs free of duplicated reference data.

When adding a new prep:

1. New file under `dashboard/scripts/`. Export a function returning the run‑derived object.
2. Wire it into `build-run-data.mjs` so it appears as a top‑level field on the per‑run JSON.
3. The new field becomes part of the `Run` type automatically (`Run = typeof r0` in `src/data/index.ts`). Adding a top‑level field to one run means adding it to all, or guarding component access with `?.`.

### Where computation lives

| Computation | Where | Why |
|---|---|---|
| Per‑tick aggregation, phase detection, series clipping | Build time (preps) | Heavy, deterministic per run, doesn't need to re‑run on every page load |
| Game‑time → minute conversion, rocket‑launch clipping | Build time (preps) | Series are clipped on build so the x‑axis ends cleanly |
| Color lookup (per‑pack, per‑recipe, per‑phase) | Runtime (React) | Lookup tables live in `game-data/`; React reads them once via `useGameData()` |
| Tech‑icon URL, required‑pack list per research interval | Runtime (`augmentResearchIntervals`) | Avoids duplicating game‑data into every per‑run JSON |
| Scale construction, layout, hover state | Runtime (React) | UI concerns |

Rule of thumb: if it's the same answer for every run that uses the same recipe, it's game‑data and lives at runtime. If it's a function of *this* run's events, it's build‑time and lives in the per‑run JSON.

### Per‑run JSON shape

| Field | Type | Semantics |
|---|---|---|
| `runName` | string | `path.basename(runDir)` with a leading `Actual-` prefix stripped |
| `durationTicks` | number | First rocket launch tick. **All series are clipped to this point** so the x‑axis ends cleanly. |
| `durationMin` | number | `durationTicks / 3600` |
| `peakActiveLabs`, `peakLabs` | numbers | Header summary metrics |
| `packsUsed` | string[] | Science pack names appearing in the run, in tier order |
| `points` | `{minute, total, active, missingByPack}[]` | Per‑sample lab saturation. `total` = labs built, `active` = labs running |
| `idleRects` | `{startMin, widthMin}[]` | Bands where labs are idle (research not running) |
| `researchIntervals` | `{name, startMin, endMin}[]` | Completed tech research. Augmented at runtime with `iconUrl` and `requiredPacks` |
| `phases` | `{name, startMin, endMin}[]` | Strategic build‑phase boundaries. Names must match `game-data/build-phases.json` |
| `mixedSegment`, `oilPhase`, `fullBuildPhase`, `endGame` | object \| null | Per‑phase widget inputs. Each prep module documents its own shape |

`src/data/index.ts` is **auto‑generated** by `build-run-data.mjs`, ordered by file mtime descending — the most recently built run becomes `defaultRun`. Don't hand‑edit it.

### Styling and visual language

The two rules: **make it look good** and **get the Factorio look and feel.** Beyond that:

- **Palette:** neutral in‑game Factorio grays (NOT the factorio.com warm browns). All chrome tokens live in [dashboard/src/theme.ts](dashboard/src/theme.ts) under `COLORS`. Use them; don't hardcode hex values in components.
- **Cream caption color** (`textStrong: '#ffe6c0'`) matches Factorio's `data.raw caption_color` — use for headings, key labels, anything that should "feel" like in‑game text.
- **Brand orange** (`accent: '#e39827'`) — used sparingly per game style (label accents, glow, active markers). **Not a surface color.** Don't paint backgrounds with it.
- **Data colors** (per‑pack, per‑recipe, per‑phase) come from `useGameData()` helpers: `packColor`, `phaseColor`, `recipeMeta`, `phaseRowDisplay`. Don't read the gameData object's nested fields directly from components — the helpers exist so the shape can change without rippling.
- **Font:** Titillium Web. Defined as `FONT` in `theme.ts`.
- **Time formatting:** `fmtTime` (h:mm:ss) and `fmtTimeNoSec` (h:mm) from `theme.ts`. Don't reinvent.
- **CSS:** component‑local `.css` files. Keep them small and adjacent to the component.
- **Reuse existing widget primitives** (`ProductionRow`, the groups/rows display config) rather than inventing parallel shapes. New phase widgets typically plug into existing primitives — that's how visual continuity holds.

### Game‑data URL contract

The dashboard fetches reference data from `${import.meta.env.BASE_URL}game-data/*`. `vite.config.ts`:

- In **dev**: registers a middleware that serves the sibling `../game-data/*.json` directly.
- In **build**: copies `../game-data/` into `dist/game-data/`.
- Uses `base: './'` (relative), so the same code works under any subpath — including the canonical Pages URL `/Replay-analyzer/` and any fork's deploy path.

Honor `BASE_URL` if you add new fetches.

### Naming

- Phase names match `game-data/build-phases.json`. The `phaseRegistry` key, the `phases[*].name` field on a run, and the `build-phases.json` entry must all line up exactly.
- Per‑run JSON dataKeys (`mixedSegment`, `oilPhase`, etc.) are camelCase; match them in `phaseRegistry.ts`'s `dataKey` field.
- Recipe identifiers are Factorio internal names (kebab‑case: `processing-unit`, `low-density-structure`). Display labels come from `game-data/recipes.json`.

---

## Recipes

### Add your run to the published dashboard

If you've extracted your own run and want it on the canonical published dashboard, three friction levels:

#### Web edit on a fork (no clone needed)

If you already have your built `<run>.json` from running `npm run data` locally:

1. Fork this repo via the GitHub UI.
2. Navigate to `dashboard/src/data/` on your fork.
3. Click "Add file" → "Upload files" and drop your `<run>.json`.
4. Edit `dashboard/src/data/index.ts` to add an import for your file:

   ```ts
   import r0 from './<your-run>.json';
   import r1 from './DS-2_14_45.json';
   import r2 from './DS-2_19_20.json';
   import r3 from './DS-2_17_29.json';

   export type Run = typeof r0;
   export const runs: Run[] = [r0, r1 as unknown as Run, r2 as unknown as Run, r3 as unknown as Run];
   export const defaultRun = runs[0];
   ```

   Put your run first if you want it to be the default; otherwise put it last.

5. Commit on the fork and open a PR against `main` of this repo.

#### Local clone + PR (preferred for repeat contributors)

```sh
git clone https://github.com/<you>/Replay-analyzer
cd Replay-analyzer/dashboard
npm install
npm run data ../extracted-data/<your-run-folder>      # rebuilds src/data/<run>.json + index.ts
git add src/data && git commit && git push
```

Then PR against `main`. `npm run data` regenerates `index.ts` ordered by mtime descending, so the freshly built run lands at the top.

#### Submit your raw extracted JSONs

If you don't want to install Node, open a PR with your `extracted-data/<run>/*.json` files attached, or zip them and attach via "Issues → New issue → attach file." The maintainer can rebuild from the raw JSONs.

#### What the maintainer reviews

Run authenticity (actual replay export, not synthetic data), phase boundaries detected sensibly (no obvious detection failures — see note about Zaspar‑calibration above), run‑name uniqueness. Runs by anyone are welcome — leaderboard placement is not a gating criterion.

---

### Fork and self‑host

If you want your own dashboard with your own runs, hosted at your own GitHub Pages URL:

1. Fork this repo.
2. In **your fork's** Settings → Pages, set Source to "GitHub Actions." The workflow at `.github/workflows/deploy-dashboard.yml` will deploy to `https://<your-username>.github.io/<fork-name>/` on push to `main`.
3. Replace the runs in `dashboard/src/data/` with your own (web edit or local clone).
4. Optionally edit `game-data/build-phases.json` and `dashboard/scripts/phase-boundaries.mjs` to retune the phase model for your category.
5. Push to `main`. Pages auto‑deploys.

`vite.config.ts` uses `base: './'`, so the build works under any subpath without configuration.

You don't owe upstream anything. If you build something interesting, a back‑PR is appreciated but never required.

---

### Add a chart, widget, or category

#### Add or modify a chart

The dashboard is **visx‑native**. All chart geometry is React + visx components rendering inline SVG. Don't import pre‑built D3 SVGs as `<img>` and don't add `analysis/*.ts` scripts — that path is deprecated and not deployed.

- Plot/series/axis lives in a component under `dashboard/src/components/`.
- New derived series go into a `dashboard/scripts/*-prep.mjs` so they land in `src/data/<run>.json`. Don't compute heavy series in the React layer.
- Use scales from `@visx/scale`, axes from `@visx/axis`, color tokens from [theme.ts](dashboard/src/theme.ts) for chrome and `useGameData()` helpers for data colors.

#### Add a phase widget

1. Build the run‑derived input in a new prep module (or extend an existing one). Wire into `build-run-data.mjs`.
2. Add display config to `game-data/recipes.json` if the widget needs labels/colors that should be reusable across runs without rebuilding per‑run JSONs.
3. Reuse existing primitives (`ProductionRow`, the groups/rows display config) rather than inventing parallel shapes.
4. Register in [phaseRegistry.ts](dashboard/src/components/phaseRegistry.ts):

   ```ts
   export const PHASE_WIDGETS: Record<string, PhaseWidgetEntry> = {
     'Your phase name': { dataKey: 'yourPhaseDataKey', Widget: YourWidget },
     // …
   };
   ```

   The phase name must match `game-data/build-phases.json`. The `dataKey` must match the field name on `Run` written by your prep module.

5. Rebuild a run with `npm run data`; the widget renders automatically when that phase is selected.

#### Add a category (or extend an existing one)

The data collection layer is run‑agnostic — nothing in `factorio-replay-analysis` is DS‑specific. The category‑specific surfaces in *this* repo are:

1. **Phase boundaries** — [dashboard/scripts/phase-boundaries.mjs](dashboard/scripts/phase-boundaries.mjs) encodes the DS phase ladder using heuristics tuned to Zaspar's plan. A new category typically needs its own phase logic (a fork of this module with category‑appropriate predicates).
2. **Phase set** — [game-data/build-phases.json](game-data/build-phases.json) lists phase names and colors.
3. **Phase widgets** — [phaseRegistry.ts](dashboard/src/components/phaseRegistry.ts) maps phase names to widgets. Reuse where the underlying recipes still make sense, add new ones where they don't.
4. **Recipe display config** — [game-data/recipes.json](game-data/recipes.json) drives end‑game / mixed / oil / full‑build widget content.
5. **`baseMachineTypes`** — controls the bbox used by phase‑boundary detection. Extend it if your category builds use machine types not currently listed.

If your category diverges enough that DS and the new category can't share a phase model, the path forward is one prep module per category and a category field on `Run`. Open an issue before doing this — `App.tsx` is single‑run today and the run picker would need to know which category each run belongs to.

#### Update tech icons / tech requirements

`game-data/factorio-tech-icons.json` is generated by `game-data/build-tech-icons.js`, which probes the Factorio wiki and applies overrides:

```sh
node game-data/build-tech-icons.js
```

`game-data/factorio-tech-requirements.json` comes from `game-data/parse-tech.js`.

---

### Add a new metric to the data collection layer

The data collection layer lives at [ameateye/factorio-replay-analysis](https://github.com/ameateye/factorio-replay-analysis). Edit `src/main.ts` there, push your change, then in this repo:

```cmd
replay-tool build       :: regenerates factorio-replay-analysis/out/control.lua
```

The new JSON appears in Factorio's `script-output` after the next `/export-replay-data`. Add a prep module under `dashboard/scripts/` to consume it.

---

## Gotchas

**`machineProduction.machines[*].count` is recipe cycles, not items.** Recipes that output >1 item per craft (purple science = 3, copper cable = 2) need `count × outputCount[recipe]` for item totals. `game-data/recipes.json` has the lookup. Existing prep modules already handle this — follow their pattern.

**`extract` JSON paths.** The data collection layer writes JSONs flat into `script-output/` (not in a `replay-data/` subfolder despite what some docs claim). The PowerShell wrapper handles this; don't second‑guess.

**npm install requires `--ignore-scripts`** for the data collection layer on Node 20. `factoriomod-debug` ships a `.ts` postinstall script that Node 20's loader rejects. The TSTL build itself is fine.

**Node‑on‑PATH for the wrapper.** When npm is managed by `fnm`, the .cmd shim doesn't inherit fnm's shell PATH. The wrapper auto‑discovers Node under `%APPDATA%\fnm\node-versions\`; set `nodePath` in `config.json` for non‑fnm setups.

**Phase‑boundary heuristics are intentional.** [phase-boundaries.mjs](dashboard/scripts/phase-boundaries.mjs) detects "leaving the base" against an axis‑aligned bbox over base‑machine builds with a sustain filter. The constants (`LEAVE_PADDING_TILES`, `LEAVE_SUSTAIN_SAMPLES`, etc.) are calibrated against failure modes (train teleports being read as base exits, etc.). Don't tweak them without understanding what they're guarding against.

**Single‑run UI.** `App.tsx` is single‑run via the run picker. Cross‑run comparison isn't implemented — surface that gap if a request implies it rather than building a half‑version.

---

## Workflow

1. Branch off `main` (or work on your fork's `main` if self‑hosting).
2. Build and run locally before opening the PR (`npm run build && npm run dev`). Visually verify the run picker, phase strip, and at least one phase widget render.
3. PR description: include a screenshot or short screen recording for visual changes. Phase widgets have many states across the published runs — check yours renders for each.
4. Pages deploy is automatic on push to `main` ([deploy-dashboard.yml](.github/workflows/deploy-dashboard.yml)). The deployed URL is https://ameateye.github.io/Replay-analyzer/.

## When you're not sure

- New visual surface? Probably a new widget under `dashboard/src/components/` registered in `phaseRegistry.ts`, with a prep module under `dashboard/scripts/` if it needs derived data.
- New colors / labels for an existing widget? Probably a `game-data/recipes.json` edit, no rebuild needed.
- Computation that crosses runs? Not yet supported — `App.tsx` is single‑run. Open an issue first.
- Adding a category but unsure where to start? `game-data/build-phases.json` + a fork of `dashboard/scripts/phase-boundaries.mjs` is the minimum viable path.
- Stuck on conventions? Re‑read the [Conventions](#conventions) section and pattern‑match against the most similar existing widget.
