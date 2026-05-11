# Dashboard

The pacing‑analysis lens for Factorio speedrun replays — a React + Vite single‑run app. The lens is currently calibrated for **Zaspar's plan** (phase boundaries especially); other plans/runners can fork the phase model — see [../CONTRIBUTING.md § Add a category](../CONTRIBUTING.md#add-a-category-or-extend-an-existing-one).

This is the only deployed surface in the repo. Live build: https://ameateye.github.io/Replay-analyzer/.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173
```

The runs in `src/data/*.json` are committed, so you don't need the extraction pipeline to develop the dashboard. To rebuild a run, see the project root [README.md](../README.md#use-it-on-your-replay).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` — production bundle in `dist/` |
| `npm run preview` | Serve the production bundle locally |
| `npm run data <run-dir>` | Rebuild `src/data/<run>.json` from raw extracted JSONs and regenerate `src/data/index.ts`. `<run-dir>` is absolute or relative to this directory (e.g. `../extracted-data/My-run`) |

## Layout

```
src/
  App.tsx                  Run picker + top-level layout
  components/              Visx-based widgets (RunOverview, EndGameWidgets, …)
  data/<run>.json          Pre-built per-run input (committed)
  data/index.ts            Auto-generated run index, mtime-newest first
  server/gameData.ts       Fetches /game-data/* once at startup
  theme.ts                 Color tokens, time formatters
scripts/                   Offline build pipeline (extracted JSONs → src/data/<run>.json)
  build-run-data.mjs         Entrypoint
  lab-saturation-prep.mjs    Per-tick lab saturation
  phase-boundaries.mjs       Strategic build-phase boundary detection (category-specific)
  production-cube-prep.mjs   Per-(recipe × buildPhase) production cube
  stocks-prep.mjs            Per-(item × source) change-event stocks dataset
  burner-phase-prep.mjs      Burner-phase widget data (minerActivity-based)
  manual-gathering-prep.mjs  Manual gathering during the burner phase
  map-prep.mjs + fbsr-prep.mjs  Per-run map payload (separate <run>.map.json)
  lib/                       Shared helpers (phase-lookup, recipe-row, buffer, …)
vite.config.ts             Includes a /game-data middleware that mirrors prod paths
```

`src/data/index.ts` is auto‑generated — `npm run data` rewrites it ordered by file mtime descending, so the most recently rebuilt run becomes the default. Don't hand‑edit it.

## Game-data is loaded at runtime

Tech icons, tech requirements, science‑pack tiers/colors, recipe metadata, and phase metadata live in `../game-data/*.json` and are served at `/game-data/*` (Vite middleware in dev, copied into `dist/game-data/` on build). The React app fetches them once at startup via `GameDataProvider`. Don't bake game‑data into per‑run JSONs.

The site deploys under a Pages subpath (`/Replay-analyzer/`), so all `/game-data` URLs are constructed as `${import.meta.env.BASE_URL}game-data/...`.

## More

- Architecture, conventions, gotchas → [../CONTRIBUTING.md](../CONTRIBUTING.md)
- Agent‑targeted reference → [../AGENTS.md](../AGENTS.md)
