// Pure data types, constants, and lookups for the FBSR map renderer.
// Shared between <MapView> (dashboard live player) and any overlay
// component or external app (e.g. analytical-hub) that consumes the
// same per-run map.json + map-sprites.json files.
//
// No React, no DOM, no fs — keep this importable from Node and from
// any Vite app.

// ─── Data shapes ──────────────────────────────────────────────────────
// These mirror the JSON shape produced by dashboard/scripts/map-prep.mjs
// and dashboard/scripts/fbsr-prep.mjs. Adding a field here is a
// data-contract change — update map-prep accordingly.

export type SpriteDef = { w: number; h: number; data: string };
export type SpriteAtlas = Record<string, SpriteDef>;

export type RecipeEvent = { ts: number; n: string };

// One renderable per (entity, FBSR Layer). `en` may repeat across entries
// (e.g. an inserter has base + arm + indicators + shadow); they share
// tb/tr because they were built/removed together.
export type Renderable = {
  en: number;
  name: string;
  px: number;
  py: number;
  ox: number;
  oy: number;
  sid: string;
  L: number;           // FBSR Layer ordinal
  tb: number;          // build tick
  tr?: number;         // remove tick (optional — only categories with mortality)
};

export type RecipeMachine = {
  en: number;
  name: string;
  px: number;
  py: number;
  tr?: number;         // remove tick — hides the recipe icon once the machine is mined
  rs: RecipeEvent[];
};

// Splitter alt-mode state at a tick. ip/op are 'left' | 'right' | 'none';
// f is an item name or '' (no filter). FBSR convention: priority arrows
// only render when ip/op !== 'none'; output filter icon replaces the
// output arrow when present (only meaningful when op !== 'none').
export type SplitterEvent = {
  ts: number;
  ip: 'left' | 'right' | 'none';
  op: 'left' | 'right' | 'none';
  f: string;
};

export type SplitterMarker = {
  en: number;
  name: string;
  px: number;        // entity center x (between the two halves)
  py: number;        // entity center y
  dir: number;       // folded end-of-run direction (0..7, 0=N, 2=E, 4=S, 6=W)
  tr?: number;       // remove tick — hides the overlay once the splitter is mined
  ts: SplitterEvent[];
};

// Inserter filter state at a tick. u = useFilters; m = 'whitelist' | 'blacklist'
// (undefined when u=false); f = filter item names (1..N).
export type InserterEvent = {
  ts: number;
  u: boolean;
  m?: 'whitelist' | 'blacklist';
  f: string[];
};

export type InserterMarker = {
  en: number;
  name: string;
  px: number;
  py: number;
  dir: number;
  tr?: number;       // remove tick — hides the overlay once the inserter is mined
  ts: InserterEvent[];
};

export type PlayerTrack = {
  name: string;
  period: number;      // ticks between samples
  positions: [number, number][];
};

// One phase boundary on the map's timeline. Matches the (subset of) shape
// emitted by dashboard/scripts/phase-boundaries.mjs that the player needs —
// `name`, `startTick`, `endTick` are sufficient for snapping a scrubber to
// boundaries; `startMin` / `endMin` are derivable. Only present when the
// chart-side build invoked map-prep inline (build-run-data.mjs); standalone
// CLI invocations of map-prep omit `phases`.
export type MapPhase = {
  name: string;
  startTick: number | null;
  endTick: number | null;
};

export type MapData = {
  runName: string;
  viewBox: [number, number, number, number];
  durationTick: number;
  entities: Renderable[];
  recipeMachines: RecipeMachine[];
  splitterMarkers?: SplitterMarker[];
  inserterMarkers?: InserterMarker[];
  playerTrack: PlayerTrack | null;
  phases?: MapPhase[];
};

// ─── Recipe-icon geometry ─────────────────────────────────────────────
// FBSR's atlas sprite is 1.6 tiles (1.4 icon + 0.1 border each side, with
// a rounded translucent-black background). We display SMALLER than FBSR
// here — the atlas sprite scales down via SVG. FBSR's full 1.6 tiles
// dominates the entity face on a 2x2 furnace; 1.0 tiles reads cleaner
// at the dashboard's viewport densities while still being legible.
//
// Y offset keeps the icon center above-center of the entity (same
// direction FBSR uses, just less aggressive since the icon is smaller).

export const RECIPE_ICON_TILES = 1.0;
export const RECIPE_ICON_Y_OFFSET = -0.2;

// ─── Time helpers ─────────────────────────────────────────────────────

export const TICKS_PER_MIN = 60 * 60;
export function ticksToMin(ticks: number): number { return ticks / TICKS_PER_MIN; }

// ─── Sprite-id helpers ────────────────────────────────────────────────
// Recipe-icon sprite IDs are namespaced with an "r:" prefix in
// map-sprites.json. Keep this here so overlays / consumers don't
// reinvent the convention.

export function recipeSpriteId(recipeName: string): string {
  return `r:${recipeName}`;
}

// Splitter / inserter filter icons share the same `f:<itemName>` namespace
// in map-sprites.json (one sprite per item, regardless of who uses it).
export function filterIconSpriteId(itemName: string): string {
  return `f:${itemName}`;
}

// ─── Pure predicates ──────────────────────────────────────────────────

// True iff the entity exists at `tick`.
//
// RunMapPlayer doesn't call this on the hot path — it walks pre-sorted
// byTb/byTr cursors for O(delta) updates. This function is the
// equivalent reference implementation: snapshot consumers (overlays,
// static renderers, tests) can call it directly. Cursor-walk parity
// against this function is the drift sentinel.
export function isAlive(entity: Renderable, tick: number): boolean {
  if (entity.tb > tick) return false;
  if (entity.tr !== undefined && entity.tr <= tick) return false;
  return true;
}

// Find the active recipe at `tick` for a recipe machine. Returns the
// recipe NAME or null if no recipe is active or the machine has been
// removed by `tick`. Recipe lists are tiny (median 1, max ~handful),
// so a back-scan is fine.
export function recipeAt(machine: RecipeMachine, tick: number): string | null {
  if (machine.tr !== undefined && machine.tr <= tick) return null;
  const rs = machine.rs;
  for (let j = rs.length - 1; j >= 0; j--) {
    if (rs[j].ts <= tick) return rs[j].n;
  }
  return null;
}

// Walk a splitter's state timeline backward to find the active state at
// tick. Returns null if the splitter doesn't yet exist (before its
// timeBuilt). State events are tiny (1..handful) so a back-scan suffices.
export function splitterStateAt(marker: SplitterMarker, tick: number): SplitterEvent | null {
  if (marker.tr !== undefined && marker.tr <= tick) return null;
  const ts = marker.ts;
  for (let j = ts.length - 1; j >= 0; j--) {
    if (ts[j].ts <= tick) return ts[j];
  }
  return null;
}

export function inserterStateAt(marker: InserterMarker, tick: number): InserterEvent | null {
  if (marker.tr !== undefined && marker.tr <= tick) return null;
  const ts = marker.ts;
  for (let j = ts.length - 1; j >= 0; j--) {
    if (ts[j].ts <= tick) return ts[j];
  }
  return null;
}

// FBSR-parity geometry for splitter priority arrows. The triangle path
// is identical for input and output arrows (MapLaneArrow ≡ MapBeltArrow
// in the Java source); only the position differs.
//
// markerShape from MapLaneArrow.java, in tile units, before rotation:
//   (-0.3, 0.375) → (0.3, 0.375) → (0, 0.125), filled
//
// Rotation: Java applies dir.back().ordinal() * π/4 + π using FBSR's
// 8-way Direction enum. Our raw direction comes from Factorio 2.0's
// 16-way encoding (0=N, 4=E, 8=S, 12=W). We divide by 2 to match FBSR
// ordering before applying the same formula.
export const SPLITTER_ARROW_PATH = 'M-0.3 0.375 L0.3 0.375 L0 0.125 Z';
export const SPLITTER_ARROW_SHADOW_OFFSET = 0.07;

// Map a Factorio 16-way direction (0=N, 4=E, 8=S, 12=W) to the
// degrees of rotation that orient the triangle so its apex points in
// the entity's facing direction. Equivalent to FBSR's
// dir.back().ordinal()*45 + 180 after collapsing 16→8.
export function splitterArrowRotationDeg(dir: number): number {
  const d8 = Math.round(dir / 2) % 8;
  return (((d8 + 4) % 8) * 45 + 180) % 360;
}

// World-space forward + right unit vectors for a 16-way direction.
// 0=N → forward (0,-1); 4=E → forward (1,0); etc. Right = forward
// rotated 90° clockwise.
function dirVecs(dir: number): { fx: number; fy: number; rx: number; ry: number } {
  const ang = (dir * Math.PI) / 8;
  const fx = Math.sin(ang), fy = -Math.cos(ang);
  return { fx, fy, rx: -fy, ry: fx };
}

// Splitter priority lane offsets relative to entity center, in entity-
// local frame BEFORE rotating to world. left and right are the two belt
// lane centers, ±0.5 perpendicular to the entity's facing direction.
// Output-side arrow is shifted 0.6 forward from the lane center.
export function splitterArrowPos(
  px: number, py: number, dir: number,
  side: 'left' | 'right',
  kind: 'in' | 'out',
): { x: number; y: number } {
  const { fx, fy, rx, ry } = dirVecs(dir);
  const lat = side === 'right' ? 0.5 : -0.5;
  const fwd = kind === 'out' ? 0.6 : 0;
  return { x: px + rx * lat + fx * fwd, y: py + ry * lat + fy * fwd };
}

// Filter-icon position on a splitter: same lateral offset as the
// priority side, no forward offset (sits at the lane center). Mirrors
// SplitterRendering.java line 81 (iconPos = right ? rightPos : leftPos).
export function splitterFilterPos(
  px: number, py: number, dir: number, side: 'left' | 'right',
): { x: number; y: number } {
  const { rx, ry } = dirVecs(dir);
  const lat = side === 'right' ? 0.5 : -0.5;
  return { x: px + rx * lat, y: py + ry * lat };
}

// Player position at arbitrary tick — linear interpolation between
// samples. Returns null if the track is empty.
export function playerAt(track: PlayerTrack, tick: number): [number, number] | null {
  if (!track.positions.length) return null;
  const period = track.period;
  const idx = tick / period;
  const i = Math.floor(idx);
  if (i < 0) return track.positions[0];
  if (i >= track.positions.length - 1) return track.positions[track.positions.length - 1];
  const f = idx - i;
  const [x0, y0] = track.positions[i];
  const [x1, y1] = track.positions[i + 1];
  return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
}
