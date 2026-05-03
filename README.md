# Replay Analyzer

Tools and a React dashboard for analyzing Factorio Death-March / speedrun replays. Wraps [GlassBricks/factorio-replay-data-collection](https://github.com/GlassBricks/factorio-replay-data-collection) so the inject-and-extract workflow runs without bash/zip on Windows.

- `dashboard/` — Vite + React dashboard rendering charts for one chosen run. The pre-built data is committed; deploys to GitHub Pages on push.
- `tools/` + `replay-tool.cmd` — Windows wrapper for the inject-and-extract workflow.
- `game-data/` — multi-run reference assets (Factorio tech requirements + wiki icon URLs) used to enrich any single run.

## First-time setup

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

## Layout

- `factorio-replay-data-collection/` — upstream extraction mod (clone separately; gitignored). `out/control.lua` is the build artifact.
- `config.json` — your personal paths (Downloads, Factorio saves, script-output, extracted-data). Gitignored. See `config.example.json`.
- `tools/replay-tool.ps1` — the wrapper. Run `replay-tool help` for full usage.
- `replay-tool.cmd` — shim so you can call the tool from cmd.exe / Git Bash.
- `extracted-data/` — exported JSON per run (gitignored; lives only on your machine).
- `dashboard/` — React dashboard. See [dashboard/README.md](dashboard/README.md).
- `game-data/` — multi-run reference assets (tech requirements, icon URL map).

## Full workflow per replay

```cmd
:: 1. Locate the save in Downloads
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

The save in Downloads is never touched. The modified save in Factorio's saves folder is regenerable any time via `install`.

## All subcommands

| Command | What it does |
|---|---|
| `install <save>` | Copy save from Downloads to Factorio saves, replace `control.lua` inside |
| `extract <name> [save]` | Move JSONs to `extracted-data\<name>\`; if `save` given, also clean it |
| `clean <save>` | Just delete a save from the Factorio saves folder |
| `list-saves [pattern]` | List zip files in Downloads (optionally filtered by glob) |
| `list-installed` | List zip files in the Factorio saves folder |
| `build` | Run `npm run build` to regenerate `out/control.lua` |
| `config` | Print the resolved configuration |
| `help` | Full help text |

`<save>` arguments accept a full path, a filename (with or without `.zip`), or a glob pattern.

## Rebuilding control.lua

Only needed if you edit `factorio-replay-data-collection/src/main.ts` (e.g. to add or remove data collectors).

```cmd
replay-tool build
```

`npm install` was run with `--ignore-scripts` — `factoriomod-debug` ships a `.ts` postinstall that Node 20 can't load. The TSTL build itself works fine.

## Where things live

| What | Default path (Windows) |
|---|---|
| Source saves | `%USERPROFILE%\Downloads` |
| Factorio saves | `%APPDATA%\Factorio\saves` |
| Factorio JSON output | `%APPDATA%\Factorio\script-output\*.json` |
| Extracted runs | `extracted-data\<run-name>\*.json` |

Edit `config.json` to change any of these.

## Output JSONs (per run)

Each run produces these files in `extracted-data\<name>\`:

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
