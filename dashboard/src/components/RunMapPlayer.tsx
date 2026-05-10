import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from '../theme';
import { mapUrlFor } from '../data/maps';
import './RunMapPlayer.css';

// Player for the FBSR-rendered base map. Map data is fetched as a static
// asset (not bundled) because it's multi-MB per run.
//
// Time scrub uses incremental DOM mutation: entities are pre-sorted by tb so
// React renders them once, then we walk forward/back through "build" and
// "remove" cursors, toggling display on only the entities that crossed the
// time boundary. O(delta) per tick change, scales to 15K+ entities.
//
// Pan/zoom: viewBox manipulation in world units; xMidYMid-meet letterboxing
// is accounted for in the screen→world math.

type SpriteDef = { w: number; h: number; data: string };
type RecipeEvent = { ts: number; n: string };
// One renderable per (entity, FBSR Layer). `en` may repeat across entries
// (e.g. an inserter has base + arm + indicators + shadow); they share tb/tr
// because they were built/removed together.
type Renderable = {
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
type RecipeMachine = {
  en: number;
  name: string;
  px: number;
  py: number;
  rs: RecipeEvent[];
};
type PlayerTrack = {
  name: string;
  period: number;      // ticks between samples
  positions: [number, number][];
};
type MapData = {
  runName: string;
  viewBox: [number, number, number, number];
  durationTick: number;
  entities: Renderable[];
  recipeMachines: RecipeMachine[];
  playerTrack: PlayerTrack | null;
};
type SpriteAtlas = Record<string, SpriteDef>;

// FBSR-parity recipe-icon geometry. Java emits a 1.6-tile sprite (1.4 icon
// + 0.1 border on each side, with a rounded translucent-black background);
// we position it so its center sits 0.3 tiles above the entity center —
// same offset CraftingMachineRendering / FurnaceRendering use internally.
const RECIPE_ICON_TILES = 1.6;
const RECIPE_ICON_Y_OFFSET = -0.3;

const TICKS_PER_MIN = 60 * 60;
function ticksToMin(ticks: number) { return ticks / TICKS_PER_MIN; }
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

// Player position at arbitrary tick — linear interpolation between samples.
function playerAt(track: PlayerTrack, tick: number): [number, number] | null {
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

export function RunMapPlayer({ runName }: { runName: string }) {
  const [data, setData] = useState<MapData | null>(null);
  const [sprites, setSprites] = useState<SpriteAtlas | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(120);

  type VB = { x: number; y: number; w: number; h: number };
  const [vb, setVb] = useState<VB | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const entitiesRef = useRef<SVGGElement>(null);
  const recipesRef = useRef<SVGGElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; vb0: VB } | null>(null);

  // Cursors track which prefix of byTb / byTr have already been applied to
  // the DOM. Stored in refs so playback / scrubbing don't trigger re-renders.
  const buildCursor = useRef(0);
  const removeCursor = useRef(0);
  // Last applied recipe-event index per entity (entityIdx → eventIdx, -1 = none).
  const lastRecipeIdx = useRef(new Map<number, number>());

  // Fetch map data + sprites in parallel. Sprites live in game-data so the
  // browser caches them under the same URL contract as the rest of the
  // shared assets (and per-run map.json stays small).
  useEffect(() => {
    let cancelled = false;
    setData(null); setSprites(null); setErr(null);
    const mapUrl = mapUrlFor(runName);
    if (!mapUrl) { setErr(`no map data for ${runName}`); return; }
    const spritesUrl = `${import.meta.env.BASE_URL}game-data/map-sprites/${runName}.json`;
    Promise.all([
      fetch(mapUrl).then(r => { if (!r.ok) throw new Error(`${r.status} ${mapUrl}`); return r.json(); }),
      fetch(spritesUrl).then(r => { if (!r.ok) throw new Error(`${r.status} ${spritesUrl}`); return r.json(); }),
    ])
      .then(([m, s]) => { if (!cancelled) { setData(m); setSprites(s); } })
      .catch(e => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [runName]);

  // Reset on data change
  useEffect(() => {
    if (!data) return;
    setTick(0);
    const [x, y, w, h] = data.viewBox;
    setVb({ x, y, w, h });
    buildCursor.current = 0;
    removeCursor.current = 0;
    lastRecipeIdx.current.clear();
  }, [data]);

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

  // Apply tick changes incrementally to the DOM. Entities are rendered once
  // in tb-sorted order; we toggle display on only the elements that crossed
  // the build/remove boundaries since the last apply.
  useEffect(() => {
    const container = entitiesRef.current;
    if (!container || !data) return;
    const setDisplay = (idx: number, visible: boolean) => {
      const el = container.children[idx] as SVGElement | undefined;
      if (el) el.style.display = visible ? '' : 'none';
    };
    // Forward
    while (buildCursor.current < byTb.length && byTb[buildCursor.current].tb <= tick) {
      setDisplay(byTb[buildCursor.current].idx, true);
      buildCursor.current++;
    }
    while (removeCursor.current < byTr.length && byTr[removeCursor.current].tr <= tick) {
      setDisplay(byTr[removeCursor.current].idx, false);
      removeCursor.current++;
    }
    // Backward (scrubbing left)
    while (buildCursor.current > 0 && byTb[buildCursor.current - 1].tb > tick) {
      buildCursor.current--;
      setDisplay(byTb[buildCursor.current].idx, false);
    }
    while (removeCursor.current > 0 && byTr[removeCursor.current - 1].tr > tick) {
      removeCursor.current--;
      // Restoring a previously-removed entity. It's only visible again if
      // it's also currently within the "built" prefix — but if its tr was
      // ever <= some earlier tick, then its tb was <= that tick too, and
      // since we're scrubbing back, current tick >= tb. So safe to show.
      setDisplay(byTr[removeCursor.current].idx, true);
    }
  }, [tick, data, byTb, byTr]);

  // Recipe overlay: walk each machine's recipe timeline and update the
  // matching <use>'s href when its current recipe changes. Recipe lists are
  // tiny (median 1, max ~handful), so we rebind across the full set on each
  // tick — well under a millisecond for ~hundreds of machines.
  useEffect(() => {
    const container = recipesRef.current;
    if (!container || !data || !sprites) return;
    for (let i = 0; i < recipeMachines.length; i++) {
      const e = recipeMachines[i];
      // findLast index where rs[j].ts <= tick
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
        const sid = `r:${e.rs[cur].n}`;
        if (sprites[sid]) {
          el.setAttribute('href', `#${sid}`);
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      }
    }
  }, [tick, data, sprites, recipeMachines]);

  // Playback loop
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last; last = now;
      const tickPerMs = (playSpeed * 60) / 1000;
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

  // Pan/zoom
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!svgRef.current || !vb) return;
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
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
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !vb) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, vb0: vb };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current; if (!d || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const fit = fitRect(rect.width, rect.height, d.vb0.w, d.vb0.h);
    const dxWorld = (e.clientX - d.startX) * (d.vb0.w / fit.fitW);
    const dyWorld = (e.clientY - d.startY) * (d.vb0.h / fit.fitH);
    setVb({ x: d.vb0.x - dxWorld, y: d.vb0.y - dyWorld, w: d.vb0.w, h: d.vb0.h });
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };
  const resetView = () => {
    if (!data) return;
    const [x, y, w, h] = data.viewBox;
    setVb({ x, y, w, h });
  };

  // Initial fitted aspect ratio (full-extent viewBox, not the zoomed one)
  const containerStyle = useMemo(() => {
    if (!data) return undefined;
    const [, , w, h] = data.viewBox;
    return { aspectRatio: `${w} / ${h}` };
  }, [data]);

  const symbols = useMemo(() => {
    if (!sprites) return null;
    return Object.entries(sprites).map(([id, s]) => (
      <symbol key={id} id={id} overflow="visible">
        <image href={`data:image/png;base64,${s.data}`} width={s.w} height={s.h} preserveAspectRatio="none" />
      </symbol>
    ));
  }, [sprites]);

  // Render renderables once, all initially hidden. The visibility effect
  // takes it from there. Keyed by array index: a single entity can appear
  // multiple times (one per FBSR Layer it touches), so `en` is no longer
  // unique. Memoized so React doesn't re-create 25–30K elements on every
  // tick / vb change.
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
      />
    ));
  }, [data]);

  // Recipe-icon <use> elements — one per machine that ever set a recipe.
  // Hidden until the cursor walk binds them to a sprite at the current tick.
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
        <span className="run-map-title">Map playback</span>
        <span className="run-map-meta">
          <span className="run-map-meta-label">t</span>
          {fmtTime(curMin)}
          <span className="run-map-meta-sep">/</span>
          {fmtTime(totalMin)}
        </span>
      </div>

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

      <div className="run-map-canvas-wrap" style={containerStyle}>
        <svg
          ref={svgRef}
          className="run-map-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>{symbols}</defs>
          <g ref={entitiesRef} id="run-map-entities">{uses}</g>
          <g ref={recipesRef} id="run-map-recipes" pointerEvents="none">{recipeUses}</g>
          {playerPos && (
            <g className="run-map-player-marker" pointerEvents="none">
              <circle cx={playerPos[0]} cy={playerPos[1]} r={0.7} className="run-map-player-halo" />
              <circle cx={playerPos[0]} cy={playerPos[1]} r={0.35} className="run-map-player-dot" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
