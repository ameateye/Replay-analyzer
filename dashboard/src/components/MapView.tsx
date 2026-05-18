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
};

export function MapView({
  title = 'Map playback',
  mapUrl,
  spritesUrl,
  initialTick = 0,
  showControls = true,
  fitMode = 'aspect',
  overlays,
}: MapViewProps) {
  const [data, setData] = useState<MapData | null>(null);
  const [sprites, setSprites] = useState<SpriteAtlas | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(initialTick);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(120);

  type VB = { x: number; y: number; w: number; h: number };
  const [vb, setVb] = useState<VB | null>(null);
  const [tooltip, setTooltip] = useState<{ name: string; px: number; py: number; sx: number; sy: number } | null>(null);
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
  }, [data, initialTick]);

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
  // disable pointer events, so the topmost hit is always an entity <use>.
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragRef.current) { if (tooltip) setTooltip(null); return; }
    const t = e.target as Element;
    if (!(t instanceof SVGUseElement)) { if (tooltip) setTooltip(null); return; }
    const name = t.getAttribute('data-name');
    const pxStr = t.getAttribute('data-px');
    const pyStr = t.getAttribute('data-py');
    if (name === null || pxStr === null || pyStr === null) {
      if (tooltip) setTooltip(null);
      return;
    }
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    setTooltip({
      name,
      px: parseFloat(pxStr),
      py: parseFloat(pyStr),
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    });
  };
  const onMouseLeave = () => { if (tooltip) setTooltip(null); };
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
          <defs>{symbols}</defs>
          <g ref={setEntitiesEl} id="run-map-entities">{uses}</g>
          <g ref={setSplittersEl} id="run-map-splitters" pointerEvents="none">{splitterMarkerNodes}</g>
          <g ref={setInsertersEl} id="run-map-inserters" pointerEvents="none">{inserterMarkerNodes}</g>
          <g ref={setRecipesEl} id="run-map-recipes" pointerEvents="none">{recipeUses}</g>
          {playerPos && (
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
            <div className="run-map-tooltip-name">{tooltip.name}</div>
            <div className="run-map-tooltip-coords">
              x {tooltip.px.toFixed(1)} · y {tooltip.py.toFixed(1)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
