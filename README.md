# Replay Analyzer

A pacing‑analysis lens for Factorio speedruns.

Three things you can do here:

- **See top runs through the lens.** A live curated dashboard of top DS runs (currently Zaspar's), broken down by phase, lab saturation, end‑game throughput, oil routing, and full‑build composition.
  → [Live dashboard](https://ameateye.github.io/Replay-analyzer/)

- **Run the lens on your own save.** Windows tooling injects the data collection layer into your save, pulls the replay's JSONs out, and rebuilds the dashboard with your run added. View it locally — or contribute it back to the published showcase.
  → [Run on your replay](#run-the-lens-on-your-own-save) · [Contribute your run](#contribute-your-run)

- **Build new lenses or contribute to the tool.** The dashboard's analytical surface (charts, phase widgets, recipe configs) is modular. Add a new view, extend the phase model to other categories, or fork the whole thing for your own showcase.
  → [CONTRIBUTING.md](CONTRIBUTING.md)

The data collection layer is [ameateye/factorio-replay-analysis](https://github.com/ameateye/factorio-replay-analysis), a fork of GlassBricks's original tool that captures replay state via a `control.lua` injection (no Factorio mod required). This repo is the analytical layer on top: a Windows runner that connects to the collection layer and extracts JSONs without bash or `zip`, plus a React + Vite dashboard that renders the pacing‑level views.

The lens is currently calibrated for **Zaspar's plan** specifically. Phase boundaries (especially how each phase's *end* is detected) are tuned to his strategy; widget selection reflects his common bottlenecks; chart design is mostly generic. Other plans/runners can fork the phase model — see [CONTRIBUTING.md → Add a category](CONTRIBUTING.md#add-a-category-or-extend-an-existing-one).

---

## See top runs through the lens

→ **[ameateye.github.io/Replay-analyzer](https://ameateye.github.io/Replay-analyzer/)**

The dashboard reads top‑to‑bottom: an overview header (run‑level summary + phase strip + lab saturation), then a phase analyzer pane below that swaps content based on the active phase (Burner / Front side / Oil / Mixed / Full build / Late game). Get the overview, then dive deeper into the phase that interests you.

Currently published: three top DS runs (Zaspar's). Use the run picker in the header to switch.

---

## Run the lens on your own save

The replay tool is **Windows‑only** (Factorio's saves folder + PowerShell are the constraints). The dashboard itself runs on any platform.

### Prerequisites

- Windows 10/11 with Factorio installed
- Node.js 20+ (any 20.x release)
- PowerShell 5.1 or 7+
- Git

### One‑time setup

```cmd
:: From this repo's root.

:: 1. Clone the data collection layer (use this fork — actively maintained alongside the analyzer)
git clone https://github.com/ameateye/factorio-replay-analysis

:: 2. Build it (see "npm install gotcha" below)
cd factorio-replay-analysis
npm install --ignore-scripts
npm run build
cd ..

:: 3. Copy the example config and edit paths to match your machine
copy config.example.json config.json

:: 4. Install dashboard deps (one-time)
cd dashboard
npm install
cd ..
```

**npm install gotcha.** `factoriomod-debug` ships a `.ts` postinstall script that Node 20 can't load. Always pass `--ignore-scripts` when installing the data collection layer's deps. The TSTL build itself is unaffected.

### Per‑replay workflow

```cmd
:: 1. Find the save in your external-saves folder
replay-tool list-saves "DSMP*"

:: 2. Inject the extraction mod into a copy of the save and put it in
::    Factorio's saves folder. Your original save in externalSavesFolder
::    is never touched.
replay-tool install "DSMP 01_47_59.zip"

:: 3. -- in Factorio --
::    Open the save, play the replay, save at the desired point, load that
::    save, then run /export-replay-data in the console.
::    (Data also auto-exports on first rocket launch.)

:: 4. Pull the JSONs into extracted-data/<name>/, clean the modified save,
::    AND rebuild the dashboard's per-run JSON in one shot.
replay-tool process DSMP-run-1 "DSMP 01_47_59.zip"

:: 5. View the run locally
cd dashboard
npm run dev
```

Open the URL Vite prints (typically http://localhost:5173). Your new run shows up in the run picker.

### Subcommand reference

| Command | What it does |
|---|---|
| `install <save>` | Copy save from `externalSavesFolder` into Factorio's saves folder, replacing `control.lua` with the mod's build artifact |
| `process <name> [save]` | One‑shot: `extract` + (optional) `clean` + rebuild dashboard data via `npm run data` |
| `extract <name> [save]` | Move every `*.json` from Factorio's `script-output` into `extracted-data\<name>\`. If `save` given, also delete that save from the Factorio saves folder |
| `clean <save>` | Delete a save from the Factorio saves folder (the original in `externalSavesFolder` is never touched) |
| `list-saves [pattern]` | List zip files in `externalSavesFolder`, optionally filtered by glob |
| `list-installed` | List zip files currently in the Factorio saves folder |
| `build` | Run `npm run build` in the data collection layer to regenerate `out/control.lua` |
| `config` | Print the resolved configuration |
| `help` | Full help text |

`<save>` arguments accept a full path, a filename (with or without `.zip`), or a glob pattern resolved against `externalSavesFolder`.

### Config keys (`config.json`)

| Key | What it is |
|---|---|
| `externalSavesFolder` | Where you keep `.zip` saves received from elsewhere (Discord, contests, other runners). Typically your download folder |
| `factorioSavesFolder` | Factorio's own saves folder, typically `%APPDATA%\Factorio\saves` |
| `factorioScriptOutput` | Where Factorio writes exported JSONs, typically `%APPDATA%\Factorio\script-output` |
| `extractedDataFolder` | Destination under this repo where `extract` parks per‑run JSONs |
| `dashboardPath` | Absolute path to the `dashboard/` directory in this repo |
| `repoPath` / `controlLuaPath` | Your local clone of the data collection layer (`factorio-replay-analysis`) and its built `out/control.lua` |
| `nodePath` (optional) | Override Node directory if `npm` isn't on PATH (e.g. when using fnm) |

For the per‑run output JSON schema (what the extractor writes and how the dashboard consumes it), see [CONTRIBUTING.md → The data layer](CONTRIBUTING.md#the-data-layer).

---

## Contribute your run

If you've run the lens on your own save and want it on the published dashboard, three paths in increasing friction:

1. **Web edit on a fork** — fork this repo, navigate to `dashboard/src/data/`, click "Add file" → "Upload files" and upload your built `<run>.json`, then re‑generate `index.ts` (instructions in [CONTRIBUTING.md](CONTRIBUTING.md#1-add-your-run-to-the-published-dashboard)) and open a PR. No clone needed.
2. **Local clone + PR** — fork, clone, run `npm run data ../extracted-data/<run>` against the run you've extracted, push, PR. The standard dev path.
3. **Self‑host your own dashboard** — fork and host on your own GitHub Pages. No PR needed, full control. Useful if you want a personal showcase rather than a contribution to this one. See [CONTRIBUTING.md → Fork and self‑host](CONTRIBUTING.md#fork-and-self-host).

PRs to the published dashboard are reviewed by the maintainer ([@ameateye](https://github.com/ameateye)).

---

## Build new lenses, fix bugs, or extend to other categories

The full developer guide — code map, dev setup, how to add a chart / widget / category / metric, conventions, gotchas — lives in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Agent‑targeted reference (for Claude Code, Cursor, Codex, etc.): **[AGENTS.md](AGENTS.md)**.

---

## Layout (high‑level)

```
dashboard/                  React + Vite app — the only deployed surface
tools/replay-tool.ps1       Windows wrapper for the extraction mod
replay-tool.cmd             Shim so the wrapper runs from cmd / Git Bash
game-data/                  Cross-run reference (tech, recipes, science packs, phases)
config.example.json         Template for your local config.json
factorio-replay-analysis/   Data collection layer (cloned separately, gitignored)
extracted-data/             Per-run extracted JSONs (local only, gitignored)
```

The deployed dashboard is auto‑built and pushed to GitHub Pages on every push to `main` via [.github/workflows/deploy-dashboard.yml](.github/workflows/deploy-dashboard.yml).

---

## License

MIT — see [LICENSE](LICENSE).

The data collection layer ([ameateye/factorio-replay-analysis](https://github.com/ameateye/factorio-replay-analysis), forked from [GlassBricks/factorio-replay-data-collection](https://github.com/GlassBricks/factorio-replay-data-collection)) is its own project; refer to its repo for its license.
