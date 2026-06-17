# Map mode performance — applied fixes and deferred work

**Date:** 2026-06-18
**Scope:** Why map mode (the `MapView` SVG renderer) was slow, what has been fixed, and the larger improvements left for later — with the evidence behind each.

Map mode renders one run's entire base as a single SVG: on `DS-2_01_47`, ~45K entity `<use>` nodes plus marker/overlay layers, all mounted at once. The recurring failure mode is that **per-interaction or per-tick work re-touches that whole tree**. The fixes below all share one principle — keep the big tree static and drive change imperatively or skip it when hidden.

References are by file + symbol (not line number) so they survive edits to `MapView.tsx`.

## Already fixed

These are in `dashboard/src/components/MapView.tsx` unless noted; described here so a future reader knows the baseline before extending it.

- **Pan/zoom is imperative.** `viewBox` is written straight to the SVG attribute (a layout effect for committed values, an rAF-coalesced handler for live gestures) instead of through React state, so a wheel/drag frame no longer re-renders the ~45K-node child tree. React state (`vb`) holds only the committed baseline (initial / reset / focus / gesture-end).
- **Hover tooltip is isolated.** The tooltip lives in a small `MapTooltip` leaf driven through an imperative handle, so moving the cursor re-renders that leaf, not `MapView`.
- **Cluster hover is CSS-driven.** The hovered cluster `<g>` gets an `is-hot` class toggled imperatively; CSS (`MapView.css`, `#run-map-clusters g.is-hot rect`) overrides the rects' opacity/stroke, so `hoveredClusterId` no longer sits in the `clusterNodes` memo deps.
- **Hidden overlays build nothing.** `flowSegmentNodes` and `clusterNodes` are gated on their visibility toggles (`showFlow` / `showClusters`). Both layers default off, so without the gate playback rebuilt their full node arrays every frame for layers the user couldn't see.

## Deferred improvements

In rough priority order (impact vs. effort). Each is independent.

### 1. Make enabled flow/cluster overlays imperative or throttled

**Problem.** When a user *enables* the flow or cluster layer, the overlay still rebuilds its whole node array every playback frame. `flowSegmentNodes` and `clusterNodes` include `tick` in their deps, and during playback `tick` advances ~every frame. `flowSegmentNodes` re-runs the per-segment geometry (`buildFlowPaths` / `buildLaneGeom` / `flowLaneDFromPaths`, in `dashboard/src/lib/mapModel.ts`) across all segments per frame; `clusterNodes` rebuilds all visible cluster rects per frame. On `DS-2_01_47` the review measured ~1,405 flow segments and ~5,543 clusters / ~6,267 rects, so this is the single worst hot loop once a layer is on.

**Proposal.** Mirror the entity layer's pattern: the entities use a build/remove **cursor walk** (geometry rendered once, per-tick visibility toggled imperatively against tick cursors — see the cursor refs and toggling effects in `MapView.tsx`). Render overlay geometry once and toggle per-tick visibility/href imperatively, or — cheaper to implement — throttle the overlay recompute to whole-second tick boundaries instead of the 60 fps playback cadence.

**Notes.** Latent today because both layers default off (and the "hidden builds nothing" gate above covers the off case). Medium/high effort for the full cursor-walk; low effort for the throttle.

### 2. Don't load the 8.6 MB run JSON in map mode

**Problem.** `dashboard/src/components/RunMapPlayer.tsx` calls `loadRun()` purely to pull `flow.beltSegments` and `flow.clusters` out of the per-run analytics JSON. That JSON is **8.6 MB** on `DS-2_01_47` (verified: `built-data/DS-2_01_47.json`), the bulk of which (production cube, stocks, labs, …) the map never uses. In the standalone map app (`MapApp`) it is pure download + parse overhead; the dashboard shares the `loadRun` cache so the cost is amortized there.

**Proposal.** Emit flow segments + clusters into the `.map.json` (or a small `.flow.json` sidecar) at build time, so map mode loads only map data. This also lets the overlays exist without a dashboard build.

**Dependencies.** Build-pipeline change in `dashboard/scripts/map-prep.mjs` / `build-run-data.mjs`, plus regenerating `built-data/*.map.json`. Mind the fork-friction constraint (a forker must be able to rebuild without external accounts). See [architecture/per_run_data.md](../architecture/per_run_data.md) (map payload) and [architecture/flow_feature.md](../architecture/flow_feature.md).

### 3. Ship the sprite atlas as a real sprite-sheet, not 257 inlined base64 PNGs

**Problem.** `game-data/map-sprites.json` is **10.4 MB** (verified). The `symbols` memo emits one `<symbol><image href="data:image/png;base64,…">` per atlas entry, so the browser parses a 10.4 MB JSON and then decodes 257 base64 PNGs into the DOM on mount — the dominant *load-time* cost of map mode. It is fetched eagerly alongside `map.json`.

**Proposal.** Emit one sprite-sheet PNG plus a coords JSON and `<use>` into sub-rects (via `viewBox`/clip), referencing the image once. Failing that, serve the JSON gzip/Brotli-compressed and lazy-decode rarely-used sprites.

**Dependencies.** The atlas is produced by the FBSR sidecar in the map pipeline; this is a generator change. Cross-reference the atlas's design history in [specs/fbsr_elimination.md](../specs/fbsr_elimination.md) and [specs/fbsr_event_driven_pipeline.md](../specs/fbsr_event_driven_pipeline.md).

### 4. (Lower) Per-frame marker back-scans

**Problem.** The recipe / splitter / inserter / roboport effects in `MapView.tsx` loop over all markers every tick and back-scan each marker's timestamp array to find the active event, even when the active index hasn't changed; the early-out skips the DOM write but not the scan. Counts are modest (≤ ~1,170 recipe machines on `DS-2_01_47`), so impact is bounded.

**Proposal.** Keep a per-marker cursor like the entity walk, advancing only on delta. Revisit only if marker counts grow materially.

## Reference measurements (DS-2_01_47)

| Quantity | Value | Source |
|---|---|---|
| Entity `<use>` nodes mounted at once | ~45,373 | map-mode performance review |
| Total static SVG nodes (entities + markers) | ~47,400 | review |
| `built-data/DS-2_01_47.map.json` | 7.6 MB | verified (`ls`) |
| `built-data/DS-2_01_47.json` (run JSON) | 8.6 MB | verified (`ls`) |
| `game-data/map-sprites.json` (atlas, 257 sprites) | 10.4 MB | verified (`ls`) |
| Flow segments | ~1,405 | review |
| Clusters / rects | ~5,543 / ~6,267 | review |
| Recipe machines | ~1,170 | review |
| Player-track points | ~7,234 | review |
