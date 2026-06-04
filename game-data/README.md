# game-data/

Cross‑run reference data — colors, recipe metadata, tech requirements, sprite atlas. Loaded once at runtime via `useGameData()` (the React `GameDataProvider`); never duplicated into per‑run JSONs (AGENTS.md hard rule #3).

Served at `${import.meta.env.BASE_URL}game-data/*`. In dev, `vite.config.ts` mirrors the URL with a middleware over this folder.

## Files

| File | Shape | Used for |
|---|---|---|
| `recipes.json` | `{ [recipeName]: { displayName?, color, ingredients[], products[], outputCount?, group? } }` | Recipe display + color lookup. `outputCount` is items per cycle — purple = ×3, copper‑cable = ×2 (see AGENTS.md hard rule #6) |
| `science-packs.json` | Ordered pack list with tier + color | Pack colors, tier ordering on the research ribbon |
| `build-phases.json` | Phase definitions: name, color, base‑machine set | Drives `phaseColor`, `phaseRowDisplay`, and `phaseRegistry.ts` keys |
| `factorio-tech-icons.json` | `{ [tech]: iconUrl }` | Tech icons on the research ribbon. Rebuilt via `node build-tech-icons.js` (wiki probe with overrides) |
| `factorio-tech-requirements.json` | `{ [tech]: [packName, ...] }` | Required packs per tech, surfaced on research hover |
| `map-sprites.json` | `{ <atlas sprite ids>: { … } }` | Merged cross‑run sprite atlas (produced by FBSR + folded by `map-prep.mjs`) |
| `flow-prototypes.json` | `{ inserterReach, footprints: { machine, miner, buffer }, recipeOutputOverride, fluidOnlyRecipes[] }` | Static prototype facts the flow edge layer needs (entity footprints, inserter reach + name set, recipe output semantics). **Build‑time only** — read by the flow prep, not served to the React app. `inserterReach` keys double as the inserter‑name set |
| `build-tech-icons.js` | Script | Rebuilds `factorio-tech-icons.json` from the Factorio wiki |
| `parse-tech.js` | Script | Parses Factorio source for tech tree data |

## Helpers (read these, not the raw JSON, from components)

In [../dashboard/src/server/gameData.ts](../dashboard/src/server/gameData.ts):

- `packColor(name)`, `phaseColor(name)`, `phaseRowDisplay(phase)`, `recipeMeta(recipe)`

Components should call helpers; the JSON shape can change without rippling.

## Conventions

- One file per concept — don't proliferate sibling files for the same data.
- Adding fields: optional first, then promote to required after every consumer updates.
- Renaming colors/labels here is hot‑reload friendly; no per‑run rebuild needed.
