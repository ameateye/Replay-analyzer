# Docs map

Every doc in the repo, with a one-line hook so you can pick the right one without opening three. The fast on-ramp for any task is [AGENTS.md → Start here](../AGENTS.md#start-here-find-your-task) — it routes by *what you're about to do*. This page is the by-topic index behind that router.

## Start here (entry docs)

| Doc | Read it when |
|---|---|
| [README.md](../README.md) | You want to *use* the tool — view runs, run the lens on your own save, publish a run |
| [AGENTS.md](../AGENTS.md) | You're an agent (or anyone) starting cold and need the task router + architecture + hard rules |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | You're *building on* the dashboard — a chart, widget, category, or extracted metric |

## Architecture — how shipped subsystems work

| Doc | Hook |
|---|---|
| [architecture/per_run_data.md](architecture/per_run_data.md) | The per-run JSON schema, field by field: shape, invariants, builder, consumer. The authoritative data contract |
| [architecture/flow_feature.md](architecture/flow_feature.md) | The belt-flow graph (segments · edges · contents · clusters) end to end — single source of truth, with pipeline mermaids |

## Specs — implementation-ready / built designs

| Doc | Status · hook |
|---|---|
| [specs/flow_edges_core.md](specs/flow_edges_core.md) | Built · the durable, tile-anchored, owner-based edge model under the flow feature |
| [specs/fbsr_elimination.md](specs/fbsr_elimination.md) | Landed · why per-run Java sprite rendering was replaced with a shared, monotonically-grown atlas |
| [specs/fbsr_event_driven_pipeline.md](specs/fbsr_event_driven_pipeline.md) | The event-driven `ReplaySidecar` map-rendering pipeline (Java tooling + the timing sidecar) |

## Concepts — design rationale & forward-looking decisions

| Doc | Hook |
|---|---|
| [concepts/per_run_data_redesign.md](concepts/per_run_data_redesign.md) | *Why* the data model flattened widget-shaped preps into the `production` cube + `stocks` datasets |
| [concepts/flow_smelting_promotion.md](concepts/flow_smelting_promotion.md) | Promoting smelting analysis into the production payload (cluster graph is wired; `smelting-prep` is built but not yet wired into the build) |
| [concepts/map_mode_performance.md](concepts/map_mode_performance.md) | Why map mode was slow, the imperative pan/zoom/hover + hidden-overlay fixes that landed, and the deferred wins (imperative overlays, lighter map-mode load, sprite-sheet atlas) |

## How-tos — procedures

| Doc | Hook |
|---|---|
| [howtos/partial-extract.md](howtos/partial-extract.md) | Extract a non-DS / partial run: a subset of collectors, a mid-replay export, a raw archive |

## Refactors — in-progress structural work

| Doc | Hook |
|---|---|
| [refactors/segments-edge-rewrite.md](refactors/segments-edge-rewrite.md) | The move from the geometric tile-index segment model to edge-based tracking. Read before touching `lib/flow/segments.mjs` |

## Explorations — investigation findings

| Doc | Hook |
|---|---|
| [explorations/README.md](explorations/README.md) | Where investigation findings live (and the convention for adding one, instead of losing it in a chat log) |
| [explorations/logic_visual_testing_takeaways.md](explorations/logic_visual_testing_takeaways.md) | What was learned trying to build a visual test harness for complex flow logic |

## Factorio knowledge — domain facts the code relies on

[factorio-knowledge/](factorio-knowledge/) is an index of Factorio mechanics the analyzer depends on — **not auto-loaded**; look here when you need the fact rather than re-deriving it. Currently: inserter-direction convention, underground-belt sideload rule, DS-map gathering yield signatures, rebuild-new-unit-number behavior. Adding a fact when you discover one is cheap.

## Component-level reference (lives next to the code)

| Doc | Hook |
|---|---|
| [dashboard/scripts/README.md](../dashboard/scripts/README.md) | The offline build pipeline: which prep produces which top-level run field, plus the map pipeline |
| [dashboard/scripts/diagnostics/README.md](../dashboard/scripts/diagnostics/README.md) | The reusable flow probes (`probe-at` / `probe-segment` / `probe-events`) — your first stop for a "why is S-X wrong?" bug |
| [game-data/README.md](../game-data/README.md) | The cross-run reference data served at `/game-data/*` and loaded once at app start |
| [tools/README.md](../tools/README.md) | The `replay-tool.ps1` command reference and the map-rendering tool chain |

## Data collection layer (submodule)

| Doc | Hook |
|---|---|
| [factorio-replay-analysis/docs/outputs.md](../factorio-replay-analysis/docs/outputs.md) | Every collector's extracted-JSON shape, field semantics, schema versions, conventions. Read before writing a prep |
| [factorio-replay-analysis/docs/entity-layout-internals.md](../factorio-replay-analysis/docs/entity-layout-internals.md) | Internal mechanics of the entity-layout collector |
| [factorio-replay-analysis/CLAUDE.md](../factorio-replay-analysis/CLAUDE.md) | The collection layer's own architecture overview |

## Skills (agent-side, `.claude/` is gitignored)

Available to agents in this repo, not shipped in PRs: **replay-processing** (the install→playback→extract→build pipeline, one run or batch), **steam-version-swap** (headless Factorio version match for a replay), **burner-phase-story** (narrating the early burner phase from the player-activity timeline).

---

### Where a new doc goes

`architecture/` how a shipped subsystem works · `concepts/` design rationale & forward-looking decisions · `specs/` implementation-ready or built designs · `howtos/` a procedure · `refactors/` in-progress structural work · `explorations/` investigation findings (see its README for the convention) · `factorio-knowledge/` a domain fact the code depends on. Keep component-level "how this folder works" docs next to the code as a `README.md`.
