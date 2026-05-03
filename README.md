# Replay Analyzer

Tools and a React dashboard for analyzing Factorio Death-March / speedrun replays. Wraps [GlassBricks/factorio-replay-data-collection](https://github.com/GlassBricks/factorio-replay-data-collection) so the inject-and-extract workflow runs without bash/zip on Windows.

- `dashboard/` — Vite + React dashboard rendering charts for one chosen run. The pre-built data is committed; deploys to GitHub Pages on push.
- `tools/` + `replay-tool.cmd` — Windows wrapper for the inject-and-extract workflow.
- `game-data/` — multi-run reference assets (tech requirements, wiki icon URLs, science-pack tiers/colors, recipe metadata, build-phase definitions). Used by both the data-build scripts and the React app.

## Layout

- `factorio-replay-data-collection/` — upstream extraction mod (clone separately; gitignored). `out/control.lua` is the build artifact.
- `config.json` — your personal paths. Gitignored. See `config.example.json`.
- `tools/replay-tool.ps1` — the wrapper. Run `replay-tool help` for full usage.
- `replay-tool.cmd` — shim so you can call the tool from cmd.exe / Git Bash.
- `extracted-data/` — exported JSON per run (gitignored; lives only on your machine).
- `dashboard/` — React dashboard (see [Dashboard](#dashboard) below).
- `game-data/` — multi-run reference assets, served at `/game-data/*` to the React app.

---

## Replay tool (Windows)

### First-time setup

```cmd
:: 1. Clone the upstream extraction mod into this folder
git clone https://github.com/GlassBricks/factorio-replay-data-collection

:: 2. Build it (Node 20+; see "Rebuilding control.lua" below for the gotcha)
cd factorio-replay-data-collection
npm install --ignore-scripts
npm run build
cd ..

:: 3. Copy the example config and edit paths for your machine
copy config.example.json config.json
```

### Workflow per replay

```cmd
:: 1. Locate the save in your external-saves folder
replay-tool list-saves "DSMP*"

:: 2. Inject control.lua and copy the save into Factorio's saves folder
replay-tool install "DSMP 01_47_59.zip"

:: 3. -- in Factorio --
::    open the save, play the replay, save at the desired point,
::    load that save, run /export-replay-data in the console.
::    (data also auto-exports on first rocket launch)

:: 4. Move the JSONs out of script-output AND remove the save from Factorio
replay-tool extract DSMP-run-1 "DSMP 01_47_59.zip"
```

`extract <name> [save]` is the one-shot: it moves every `*.json` from Factorio's `script-output` into `extracted-data\<name>\`, then deletes the named save from the Factorio saves folder. If you skip the save argument, only the JSONs are moved — useful if you want to do more in Factorio first.

The original save in your external-saves folder is never touched. The modified save in Factorio's saves folder is regenerable any time via `install`.

### All subcommands

| Command | What it does |
|---|---|
| `install <save>` | Copy save from `externalSavesFolder` to Factorio saves, replace `control.lua` inside |
| `extract <name> [save]` | Move JSONs to `extracted-data\<name>\`; if `save` given, also clean it |
| `clean <save>` | Just delete a save from the Factorio saves folder |
| `list-saves [pattern]` | List zip files in `externalSavesFolder` (optionally filtered by glob) |
| `list-installed` | List zip files in the Factorio saves folder |
| `build` | Run `npm run build` to regenerate `out/control.lua` |
| `config` | Print the resolved configuration |
| `help` | Full help text |

`<save>` arguments accept a full path, a filename (with or without `.zip`), or a glob pattern.

### Rebuilding control.lua

Only needed if you edit `factorio-replay-data-collection/src/main.ts` (e.g. to add or remove data collectors).

```cmd
replay-tool build
```

`npm install` was run with `--ignore-scripts` — `factoriomod-debug` ships a `.ts` postinstall that Node 20 can't load. The TSTL build itself works fine.

### Configured paths

`config.json` defines five paths the wrapper uses:

| Key | What it is |
|---|---|
| `externalSavesFolder` | Where you keep .zip saves you've received from elsewhere (Discord, contests, other runners). Not a generic "downloads" concept — point it wherever you actually store these. |
| `factorioSavesFolder` | Factorio's own saves folder, typically `%APPDATA%\Factorio\saves`. |
| `factorioScriptOutput` | Where Factorio writes the exported JSONs, typically `%APPDATA%\Factorio\script-output`. |
| `extractedDataFolder` | Destination folder under this repo where `extract` parks per-run JSONs. |
| `repoPath` / `controlLuaPath` | Your local clone of `factorio-replay-data-collection` and its built `out/control.lua`. |

### Output JSONs (per run)

Each run produces these files in `<extractedDataFolder>\<name>\`:

| File | Content |
|---|---|
| `bufferAmounts.json` | Buffer chest contents over time |
| `labContents.json` | Research progress and lab inputs |
| `machineProduction.json` | Recipe runs across assemblers, chemical plants, refineries, furnaces |
| `playerInventory.json` | Periodic inventory snapshots + crafting queue/events |
| `playerPosition.json` | Player movement track |
| `researchTiming.json` | Tech research start/finish times |
| `roboportUsage.json` | Roboport stats |
| `rocketLaunchTime.json` | Rocket launch timestamps |

---

## Dashboard

React + Vite dashboard for single-run replay analysis. Live build is auto-deployed to GitHub Pages via [.github/workflows/deploy-dashboard.yml](.github/workflows/deploy-dashboard.yml) on push to `main`.

### Setup

```sh
cd dashboard
npm install
npm run dev
```

Open the URL Vite prints (typically http://localhost:5173).

The dashboard reads from `dashboard/src/data/<run>.json`, which is committed. You don't need raw replay data to run or build the dashboard.

### Rebuilding the per-run JSON

`dashboard/src/data/<run>.json` is derived from `extracted-data/<run>/*.json`. To regenerate it for a new run:

```sh
cd dashboard
npm run data ../extracted-data/<your-run-folder>
```

This rewrites `src/data/<run>.json` and `src/data/index.ts` so the dashboard picks up the new run on next dev / build.

### Layout

- `dashboard/src/components/` — visx-based React components (RunOverview, EndGameWidgets, …)
- `dashboard/src/data/` — committed pre-built per-run JSON (run-specific only; no game-data)
- `dashboard/src/server/` — runtime loaders for shared cross-run game-data (fetched from `/game-data/*`)
- `dashboard/scripts/build-run-data.mjs` — entry for `npm run data`. Reads raw extracted JSONs, writes the compact dashboard input. Wraps:
  - `scripts/lab-saturation-prep.mjs` — research / lab-saturation series
  - `scripts/phase-boundaries.mjs` — strategic build-phase boundaries
  - `scripts/end-game-production-prep.mjs` — end-game widget series, split into per-recipe submodules under `scripts/end-game/`

Tech icons / requirements / science-pack metadata / recipe metadata / phase metadata live in `game-data/` and are served at `/game-data/*` by a small Vite middleware in dev (and copied into `dist/game-data/` on build). The React app fetches them once at startup via `GameDataProvider`, so they stay reusable across runs and across charts.
