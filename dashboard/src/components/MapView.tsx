import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtTime } from '../theme';
import {
  RECIPE_ICON_TILES,
  RECIPE_ICON_Y_OFFSET,
  SPLITTER_ARROW_PATH,
  SPLITTER_ARROW_SHADOW_OFFSET,
  ticksToMin,
  recipeSpriteId,
  filterIconSpriteId,
  splitterArrowPos,
  splitterArrowRotationDeg,
  splitterFilterPos,
  splitterStateAt,
  inserterStateAt,
  playerAt,
  type MapData,
  type SpriteAtlas,
} from '../lib/mapModel';
import './MapView.css';

// Flow segment overlay: a layer that draws each belt segment (from the
// flow model) as a continuous polyline through tile centers, with
// directional arrows along the path. When the flow prep emits per-lane
// `contents` (one entry per left/right belt side) the segment is
// rendered as TWO parallel lane lines, each coloured by its lane's
// item; otherwise a single centred line. Toggled via the layers bar.
// One presence interval for a single item on a single lane. tb/tr are
// game ticks (60 ticks/sec). tr omitted ↔ still present at run end —
// aligns with the tb/tr convention used by segments, edges, machines.
export type FlowLaneInterval = { item: string; tb: number; tr?: number };

// Per-tile occupancy with timing. Same (x,y) may legally appear twice
// with adjacent [tb, tr) windows when a quick-replace swaps the
// occupying unit (see per_run_data.md). Half-open intervals: alive at
// tick T ↔ `tb <= T && (tr === undefined || tr > T)`.
export type FlowTileLocation = {
  x: number;
  y: number;
  direction?: number;
  tb: number;
  tr?: number;
};

export type FlowSegmentLite = {
  id: string;
  tb: number;
  tr?: number;
  tileLocations?: FlowTileLocation[];
  contents?: {
    left?:  { items?: FlowLaneInterval[] };
    right?: { items?: FlowLaneInterval[] };
  };
};

// One spatially-connected sub-block of a cluster, with its own lifetime so the
// layer scrubs. A cluster's members can be disjoint (functional contiguity
// merges blocks bridged by a shared belt); each piece is drawn separately.
export type FlowClusterRect = { minX: number; minY: number; maxX: number; maxY: number; tb: number; tr?: number };

export type FlowClusterLite = {
  id: string;
  kind: 'machine' | 'furnace' | 'miner' | 'buffer';
  tb: number;
  tr?: number;
  recipe?: string | null;
  storedItem?: string | null;
  members?: { unit: number }[];
  rects: FlowClusterRect[];
};

const FLOW_DIR_VEC: Record<number, [number, number]> = {
  0:  [0, -1],   // N
  4:  [1,  0],   // E
  8:  [0,  1],   // S
  12: [-1, 0],   // W
};

// Continuous polyline geometry for one segment. Returns one path per
// connected directional chain in the segment; UG-pair jumps & splitter
// twin-tiles naturally fall into separate paths because their tiles are
// not geometrically adjacent in the flow direction.
type FlowPath = { pts: { x: number; y: number }[]; dirs: [number, number][] };
function buildFlowPaths(tiles: { x: number; y: number; direction?: number }[] | undefined): FlowPath[] {
  if (!tiles || tiles.length === 0) return [];
  const keyOf = (t: { x: number; y: number }) => `${t.x},${t.y}`;
  const byKey = new Map<string, { x: number; y: number; direction?: number }>();
  for (const t of tiles) byKey.set(keyOf(t), t);
  const forward = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const t of tiles) {
    const d = t.direction;
    if (d == null) continue;
    const dv = FLOW_DIR_VEC[d];
    if (!dv) continue;
    const nk = keyOf({ x: t.x + dv[0], y: t.y + dv[1] });
    if (byKey.has(nk)) {
      forward.set(keyOf(t), nk);
      hasIncoming.add(nk);
    }
  }
  const visited = new Set<string>();
  const paths: FlowPath[] = [];
  const walk = (startKey: string) => {
    const pts: { x: number; y: number }[] = [];
    const dirs: [number, number][] = [];
    let cur: string | undefined = startKey;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const t = byKey.get(cur);
      if (!t) break;
      pts.push({ x: t.x + 0.5, y: t.y + 0.5 });
      const dv = t.direction != null ? FLOW_DIR_VEC[t.direction] ?? [0, 0] : [0, 0];
      dirs.push([dv[0], dv[1]]);
      cur = forward.get(cur);
    }
    return { pts, dirs };
  };
  // Heads (no incoming): regular chains.
  for (const t of tiles) {
    const k = keyOf(t);
    if (visited.has(k)) continue;
    if (hasIncoming.has(k)) continue;
    const p = walk(k);
    if (p.pts.length > 0) paths.push(p);
  }
  // Cycles / isolated tiles.
  for (const t of tiles) {
    const k = keyOf(t);
    if (visited.has(k)) continue;
    const p = walk(k);
    if (p.pts.length > 0) paths.push(p);
  }
  return paths;
}

// Direction marks along each chain. Sample every FLOW_ARROW_EVERY tiles
// plus a guaranteed mid-tile so short segments still get one. Each
// mark is drawn as an OPEN "<" shape (two strokes meeting at the tip) —
// open so SVG doesn't auto-fill the triangle. That lets us merge every
// mark into the same single <path> as the polyline (one stroke pass).
const FLOW_ARROW_EVERY = 5;
const FLOW_ICON_EVERY = 6;       // tiles between item icons / labels along a lane

// Lane offsets (perpendicular to flow direction) and stroke geometry.
// 0 = centred (single-line rendering). ±FLOW_LANE_OFFSET = the two
// lanes of a 1-tile-wide belt; sized to leave a visible gap between
// the lane strokes inside the tile footprint.
const FLOW_LANE_OFFSET = 0.22;
const FLOW_STROKE_CENTER = 0.18;
const FLOW_STROKE_LANE   = 0.15;
// Arrow size shrinks when drawn inside a lane (half the visual room).
const FLOW_ARROW_LEN_CENTER = 0.32;
const FLOW_ARROW_WIDTH_CENTER = 0.34;
const FLOW_ARROW_LEN_LANE = 0.22;
const FLOW_ARROW_WIDTH_LANE = 0.22;
// Identifier glyphs that ride the lane line.
const FLOW_ICON_SIZE = 0.55;
const FLOW_LABEL_FONT_SIZE = 0.42;

// Mitred offset polyline for one chain. Naive per-point offsetting
// breaks at corners: the perpendicular flips between two consecutive
// edges, so the two lane lines cross each other through the bend.
// Compute the offset point as the intersection of the two offset edges
// meeting at each interior vertex; for unit edge perpendiculars at
// half-angle α the mitre formula is `pt + d * (pIn + pOut) / (1 + pIn·pOut)`.
// Straight segments collapse to the simple `pt + d * perp` case.
type LaneGeom = {
  offPts: { x: number; y: number }[];
  d: string;
  dirs: [number, number][];   // per-tile flow direction (unchanged from chain)
  edgeDirs: [number, number][]; // per-edge unit direction (length N-1)
};

function buildLaneGeom(p: FlowPath, offset: number): LaneGeom {
  const n = p.pts.length;
  if (n === 0) return { offPts: [], d: '', dirs: [], edgeDirs: [] };
  if (n === 1) {
    const [dx, dy] = p.dirs[0];
    const perpX = dy, perpY = -dx;
    const c = { x: p.pts[0].x + offset * perpX, y: p.pts[0].y + offset * perpY };
    const d = dx === 0 && dy === 0
      ? `M ${c.x - 0.15} ${c.y} L ${c.x + 0.15} ${c.y}`
      : `M ${c.x - 0.4 * dx} ${c.y - 0.4 * dy} L ${c.x + 0.4 * dx} ${c.y + 0.4 * dy}`;
    return { offPts: [c], d, dirs: [p.dirs[0]], edgeDirs: [] };
  }
  const edgeDirs: [number, number][] = [];
  const edgePerps: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const ex = p.pts[i + 1].x - p.pts[i].x;
    const ey = p.pts[i + 1].y - p.pts[i].y;
    const len = Math.hypot(ex, ey) || 1;
    const ux = ex / len, uy = ey / len;
    edgeDirs.push([ux, uy]);
    edgePerps.push([uy, -ux]);
  }
  const offPts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    let sx: number, sy: number;
    if (i === 0) [sx, sy] = edgePerps[0];
    else if (i === n - 1) [sx, sy] = edgePerps[n - 2];
    else {
      const [ix, iy] = edgePerps[i - 1];
      const [ox, oy] = edgePerps[i];
      const dot = ix * ox + iy * oy;
      const denom = 1 + dot;
      if (Math.abs(denom) < 1e-6) { sx = ix; sy = iy; }
      else { sx = (ix + ox) / denom; sy = (iy + oy) / denom; }
    }
    offPts.push({ x: p.pts[i].x + offset * sx, y: p.pts[i].y + offset * sy });
  }
  let d = `M ${offPts[0].x} ${offPts[0].y}`;
  for (let i = 1; i < n; i++) d += ` L ${offPts[i].x} ${offPts[i].y}`;
  return { offPts, d, dirs: p.dirs, edgeDirs };
}

// Build the full SVG `d` (polyline + arrow "<" marks) for one lane.
// Takes pre-built chains so the caller can share the buildFlowPaths
// pass across all three lane variants (center / left / right).
function flowLaneDFromPaths(paths: FlowPath[], offset: number): string {
  if (paths.length === 0) return '';
  const lane = offset !== 0;
  const arrowLen   = lane ? FLOW_ARROW_LEN_LANE   : FLOW_ARROW_LEN_CENTER;
  const arrowWidth = lane ? FLOW_ARROW_WIDTH_LANE : FLOW_ARROW_WIDTH_CENTER;
  const parts: string[] = [];
  for (const p of paths) {
    const g = buildLaneGeom(p, offset);
    if (g.d) parts.push(g.d);
    if (g.offPts.length === 0) continue;
    // Arrows: at sampled tile indices, pointing along edge direction
    // out of that tile (or the inbound edge for the last tile).
    const sampled = new Set<number>([Math.floor(g.offPts.length / 2)]);
    for (let i = Math.floor(FLOW_ARROW_EVERY / 2); i < g.offPts.length; i += FLOW_ARROW_EVERY) {
      sampled.add(i);
    }
    for (const i of sampled) {
      const edgeIdx = i < g.edgeDirs.length ? i : g.edgeDirs.length - 1;
      const ed = g.edgeDirs[edgeIdx] ?? g.dirs[i];
      const dx = ed[0], dy = ed[1];
      if (dx === 0 && dy === 0) continue;
      const cx = g.offPts[i].x, cy = g.offPts[i].y;
      const tipX = cx + arrowLen * dx;
      const tipY = cy + arrowLen * dy;
      const baseX = cx - arrowLen * 0.1 * dx;
      const baseY = cy - arrowLen * 0.1 * dy;
      const lx = baseX + (arrowWidth / 2) * -dy;
      const ly = baseY + (arrowWidth / 2) *  dx;
      const rx = baseX - (arrowWidth / 2) * -dy;
      const ry = baseY - (arrowWidth / 2) *  dx;
      parts.push(`M ${lx} ${ly} L ${tipX} ${tipY} L ${rx} ${ry}`);
    }
  }
  return parts.join(' ');
}

// Per-lane positions where an item icon or label should ride. Sampled
// off the same offset polyline as the lane line so they sit ON the
// stroke. Anchored at midpoint and stepped every FLOW_ICON_EVERY tiles
// either side, then sorted ascending so callers receive positions in
// flow order (start → end). That ordering matters for mixed-item
// lanes: item cycling (`items[idx % items.length]`) anchors items[0]
// at the head of the belt, items[1] next, and so on.
function flowIconPositionsFromPaths(paths: FlowPath[], offset: number): { x: number; y: number }[] {
  if (paths.length === 0) return [];
  const out: { x: number; y: number }[] = [];
  for (const p of paths) {
    const g = buildLaneGeom(p, offset);
    if (g.offPts.length === 0) continue;
    const mid = Math.floor(g.offPts.length / 2);
    const sampled = new Set<number>([mid]);
    for (let i = mid - FLOW_ICON_EVERY; i >= 0; i -= FLOW_ICON_EVERY) sampled.add(i);
    for (let i = mid + FLOW_ICON_EVERY; i < g.offPts.length; i += FLOW_ICON_EVERY) sampled.add(i);
    const sorted = [...sampled].sort((a, b) => a - b);
    for (const i of sorted) out.push({ x: g.offPts[i].x, y: g.offPts[i].y });
  }
  return out;
}

// Hashed per-item colour. Keep in sync with the visual-test's
// `itemColor` so segments and the flow-test agree at a glance. Empty
// lane → desaturated grey so it reads as "lane-with-no-known-item"
// rather than disappearing.
function flowItemColor(item: string | null | undefined): string {
  if (!item) return '#5a5a5a';
  let h = 0;
  for (let i = 0; i < item.length; i++) h = (h * 31 + item.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 70 + ((h >>> 8) % 20);
  const lig = 62 + ((h >>> 16) % 18);
  return `hsl(${hue} ${sat}% ${lig}%)`;
}

// Per-cluster colour, hashed from the cluster id (NOT its item) so two
// clusters producing the same item are visually distinct — the point of the
// layer is to tell same-item blocks apart. All rects of one cluster share it.
function clusterColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 58 + ((h >>> 8) % 24);   // 58..81
  const lig = 52 + ((h >>> 16) % 16);  // 52..67
  return `hsl(${hue} ${sat}% ${lig}%)`;
}

// Tiles alive at `tick` per half-open [tb, tr). Duplicate (x,y) entries
// from quick-replace swaps coexist in the raw list with adjacent
// non-overlapping windows; the filter naturally keeps at most one
// per (x,y) at any single tick.
function activeTiles(tiles: FlowTileLocation[] | undefined, tick: number): FlowTileLocation[] {
  if (!tiles?.length) return [];
  const out: FlowTileLocation[] = [];
  for (const t of tiles) {
    if (t.tb > tick) continue;
    if (t.tr !== undefined && tick >= t.tr) continue;
    out.push(t);
  }
  return out;
}

// Distinct items present on a lane at `tick`. The underlying data is a
// temporal ledger — each entry is one [tb, tr) presence interval, with
// tr === undefined meaning "still alive at run end". Duplicate items
// (same lane, multiple non-overlapping intervals) collapse to one
// entry; order preserved from the source ledger so identifier cycling
// stays deterministic across renders.
function activeItems(side: { items?: FlowLaneInterval[] } | undefined, tick: number): string[] {
  const intervals = side?.items;
  if (!intervals?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of intervals) {
    if (x.tb > tick) continue;
    if (x.tr !== undefined && tick >= x.tr) continue;
    if (seen.has(x.item)) continue;
    seen.add(x.item);
    out.push(x.item);
  }
  return out;
}

// Stable string key for two arrays (order-preserving) — used to detect
// symmetric lanes so we can collapse to a single centred line.
function sameItemList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Prefer the filter-icon sprite (used by splitter/inserter overlays —
// covers the items a runner sets explicitly), fall back to recipe-icon
// (covers crafted items), otherwise no icon — the colour alone has to
// carry the encoding. Raw resources (coal, iron-ore) often hit the
// no-sprite path.
function itemSpriteId(item: string, sprites: SpriteAtlas | null): string | null {
  if (!sprites) return null;
  const f = `f:${item}`;
  if (sprites[f]) return f;
  const r = `r:${item}`;
  if (sprites[r]) return r;
  return null;
}


// Roboport overlay: each roboport renders the count of bots queued waiting
// for a charger as a text label centred on the entity. Charging caps at 4
// (one per charge pad — always working when non-zero) and isn't shown.
// Waiting bots is the bottleneck signal, so the label colour shifts from
// green (no queue) through yellow → red (heavy queue, ~50 bots in this run).
const ROBOPORT_LABEL_FONT_SIZE = 1.7;  // tiles — large enough to read against the 4×4 roboport sprite
const ROBOPORT_LABEL_SATURATION_RED_AT = 40;  // waiting count that's fully red on the hue scale

function roboportLabelColor(waiting: number): string {
  // 0 → green (hue 120); ROBOPORT_LABEL_SATURATION_RED_AT+ → red (hue 0).
  const hue = Math.max(0, 120 - (waiting * 120) / ROBOPORT_LABEL_SATURATION_RED_AT);
  return `hsl(${hue} 80% 55%)`;
}

// Splitter filter icon: 0.5 tiles total (FBSR uses 0.7 — size 0.5 + border
// 0.1 on each side — but at the dashboard's viewport densities the smaller
// size reads better against the splitter's belt structure).
const SPLITTER_FILTER_ICON_TILES = 0.5;

// Inserter filter icons: FBSR-parity sizing & layout. With 1 filter the
// icon is large and centered; with 2-4 filters the icons shrink and
// arrange in a 2x1 row or 2x2 grid (FBSR InserterRendering.java lines
// 124-141). All positions are relative to the inserter base center.
const INSERTER_ICON_BIG  = 0.5;   // 1-filter case (atlas sprite scaled to 0.5)
const INSERTER_ICON_SMALL = 0.4;  // 2-4-filter case
const INSERTER_ICON_SHIFT = 0.5;  // distance between icon centers in the grid

// FBSR-parity layout for N filter icons. Returns per-slot center offsets
// from the inserter base, plus the per-icon display size. Mirrors
// InserterRendering.java iconStartPos + iconShift formulas.
function inserterIconLayout(n: number): { dx: number; dy: number; size: number }[] {
  if (n <= 0) return [];
  const big = n === 1;
  const size = big ? INSERTER_ICON_BIG : INSERTER_ICON_SMALL;
  if (n === 1) return [{ dx: 0, dy: 0, size }];
  // 2 filters: side-by-side, centers at (-0.25, 0) and (+0.25, 0).
  if (n === 2) return [
    { dx: -0.25, dy: 0, size },
    { dx:  0.25, dy: 0, size },
  ];
  // 3-4 filters: 2x2 grid centered at (0, 0).
  const slots: { dx: number; dy: number; size: number }[] = [];
  for (let i = 0; i < Math.min(n, 4); i++) {
    slots.push({
      dx: -0.25 + (i % 2) * INSERTER_ICON_SHIFT,
      dy: -0.25 + Math.floor(i / 2) * INSERTER_ICON_SHIFT,
      size,
    });
  }
  return slots;
}

// Static helper: yellow triangle with a 0.07-tile dark drop-shadow,
// pixel-equivalent to FBSR's MapLaneArrow / MapBeltArrow rendering.
// Initially hidden; the splitter overlay effect toggles display.
function SplitterArrow({ x, y, rotDeg }: { x: number; y: number; rotDeg: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotDeg})`} style={{ display: 'none' }}>
      <path d={SPLITTER_ARROW_PATH}
            fill="#444"
            transform={`translate(${SPLITTER_ARROW_SHADOW_OFFSET} ${SPLITTER_ARROW_SHADOW_OFFSET})`} />
      <path d={SPLITTER_ARROW_PATH} fill="#ffe000" />
    </g>
  );
}

// One row in the Layers popover. Checkbox + label; sub-rows are
// indented and dim when their parent ("Alt mode") is off. The whole
// row is clickable to keep target areas finger-friendly.
function LayerCheck({
  label,
  active,
  onChange,
  hint,
  sub,
  disabled,
}: {
  label: string;
  active: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
  sub?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        'run-map-layer-row' +
        (sub ? ' is-sub' : '') +
        (disabled ? ' is-disabled' : '')
      }
      title={hint}
    >
      <input
        type="checkbox"
        checked={active}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

// Self-contained map viewer. Owns its own tick state, playback loop,
// pan/zoom, and hover tooltip. Both the dashboard's RunMapPlayer and
// the analytical-hub mount this directly — they only differ in how
// they resolve the URLs and what overlays they pass.
//
// Time scrub uses incremental DOM mutation: entities are pre-sorted by tb
// so React renders them once, then we walk forward/back through "build"
// and "remove" cursors, toggling display on only the entities that
// crossed the time boundary. O(delta) per tick change, scales to 15K+
// entities. (The pure equivalent is mapModel.isAlive; the cursor walk
// must produce an identical visibility set.)
//
// Overlays: any ReactNode passed via the `overlays` prop is rendered
// inside the same <svg> in world (tile) coordinates, on top of the
// entity layer and player marker. Overlays automatically inherit the
// pan/zoom transform.

const TICKS_PER_SECOND = 60;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// Compute the actual fitted rect inside the SVG viewport for preserveAspectRatio="xMidYMid meet"
function fitRect(viewportW: number, viewportH: number, vbW: number, vbH: number) {
  const sx = viewportW / vbW, sy = viewportH / vbH;
  const s = Math.min(sx, sy);
  const fitW = vbW * s, fitH = vbH * s;
  return { fitW, fitH, offsetX: (viewportW - fitW) / 2, offsetY: (viewportH - fitH) / 2 };
}
function screenToWorld(rect: DOMRect, vb: { x: number; y: number; w: number; h: number }, clientX: number, clientY: number) {
  const sx = clientX - rect.left, sy = clientY - rect.top;
  const fit = fitRect(rect.width, rect.height, vb.w, vb.h);
  const ix = (sx - fit.offsetX) / fit.fitW;
  const iy = (sy - fit.offsetY) / fit.fitH;
  return { wx: vb.x + ix * vb.w, wy: vb.y + iy * vb.h };
}

// Context exposing the chrome `<div>` (an absolute-positioned layer over
// the canvas, in screen coords). Overlay components render into it via
// React.createPortal — useful for legends, status badges, and any HTML
// that should NOT pan/zoom with the map.
export const MapViewChromeContext = createContext<HTMLDivElement | null>(null);

export type MapViewProps = {
  // Display label shown in the panel header. Defaults to "Map playback".
  title?: string;
  // URL of the per-run map JSON file (the output of map-prep.mjs).
  mapUrl: string;
  // URL of the cross-run sprite atlas (game-data/map-sprites.json).
  spritesUrl: string;
  // Optional initial playback position in ticks. Defaults to 0.
  initialTick?: number;
  // Show the playback controls bar (play/pause/slider/speed/reset).
  // Set to false for static-snapshot use cases (e.g. analytical-hub
  // overlays at a fixed tick). Defaults to true.
  showControls?: boolean;
  // 'aspect' (default) sizes the canvas-wrap by the map's aspect ratio
  // so it grows tall on wide containers — fine when the dashboard is
  // the only consumer. 'viewport' drops the aspect-ratio so the parent
  // (e.g. a flex column with a fixed height) drives both dimensions
  // and the SVG letterboxes itself via preserveAspectRatio.
  fitMode?: 'aspect' | 'viewport';
  // SVG nodes rendered on top of entities + player marker, in world
  // (tile) coordinates. Pass any number of <g>…</g> elements.
  overlays?: ReactNode;
  // Optional callback invoked whenever the playback tick changes. Lets
  // an external host (e.g. the flow visual test) re-evaluate overlays
  // against the current scrub position. No-op by default — does not
  // affect production code paths.
  onTick?: (tick: number) => void;
  // Optional viewport target. When set (and changed by reference),
  // MapView pans/zooms so this bbox occupies the centre of the canvas
  // with ~30% padding. Used by overlay hosts to "go look at this".
  focusBBox?: { x: number; y: number; w: number; h: number } | null;
  // Optional belt-segment flow data. When present, a toggleable layer
  // renders each segment as a continuous coloured polyline with
  // directional arrows. Pass run.flow.beltSegments here. Cursor-driven
  // tb/tr visibility mirrors the entity layer.
  flowSegments?: FlowSegmentLite[];
  // Optional cluster data (machine/furnace/miner/buffer blocks). When
  // present, a toggleable layer draws each cluster's disjoint sub-rects
  // in a per-cluster colour, highlighted together on hover. Pass
  // run.flow.clusters. tb/tr lifetime mirrors the entity layer.
  clusters?: FlowClusterLite[];
};

export function MapView({
  title = 'Map playback',
  mapUrl,
  spritesUrl,
  initialTick = 0,
  showControls = true,
  fitMode = 'aspect',
  overlays,
  onTick,
  focusBBox,
  flowSegments,
  clusters,
}: MapViewProps) {
  const [data, setData] = useState<MapData | null>(null);
  const [sprites, setSprites] = useState<SpriteAtlas | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(initialTick);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(120);

  type VB = { x: number; y: number; w: number; h: number };
  const [vb, setVb] = useState<VB | null>(null);
  const [tooltip, setTooltip] = useState<
    | { kind: 'entity'; name: string; en: number; px: number; py: number; sx: number; sy: number }
    | { kind: 'flow'; id: string; sx: number; sy: number }
    | { kind: 'cluster'; id: string; label: string; sub: string; sx: number; sy: number }
    | null
  >(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // DOM refs kept as state (set via callback refs) so effects can
  // re-run when the elements attach. Plain useRef would race the
  // data-load → vb-set → SVG-mount sequence: an effect keyed on
  // [data] fires with a null ref, then the SVG mounts on the next
  // render but no dep changes so the effect never repeats.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const [entitiesEl, setEntitiesEl] = useState<SVGGElement | null>(null);
  const [recipesEl, setRecipesEl]   = useState<SVGGElement | null>(null);
  const [splittersEl, setSplittersEl] = useState<SVGGElement | null>(null);
  const [insertersEl, setInsertersEl] = useState<SVGGElement | null>(null);
  const [roboportsEl, setRoboportsEl] = useState<SVGGElement | null>(null);

  // Overlay-visibility toggles. Each overlay is rendered once; the
  // toggle hides the wrapper <g> via display:none so cursor-walked DOM
  // state (recipe / splitter / inserter / entity / flow) survives
  // toggling. Flow overlay defaults OFF (large dataset, opt-in for
  // analysis). Alt mode groups recipe / splitter-arrow / inserter-
  // filter overlays — FBSR's "alt info" idea — so a single switch
  // strips them all without losing the per-overlay sub-controls.
  const [showFlow, setShowFlow] = useState(false);
  const [showClusters, setShowClusters] = useState(false);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const [altMode, setAltMode] = useState(true);
  const [altRecipes, setAltRecipes] = useState(true);
  const [altSplitterArrows, setAltSplitterArrows] = useState(true);
  const [altInserterFilters, setAltInserterFilters] = useState(true);
  const [showBotQueue, setShowBotQueue] = useState(true);
  const [showPlayerPos, setShowPlayerPos] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const layersMenuRef = useRef<HTMLDivElement>(null);

  // Effective visibility per layer — alt-mode is a master switch over
  // its three sub-overlays.
  const showRecipes = altMode && altRecipes;
  const showSplitterArrows = altMode && altSplitterArrows;
  const showInserterFilters = altMode && altInserterFilters;

  // Close the layers menu when the user clicks anywhere outside it.
  useEffect(() => {
    if (!layersOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const el = layersMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setLayersOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [layersOpen]);
  // Chrome layer: HTML inside canvas-wrap, exposed to overlay components
  // via context so they can portal screen-space elements (legends, etc.)
  // that don't pan/zoom with the map.
  const [chromeEl, setChromeEl] = useState<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; vb0: VB } | null>(null);

  // Cursors track which prefix of byTb / byTr have already been applied to
  // the DOM. Stored in refs so playback / scrubbing don't trigger re-renders.
  const buildCursor = useRef(0);
  const removeCursor = useRef(0);
  // Last applied recipe-event index per entity (entityIdx → eventIdx, -1 = none).
  const lastRecipeIdx = useRef(new Map<number, number>());
  // Last applied splitter / inserter state-event index per entity. Independent
  // of recipe cursor — splitters / inserters live in their own arrays.
  const lastSplitterIdx = useRef(new Map<number, number>());
  const lastInserterIdx = useRef(new Map<number, number>());
  // Roboport state cursor: tracks last applied event index per marker (by
  // unitNumber, since roboport markers don't carry `en`).
  const lastRoboportIdx = useRef(new Map<number, number>());
  // Fetch map data + sprites in parallel.
  useEffect(() => {
    let cancelled = false;
    setData(null); setSprites(null); setErr(null);
    if (!mapUrl) { setErr('no map URL'); return; }
    Promise.all([
      fetch(mapUrl).then(r => { if (!r.ok) throw new Error(`${r.status} ${mapUrl}`); return r.json(); }),
      fetch(spritesUrl).then(r => { if (!r.ok) throw new Error(`${r.status} ${spritesUrl}`); return r.json(); }),
    ])
      .then(([m, s]) => { if (!cancelled) { setData(m); setSprites(s); } })
      .catch(e => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [mapUrl, spritesUrl]);

  // Reset on data change. Honors initialTick so external shells (e.g.
  // hub URL ?tick=) can deep-link.
  useEffect(() => {
    if (!data) return;
    setTick(initialTick);
    const [x, y, w, h] = data.viewBox;
    setVb({ x, y, w, h });
    buildCursor.current = 0;
    removeCursor.current = 0;
    lastRecipeIdx.current.clear();
    lastSplitterIdx.current.clear();
    lastInserterIdx.current.clear();
    lastRoboportIdx.current.clear();
  }, [data, initialTick]);

  // External focus: when an overlay host wants to "go look at X", it
  // passes a focusBBox; we centre that bbox in the canvas with ~30%
  // padding. Re-runs only on focusBBox reference change so the user
  // can manually pan/zoom without us yanking them back.
  useEffect(() => {
    if (!focusBBox || !data) return;
    const minSide = 8;            // never zoom in tighter than ~8 tiles
    const w = Math.max(focusBBox.w, minSide);
    const h = Math.max(focusBBox.h, minSide);
    const pad = 0.35;
    const fullW = w * (1 + pad * 2);
    const fullH = h * (1 + pad * 2);
    const cx = focusBBox.x + focusBBox.w / 2;
    const cy = focusBBox.y + focusBBox.h / 2;
    setVb({ x: cx - fullW / 2, y: cy - fullH / 2, w: fullW, h: fullH });
  }, [focusBBox, data]);

  // DOM order = visual stack (layer/Y/X) set by map-prep. The cursors walk
  // in time order, so we precompute byTb / byTr separately, each entry
  // carrying the entity's DOM-child index for direct access.
  const byTb = useMemo(() => {
    if (!data) return [];
    return data.entities
      .map((e, idx) => ({ idx, tb: e.tb }))
      .sort((a, b) => a.tb - b.tb);
  }, [data]);
  const byTr = useMemo(() => {
    if (!data) return [];
    return data.entities
      .map((e, idx) => e.tr !== undefined ? { idx, tr: e.tr } : null)
      .filter((x): x is { idx: number; tr: number } => x !== null)
      .sort((a, b) => a.tr - b.tr);
  }, [data]);
  // Recipe-overlay rows come from a separate top-level field. One entry per
  // machine that ever set a recipe — decoupled from the per-renderable
  // entities array so a single machine doesn't get N recipe `<use>` elements.
  const recipeMachines = useMemo(() => data?.recipeMachines ?? [], [data]);
  const splitterMarkers = useMemo(() => data?.splitterMarkers ?? [], [data]);
  const inserterMarkers = useMemo(() => data?.inserterMarkers ?? [], [data]);
  const roboportMarkers = useMemo(() => data?.roboportMarkers ?? [], [data]);

  // Apply tick changes incrementally to the DOM. Re-runs when the
  // container element attaches (via callback ref → state), so the
  // initial walk fires after the SVG mounts even at non-zero
  // initialTick (the bug: at tick=0 the walk is a no-op so the dash-
  // board accidentally worked).
  useEffect(() => {
    const container = entitiesEl;
    if (!container || !data) return;
    const setDisplay = (idx: number, visible: boolean) => {
      const el = container.children[idx] as SVGElement | undefined;
      if (el) el.style.display = visible ? '' : 'none';
    };
    while (buildCursor.current < byTb.length && byTb[buildCursor.current].tb <= tick) {
      setDisplay(byTb[buildCursor.current].idx, true);
      buildCursor.current++;
    }
    while (removeCursor.current < byTr.length && byTr[removeCursor.current].tr <= tick) {
      setDisplay(byTr[removeCursor.current].idx, false);
      removeCursor.current++;
    }
    // Backward pass: undo-remove (show) before undo-build (hide), mirroring
    // the forward order (build before remove). If both passes touch the same
    // entity in a big backward jump, the undo-build hide must win — otherwise
    // an entity that was built+removed before `tick` gets revealed.
    while (removeCursor.current > 0 && byTr[removeCursor.current - 1].tr > tick) {
      removeCursor.current--;
      setDisplay(byTr[removeCursor.current].idx, true);
    }
    while (buildCursor.current > 0 && byTb[buildCursor.current - 1].tb > tick) {
      buildCursor.current--;
      setDisplay(byTb[buildCursor.current].idx, false);
    }
  }, [tick, data, byTb, byTr, entitiesEl]);

  // Recipe overlay: walk each machine's recipe timeline and update the
  // matching <use>'s href when its current recipe changes.
  useEffect(() => {
    const container = recipesEl;
    if (!container || !data || !sprites) return;
    for (let i = 0; i < recipeMachines.length; i++) {
      const e = recipeMachines[i];
      let cur = -1;
      if (e.tr === undefined || e.tr > tick) {
        for (let j = e.rs.length - 1; j >= 0; j--) {
          if (e.rs[j].ts <= tick) { cur = j; break; }
        }
      }
      const prev = lastRecipeIdx.current.get(e.en);
      if (prev === cur) continue;
      lastRecipeIdx.current.set(e.en, cur);
      const el = container.children[i] as SVGUseElement | undefined;
      if (!el) continue;
      if (cur < 0) {
        el.style.display = 'none';
      } else {
        const sid = recipeSpriteId(e.rs[cur].n);
        if (sprites[sid]) {
          el.setAttribute('href', `#${sid}`);
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      }
    }
  }, [tick, data, sprites, recipeMachines, recipesEl]);

  // Splitter alt-mode overlay: per marker, each <g> wrapper holds 6
  // children (input arrow L/R, output arrow L/R, filter icon L/R). The
  // effect walks each timeline back to find the active state, then
  // toggles the appropriate child's visibility. Filter icon href is
  // updated when the filter item changes.
  useEffect(() => {
    const container = splittersEl;
    if (!container || !data || !sprites) return;
    for (let i = 0; i < splitterMarkers.length; i++) {
      const m = splitterMarkers[i];
      const ev = splitterStateAt(m, tick);
      // Index-based cursor: -1 = no event applied yet (before tb).
      let curIdx = -1;
      if (ev) {
        for (let j = m.ts.length - 1; j >= 0; j--) {
          if (m.ts[j].ts <= tick) { curIdx = j; break; }
        }
      }
      const prevIdx = lastSplitterIdx.current.get(m.en);
      if (prevIdx === curIdx) continue;
      lastSplitterIdx.current.set(m.en, curIdx);
      const wrapper = container.children[i] as SVGGElement | undefined;
      if (!wrapper) continue;
      const inL = wrapper.children[0] as SVGElement;
      const inR = wrapper.children[1] as SVGElement;
      const outL = wrapper.children[2] as SVGElement;
      const outR = wrapper.children[3] as SVGElement;
      const filtL = wrapper.children[4] as SVGUseElement;
      const filtR = wrapper.children[5] as SVGUseElement;
      if (!ev) {
        inL.style.display = inR.style.display = 'none';
        outL.style.display = outR.style.display = 'none';
        filtL.style.display = filtR.style.display = 'none';
        continue;
      }
      inL.style.display  = ev.ip === 'left'  ? '' : 'none';
      inR.style.display  = ev.ip === 'right' ? '' : 'none';
      const hasFilter = ev.f !== '';
      const filterSid = hasFilter ? filterIconSpriteId(ev.f) : '';
      const filterAvailable = hasFilter && !!sprites[filterSid];
      // Output arrow shows only when output priority is set AND there's
      // no filter overriding it (FBSR convention from SplitterRendering).
      outL.style.display = (ev.op === 'left'  && !filterAvailable) ? '' : 'none';
      outR.style.display = (ev.op === 'right' && !filterAvailable) ? '' : 'none';
      if (filterAvailable) {
        filtL.setAttribute('href', `#${filterSid}`);
        filtR.setAttribute('href', `#${filterSid}`);
        filtL.style.display = ev.op === 'left'  ? '' : 'none';
        filtR.style.display = ev.op === 'right' ? '' : 'none';
      } else {
        filtL.style.display = filtR.style.display = 'none';
      }
    }
  }, [tick, data, sprites, splitterMarkers, splittersEl]);

  // Inserter alt-mode overlay: per marker, wrapper holds 4 slot <g>s,
  // each containing a filter <use> and a blacklist <path>. The effect
  // walks the state timeline, computes the FBSR-parity layout for the
  // visible filter count (1 large at center; 2 side-by-side; 3-4 in a
  // 2x2 grid), positions each slot via transform, and toggles the X
  // overlay when mode is 'blacklist'.
  useEffect(() => {
    const container = insertersEl;
    if (!container || !data || !sprites) return;
    for (let i = 0; i < inserterMarkers.length; i++) {
      const m = inserterMarkers[i];
      const ev = inserterStateAt(m, tick);
      let curIdx = -1;
      if (ev) {
        for (let j = m.ts.length - 1; j >= 0; j--) {
          if (m.ts[j].ts <= tick) { curIdx = j; break; }
        }
      }
      const prevIdx = lastInserterIdx.current.get(m.en);
      if (prevIdx === curIdx) continue;
      lastInserterIdx.current.set(m.en, curIdx);
      const wrapper = container.children[i] as SVGGElement | undefined;
      if (!wrapper) continue;
      const showAny = ev && ev.u && ev.f.length > 0;
      const filters = showAny ? ev!.f.slice(0, 4) : [];
      const layout = inserterIconLayout(filters.length);
      const isBlacklist = ev?.m === 'blacklist';
      for (let k = 0; k < 4; k++) {
        const slot = wrapper.children[k] as SVGGElement | undefined;
        if (!slot) continue;
        if (k >= filters.length) { slot.style.display = 'none'; continue; }
        const itemName = filters[k];
        const sid = filterIconSpriteId(itemName);
        if (!sprites[sid]) { slot.style.display = 'none'; continue; }
        const { dx, dy, size } = layout[k];
        // Slot transform: translate to icon top-left in world coords,
        // then scale to icon size. Children render in a unit cell.
        const x = m.px + dx - size / 2;
        const y = m.py + dy - size / 2;
        slot.setAttribute('transform', `translate(${x} ${y}) scale(${size})`);
        const useEl = slot.children[0] as SVGUseElement;
        const xEl = slot.children[1] as SVGPathElement;
        useEl.setAttribute('href', `#${sid}`);
        xEl.style.display = isBlacklist ? '' : 'none';
        slot.style.display = '';
      }
    }
  }, [tick, data, sprites, inserterMarkers, insertersEl]);

  // Roboport waiting-bot label: per marker, one <text>. Walks the timeline
  // back to the active state, updates text content + colour. Hidden before
  // tb / after tr. Charging count isn't shown — it caps at 4 and just means
  // "the roboport is working"; only the waiting count signals a bottleneck.
  useEffect(() => {
    const container = roboportsEl;
    if (!container || !data) return;
    for (let i = 0; i < roboportMarkers.length; i++) {
      const m = roboportMarkers[i];
      let curIdx = -1;
      const alive = tick >= m.tb && (m.tr === undefined || tick < m.tr);
      if (alive) {
        for (let j = m.ts.length - 1; j >= 0; j--) {
          if (m.ts[j].ts <= tick) { curIdx = j; break; }
        }
      }
      const prevIdx = lastRoboportIdx.current.get(m.un);
      if (prevIdx === curIdx) continue;
      lastRoboportIdx.current.set(m.un, curIdx);
      const el = container.children[i] as SVGTextElement | undefined;
      if (!el) continue;
      if (curIdx < 0) { el.style.display = 'none'; continue; }
      const w = m.ts[curIdx].w;
      el.textContent = String(w);
      el.setAttribute('fill', roboportLabelColor(w));
      el.style.display = '';
    }
  }, [tick, data, roboportMarkers, roboportsEl]);

  // Tick notification for external hosts (e.g. flow visual test).
  // No-op when onTick isn't passed.
  useEffect(() => {
    if (onTick) onTick(tick);
  }, [tick, onTick]);

  // Playback loop
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last; last = now;
      const tickPerMs = (playSpeed * TICKS_PER_SECOND) / 1000;
      setTick(prev => {
        const next = prev + dt * tickPerMs;
        if (next >= data.durationTick) { setPlaying(false); return data.durationTick; }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, data, playSpeed]);

  // Pan/zoom — wheel must be a NATIVE non-passive listener to call
  // preventDefault. React's synthetic onWheel has been passive since
  // React 17, so attaching via JSX silently lets the page scroll.
  // Indirect through a ref so the closure always reads current state.
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    if (!vb) return;
    e.preventDefault();
    const target = e.currentTarget as SVGSVGElement;
    const rect = target.getBoundingClientRect();
    const { wx, wy } = screenToWorld(rect, vb, e.clientX, e.clientY);
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    setVb(v => {
      if (!v) return v;
      const nw = clamp(v.w * factor, 2, 5000);
      const nh = clamp(v.h * factor, 2, 5000);
      const fit = fitRect(rect.width, rect.height, nw, nh);
      const fxIn = (e.clientX - rect.left - fit.offsetX) / fit.fitW;
      const fyIn = (e.clientY - rect.top  - fit.offsetY) / fit.fitH;
      return { x: wx - fxIn * nw, y: wy - fyIn * nh, w: nw, h: nh };
    });
  };
  useEffect(() => {
    if (!svgEl) return;
    const listener = (e: WheelEvent) => wheelHandlerRef.current(e);
    svgEl.addEventListener('wheel', listener, { passive: false });
    return () => svgEl.removeEventListener('wheel', listener);
  }, [svgEl]);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !vb) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, vb0: vb };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current; if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fit = fitRect(rect.width, rect.height, d.vb0.w, d.vb0.h);
    const dxWorld = (e.clientX - d.startX) * (d.vb0.w / fit.fitW);
    const dyWorld = (e.clientY - d.startY) * (d.vb0.h / fit.fitH);
    setVb({ x: d.vb0.x - dxWorld, y: d.vb0.y - dyWorld, w: d.vb0.w, h: d.vb0.h });
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  // Hover tooltip — event delegation on the SVG. Recipe overlays already
  // disable pointer events, so the topmost hit is normally an entity <use>.
  // Flow segments expose their wrapper <g data-flow-id> via the path stroke,
  // so a SVGPathElement hit walks up to find the segment ID.
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragRef.current) { if (tooltip) setTooltip(null); return; }
    const t = e.target as Element;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (t instanceof SVGPathElement) {
      const g = t.closest('[data-flow-id]');
      if (g) {
        const id = g.getAttribute('data-flow-id') ?? '';
        setTooltip({ kind: 'flow', id, sx, sy });
        return;
      }
    }
    // Cluster rects: hovering any rect highlights the whole cluster (all its
    // disjoint sub-blocks) via hoveredClusterId, and shows a cluster tooltip.
    const cg = t.closest('[data-cluster-id]');
    if (cg) {
      const id = cg.getAttribute('data-cluster-id') ?? '';
      if (hoveredClusterId !== id) setHoveredClusterId(id);
      setTooltip({ kind: 'cluster', id, label: cg.getAttribute('data-cluster-label') ?? id, sub: cg.getAttribute('data-cluster-sub') ?? '', sx, sy });
      return;
    }
    if (hoveredClusterId !== null) setHoveredClusterId(null);
    if (!(t instanceof SVGUseElement)) { if (tooltip) setTooltip(null); return; }
    const name = t.getAttribute('data-name');
    const pxStr = t.getAttribute('data-px');
    const pyStr = t.getAttribute('data-py');
    const enStr = t.getAttribute('data-en');
    if (name === null || pxStr === null || pyStr === null) {
      if (tooltip) setTooltip(null);
      return;
    }
    setTooltip({
      kind: 'entity',
      name,
      en: enStr === null ? NaN : parseInt(enStr, 10),
      px: parseFloat(pxStr),
      py: parseFloat(pyStr),
      sx,
      sy,
    });
  };
  const onMouseLeave = () => { if (tooltip) setTooltip(null); if (hoveredClusterId !== null) setHoveredClusterId(null); };
  const resetView = () => {
    if (!data) return;
    const [x, y, w, h] = data.viewBox;
    setVb({ x, y, w, h });
  };

  // Initial fitted aspect ratio (full-extent viewBox, not the zoomed
  // one). In 'viewport' mode, omit aspectRatio so the parent's
  // dimensions drive the size — the SVG letterboxes itself.
  const containerStyle = useMemo(() => {
    if (!data || fitMode === 'viewport') return undefined;
    const [, , w, h] = data.viewBox;
    return { aspectRatio: `${w} / ${h}` };
  }, [data, fitMode]);

  const symbols = useMemo(() => {
    if (!sprites) return null;
    // viewBox is essential for SVG <use> width/height to scale the contents.
    // Without it, the symbol's contents render at intrinsic size regardless
    // of what the use specifies — recipe / filter icon scaling would silently
    // no-op and everything would render at the atlas's 1.6-tile native size.
    return Object.entries(sprites).map(([id, s]) => (
      <symbol key={id} id={id} viewBox={`0 0 ${s.w} ${s.h}`} overflow="visible">
        <image href={`data:image/png;base64,${s.data}`} width={s.w} height={s.h} preserveAspectRatio="none" />
      </symbol>
    ));
  }, [sprites]);

  // Render renderables once, all initially hidden. Keyed by array index:
  // a single entity can appear multiple times (one per FBSR Layer it
  // touches), so `en` is no longer unique. Memoized so React doesn't
  // re-create 25–30K elements on every tick / vb change.
  //
  // width/height match the sprite's intrinsic size — required now that
  // symbols carry a viewBox (which makes <use> width/height authoritative
  // for sizing). For entities we want identity scaling, so use s.w / s.h.
  const uses = useMemo(() => {
    if (!data || !sprites) return null;
    return data.entities.map((e, i) => {
      const s = sprites[e.sid];
      const w = s?.w ?? 1;
      const h = s?.h ?? 1;
      return (
        <use
          key={i}
          href={`#${e.sid}`}
          x={e.ox}
          y={e.oy}
          width={w}
          height={h}
          style={{ display: 'none' }}
          data-name={e.name}
          data-en={e.en}
          data-l={e.L}
          data-tb={e.tb}
          data-px={e.px}
          data-py={e.py}
        />
      );
    });
  }, [data, sprites]);

  // Recipe-icon <use> elements — one per machine that ever set a recipe.
  const recipeUses = useMemo(() => {
    if (!data) return null;
    const half = RECIPE_ICON_TILES / 2;
    return recipeMachines.map(e => (
      <use
        key={e.en}
        href="#__placeholder"
        x={e.px - half}
        y={e.py + RECIPE_ICON_Y_OFFSET - half}
        width={RECIPE_ICON_TILES}
        height={RECIPE_ICON_TILES}
        style={{ display: 'none' }}
        data-en={e.en}
      />
    ));
  }, [data, recipeMachines]);

  // Splitter alt-mode markers — one <g> per splitter, with 6 fixed-position
  // children: input arrow L/R (yellow triangle + dark drop-shadow), output
  // arrow L/R, filter icon L/R. The effect above toggles which children
  // are visible based on current state.
  const splitterMarkerNodes = useMemo(() => {
    if (!data) return null;
    const halfFilter = SPLITTER_FILTER_ICON_TILES / 2;
    return splitterMarkers.map(m => {
      const rotDeg = splitterArrowRotationDeg(m.dir);
      const inL = splitterArrowPos(m.px, m.py, m.dir, 'left',  'in');
      const inR = splitterArrowPos(m.px, m.py, m.dir, 'right', 'in');
      const outL = splitterArrowPos(m.px, m.py, m.dir, 'left',  'out');
      const outR = splitterArrowPos(m.px, m.py, m.dir, 'right', 'out');
      const filtL = splitterFilterPos(m.px, m.py, m.dir, 'left');
      const filtR = splitterFilterPos(m.px, m.py, m.dir, 'right');
      return (
        <g key={m.en} data-en={m.en}>
          <SplitterArrow x={inL.x}  y={inL.y}  rotDeg={rotDeg} />
          <SplitterArrow x={inR.x}  y={inR.y}  rotDeg={rotDeg} />
          <SplitterArrow x={outL.x} y={outL.y} rotDeg={rotDeg} />
          <SplitterArrow x={outR.x} y={outR.y} rotDeg={rotDeg} />
          <use href="#__placeholder"
               x={filtL.x - halfFilter} y={filtL.y - halfFilter}
               width={SPLITTER_FILTER_ICON_TILES} height={SPLITTER_FILTER_ICON_TILES}
               style={{ display: 'none' }} />
          <use href="#__placeholder"
               x={filtR.x - halfFilter} y={filtR.y - halfFilter}
               width={SPLITTER_FILTER_ICON_TILES} height={SPLITTER_FILTER_ICON_TILES}
               style={{ display: 'none' }} />
        </g>
      );
    });
  }, [data, splitterMarkers]);

  // Inserter filter markers — one wrapper <g> per inserter, with 4 slot
  // wrappers inside. Each slot contains a <use> for the filter icon and
  // a <path> for the blacklist X. The effect positions / sizes / toggles
  // each slot per the current state.
  const inserterMarkerNodes = useMemo(() => {
    if (!data) return null;
    return inserterMarkers.map(m => (
      <g key={m.en} data-en={m.en}>
        {[0, 1, 2, 3].map(k => (
          <g key={k} style={{ display: 'none' }}>
            <use href="#__placeholder" x={0} y={0} width={1} height={1} />
            {/* Blacklist X: two diagonal red strokes spanning the icon's
                unit-cell. Drawn over the filter image. The slot wrapper
                applies the position+size transform; the X is in unit
                coords (0..1 × 0..1) and scales with the wrapper. */}
            <path d="M0.15 0.15 L0.85 0.85 M0.85 0.15 L0.15 0.85"
                  stroke="#e63b3b"
                  strokeWidth={0.12}
                  strokeLinecap="round"
                  fill="none"
                  style={{ display: 'none' }} />
          </g>
        ))}
      </g>
    ));
  }, [data, inserterMarkers]);

  // Roboport label nodes — one <text> per roboport, initially hidden. The
  // effect above sets textContent + fill per tick. Black stroke + paint-
  // order:stroke gives a halo so the number reads against the multi-colour
  // roboport sprite without depending on background contrast.
  const roboportMarkerNodes = useMemo(() => {
    if (!data) return null;
    return roboportMarkers.map(m => (
      <text
        key={m.un}
        x={m.px}
        y={m.py}
        fontSize={ROBOPORT_LABEL_FONT_SIZE}
        fontWeight="bold"
        textAnchor="middle"
        dominantBaseline="central"
        fill="hsl(120 80% 55%)"
        stroke="#000"
        strokeWidth={0.22}
        paintOrder="stroke"
        style={{ display: 'none' }}
      />
    ));
  }, [data, roboportMarkers]);

  // Flow segment SVG nodes. Per-segment routing:
  //   • Both sides empty → ONE neutral centred line (cheap, the common case).
  //   • Both sides same item set → ONE centred coloured line + identifiers along it.
  //   • Sides differ (or only one carries an item) → TWO lane lines, each
  //     coloured by its own item set + identifiers along that lane.
  // Identifiers are item icons when the atlas has a sprite, otherwise
  // a short text label (raw resources like `coal` / `iron-ore` have no
  // sprite, so colour-alone is unreadable without these labels).
  //
  // Tick-filtered: the per-item lifetime intervals from the flow prep
  // are honoured here — only items whose [tb, tr) covers `tick` are
  // included. Segment-level visibility (the outer tb/tr) is folded
  // into the same render, so out-of-life segments simply don't emit
  // a node. Geometry is precomputed in `flowGeometry`, so the per-
  // tick work is one `activeItems()` scan per lane + JSX assembly.
  const flowSegmentNodes = useMemo(() => {
    if (!flowSegments || flowSegments.length === 0) return null;
    const renderIdentifier = (item: string, x: number, y: number, keyPrefix: string) => {
      const sid = itemSpriteId(item, sprites);
      if (sid) {
        return (
          <use
            key={keyPrefix}
            href={`#${sid}`}
            x={x - FLOW_ICON_SIZE / 2}
            y={y - FLOW_ICON_SIZE / 2}
            width={FLOW_ICON_SIZE}
            height={FLOW_ICON_SIZE}
            style={{ pointerEvents: 'none' }}
            data-item={item}
          />
        );
      }
      return (
        <text
          key={keyPrefix}
          x={x}
          y={y}
          fontSize={FLOW_LABEL_FONT_SIZE}
          fontWeight={700}
          textAnchor="middle"
          dominantBaseline="central"
          fill={flowItemColor(item)}
          stroke="#000"
          strokeWidth={0.08}
          paintOrder="stroke"
          style={{ pointerEvents: 'none', fontFamily: 'Titillium Web, sans-serif' }}
          data-item={item}
        >
          {item}
        </text>
      );
    };

    // Stroke colour rule: 0 items → grey; 1 item → that item's colour;
    // >1 items (mixed) → neutral grey, with the cycled icons carrying
    // the encoding (one colour cannot represent a mix faithfully).
    const laneStroke = (items: string[]) =>
      items.length === 0 ? '#9a9a9a' :
      items.length === 1 ? flowItemColor(items[0]) :
      '#9a9a9a';

    const out: ReactNode[] = [];
    for (const s of flowSegments) {
      if (tick < s.tb) continue;
      if (s.tr !== undefined && tick >= s.tr) continue;
      const tilesNow = activeTiles(s.tileLocations, tick);
      if (tilesNow.length === 0) continue;
      // Build chains once; reuse for centre + both lane offsets.
      const paths = buildFlowPaths(tilesNow);
      if (paths.length === 0) continue;
      const leftItems  = activeItems(s.contents?.left,  tick);
      const rightItems = activeItems(s.contents?.right, tick);
      const symmetric = sameItemList(leftItems, rightItems);
      const empty = leftItems.length === 0 && rightItems.length === 0;

      const children: ReactNode[] = [];
      if (empty || symmetric) {
        const d = flowLaneDFromPaths(paths, 0);
        if (empty) {
          if (d) children.push(
            <path key="c" d={d} fill="none" stroke="#9a9a9a"
                  strokeWidth={FLOW_STROKE_CENTER}
                  strokeOpacity={0.55}
                  strokeLinecap="round" strokeLinejoin="round" />
          );
        } else {
          if (d) children.push(
            <path key="c" d={d} fill="none" stroke={laneStroke(leftItems)}
                  strokeWidth={FLOW_STROKE_CENTER}
                  strokeLinecap="round" strokeLinejoin="round" />
          );
          const positions = flowIconPositionsFromPaths(paths, 0);
          positions.forEach((pos, idx) => {
            const item = leftItems[idx % leftItems.length];
            children.push(renderIdentifier(item, pos.x, pos.y, `c-id-${idx}`));
          });
        }
      } else {
        const lD = flowLaneDFromPaths(paths, +FLOW_LANE_OFFSET);
        const rD = flowLaneDFromPaths(paths, -FLOW_LANE_OFFSET);
        if (lD) children.push(
          <path key="l" d={lD} fill="none" stroke={laneStroke(leftItems)}
                strokeWidth={FLOW_STROKE_LANE}
                strokeOpacity={leftItems.length ? 1 : 0.55}
                strokeLinecap="round" strokeLinejoin="round" />
        );
        if (rD) children.push(
          <path key="r" d={rD} fill="none" stroke={laneStroke(rightItems)}
                strokeWidth={FLOW_STROKE_LANE}
                strokeOpacity={rightItems.length ? 1 : 0.55}
                strokeLinecap="round" strokeLinejoin="round" />
        );
        if (leftItems.length > 0) {
          const lPos = flowIconPositionsFromPaths(paths, +FLOW_LANE_OFFSET);
          lPos.forEach((pos, idx) => {
            const item = leftItems[idx % leftItems.length];
            children.push(renderIdentifier(item, pos.x, pos.y, `l-id-${idx}`));
          });
        }
        if (rightItems.length > 0) {
          const rPos = flowIconPositionsFromPaths(paths, -FLOW_LANE_OFFSET);
          rPos.forEach((pos, idx) => {
            const item = rightItems[idx % rightItems.length];
            children.push(renderIdentifier(item, pos.x, pos.y, `r-id-${idx}`));
          });
        }
      }

      out.push(
        <g key={s.id} data-flow-id={s.id}>
          {children}
        </g>
      );
    }
    return out;
  }, [flowSegments, sprites, tick]);

  // Cluster overlay — one translucent rect per disjoint sub-block, all rects
  // of a cluster sharing its colour. Tick-filtered at both the cluster and the
  // rect [tb,tr) level. Hovering any rect highlights the whole cluster.
  const clusterNodes = useMemo(() => {
    if (!clusters || clusters.length === 0) return null;
    const out: ReactNode[] = [];
    for (const c of clusters) {
      if (tick < c.tb) continue;
      if (c.tr !== undefined && tick >= c.tr) continue;
      const color = clusterColor(c.id);
      const hot = hoveredClusterId === c.id;
      const rectEls: ReactNode[] = [];
      for (let i = 0; i < c.rects.length; i++) {
        const r = c.rects[i];
        if (tick < r.tb) continue;
        if (r.tr !== undefined && tick >= r.tr) continue;
        rectEls.push(
          <rect
            key={i}
            x={r.minX}
            y={r.minY}
            width={Math.max(r.maxX - r.minX + 1, 0.5)}
            height={Math.max(r.maxY - r.minY + 1, 0.5)}
            fill={color}
            fillOpacity={hot ? 0.34 : 0.15}
            stroke={color}
            strokeWidth={hot ? 0.24 : 0.1}
            strokeLinejoin="round"
          />
        );
      }
      if (rectEls.length === 0) continue;
      const item = c.recipe ?? c.storedItem ?? '—';
      const blocks = c.rects.length;
      out.push(
        <g
          key={c.id}
          data-cluster-id={c.id}
          data-cluster-label={item}
          data-cluster-sub={`${c.kind} · ${c.members?.length ?? 0} machines · ${blocks} block${blocks === 1 ? '' : 's'}`}
        >
          {rectEls}
        </g>,
      );
    }
    return out;
  }, [clusters, tick, hoveredClusterId]);

  // Player marker — current interpolated position
  const playerPos = useMemo(() => {
    if (!data?.playerTrack) return null;
    return playerAt(data.playerTrack, tick);
  }, [data, tick]);

  if (err) return <div className="run-map-player run-map-error">map data error: {err}</div>;
  if (!data || !sprites || !vb) return <div className="run-map-player run-map-loading">loading map…</div>;

  const totalMin = ticksToMin(data.durationTick);
  const curMin = ticksToMin(tick);

  return (
    <div className="run-map-player">
      <div className="run-map-header">
        <span className="run-map-title">{title}</span>
        <span className="run-map-meta">
          <span className="run-map-meta-label">t</span>
          {fmtTime(curMin)}
          <span className="run-map-meta-sep">/</span>
          {fmtTime(totalMin)}
        </span>
      </div>

      {showControls && (
        <div className="run-map-controls">
          <button
            className="run-map-btn run-map-btn--play"
            onClick={() => setPlaying(p => !p)}
            aria-label={playing ? 'Pause' : 'Play'}
          >{playing ? '❚❚' : '▶'}</button>
          <input
            className="run-map-slider"
            type="range"
            min={0}
            max={data.durationTick}
            step={60}
            value={tick}
            style={{ ['--p' as never]: `${(tick / data.durationTick) * 100}%` }}
            onChange={e => { setTick(Number(e.target.value)); setPlaying(false); }}
          />
          <select
            className="run-map-speed"
            value={playSpeed}
            onChange={e => setPlaySpeed(Number(e.target.value))}
            aria-label="Playback speed"
          >
            <option value={30}>30×</option>
            <option value={60}>60×</option>
            <option value={120}>120×</option>
            <option value={300}>300×</option>
            <option value={600}>600×</option>
            <option value={1200}>1200×</option>
          </select>
          <div className="run-map-layers-menu" ref={layersMenuRef}>
            <button
              className={'run-map-btn run-map-layers-btn' + (layersOpen ? ' is-open' : '')}
              onClick={() => setLayersOpen(o => !o)}
              aria-haspopup="true"
              aria-expanded={layersOpen}
            >Layers ▾</button>
            {layersOpen && (
              <div className="run-map-layers-pop" role="menu">
                {flowSegments && flowSegments.length > 0 && (
                  <LayerCheck
                    label="Flow segments"
                    active={showFlow}
                    onChange={setShowFlow}
                    hint="Belt-segment polylines with flow-direction arrows"
                  />
                )}
                {clusters && clusters.length > 0 && (
                  <LayerCheck
                    label="Clusters"
                    active={showClusters}
                    onChange={setShowClusters}
                    hint="Machine / furnace / miner / buffer blocks; disjoint pieces of one cluster share a colour"
                  />
                )}
                {(recipeMachines.length > 0 ||
                  splitterMarkers.length > 0 ||
                  inserterMarkers.length > 0) && (
                  <>
                    <LayerCheck
                      label="Alt mode"
                      active={altMode}
                      onChange={setAltMode}
                      hint="Recipe icons + splitter priorities + inserter filters (Factorio's alt-info overlay)"
                    />
                    {recipeMachines.length > 0 && (
                      <LayerCheck
                        label="Recipe icons"
                        active={altRecipes}
                        onChange={setAltRecipes}
                        sub
                        disabled={!altMode}
                        hint="Icon on each assembler / furnace showing its current recipe"
                      />
                    )}
                    {splitterMarkers.length > 0 && (
                      <LayerCheck
                        label="Splitter priorities"
                        active={altSplitterArrows}
                        onChange={setAltSplitterArrows}
                        sub
                        disabled={!altMode}
                        hint="Splitter input/output priority arrows and filter icons"
                      />
                    )}
                    {inserterMarkers.length > 0 && (
                      <LayerCheck
                        label="Inserter filters"
                        active={altInserterFilters}
                        onChange={setAltInserterFilters}
                        sub
                        disabled={!altMode}
                        hint="Filter icons + blacklist marks on filter inserters"
                      />
                    )}
                  </>
                )}
                {roboportMarkers.length > 0 && (
                  <LayerCheck
                    label="Bot-queue counts"
                    active={showBotQueue}
                    onChange={setShowBotQueue}
                    hint="Waiting-bot count over each roboport"
                  />
                )}
                {data?.playerTrack && (
                  <LayerCheck
                    label="Player position"
                    active={showPlayerPos}
                    onChange={setShowPlayerPos}
                    hint="Player position marker"
                  />
                )}
              </div>
            )}
          </div>
          <button className="run-map-btn" onClick={resetView} aria-label="Reset view">⤢</button>
        </div>
      )}

      <div className="run-map-canvas-wrap" ref={wrapRef} style={containerStyle}>
        <svg
          ref={setSvgEl}
          className="run-map-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          <defs>
            {symbols}
            {/* Flow halo: one shared filter that paints a thin dark
                outline behind every stroke in the flow layer. Applied
                to the layer <g> so all segments share one filter pass
                instead of one halo path per segment. */}
            <filter id="run-map-flow-halo" x="-10%" y="-10%" width="120%" height="120%"
                    primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feMorphology in="SourceGraphic" operator="dilate" radius="0.08" result="dilated" />
              <feColorMatrix in="dilated" type="matrix"
                             values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="halo" />
              <feMerge>
                <feMergeNode in="halo" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g ref={setEntitiesEl} id="run-map-entities">{uses}</g>
          {/* Cluster overlay — translucent per-cluster-coloured rects, drawn
              over the entity sprites as a backdrop tint (alt/flow info stays
              readable on top). Rects catch pointer for hover-highlight +
              tooltip; the whole layer hides via display when toggled off. */}
          <g id="run-map-clusters"
             style={{ display: showClusters ? '' : 'none' }}>{clusterNodes}</g>
          <g ref={setSplittersEl} id="run-map-splitters" pointerEvents="none"
             style={{ display: showSplitterArrows ? '' : 'none' }}>{splitterMarkerNodes}</g>
          <g ref={setInsertersEl} id="run-map-inserters" pointerEvents="none"
             style={{ display: showInserterFilters ? '' : 'none' }}>{inserterMarkerNodes}</g>
          <g ref={setRecipesEl} id="run-map-recipes" pointerEvents="none"
             style={{ display: showRecipes ? '' : 'none' }}>{recipeUses}</g>
          {/* Flow segment overlay — drawn over recipe icons so the
              polylines and arrows aren't hidden by them. Segment
              visibility AND per-item lifetime filtering both live in
              the per-tick render (`flowSegmentNodes`) — no imperative
              DOM walk. Path strokes catch pointer events for the
              segment-ID tooltip; icons/labels keep pointer-events:none
              so they don't block entity hover. */}
          <g id="run-map-flow"
             filter="url(#run-map-flow-halo)"
             style={{ display: showFlow ? '' : 'none' }}>{flowSegmentNodes}</g>
          {/* Roboport labels render LAST so the waiting count sits on top of the sprite + recipe icons. */}
          <g ref={setRoboportsEl} id="run-map-roboports" pointerEvents="none"
             style={{ display: showBotQueue ? '' : 'none' }}>{roboportMarkerNodes}</g>
          {playerPos && showPlayerPos && (
            <g className="run-map-player-marker" pointerEvents="none">
              <circle cx={playerPos[0]} cy={playerPos[1]} r={0.7} className="run-map-player-halo" />
              <circle cx={playerPos[0]} cy={playerPos[1]} r={0.35} className="run-map-player-dot" />
            </g>
          )}
          <MapViewChromeContext.Provider value={chromeEl}>
            {overlays}
          </MapViewChromeContext.Provider>
        </svg>
        <div className="run-map-chrome" ref={setChromeEl} />
        {tooltip && (
          <div
            className="run-map-tooltip"
            style={{ left: tooltip.sx, top: tooltip.sy }}
          >
            {tooltip.kind === 'flow' ? (
              <div className="run-map-tooltip-name">segment {tooltip.id}</div>
            ) : tooltip.kind === 'cluster' ? (
              <>
                <div className="run-map-tooltip-name">{tooltip.label}</div>
                <div className="run-map-tooltip-coords">{tooltip.sub}</div>
                <div className="run-map-tooltip-unit">{tooltip.id}</div>
              </>
            ) : (
              <>
                <div className="run-map-tooltip-name">{tooltip.name}</div>
                <div className="run-map-tooltip-coords">
                  x {tooltip.px.toFixed(1)} · y {tooltip.py.toFixed(1)}
                </div>
                {Number.isFinite(tooltip.en) && (
                  <div className="run-map-tooltip-unit">#{tooltip.en}</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
