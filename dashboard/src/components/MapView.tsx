import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtTime } from '../theme';
import {
  RECIPE_ICON_TILES,
  RECIPE_ICON_Y_OFFSET,
  ticksToMin,
  recipeSpriteId,
  playerAt,
  type MapData,
  type SpriteAtlas,
} from '../lib/mapModel';
import './MapView.css';

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
    while (buildCursor.current > 0 && byTb[buildCursor.current - 1].tb > tick) {
      buildCursor.current--;
      setDisplay(byTb[buildCursor.current].idx, false);
    }
    while (removeCursor.current > 0 && byTr[removeCursor.current - 1].tr > tick) {
      removeCursor.current--;
      setDisplay(byTr[removeCursor.current].idx, true);
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
      for (let j = e.rs.length - 1; j >= 0; j--) {
        if (e.rs[j].ts <= tick) { cur = j; break; }
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
    return Object.entries(sprites).map(([id, s]) => (
      <symbol key={id} id={id} overflow="visible">
        <image href={`data:image/png;base64,${s.data}`} width={s.w} height={s.h} preserveAspectRatio="none" />
      </symbol>
    ));
  }, [sprites]);

  // Render renderables once, all initially hidden. Keyed by array index:
  // a single entity can appear multiple times (one per FBSR Layer it
  // touches), so `en` is no longer unique. Memoized so React doesn't
  // re-create 25–30K elements on every tick / vb change.
  const uses = useMemo(() => {
    if (!data) return null;
    return data.entities.map((e, i) => (
      <use
        key={i}
        href={`#${e.sid}`}
        x={e.ox}
        y={e.oy}
        style={{ display: 'none' }}
        data-name={e.name}
        data-en={e.en}
        data-l={e.L}
        data-tb={e.tb}
        data-px={e.px}
        data-py={e.py}
      />
    ));
  }, [data]);

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
