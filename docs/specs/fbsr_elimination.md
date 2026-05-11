# Spec: Eliminate per-run FBSR from the map pipeline

**Status:** A + B + C landed and exercised end-to-end 2026-05-12. `npm run data <run>` produces `<run>.map.json` directly from extracted-data + the shared store; if the run introduces a new `(name, dir, bgt)` variant, recipe icon, or filter item, `fbsr-prep` invokes the local `SpriteEnumerator` Java CLI to render the gap and merges the result into `game-data/{map-sprite-meta,map-sprites}.json` before `map-prep` runs. Verified on a previously-uncovered run (`DS-2_16_04` introduced 4 variants / 2 recipes / 2 filter items — gap-filled in ~200 ms and the rebuilt map fully resolves against the augmented atlas).
**Author:** Claude (2026-05-12) per user direction.

---

## Problem

The map pipeline currently invokes Java FBSR (`ReplaySvgRender`) **per run**:

```
extracted-data/<run>/*.json
  → fbsr-prep.mjs        → tools/output/<run>.{json, timing.json}
  → Java FBSR             → tools/output/<run>.manifest.json   (sprites + per-entity placements)
  → map-prep.mjs          → dashboard/src/data/<run>.map.json + merges into game-data/map-sprites.json
```

But sprites are **not run-dependent** — they depend on Factorio's entity prototypes, not on the player's specific factory. The pixels and the `(name, direction, beltToGroundType, L) → sid` mapping are the same for every run. Re-running FBSR on every replay rebuilds something that doesn't change.

Only the **placements** (which entities, at which px/py, built/removed when, with which recipe/splitter/inserter timelines) are run-dependent.

## Goal

Split the map pipeline into:
- A **shared sprite store** under `game-data/` that grows over time as new entity variants appear. Built/extended on demand, not per run.
- A **per-run placer** (`map-prep`) that reads only `extracted-data/<run>/*` + the shared store, produces `<run>.map.json`, and never invokes Java.

## Architecture

### Shared store

Two files under `game-data/`:

| File | Status | Shape |
|---|---|---|
| `map-sprites.json` | Already exists, already shared | `{ "<sid>": { "data": "<base64-png>", "w": …, "h": … } }` — entity sprites (`s30`…), recipe icons (`r:<recipe>`), filter icons (`f:<item>`) |
| `map-sprite-meta.json` | **New** | `{ "<name>\|<direction>\|<bgt>": { "layers": [{ "L": 51, "sid": "s30", "oxOff": -1, "oyOff": -1 }, …] } }` |

The meta lookup is keyed on the **end-of-run** orientation (post-mutation-folding). One entity variant may have multiple layer entries (e.g. inserter base + arm).

### Components

**Component A — Node only, no Java required.** *(landed 2026-05-12)*
- Rewrite `dashboard/scripts/map-prep.mjs` so it:
  - Reads `extracted-data/<run>/{entityLayout,minerActivity,machineProduction,labContents,bufferAmounts,playerPosition,rocketLaunchTime}.json`.
  - Loads `game-data/map-sprite-meta.json` and `game-data/map-sprites.json` (the latter only to confirm the sid exists — not embedded into map.json output).
  - For each entity: fold mutations to durationTick, look up `(name, end-direction, end-bgt)` in meta, emit one `entities[]` entry per layer with `(px + oxOff, py + oyOff, sid, L, en, tb, tr?)`.
  - Builds `recipeMachines`, `splitterMarkers`, `inserterMarkers`, `playerTrack`, `phases` (input), `durationTick`.
  - Writes `dashboard/src/data/<run>.map.json`. **No `tools/output/` involvement.**
- Update `build-run-data.mjs`: drop the `mapPrepInputsReady` gate; map-prep always runs.
- **Bootstrap path for `game-data/map-sprite-meta.json`:** a one-shot script (`dashboard/scripts/build-sprite-meta-from-existing.mjs`, ephemeral) derives the meta from the committed `<run>.map.json` files + the locally-present `tools/output/DS-2_14_45.timing.json` (for en→un) + `extracted-data/*/entityLayout.json` (for end-of-run dir/bgt by folding mutations). No Java needed. For each variant the script picks the modal layer-set across all entities (so topology-only layers like the L=29 belt-corner overlay don't get applied universally during placement). Only `DS-2_14_45.map.json` is committed today, so the meta only covers what that run uses. Run once, commit `game-data/map-sprite-meta.json`, delete the bootstrap script once Components B+C have a path to extend the meta.
- **Known regression after A, fixed by B+C:** belt corner pieces (L=29 sprites) render as straight belts, since the meta only carries one layer-set per `(name,dir,bgt)`. Functional content (entity positions, build/remove ticks, recipe/splitter/inserter overlays) is unaffected; the rebuilt `DS-2_14_45.map.json` matches the legacy bake on overlay counts (recipeMachines 1198, splitterMarkers 89, inserterMarkers 40) and viewBox.

**Component B — Java FBSR.** *(landed 2026-05-12)*
- Add `Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/cli/SpriteEnumerator.java`. (The FBSR submodule uses `pom.xml`'s `<sourceDirectory>src</sourceDirectory>` — `src/main/java/` was a transcription error in the original spec.)
- `build/vanilla/` was already populated locally; no `profiles/vanilla/` setup step was required. The original spec's framing of this as a "user step" was off — it's a one-time submodule maintenance task, already done in this checkout.
- Input: plain JSON, **not a Factorio blueprint**:
  ```json
  {
    "variants": [{"name": "transport-belt", "direction": 0, "bgt": null}, …],
    "recipes": ["iron-gear-wheel", …],
    "filterItems": ["coal", …]
  }
  ```
- Output: same shape as the existing manifest's relevant subset:
  ```json
  {
    "meta": {
      "<name>|<dir>|<bgt>": { "layers": [{"L": 51, "sid": "s30", "oxOff": …, "oyOff": …}] }
    },
    "sprites": { "<sid>": {"data": "…", "w": …, "h": …} }
  }
  ```
- Reuses FBSR's existing rendering pipeline; only the input parser + the output writer are new. The bulk of the renderer is unchanged.
- Rebuild jar: `mvn -DskipTests package`.
- Requires `profiles/vanilla/` populated (one-time: `mvn exec:java` → `profile-default-vanilla` → `build`).

**Component C — Node glue around B.** *(landed 2026-05-12)*
- Rewrite `dashboard/scripts/fbsr-prep.mjs`:
  - Walks `extracted-data/<run>/*` to collect the set of `(name, end-direction, end-bgt)` variants the run needs (including end-of-run orientations from folded mutations).
  - Also collects `recipes` + `filterItems` (machines that ever ran a recipe; splitters/inserters that ever had filters).
  - Diffs against `game-data/map-sprite-meta.json`. If the diff is empty, exits cleanly (no Java).
  - If non-empty, writes a variant JSON, invokes `SpriteEnumerator` via the local JDK + FBSR jar, reads the output, merges into `game-data/map-sprite-meta.json` + `map-sprites.json`.
- Wire into `build-run-data.mjs`: `fbsr-prep` runs *before* `map-prep`. Idempotent when no gaps.
- **Sid remap during merge.** `SpriteEnumerator` numbers entity sids from `s0` each run; if those were merged verbatim they'd collide with existing atlas entries. The merge step in `fbsr-prep.mjs` scans the existing atlas for the highest `sN` and remaps incoming entity sids to `s<max+1>` ..., rewriting the meta layers' `sid` fields in lockstep. Recipe (`r:<name>`) and filter (`f:<item>`) sids are name-keyed and need no remap.

## Sequencing

1. **Component A** — land first. Self-contained, unblocks the architecture, can ship without Java. After this lands, `npm run data <run>` produces `<run>.map.json` without ever touching `tools/output/` or Java.
2. **Component B** — submodule change. Implement after vanilla profile is populated (user step). Commit on the FBSR submodule's `replay-analyzer` branch.
3. **Component C** — Node glue. Implement after B's jar is rebuilt; verify the gap-fill flow end-to-end on a synthetic test (e.g. delete one entry from meta, run fbsr-prep, confirm it's restored).

## Open / deferred

- **`tools/output/`** — after A, the only producer left is C's transient variant-JSON handoff. Consider moving that to a different location (e.g. `tools/sprite-build/`) and adding `tools/output/` to `.gitignore` truly aggressively.
- **`tools/fbsr-prep.mjs` (old)** — superseded by the new `dashboard/scripts/fbsr-prep.mjs`. Delete after C lands.
- **`replay-tool.ps1` `run` command** — currently chains install + playback + process + npm run data. With A, no map step is needed in the chain (map-prep is inside `npm run data`). With C, the gap-fill is automatic. No wrapper change needed.
- **CI** — `.github/workflows/deploy-dashboard.yml` runs `npm ci && npm run build` in `dashboard/`. After A, `map-sprite-meta.json` is committed in `game-data/`, so CI doesn't need Java. After C, CI still doesn't need Java (it only runs `npm run build`, not `npm run data`).
- **Backward-compat for legacy committed `<run>.map.json` files** — A regenerates all of them from extracted-data. No backward-compat needed since the consumer is fully under our control.

## Decisions confirmed with user

- **Meta location:** `game-data/map-sprite-meta.json` (new sibling, not embedded in `map-sprites.json`).
- **FBSR fallback:** Yes — `fbsr-prep` invokes Java FBSR for missing variants, doesn't just warn.
- **FBSR input format:** Plain variant JSON, **not** a Factorio blueprint. SpriteEnumerator is a new CLI; existing `ReplaySvgRender` blueprint path stays for the old workflow.
- **Bootstrap:** Full process if needed, including populating Factorio data dump. Component A's "derive from committed map.json" path is a shortcut to get A landed; B + C complete the picture.
