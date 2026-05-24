# Spec: Wire map rendering to FBSR (event-driven)

**Status:** Done 2026-05-24. All three landings shipped. Per-run map data is produced end-to-end by `IncrementalMap` + `ReplaySidecar` (Java) called from the consolidated [map-prep.mjs](../../dashboard/scripts/map-prep.mjs). The legacy `fbsr-prep.mjs`, `SpriteEnumerator`, `ReplayRender`, `ReplaySvgRender`, `build-sprite-meta-from-existing.mjs`, and `game-data/map-sprite-meta.json` are all deleted. The shared atlas at `game-data/map-sprites.json` is now hex sids (from `SpriteIdentity`) + `r:`/`f:` overlay sids; it grows monotonically as new runs are processed by the sidecar's `FileAtlasSink`.
**Date:** 2026-05-21 (revised from 2026-05-20, 2026-05-19, 2026-05-13)
**Supersedes:** the entity → sprite mapping path of [fbsr_elimination.md](fbsr_elimination.md) (Components A + B + C). The shared sprite atlas (`game-data/map-sprites.json`, lazy-loaded by the dashboard) survives unchanged.

---

## Problem

After [fbsr_elimination.md](fbsr_elimination.md) landed, [map-prep.mjs](../../dashboard/scripts/map-prep.mjs) does its own per-variant sprite lookup against [game-data/map-sprite-meta.json](../../game-data/map-sprite-meta.json). Two costs surfaced:

1. **The rendering rule got duplicated.** The "which sprite does a belt with these neighbours get" decision lives in FBSR (`TransportBeltRendering.createRenderers` + `WorldMap.getBeltBend`). Replicating it in Node — [lib/layout/belt-topology.mjs](../../dashboard/scripts/lib/layout/belt-topology.mjs) — created a second source of truth that can drift. We already paid the cost of one drift incident: the bootstrap that built `map-sprite-meta.json` collapsed all belts to a single `(name, dir, bgt)` key, dropping curve sprites and end caps; only a hand-written follow-up rule put them back.
2. **The variant-key meta can't express topology-dependent rendering.** A belt's sprite depends on its neighbours, not just its `(name, dir, bgt)`. The bootstrap workaround only worked because a previous FBSR-baked `<run>.map.json` existed to harvest sprite assignments from. Runs without a pre-existing bake (or with new belt directions) can't be filled in by the existing pipeline.

The deeper miss: we built parallel machinery instead of using the rendering logic FBSR already exposes. FBSR is a stateless input → output renderer — given a properly-populated `WorldMap` plus an entity, its `createRenderers` tells us exactly which sprites to draw and where. We just have to drive it incrementally.

## Goal

Replace the variant-lookup pipeline with one that uses FBSR's own `populateWorldMap` + `createRenderers` per entity event, in tick order. Per-run output stays small — a per-entity timeline of `(sprite ID, position, layer)` tuples. Sprite pixels stay in the existing global atlas, lazy-loaded by the dashboard.

Net effect on the codebase:
- [build-sprite-meta-from-existing.mjs](../../dashboard/scripts/build-sprite-meta-from-existing.mjs), [lib/layout/belt-topology.mjs](../../dashboard/scripts/lib/layout/belt-topology.mjs), and [game-data/map-sprite-meta.json](../../game-data/map-sprite-meta.json) all delete.
- [map-prep.mjs](../../dashboard/scripts/map-prep.mjs) keeps the auxiliary outputs (overlays, viewBox, playerTrack, phases). The entity → sprite mapping moves into a Java sidecar.
- The sprite atlas keeps its current shape and growth model.

---

## Background — how FBSR renders

For full code paths see the conversation trace; the salient phases are:

**Phase 1 — `populateWorldMap(map, entity)` per entity.** Each entity registers itself in the WorldMap. For belts ([TransportBeltRendering.java:198-214](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/entity/TransportBeltRendering.java#L198-L214)):
```java
map.setBelt(new BeltCell(pos, facing, bendable, bendOthers, undergroundInput, undergroundOutput));
// internally: belts.put(pos.getXCell(), pos.getYCell(), beltCell);   // last-write-wins per cell
```
The `belts` table is `Table<Integer, Integer, BeltCell>` keyed by integer cell. **Two entities at the same cell overwrite each other** — Factorio doesn't allow overlap, so this is correct for valid input.

**Phase 2 — `createRenderers(register, map, entity)` per entity.** For a belt, this:
1. Reads `belt = map.getBelt(pos).get()` and computes `bend` via `getBeltBend(pos, belt)`, which calls `isBeltFacingMeFrom` for left/right/back perp cells.
2. Emits the main sprite via `defineBeltSprites(consumer, cardinal, bend.ordinal(), frame)` — pushes a `MapSprite(SpriteDef, Layer.TRANSPORT_BELT, position)` into the `register` consumer.
3. Checks the forward cell; if no belt accepts us, emits an ending cap via `defineBeltEndingSprites(consumer, cardinal, frame)` at `position.add(dir.offset())`.
4. Checks the back cell (`backDir = bend.reverse(dir)`); if no belt feeds us, emits a starting cap at `position.add(backDir.offset())`.

**Phase 3 — atlas write.** All `MapRenderable`s collected in the global register bucket are sorted by `Layer.ordinal()` and written to the output image / SVG.

**Why the current pre-elimination bake has artifacts.** The pre-rewrite [tools/fbsr-prep.mjs](../../tools/fbsr-prep.mjs) collected every entity ever built — including build-then-rebuild positions like `un=526` and `un=3105` both at `(100.5, -26.5)` — and submitted them as a single synthetic blueprint. Phase 1 then ran twice for that cell; whichever entity ran second won the `belts` table slot. Phase 2 for the loser used the winner's facing for its bend computation, producing a wrong sprite. The race is in our packaging, not in FBSR.

**Sprite identity.** Each `defineSprites(consumer, index, frame)` call returns a pre-allocated `SpriteDef` from `FPRotatedAnimation.defs[index][frame]` ([FPRotatedAnimation.java:150-159](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/fp/FPRotatedAnimation.java#L150-L159)). The persistent identity tuple is:
```
(path, source.x, source.y, source.width, source.height,
 shadow, blendMode, tint, tintAsOverlay)
```
— derivable from prototype data, stable across JVM runs. SHA-1 of that tuple = our sid.

---

## Architecture

Three components, in two repos:

| | | |
|---|---|---|
| **A** | `Factorio-FBSR/` fork | WorldMap mutate/remove APIs + per-entity render entry point + serialisable SpriteDef identity |
| **B** | `Factorio-FBSR/.../IncrementalMap.java` + `.../cli/ReplaySidecar.java` | `IncrementalMap` (in `com.demod.fbsr`, alongside `WorldMap`) provides two standalone public capabilities — `updateMap(events)` (apply event batch to map state, return affected entities) and `emitUpdates(affected, ts, atlas?)` (render affected entities to renderableTimeline items, optionally growing an atlas). `ReplaySidecar` is the CLI driver that wraps them in a per-tick loop. Subsumes the deleted `ReplayRender`, `ReplaySvgRender`, and `SpriteEnumerator`. |
| **C** | This repo | Single consolidated [map-prep.mjs](../../dashboard/scripts/map-prep.mjs): synthesises BSEntity records (mutation deltas → records with disjoint `[tb,tr)`), invokes `ReplaySidecar`, flattens the per-`un` timeline into the MapView wire shape, builds overlays + playerTrack + viewBox. Legacy `fbsr-prep.mjs` deleted. |

### A — Factorio-FBSR fork

#### A.1 — WorldMap mutate/remove APIs + affected-position return

Today [WorldMap.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/WorldMap.java) only has `setBelt(...)` and `setX(...)` for the other cell collections. Two changes:

**(a) Add `remove*` methods** on every cell collection used by entities in our LAYOUT_SCOPE + the auxiliary collections those entities populate during `populateWorldMap`:

```java
public void removeBelt(MapPosition pos);
public void removePipe(MapPosition pos);
public void removeHeatPipe(MapPosition pos);
public void removeBeacon(MapPosition pos);
public void removeCargoBayConnectable(MapPosition pos);
public void removeNixieTube(MapPosition pos);
public void removeFusionConnections(MapPosition pos);
// ... plus any other set* methods called by entities in LAYOUT_SCOPE
```

Each is a one-liner: `belts.remove(pos.getXCell(), pos.getYCell())` and similar. Commit `51646eb` (2026-05-18) shipped this for `removeBelt` plus the LAYOUT_SCOPE cell collections; the remaining `remove*` methods are pending.

**(b) Promote `populateWorldMap` / `unpopulateWorldMap` to return `Set<MapPosition>`** — the cells whose render may have changed as a result of the mutation:

```java
public Set<MapPosition> populateWorldMap(WorldMap map, MapEntity entity);
public Set<MapPosition> unpopulateWorldMap(WorldMap map, MapEntity entity);
```

Default impl on `EntityRendererFactory`: `Set.of(entity.getPosition())`. The per-factory affected set is derived by inverting each entity type's `createRenderers` read pattern — the cells whose render output reads the cell(s) the entity wrote. Two helpers on `EntityRendererFactory` cover the common shapes:

- `positionAndCardinals(pos)` — `pos ∪ {N, E, S, W}.offset(pos)` (5 cells).
- `positionAndFacingAxis(pos, facing)` — `pos ∪ facing.offset(pos) ∪ facing.back().offset(pos)` (3 cells).

| Entity factory | Affected set | Why |
|---|---|---|
| **TransportBelt** | `positionAndFacingAxis(pos, facing)` | Belt's render reads its 4 cardinals during bend + cap computation, **but** a cardinal cell C only changes the read result when C's belt faces toward the reader. Inverting: a belt at P facing F appears in another belt's read set only on F's axis (forward = receiver, back = feeder). Sides never matter — `isBeltFacingMeFrom` requires C's facing to be opposite the perpendicular direction, which would put the reader on C's *own* facing axis. The belt-reader side check (lines 103-135 of `TransportBeltRendering.createRenderers`) is captured by the same rule: a side feeder that affects a reader belt is one facing the reader, which puts the reader on the feeder's facing axis. |
| **UndergroundBelt** | `positionAndFacingAxis(pos, facing)` | Entrance/exit structure is fixed orientation and reads only side cells for belt-reader (same rule as transport belt). The cross-tile underground span and belt-reader-through-UG signal flow read the linked-belt position; those reads are render-invariant under normal entity lifecycle (the linked-belt lookup is driven by belt-reader chains, not by an entity's own sprite layer). **Limitation:** if an UG-belt entrance is added/removed and a belt reader is reading through it, the reader's render could in principle change up to `maxDistance` tiles away; this case is not captured. Not load-bearing for replay-analyzer (no belt readers in DS speedrun runs). |
| **Splitter** | `positionAndFacingAxis(belt1, facing) ∪ positionAndFacingAxis(belt2, facing)` | Splitter writes two adjacent belt cells perpendicular to facing. Each behaves like a standalone belt for read purposes. 6 unique cells (the inner-edge cardinals overlap once each, so dedup brings 8 to 6). |
| **LaneSplitter** | `positionAndFacingAxis(pos, facing)` | Single belt cell, same rule as transport belt. |
| **Loader** | `positionAndFacingAxis(beltPos, facing)` | Writes one belt cell at `pos + beltShift`. Same rule, anchored at the belt's actual position. |
| **EntityRendering** (fluid/heat base) | `⋃ positionAndCardinals(connPos)` over each pipe/heat connection touched | Pipes connect on all 4 cardinals via `PipeRendering.computePipeAdjCode` (reads `isPipeConnected` for N/E/S/W independently). Heat pipes use the same shape via `isHeatPipe`. |
| **ElevatedPipe** | `positionAndCardinals(pos)` | Elevated pipes actually read along their own facing axis (`isElevatedPipe(dir.offset(pos, distCheck))`). The current cardinals approximation over-counts. **Acceptable** — elevated pipes are modded content, not in scope. |
| **Wall** | `positionAndCardinals(pos) ∪ {SW.offset(pos)}` | `WallRendering.createRenderers` reads its 4 cardinals (`isWall(N/E/S/W)`, `isVerticalGate(N)`, `isHorizontalGate(E)`, ...) plus the NE diagonal (for the corner-fill check). Inverting: a wall at P affects renders at its 4 cardinals (they read P) plus the wall at P's **SW** diagonal (which reads P as its NE). 6 cells. |
| **Gate** | `positionAndCardinals(pos)` | Gate's own render reads nothing — sprite is determined by direction. But walls at the 4 cardinals read `isVerticalGate / isHorizontalGate` of their cardinals, so adding/removing a gate at G affects the 4 walls that may sit at G's cardinals. 5 cells. |
| **NixieTubeBase** | `positionAndCardinals(pos)` *(approximate)* | Nixie's render walks WEST from itself indefinitely, reading consecutive same-name nixies for `symbolIndex`. Adding a nixie at N extends the chain for **every same-name nixie east of N**, potentially many tiles. The 4-cardinal approximation only catches the immediate east neighbour. **Limitation acknowledged** — nixie tubes are modded, not in scope for replay-analyzer. Precise fix would walk east during populate to enumerate all chain members. |
| **CargoBayConnections** | `⋃ {connPoint}` over each connection point | `CargoBayConnectionsRendering.createRenderers` reads `isCargoBayConnectable` at distance 2 from each connection point (lines 158-171). The current set captures only the connection points themselves — neighbours within 2 tiles are missed. **Limitation acknowledged** — cargo bays are space-age content, not in scope. |
| **FusionReactor** | `⋃ {connPoint}` over each connection point | Fusion reactor's render reads `getFusionConnections(connPoint)` only at its **own** bound positions (`createRenderers` line 44). No neighbour reads — connection points alone are sufficient. |
| **Rail** | `Set.of(entity.getPosition())` *(default)* | Rail's render uses `isRailConnected(rail, rail.A)` / `(rail, rail.B)` — endpoint-based, not cell-cardinals. Adjacent rails could be at fractional positions and read via the rail-graph. **Limitation acknowledged** — rails appear in DS speedrun runs (rocket train, in some categories) but the rail-endpoint affected set is not captured by the cardinals helper. Default position-only is a safe under-approximation: rails won't always re-render when their neighbour changes, but the initial render at build time will use the correct WorldMap state. |
| **Beacon** | `Set.of(entity.getPosition())` *(default)* | Beacon's populate writes to `setBeaconed` cells in the supply area, but those are logistic-grid state, not rendered output. No neighbour reads `isBeaconed` during sprite creation. The beacon's own tile is sufficient. |
| **Reactor, Boiler, RailChainSignal, RailSignal, TrainStop, UnknownEntity, ErrorRendering** | inherited from base | These overrides are scaffold-only (super-call plus dead-code or TODOs). They contribute no extra affected cells. |

For logistic-grid-cell collections that *do* affect rendering (e.g. inserter `belt-loader` side-loading via `isMatchingUndergroundBeltEnding` driven by `setLogisticMove`), the producing factory writes through the populate step and the consuming factory reads during `createRenderers`. None of the active overrides in this codebase trigger that pathway — flagged as future work if it surfaces.

This places the neighbour-knowledge ("belts read their cardinals during `getBeltBend`") **inside FBSR factories**, where the populate logic already lives. The sidecar never re-derives it — it just consumes the returned `Set<MapPosition>` and looks up which entities currently occupy those cells. Eliminates the cross-repo duplication that motivated this whole spec.

`unpopulateWorldMap`'s existence is the first core FBSR change. The `Set<MapPosition>` return shape on both populate and unpopulate is the second; together they replace the sidecar-side `neighboursAt` machinery the previous revision proposed.

#### A.2 — Per-entity render entry point

`createRenderers(Consumer<MapRenderable> register, WorldMap map, MapEntity entity)` already exists and takes a register consumer per entity. The driver pattern below uses `register = capturedList::add` to capture one entity's emit list — no FBSR change needed for capture.

No new factory-lookup helper is needed: `MapEntity` already carries its `EntityRendererFactory` from parse time (stored on the field at [MapEntity.java:32](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/map/MapEntity.java#L32), exposed via `getFactory()`). The existing render-all-entities loop in `FBSR.renderBlueprint` resolves the factory once per entity in `parseBlueprint()` via `resolver.resolveFactoryEntityName(name)`, stores it on the `MapEntity`, and downstream phases just call `t.getFactory().populateWorldMap(...)` / `createRenderers(...)` etc.

The incremental driver does the same:

```java
// Once, when an entity first appears (parse-time):
EntityRendererFactory factory = resolver.resolveFactoryEntityName(entityName);
MapEntity entity = new MapEntity(bsEntity, factory, resolver);

// Per render call (no lookup):
List<MapRenderable> rendered = new ArrayList<>();
entity.getFactory().createRenderers(rendered::add, map, entity);
```

#### A.3 — MapSprite metadata exposure

The driver needs to translate captured `MapSprite`s into JSON. `MapSprite` already holds `def: SpriteDef`, `bounds: MapRect`, and (via `MapRenderable`) `layer: Layer`. Confirm getters exist for all three:

```java
public SpriteDef getDef();          // already exists
public Layer getLayer();            // already on MapRenderable
public MapRect getBounds();         // already exists
```

No new getters required. The driver reads `bounds.getX()` / `getY()` for the sprite's top-left in tile units.

**Sprite identity and PNG extraction live in the fork's `cli` package**, called from `TimelineCapture` (§A.4) not from individual CLIs. `SpriteDef`'s existing public surface — `getPath()`, `getSource()`, `isShadow()`, `getBlendMode()`, `getTint()`, `isTintAsOverlay()`, `getSourceBounds()`, `requestAtlas()`, `getAtlasRef()` — already exposes everything those helpers need; no change to `SpriteDef` itself.

#### A.4 — Data-prep surface: sprite identity + atlas augmentation

A.4 is the data-prep utility bundle for stable, dedup'd sprite storage. It is **not** the per-entity render loop — the loop (createRenderers → filter to MapSprite → hash → atlas.put → emit layer JSON) lives in `IncrementalMap.emitUpdates` (§B.4) and calls into A.4's utilities.

Surface:

- `SpriteIdentity.identityHash(SpriteDef)` → 40-char SHA-1 over the metadata tuple `(path, source.x, source.y, source.width, source.height, shadow, blendMode, tint, tintAsOverlay)`. Stable across JVM runs. **Already exists fork-side** at [SpriteIdentity.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/SpriteIdentity.java) (in `com.demod.fbsr`, alongside the other `*Utils` utilities).
- `SpriteIdentity.extractPng(SpriteDef)` → PNG-encoded bytes of the source rect, no tint applied. **Already exists.**
- `AtlasSink` interface (`has(sid)`, `put(sid, png, w, h)`) + file-backed implementation reading/writing `<atlas-path>` (`game-data/map-sprites.json`). **Done 2026-05-24** at [AtlasSink.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/AtlasSink.java) + [FileAtlasSink.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/FileAtlasSink.java).
- Driver-side wiring to open the atlas before the per-tick loop and write it back at the end. **Done 2026-05-24** — `ReplaySidecar` is now a 3-arg CLI (`<input.json> <output.json> <atlas-path>`) and passes the `AtlasSink` into `IncrementalMap.emitUpdates(affected, ts, atlas)` so new sids accumulate PNG bytes as runs are processed.

`applyRuntimeTint` is intentionally excluded from the identity tuple (see `SpriteIdentity`'s class comment). Recipe + filter overlays keep their `r:<recipe>` / `f:<item>` sid namespace for atlas-key compatibility with the existing MapView overlay code path.

**Consolidation.** `ReplayRender`, `ReplaySvgRender`, and `SpriteEnumerator` were deleted 2026-05-24. ReplaySidecar's single-frame mode (one record per entity at tick 0, no `tr`) covers their use cases; the sidecar fills the atlas naturally as runs are processed, with no run-independent pre-warm step.

---

### B — Java sidecar (`IncrementalMap` + `ReplaySidecar`)

Two new files:
- [IncrementalMap.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/IncrementalMap.java) in `com.demod.fbsr` (alongside `WorldMap`) — the event-driven counterpart to `WorldMap`; service class, not a CLI.
- [ReplaySidecar.java](../../Factorio-FBSR/FactorioBlueprintStringRenderer/src/com/demod/fbsr/cli/ReplaySidecar.java) in `com.demod.fbsr.cli` — the per-run CLI driver. Replaces the deleted `SpriteEnumerator`, `ReplaySvgRender`, and `ReplayRender`.

**`IncrementalMap`** (§B.3 + §B.4) owns the FBSR-side runtime: WorldMap, populate/unpopulate, position-to-entity index, per-entity `createRenderers`, MapSprite filter, sid emission via `SpriteIdentity`. Two standalone public capabilities — `updateMap(events)` (apply event batch to WorldMap state, return affected entities) and `emitUpdates(affected, ts)` (render affected entities to renderableTimeline items). Either can be called independently; both are reusable for single-frame renders, tests, or what-if previews.

**`ReplaySidecar`** (§B.5 + §B.6) is the CLI driver: reads input, parses records to events, sorts/batches by tick, wraps the two capabilities in the per-run loop, diffs per-`un`, writes output JSON. The driver uses a vanilla-only `ModdingResolver` (via `byProfileOrder`) — replay input carries no modding info, so the sidecar commits to vanilla up front. Modded sources need a separate CLI path with real blueprint info. The driver holds no FBSR types other than the `MapEntity` references it passes through.

#### B.1 — Inputs

```
java -cp <cp> com.demod.fbsr.cli.ReplaySidecar <run-input.json> <run-output.json>
```

The third arg is the atlas path (typically `game-data/map-sprites.json`). The sidecar opens it via `FileAtlasSink`, passes it into `IncrementalMap.emitUpdates`, and rewrites it on close — but only if any new sids were appended.

`<run-input.json>`: an array of **BSEntity-shape** records, each annotated with a build tick (`tb`) and optional remove tick (`tr`). Field names match `BSEntity`'s JSON keys exactly so each record feeds straight into `factory.parseEntity(record)` with no field-mapping shim:

```jsonc
{
  "runName": "DS-2_14_45",
  "durationTick": 482181,
  "entities": [
    {
      "entity_number": 526,
      "name": "transport-belt",
      "position": { "x": 100.5, "y": -26.5 },
      "direction": 4,
      "tb": 38145,
      "tr": 38148
    },
    {
      "entity_number": 526,
      "name": "transport-belt",
      "position": { "x": 100.5, "y": -26.5 },
      "direction": 6,
      "tb": 38148,
      "tr": 84608
    }
    // Underground belts carry `"type": "input" | "output"` (BSEntity native).
    // Splitters carry BSEntity's splitter config fields verbatim.
    // Inserters carry BSEntity's filter fields verbatim.
  ]
}
```

**Mutations are represented as new records, not as deltas.** A belt rotated 5 times appears as 5 records sharing `entity_number=526`, each with disjoint `[tb, tr)` intervals. Splitter config changes, inserter filter changes, belt-graph topology changes — all produce a new record with the updated state.

Rationale: the only vocabulary FBSR has for an entity is the `BSEntity` snapshot. Encoding mutations as deltas would require the sidecar to invent a mutation taxonomy (MUTATE_DIRECTION / MUTATE_BGT / MUTATE_BELT_GRAPH / MUTATE_SPLITTER_CONFIG / MUTATE_INSERTER_FILTERS) that FBSR doesn't share. Record-replacement keeps the sidecar's vocabulary identical to FBSR's: `BSEntity` in, `BSEntity`-rendered out. Component C (Node-side) owns the delta→record collapse.

Multiple records sharing an `entity_number` are grouped at the timeline-output step (§B.5), threading them into a single per-`un` `renderableTimeline` for the dashboard.

#### B.2 — Event stream construction

Inside the sidecar:

1. For each record:
   - **BUILD** event at `tb`, payload = the BSEntity record.
   - **REMOVE** event at `tr` (if present), payload = the same record.
2. Sort all events ascending by `tick`. Tie-break: REMOVE before BUILD (so a remove+build at the same tick re-establishes the cell with the new state), then by `entity_number` for determinism.
3. Iterate in tick order, grouping all events at the same tick into a batch.

Two event kinds. No MUTATE_*; record replacement covers every state change uniformly.

#### B.3 — Capability 1: `IncrementalMap.updateMap(events)`

Public capability on `IncrementalMap`. Apply a batch of events to internal WorldMap state and return the entities whose render may have changed:

```java
Set<MapEntity> updateMap(List<Event> events);
```

Per event in the batch:
- BUILD: `factory.populateWorldMap(map, entity)` (returns affected positions per §A.1b) + `factory.populateLogistics(map, entity)` + `positionToEntity.put(pos, entity)`.
- REMOVE: `factory.unpopulateWorldMap(map, entity)` (returns affected positions) + `positionToEntity.remove(pos)`.

Affected entities = `positionToEntity.get(p)` for `p` in the union of affected positions, dropping nulls. Entities removed in this batch are **not** in the affected set — their timelines simply end at their last appended snapshot (per §B.5: do NOT emit a final empty entry). The capability's caller decides what batch granularity to apply; the CLI driver groups by tick.

The capability never asks "what's at the cardinal of this position?" — the affected-position set comes from `(un)populateWorldMap`'s `Set<MapPosition>` return (§A.1b). All neighbour-detection logic lives FBSR-side.

`positionToEntity` is internal to `IncrementalMap` and maintained alongside the WorldMap. WorldMap stores `BeltCell` / `PipeCell` / etc. (rendering state per cell type); `positionToEntity` answers a different question — "which entity currently occupies this tile".

`unpopulateLogistics` is not yet defined fork-side; logistic-grid state may drift across remove+rebuild for beaconed machines. Not load-bearing for belt/pipe/most-machine renders.

#### B.4 — Capability 2: `IncrementalMap.emitUpdates(affected, ts)`

Public capability on `IncrementalMap`. Render each affected entity to a renderableTimeline item keyed by `entity_number`:

```java
Map<Integer, JSONObject> emitUpdates(Collection<MapEntity> affected, long ts);
// each value: { "ts": ts, "layers": [{ "L": int, "sid": String, "ox": double, "oy": double }, …] }
```

For each entity in `affected`:
1. `entity.getFactory().createRenderers(emitted::add, map, entity)` — per §A.2.
2. Filter `emitted` to `MapSprite` (other `MapRenderable` types are dropped).
3. Per sprite, emit one layer object:
   - `sid` = `SpriteIdentity.identityHash(sprite.getDef())`
   - `L`   = `sprite.getLayer().ordinal()`
   - `ox`, `oy` = `sprite.getBounds().getX/Y()` (tile units, top-left)

Sids are stable across JVM runs (identity is metadata-based, not PNG-byte-based). Atlas augmentation goes through the optional 3-arg overload `emitUpdates(affected, ts, atlas)`: new sids cause `atlas.put(sid, png, w, h)` with bytes from `SpriteIdentity.extractPng(def)` and the def's tile-unit `sourceBounds`, guarded by `atlas.has(sid)` so identity-based dedup happens before PNG extraction. The 2-arg form passes a null sink — useful for tests / what-if previews that don't want to mutate an atlas file.

`applyRuntimeTint` is intentionally excluded from the identity tuple. Two SpriteDefs differing only by runtime-tint flag share a sid and PNG bytes. If the dashboard ever needs runtime-tinted entities (player colour, etc.), surface the flag as a layer-record field and apply the tint client-side rather than splitting sids.

Recipe + filter overlays keep their `r:<recipe>` / `f:<item>` sid namespace (atlas-key compatibility with the existing MapView overlay code path).

#### B.5 — Driver loop: diff + per-`un` append

The CLI driver wraps the two capabilities:

```
for each tick batch in chronological order:
  affected = replayMap.updateMap(batch)
  updates  = replayMap.emitUpdates(affected, tick)
  for (un, item) in updates:
    if item.layers != prevLayers[un]:
      timelines[un].append(item)
      prevLayers[un] = item.layers
```

Equality: same number of layers, same `(L, sid, ox, oy)` quadruples in the same order (`JSONArray.similar`). Driver responsibilities: input parse, event construction, tick sort (REMOVE before BUILD at same tick, entity_number tiebreak), batching by tick, calling the two capabilities, diff/append per-`un`, output write. The capabilities are stateless w.r.t. timeline history.

This keeps timelines short for entities that go through transient states (e.g. a belt rotated several times in a row, but neighbours never changed → only the rotations whose rendered shape actually differs land in the timeline).

For removed entities: do NOT emit a final empty entry. The dashboard's existing `tr` filter handles visibility cutoff — the final timeline entry stands as the entity's "last seen" appearance.

#### B.6 — Output

`<run-output.json>` shape:

```jsonc
{
  "runName": "DS-2_14_45",
  "entities": [
    {
      "un": 9376,
      "renderableTimeline": [
        {
          "ts": 346923,
          "layers": [
            { "L": 28, "sid": "8a2f...", "ox": 194.92, "oy": -168.97 },
            { "L": 29, "sid": "1c4d...", "ox": 195.87, "oy": -168.97 }
          ]
        },
        {
          "ts": 350200,
          "layers": [ /* … bend changed to NONE, cap dropped */ ]
        }
      ]
    }
    // ...
  ]
}
```

Atlas-file write goes through `FileAtlasSink` (see §A.4): opened before the per-tick loop, passed through `IncrementalMap.emitUpdates`, rewritten on close — only if any new sids were appended. Existing entries (hex sids from prior sidecar runs + `r:`/`f:` overlay sids) are never rewritten; the file grows monotonically.

---

### C — Node refactor

#### C.1 — Deletions

Files removed in this spec:
- [dashboard/scripts/build-sprite-meta-from-existing.mjs](../../dashboard/scripts/build-sprite-meta-from-existing.mjs)
- [dashboard/scripts/lib/layout/belt-topology.mjs](../../dashboard/scripts/lib/layout/belt-topology.mjs)
- [game-data/map-sprite-meta.json](../../game-data/map-sprite-meta.json)
- The `beltShape` / `foldBeltGraph` block in [dashboard/scripts/lib/layout/merge-entities.mjs](../../dashboard/scripts/lib/layout/merge-entities.mjs) (`foldForMap`'s belt-shape computation) — replaced by FBSR's render output.

#### C.2 — map-prep.mjs owns the full pipeline

`fbsr-prep.mjs` is deleted. [map-prep.mjs](../../dashboard/scripts/map-prep.mjs) now owns every per-run step:

- Builds the lossless merged-entity stream via [lib/layout/merge-entities.mjs](../../dashboard/scripts/lib/layout/merge-entities.mjs) (`buildMergedEntities`).
- **Collapses mutation deltas into discrete BSEntity-shape records** — each render-relevant state change becomes a new record sharing `entity_number` with the prior one with disjoint `[tb, tr)` intervals (per §B.1). Field renames to BSEntity-native (`entity_number`, `position`, `type` for UB) so the sidecar hands records straight to `factory.parseEntity`. Render-relevant keys = direction / name / beltToGroundType / splitter config; belt-graph mutations are dropped (the sidecar reconstructs neighbour topology itself).
- Writes the synthesised `replay-input.json`, invokes `ReplaySidecar <input> <output> game-data/map-sprites.json` via `spawnSync`, reads `replay-output.json` back.
- Flattens the per-`un` `renderableTimeline` into the flat `entities[]` MapView wire shape — one entry per (entity × snapshot × layer), with `tr` = next snapshot's `ts` or the entity's own `timeRemoved`.
- Builds `recipeMachines` / `splitterMarkers` / `inserterMarkers` / `playerTrack` / `viewBox` (same overlay/playerTrack logic as the legacy pipeline).
- Joins overlays to entities via `en` (1-based merged-iteration index), the same convention the MapView consumes.

Recipe + filter overlay sids (`r:<recipe>` / `f:<item>`) live alongside hex sids in `game-data/map-sprites.json`; the sidecar doesn't touch them. New recipes / filters in future runs need a one-off icon enumeration (deferred; current committed runs are covered by the seeded set).

The orchestrator [build-run-data.mjs](../../dashboard/scripts/build-run-data.mjs) calls `buildMapData(runName, { phases, miners, merged })` once and merges the produced `<run>.map.json` with the chart-side per-run data:

```jsonc
{
  "runName": "...",
  "viewBox": [...],
  "durationTick": ...,
  "entities": [        // from sidecar; one row per un with renderableTimeline
    {
      "en": 9376,         // 1-based, assigned by build-run-data, used by overlays
      "un": 29027,
      "name": "transport-belt",
      "px": 195.5, "py": -168.5,
      "tb": 346923,
      "tr": 84660,
      "renderableTimeline": [
        { "ts": 346923, "layers": [{L,sid,ox,oy}, ...] }
      ]
    }
  ],
  "recipeMachines":   [...],   // from map-prep, joined to entities by `en`
  "splitterMarkers":  [...],
  "inserterMarkers":  [...],
  "playerTrack":      {...},
  "phases":           [...]
}
```

#### C.4 — MapView reads the timeline

[dashboard/src/components/MapView.tsx](../../dashboard/src/components/MapView.tsx) currently iterates `entities[]` and renders one fixed `(ox, oy, L, sid)` row per entity, gated on `tb ≤ tick ≤ tr`. The change:

```ts
function activeLayers(entity: Entity, tick: number): Layer[] {
  // Find the largest ts ≤ tick in entity.renderableTimeline.
  // Binary search on the timeline (sorted by ts).
  const tl = entity.renderableTimeline;
  let lo = 0, hi = tl.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl[mid].ts <= tick) { ans = mid; lo = mid + 1; }
    else                     { hi = mid - 1; }
  }
  return tl[ans].layers;
}
```

Visibility gate (`tb ≤ tick ≤ tr ?? Infinity`) unchanged. Total per-frame cost: existing entity-iteration loop + one O(log T) lookup per entity, where T is the entity's timeline length (1 for non-belts; small constant for belts).

#### C.5 — Type surface

The `Run` type is `typeof r0` from [dashboard/src/data/index.ts](../../dashboard/src/data/index.ts). Once the schema changes, the type changes for every consumer. Old-shape `<run>.map.json` files fail TypeScript at build — that's the cutover guard.

---

## Sprite atlas

`game-data/map-sprites.json` keeps its current shape:

```jsonc
{ "<sid>": { "data": "<base64-png>", "w": <tile-width>, "h": <tile-height> } }
```

with two changes:
- sids are now 40-character hex hashes (was `s0`, `s1`, …). Recipe and filter sids stay name-prefixed (`r:<recipe>`, `f:<item>`).
- The atlas grows monotonically across all runs the sidecar processes. Existing entries are never rewritten; only appended.

Loaded once by the dashboard at app start (lazy on first map open), as today.

---

## Sequencing

Three landings, in order:

### Landing 1 — Component A (Factorio-FBSR fork)

Branch: `replay-analyzer` on `ameateye/Factorio-FBSR`.

1. Add `removeBelt(pos)` + parallel `remove*` for every cell collection in `WorldMap`. **(§A.1a — shipped 2026-05-18 commit `51646eb`.)**
2. Promote `populateWorldMap` / `unpopulateWorldMap` to return `Set<MapPosition>` of affected cells. Default impl on `EntityRendererFactory` returns `Set.of(entity.getPosition())`. Override belts/pipes per the §A.1b table. **(Staged 2026-05-20.)**
3. Add `unpopulateWorldMap` overrides on each entity factory in LAYOUT_SCOPE + auxiliary categories. **(Done.)**
4. `SpriteIdentity.identityHash(def)` + `SpriteIdentity.extractPng(def)` utilities in the cli package. **(Already exists.)**
5. `AtlasSink` interface + file-backed implementation reading/writing `<atlas-path>`. (§A.4) **Done 2026-05-24.**
6. `mvn -DskipTests package` — rebuild jar.

Tests:
- WorldMap: `setBelt → getBelt → removeBelt → getBelt` returns empty.
- `populateWorldMap` for a belt returns the §A.1b set; for a machine returns `Set.of(machine.position)`.
- `SpriteIdentity.identityHash` determinism: load vanilla in two JVM boots, hash the same SpriteDef in both, assert the 40-char strings match.
- `AtlasSink` round-trip: put + has + reload from file → has still returns true; existing entries unchanged.

### Landing 2 — Component B (Java sidecar)

Branch: `replay-analyzer` (same fork).

1. Implement `IncrementalMap.java` per §B.3 + §B.4 — two public capabilities (`updateMap` + `emitUpdates`), owning the WorldMap + position index + per-entity render via `SpriteIdentity`. **(Done 2026-05-21.)**
2. Implement `ReplaySidecar.java` per §B.5 + §B.6 — CLI driver: parse input, build events, sort, batch by tick, call the two capabilities, diff per-`un`, write output. **(Done 2026-05-21.)**
3. Wire `IncrementalMap.emitUpdates` to the `AtlasSink`; grow the CLI back to 3 args with `<atlas-path>`. **Done 2026-05-24** (3-arg overload + `FileAtlasSink` opened in `ReplaySidecar`).
4. ~~Extract `SpriteEnumerator`'s vanilla loading + classpath discovery into a shared helper~~ — not needed; `ReplaySidecar` loads the vanilla profile directly via `Profile.vanilla()` + `FBSR.load(...)`. **Skipped.**
5. `mvn -DskipTests package`.

Tests:
- Smoke run on `extracted-data/DS-2_14_45/` → produces `<run-output.json>` with non-empty timelines.
- Spot-check 5 belts: one straight middle, one corner (FROM_LEFT bend), one starting cap, one ending cap, one isolated. Compare predicted layer count + sids against expectation derived from the trace in this spec.
- Spot-check the build-then-rebuild case: `un=526` and `un=3105` at `(100.5, -26.5)` should both have non-trivial timelines reflecting their disjoint lifetimes — `un=526`'s renderables computed from its lifetime topology, not from `un=3105`.
- Mutation-as-record: a belt with 3 rotations (3 input records sharing `entity_number`, disjoint `[tb, tr)`) produces a per-un timeline with ≤3 entries (B.5 diff may collapse identical bends across rotations).

### Landing 3 — Component C (Node refactor + fork-side deletes) **Done 2026-05-24**

Landed as parallel-build-then-cutover: a parallel `fbsr-prep-v2.mjs` + `map-prep-v2.mjs` flow with `?v=v2` URL toggle and side-by-side files, used to pin a sprite-bounds bug (v2 was using `sourceBounds` where it should have used `getBounds()` — fixed in `IncrementalMap.emitUpdates`). Once parity was visually confirmed on DS-2_14_45, the cutover consolidated everything:

1. **Node side**: deleted legacy `fbsr-prep.mjs`, `build-sprite-meta-from-existing.mjs`, parallel `fbsr-prep-v2.mjs`, `map-prep-v2.mjs`, and `_diagnostics/smoke-v1-vs-v2.mjs`. New consolidated [map-prep.mjs](../../dashboard/scripts/map-prep.mjs) owns the full pipeline (BSEntity synthesis + sidecar invocation + overlays + viewBox). `build-run-data.mjs` dropped the `ensureSpriteCoverage` step.
2. **Dashboard**: `?v=v2` toggle removed from `RunMapPlayer.tsx`; `maps.ts` glob narrowed back to `*.map.json`. MapView wire shape unchanged.
3. **Atlas swap**: `game-data/map-sprites.json` replaced with the v2 atlas (hex sids + r:/f: overlay sids). Legacy `s<N>` entries deleted. `map-sprite-meta.json` deleted.
4. **Fork-side deletes**: `SpriteEnumerator.java`, `ReplayRender.java`, `ReplaySvgRender.java`. JAR repackaged via `mvn -DskipTests package`.
5. **Regenerated** every committed `<run>.map.json` (DS-2_14_45 + DS-2_16_04) through the new pipeline.

Commit boundary: submodule PR (Factorio-FBSR) lands the Java cleanup + new files; main repo PR lands the consolidated map-prep + regenerated map data + submodule pointer bump.

---

## Migration

Hard cutover at Landing 3v2 (3v1 is purely additive — both pipelines coexist). Once 3v2 lands:
- `<run>.map.json` files have the new schema. The `Run` TypeScript type reflects the new shape; every consumer sees the change.
- No backwards-compat shim. Re-running `npm run data <run>` is required for any pre-cutover map data.
- CI catches stale runs at the `npm run build` step (TypeScript fail on old `entities[]` rows).

A dashboard pinned to a pre-cutover commit will keep working against pre-cutover map.json. Cross-version mixing is unsupported.

---

## Testing strategy

Per-landing tests in §Sequencing. Cross-cutting:

**Visual regression suite.** Existing Playwright tests at [dashboard/tests/](../../dashboard/tests/) snapshot the rendered map at a few well-known ticks per run. After Landing 3, refresh snapshots once a human eyeballs DS-2_14_45 and DS-2_16_04 in the dashboard and confirms:
- Belt corners render as corners (DS-2_14_45 baseline: 693 corner pieces in the FBSR-era bake; we expect more with the race-bug fixed).
- Build-then-rebuild positions show the right entity at the right tick.
- Recipe / splitter / inserter overlays still appear.

**Atlas growth check.** `game-data/map-sprites.json` should not lose entries between runs. CI assertion: regenerating an existing run never removes a sid from the atlas (only adds).

**Timeline determinism.** Re-running the sidecar on the same input must produce byte-identical `<run-output.json>` (modulo ts/tick ordering already handled by sort tiebreaker).

---

## Open / deferred

- **Long-running JVM (daemon mode).** Per-run CLI invocation incurs ~5 s Java boot per run. Acceptable for current cadence (3 committed runs → 15 s total). Daemon mode (stdin/socket framing, long-running JVM, optional incremental partial-rebuild) becomes attractive when either: batch rebuilding >20 runs after a fork-side change (>100 s of stalled JVM boots), OR an interactive use case emerges (dashboard editor, what-if queries). Neither is active today; the batch CLI in §B is the chosen form.
- **Modded entity / unknown-sprite fallback.** If `EntityRendererFactory.forEntity(entity)` throws (entity name not in vanilla), current SpriteEnumerator skips. Sidecar should follow the same pattern: log + skip; entity gets no `renderableTimeline`; map-prep emits a warning.
- **Other topology-dependent entity types** (pipes, walls, rails). Same architecture extends — `unpopulateWorldMap` already factored at the abstract level. Spec separately when those become in-scope; today only belts have neighbour reactivity within LAYOUT_SCOPE.
- **Atlas pruning.** The atlas grows monotonically. A periodic prune (which sids no run currently references?) could reclaim space. Not urgent.
- **Sidecar progress reporting.** A run with ~20 k entities × ~1 mutation each ≈ ~20 k events. Should print progress every N events for long runs. Cosmetic, not required.

---

## Decisions confirmed

- The pipeline is generic across entity types. "Topology mattering only for belts" is an internal detail of FBSR's per-entity rendering logic, not a fork in our pipeline.
- Hard cutover; no v1+v2 dual-mode.
- Sprite atlas: global, lazy-loaded by dashboard. Per-run output is purely the entity → sprite-ID + position mapping with timestamps.
- Sidecar form: per-run CLI invocation. Long-running JVM deferred.
- Java code lives in `Factorio-FBSR/` next to (and eventually replacing) `SpriteEnumerator`.
- `renderableTimeline` is unified — every entity carries a timeline; non-belts have length 1.
- **Input is BSEntity-shape; mutations are new records.** No invented mutation taxonomy. Every state change is a fresh BSEntity record sharing `entity_number` with the prior one, disjoint `[tb, tr)` intervals. Sidecar drives only BUILD + REMOVE.
- **Neighbour-knowledge lives in FBSR factories, not the sidecar.** `populateWorldMap` / `unpopulateWorldMap` return `Set<MapPosition>` of affected cells. The sidecar consumes the set; it never re-derives neighbour rules.
- **Render + capture lives in `TimelineCapture` (FBSR-side, §A.4).** All replay CLIs — current `ReplayRender`, `ReplaySvgRender`, `SpriteEnumerator` — become trivial wrappers and delete in Landing 3. `ReplaySidecar` is the single per-run driver.
- **Sprite identity is metadata-based, not PNG-byte-based.** SHA-1 of `(path, source rect, shadow, blendMode, tint, tintAsOverlay)` — computable without rendering, so dedup happens before PNG extraction.
