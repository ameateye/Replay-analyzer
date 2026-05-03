# Replay dashboard

React + Vite dashboard for Factorio DS replay analysis. V1 is single-run.

## Setup

```sh
npm install
npm run dev
```

Open the URL Vite prints (typically http://localhost:5173).

The dashboard reads from `src/data/<run>.json`, which is committed. You don't need raw replay data to run or build the dashboard.

## Rebuilding the data from a raw run

`src/data/<run>.json` is derived from `extracted-data/<run>/*.json` (which is per-machine and gitignored at the repo root). To regenerate it for a new run:

```sh
npm run data ../extracted-data/<your-run-folder>
```

This rewrites `src/data/<run>.json` and `src/data/index.ts` so the dashboard picks up the new run on next dev / build.

## Layout

- `src/components/` — visx-based React components (RunOverview, EndGameWidgets, …)
- `src/data/` — committed pre-built run JSON
- `scripts/build-run-data.mjs` — entry for `npm run data`. Reads raw extracted JSONs + `../game-data/factorio-tech-*.json` and writes the compact dashboard input.
