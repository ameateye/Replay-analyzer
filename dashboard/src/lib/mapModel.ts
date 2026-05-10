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
  rs: RecipeEvent[];
};

export type PlayerTrack = {
  name: string;
  period: number;      // ticks between samples
  positions: [number, number][];
};

export type MapData = {
  runName: string;
  viewBox: [number, number, number, number];
  durationTick: number;
  entities: Renderable[];
  recipeMachines: RecipeMachine[];
  playerTrack: PlayerTrack | null;
};

// ─── Recipe-icon geometry ─────────────────────────────────────────────
// FBSR-parity: Java emits a 1.6-tile sprite (1.4 icon + 0.1 border on
// each side, with a rounded translucent-black background); positioned
// so its center sits 0.3 tiles above the entity center — same offset
// CraftingMachineRendering / FurnaceRendering use internally.

export const RECIPE_ICON_TILES = 1.6;
export const RECIPE_ICON_Y_OFFSET = -0.3;

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
// recipe NAME or null if no recipe is active. Recipe lists are tiny
// (median 1, max ~handful), so a back-scan is fine.
export function recipeAt(machine: RecipeMachine, tick: number): string | null {
  const rs = machine.rs;
  for (let j = rs.length - 1; j >= 0; j--) {
    if (rs[j].ts <= tick) return rs[j].n;
  }
  return null;
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
