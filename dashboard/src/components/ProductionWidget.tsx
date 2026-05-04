// One row of the end-game production stack. Renders a single mode at a time
// (rate / cumulative / buffer) into a horizontal slot inside the parent SVG.
// The x scale is provided by the parent so every row — and the run-overview
// chart above — share the same time axis.
//
// Rate mode: actual production filled, stacked stall-loss bands stacked above
// (one per missing item / fluid / non-working status), with the potential
// capacity drawn as a dashed reference line. The bands are pre-scaled in the
// data prep so the stack top tracks the potential line during stalls.
import { useMemo, useState, type RefObject } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { LinePath, AreaClosed } from '@visx/shape';
import { bisector } from 'd3-array';
import { curveStepAfter } from 'd3-shape';
import type { ScaleLinear } from 'd3-scale';
import { useGameData } from '../server/GameDataContext';
import { recipeMeta } from '../server/gameData';
import { COLORS, FONT, fmtTime } from '../theme';
import { containerXY, TooltipRow, type TooltipState } from './Tooltip';

// 'fluid-buffer' is buffer-mode for fluid tanks: same line rendering as
// 'buffer' but different headline + tooltip wording (tanks, not chests + inv).
// Data prep stores the per-tick fluid sum in `bufferWithInv` so the line path
// is identical.
export type ProductionMode = 'rate' | 'cum' | 'buffer' | 'fluid-buffer';

type StatusKey = 'no_ingredients' | 'no_fuel' | 'full_output' | 'low_power' | 'unknown';

// One stacked source within a combined rate row (e.g. basic + advanced oil
// processing under a single "Refinery throughput" row). Per-component
// label/color come from the runtime display config (componentMeta prop), not
// the per-run JSON, so editing recipes.json is enough to recolor.
export type RecipeComponent = {
  recipe: string;
  actual: number[];
  cum: number[];
  peakActual: number;
  finalCum: number;
};

export type ComponentMeta = { recipe: string; label: string; color: string };

// Per-recipe series. Display meta (label, color) lives in game-data and is
// looked up at render time via recipeMeta(); see src/server/gameData.ts.
export type Recipe = {
  recipe: string;
  chestCount: number;
  finalCum: number;
  peakActual: number;
  peakPotential: number;
  peakBuffer: number;
  peakBufferWithInv: number;
  actual: number[];
  potential: number[];
  itemsByLoss: string[];
  fluidsByLoss: string[];
  itemLoss: Record<string, number[] | undefined>;
  fluidLoss: Record<string, number[] | undefined>;
  statusLoss: Record<StatusKey, number[]>;
  cum: number[];
  buffer: number[];
  bufferWithInv: number[];
  // Buffer-limit reference. Per-tick chest/tank capacity (sum of buffers
  // built by tick i). Only populated when the chest buffer reaches the
  // approach threshold of capacity at some moment in the run — that's the
  // gate for rendering the dashed limit line in buffer / fluid-buffer modes.
  bufferLimit: number[] | null;
  peakBufferLimit: number;
  showBufferLimit: boolean;
  // Optional: when a row aggregates multiple sources, components carries the
  // per-source actual + cum so rate-mode can stack them in distinct colors.
  components?: RecipeComponent[];
};

type Props = {
  recipe: Recipe;
  minutes: number[];
  mode: ProductionMode;
  xScale: ScaleLinear<number, number>;
  innerW: number;
  rowH: number;
  marginLeft: number;
  marginRight: number;
  totalW: number;
  containerRef: RefObject<HTMLDivElement>;
  setTooltip: (s: TooltipState) => void;
  // Optional per-row label/color override. Useful when the same recipe key
  // appears multiple times with different roles (e.g. blue science as both a
  // rate row and a cumulative row in the oil-phase widget) so recipeMeta()'s
  // single recipe→meta lookup can't distinguish them.
  metaOverride?: { label: string; color: string };
  // Per-component display meta (label/color), keyed by recipe. Used when the
  // row aggregates multiple sources and the rate stack needs distinct colors
  // per source.
  componentMeta?: ComponentMeta[];
};

const bisectMinute = bisector<number, number>(m => m).left;

// Tuned for the Factorio-dark plot panel — bright cyan reads cleanly against
// the inset slate-gray surface; the line is one notch lighter than the fill.
const ACTUAL_FILL = '#1e9bbf';
const ACTUAL_LINE = '#7dd3e8';
const ITEM_PALETTE = ['#e74634', '#f3934e', '#cf833a', '#fbbb27', '#a23b1c', '#c4690b'];
const FLUID_PALETTE = ['#5fbff4', '#67e8f9', '#3aa8f0', '#7d5bd1'];
const STATUS_COLOR: Record<StatusKey, string> = {
  no_ingredients: '#a8865a',
  no_fuel:        '#1a1a1a',
  full_output:    '#fbbb27',
  low_power:      '#b14df5',
  unknown:        '#a09c97',
};
const LOSS_STATUS_ORDER: StatusKey[] = ['no_ingredients', 'no_fuel', 'full_output', 'low_power', 'unknown'];

export function ProductionRow({
  recipe,
  minutes,
  mode,
  xScale,
  innerW,
  rowH,
  marginLeft,
  marginRight,
  totalW,
  containerRef,
  setTooltip,
  metaOverride,
  componentMeta,
}: Props) {
  const gameData = useGameData();
  const lookupMeta = recipeMeta(gameData, recipe.recipe);
  const meta = metaOverride
    ? { recipe: recipe.recipe, label: metaOverride.label, color: metaOverride.color }
    : lookupMeta;
  // Combine the per-component data series (from the per-run JSON) with
  // per-component display meta (from runtime gameData) so the rate stack and
  // the rate-tooltip "sources" rows can use stable label/color while still
  // letting recipes.json edits take effect on reload.
  const renderComponents = useMemo(
    () => recipe.components?.map(c => {
      const m = componentMeta?.find(x => x.recipe === c.recipe);
      return { ...c, label: m?.label ?? c.recipe, color: m?.color ?? '#999999' };
    }),
    [recipe.components, componentMeta],
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const isBufferMode = mode === 'buffer' || mode === 'fluid-buffer';
  const showLimit = isBufferMode && recipe.showBufferLimit && recipe.bufferLimit != null;
  const peak = mode === 'rate'
    ? Math.max(recipe.peakPotential, recipe.peakActual)
    : mode === 'cum'
    ? recipe.finalCum
    : showLimit
    ? Math.max(recipe.peakBufferWithInv, recipe.peakBufferLimit)
    : recipe.peakBufferWithInv;

  const yScale = useMemo(
    () => scaleLinear<number>({
      domain: [0, niceCeiling(Math.max(1, peak * 1.1))],
      range: [rowH, 0],
      nice: true,
    }),
    [peak, rowH],
  );

  const handleMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fracX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const [d0, d1] = xScale.domain();
    const minute = d0 + fracX * (d1 - d0);
    const i = clampIdx(bisectMinute(minutes, minute), minutes.length);
    const idx = nearestMinute(minutes, i, minute);
    setHoverIdx(idx);

    const { x, y } = containerXY(e, containerRef);
    setTooltip({
      x,
      y,
      placement: 'top',
      content: buildProductionTooltip(recipe, meta, minutes, idx, mode, renderComponents),
    });
  };

  const handleLeave = () => {
    setHoverIdx(null);
    setTooltip(null);
  };

  const hoverX = hoverIdx != null ? xScale(minutes[hoverIdx]) : null;
  const hoverY =
    hoverIdx == null
      ? null
      : mode === 'rate'
      ? yScale(recipe.actual[hoverIdx])
      : mode === 'cum'
      ? yScale(recipe.cum[hoverIdx])
      : yScale(recipe.bufferWithInv[hoverIdx]);
  const hoverColor = mode === 'rate' ? ACTUAL_LINE : meta.color;

  const headline = mode === 'rate'
    ? `peak ${formatRate(recipe.peakActual)} / ${formatRate(recipe.peakPotential)} /min · total ${recipe.finalCum.toLocaleString('en-US')}`
    : mode === 'cum'
    ? `total ${recipe.finalCum.toLocaleString('en-US')}`
    : mode === 'fluid-buffer'
    ? `peak ${recipe.peakBufferWithInv.toLocaleString('en-US')} · ${recipe.chestCount} tank${recipe.chestCount === 1 ? '' : 's'}`
    : `peak ${recipe.peakBufferWithInv.toLocaleString('en-US')} · ${recipe.chestCount} chest${recipe.chestCount === 1 ? '' : 's'} + inv`;

  return (
    <>
      {/* Left-margin label. foreignObject so long labels wrap onto multiple
          lines instead of overflowing into the plot. */}
      <foreignObject x={0} y={0} width={marginLeft} height={rowH}>
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            textAlign: 'right',
            paddingRight: 10,
            boxSizing: 'border-box',
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 700,
            color: COLORS.textStrong,
            letterSpacing: '0.3px',
            lineHeight: 1.2,
            overflowWrap: 'break-word',
          }}
        >
          {meta.label}
        </div>
      </foreignObject>

      {/* Right-margin headline */}
      <text
        x={totalW - marginRight + 10}
        y={rowH / 2}
        dominantBaseline="middle"
        fontFamily={FONT}
        fontSize={11}
        fill={COLORS.text}
      >
        {headline}
      </text>

      <Group left={marginLeft} top={0}>
        <rect width={innerW} height={rowH} fill={COLORS.surface} />

        {/* Top + bottom row borders */}
        <line
          x1={0}
          x2={innerW}
          y1={0}
          y2={0}
          stroke={COLORS.grid}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
        <line
          x1={0}
          x2={innerW}
          y1={rowH}
          y2={rowH}
          stroke={COLORS.axis}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />

        {mode === 'rate'
          ? renderRateMode(recipe, renderComponents, minutes, xScale, yScale, rowH)
          : renderLineMode(recipe, meta.color, minutes, xScale, yScale, mode === 'cum' ? 'cum' : 'buffer')}

        {/* Compact y-axis tick: max value at top */}
        <text
          x={-6}
          y={2}
          textAnchor="end"
          dominantBaseline="hanging"
          fontFamily={FONT}
          fontSize={9.5}
          fill={COLORS.text}
        >
          {formatTickShort(yScale.domain()[1])}
        </text>

        {/* Hover crosshair + dot */}
        {hoverX != null && hoverY != null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={0}
              y2={rowH}
              stroke={COLORS.textStrong}
              strokeWidth={1}
              strokeOpacity={0.4}
              strokeDasharray="3 3"
            />
            <circle cx={hoverX} cy={hoverY} r={3} fill={hoverColor} stroke="#fff" strokeWidth={1} />
          </g>
        )}

        {/* Mouse capture overlay */}
        <rect
          width={innerW}
          height={rowH}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={handleLeave}
        />
      </Group>
    </>
  );
}

function clampIdx(i: number, n: number): number {
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

function nearestMinute(minutes: number[], i: number, m: number): number {
  if (i <= 0) return 0;
  if (i >= minutes.length) return minutes.length - 1;
  return m - minutes[i - 1] < minutes[i] - m ? i - 1 : i;
}

type RenderComponent = RecipeComponent & { label: string; color: string };

function buildProductionTooltip(
  recipe: Recipe,
  meta: { label: string; color: string },
  minutes: number[],
  i: number,
  mode: ProductionMode,
  renderComponents?: RenderComponent[],
) {
  const t = fmtTime(minutes[i]);
  const actual = recipe.actual[i];
  const potential = recipe.potential[i];
  const gap = Math.max(0, potential - actual);
  const cum = recipe.cum[i];
  const buf = recipe.bufferWithInv[i];
  const box = recipe.buffer[i];
  const inInv = Math.max(0, buf - box);

  return (
    <>
      <div className="chart-tooltip__title">
        <span>{meta.label}</span>
        <span className="time">{t}</span>
      </div>

      {mode === 'fluid-buffer' ? (
        <div className="chart-tooltip__tabs">
          <Tab
            label="buffer"
            color={meta.color}
            value={buf.toLocaleString('en-US')}
            active
          />
        </div>
      ) : (
        <div className="chart-tooltip__tabs">
          <Tab
            label="rate"
            color={ACTUAL_FILL}
            value={formatRate(actual)}
            unit="/min"
            active={mode === 'rate'}
          />
          <Tab
            label="production"
            color={meta.color}
            value={cum.toLocaleString('en-US')}
            active={mode === 'cum'}
          />
          <Tab
            label="buffer"
            color={meta.color}
            value={buf.toLocaleString('en-US')}
            active={mode === 'buffer'}
          />
        </div>
      )}

      {mode === 'rate' && renderRateDetails(recipe, i, potential, gap, renderComponents)}
      {mode === 'cum' && renderProductionDetails(recipe, cum)}
      {mode === 'buffer' && renderBufferDetails(box, inInv, recipe, i)}
      {mode === 'fluid-buffer' && renderFluidBufferDetails(recipe, i)}
    </>
  );
}

function Tab({
  label,
  value,
  unit,
  color,
  active,
}: {
  label: string;
  value: string;
  unit?: string;
  color: string;
  active: boolean;
}) {
  return (
    <div className={active ? 'chart-tooltip__tab chart-tooltip__tab--active' : 'chart-tooltip__tab'}>
      <div className="chart-tooltip__tab-label">
        <span className="chart-tooltip__swatch" style={{ background: color }} />
        {label}
      </div>
      <div className="chart-tooltip__tab-value">
        {value}
        {unit && <span className="chart-tooltip__tab-unit">{unit}</span>}
      </div>
    </div>
  );
}

function renderRateDetails(
  recipe: Recipe,
  i: number,
  potential: number,
  gap: number,
  renderComponents?: RenderComponent[],
) {
  type Loss = { color: string; label: string; value: number };
  const losses: Loss[] = [];
  for (const name of recipe.itemsByLoss) {
    const idx = recipe.itemsByLoss.indexOf(name);
    const v = recipe.itemLoss[name]?.[i] ?? 0;
    if (v > 0) losses.push({ color: ITEM_PALETTE[idx % ITEM_PALETTE.length], label: name, value: v });
  }
  for (const name of recipe.fluidsByLoss) {
    const idx = recipe.fluidsByLoss.indexOf(name);
    const v = recipe.fluidLoss[name]?.[i] ?? 0;
    if (v > 0) losses.push({ color: FLUID_PALETTE[idx % FLUID_PALETTE.length], label: name, value: v });
  }
  for (const name of LOSS_STATUS_ORDER) {
    const v = recipe.statusLoss[name][i];
    if (v > 0) losses.push({ color: STATUS_COLOR[name], label: name.replace(/_/g, ' '), value: v });
  }
  losses.sort((a, b) => b.value - a.value);
  const topLosses = losses.slice(0, 5);

  return (
    <>
      <div className="chart-tooltip__sep" />
      <TooltipRow label="potential" value={`${formatRate(potential)} /min`} muted />
      {gap > 0 && (
        <TooltipRow label="gap" value={`${formatRate(gap)} /min`} muted />
      )}
      {renderComponents && renderComponents.length > 0 && (
        <>
          <div className="chart-tooltip__details-label">sources</div>
          {renderComponents.map(c => (
            <TooltipRow
              key={c.recipe}
              color={c.color}
              label={c.label}
              value={`${formatRate(c.actual[i])} /min`}
            />
          ))}
        </>
      )}
      {topLosses.length > 0 && (
        <>
          <div className="chart-tooltip__details-label">stalled by</div>
          {topLosses.map(l => (
            <TooltipRow
              key={l.label}
              color={l.color}
              label={l.label}
              value={`${formatRate(l.value)} /min`}
            />
          ))}
        </>
      )}
    </>
  );
}

function renderProductionDetails(recipe: Recipe, cum: number) {
  const final = recipe.finalCum;
  const pct = final > 0 ? Math.round((cum / final) * 100) : 0;
  return (
    <>
      <div className="chart-tooltip__sep" />
      <TooltipRow label="of final" value={`${final.toLocaleString('en-US')} (${pct}%)`} muted />
    </>
  );
}

function renderBufferDetails(box: number, inInv: number, recipe: Recipe, i: number) {
  const limit = recipe.showBufferLimit && recipe.bufferLimit ? recipe.bufferLimit[i] : null;
  return (
    <>
      <div className="chart-tooltip__sep" />
      <TooltipRow label="box only" value={box.toLocaleString('en-US')} muted />
      <TooltipRow label="in inventory" value={inInv.toLocaleString('en-US')} muted />
      {limit != null && limit > 0 && (
        <TooltipRow
          label="chest limit"
          value={`${limit.toLocaleString('en-US')} (${Math.round((box / limit) * 100)}%)`}
          muted
        />
      )}
    </>
  );
}

function renderFluidBufferDetails(recipe: Recipe, i: number) {
  const limit = recipe.showBufferLimit && recipe.bufferLimit ? recipe.bufferLimit[i] : null;
  if (limit == null || limit <= 0) return null;
  const buf = recipe.bufferWithInv[i];
  return (
    <>
      <div className="chart-tooltip__sep" />
      <TooltipRow
        label="tank limit"
        value={`${limit.toLocaleString('en-US')} (${Math.round((buf / limit) * 100)}%)`}
        muted
      />
    </>
  );
}

function renderLineMode(
  recipe: Recipe,
  color: string,
  minutes: number[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  mode: 'cum' | 'buffer',
) {
  const series = mode === 'cum' ? recipe.cum : recipe.bufferWithInv;
  const points = minutes.map((m, i) => ({ minute: m, value: series[i] }));

  if (mode === 'cum') {
    return (
      <>
        <AreaClosed
          data={points}
          x={p => xScale(p.minute)}
          y={p => yScale(p.value)}
          yScale={yScale}
          fill={color}
          fillOpacity={0.22}
        />
        <LinePath
          data={points}
          x={p => xScale(p.minute)}
          y={p => yScale(p.value)}
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.95}
        />
      </>
    );
  }

  // buffer / fluid-buffer: draw the limit step-line first (under), then the
  // buffer line on top.
  const limitPoints = recipe.showBufferLimit && recipe.bufferLimit
    ? minutes.map((m, i) => ({ minute: m, value: recipe.bufferLimit![i] }))
    : null;

  return (
    <>
      {limitPoints && (
        <LinePath
          data={limitPoints}
          x={p => xScale(p.minute)}
          y={p => yScale(p.value)}
          curve={curveStepAfter}
          stroke={COLORS.text}
          strokeWidth={1}
          strokeOpacity={0.55}
          strokeDasharray="3 2"
        />
      )}
      <LinePath
        data={points}
        x={p => xScale(p.minute)}
        y={p => yScale(p.value)}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.95}
      />
    </>
  );
}

function renderRateMode(
  recipe: Recipe,
  renderComponents: RenderComponent[] | undefined,
  minutes: number[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  rowH: number,
) {
  type Layer = { minute: number; y0: number; y1: number; defined: boolean };

  const N = minutes.length;
  const actualPts = minutes.map((m, i) => ({ minute: m, value: recipe.actual[i] }));
  const potentialPts = minutes.map((m, i) => ({ minute: m, value: recipe.potential[i] }));

  // Component-stacked actual: bottom-up bands one per source, summing to
  // recipe.actual. When absent, fall back to a single teal area.
  const componentLayers = renderComponents && renderComponents.length > 0
    ? renderComponents.map((comp, idx) => {
        const layer: Layer[] = new Array(N);
        for (let i = 0; i < N; i++) {
          let y0 = 0;
          for (let j = 0; j < idx; j++) y0 += renderComponents[j].actual[i];
          const here = comp.actual[i];
          layer[i] = { minute: minutes[i], y0, y1: y0 + here, defined: here > 0 };
        }
        return { color: comp.color, label: comp.label, layer };
      })
    : null;

  // Stack order from the bottom up: items first (largest loss first), then
  // fluids, then statuses. Same order as production-d3.ts.
  type StackKey =
    | { kind: 'item'; name: string }
    | { kind: 'fluid'; name: string }
    | { kind: 'status'; name: StatusKey };
  const stackOrder: StackKey[] = [
    ...recipe.itemsByLoss.map((name): StackKey => ({ kind: 'item', name })),
    ...recipe.fluidsByLoss.map((name): StackKey => ({ kind: 'fluid', name })),
    ...LOSS_STATUS_ORDER.map((name): StackKey => ({ kind: 'status', name })),
  ];

  const lossAt = (i: number, key: StackKey): number => {
    if (key.kind === 'item')   return recipe.itemLoss[key.name]?.[i] ?? 0;
    if (key.kind === 'fluid')  return recipe.fluidLoss[key.name]?.[i] ?? 0;
    return recipe.statusLoss[key.name][i];
  };

  const buildLayer = (idx: number): Layer[] => {
    const out: Layer[] = new Array(N);
    for (let i = 0; i < N; i++) {
      let y0 = recipe.actual[i];
      for (let j = 0; j < idx; j++) y0 += lossAt(i, stackOrder[j]);
      const here = lossAt(i, stackOrder[idx]);
      out[i] = { minute: minutes[i], y0, y1: y0 + here, defined: here > 0 };
    }
    return out;
  };

  const colorFor = (key: StackKey): string => {
    if (key.kind === 'item')  {
      const idx = recipe.itemsByLoss.indexOf(key.name);
      return ITEM_PALETTE[idx % ITEM_PALETTE.length];
    }
    if (key.kind === 'fluid') {
      const idx = recipe.fluidsByLoss.indexOf(key.name);
      return FLUID_PALETTE[idx % FLUID_PALETTE.length];
    }
    return STATUS_COLOR[key.name];
  };

  return (
    <>
      {/* Actual production. Single teal area when there's one source; stacked
          per-component bands (bottom-up) when the row aggregates multiple. */}
      {componentLayers ? (
        componentLayers.map(({ color, label, layer }) => (
          <AreaClosed
            key={label}
            data={layer}
            x={d => xScale(d.minute)}
            y={d => yScale(d.y1)}
            y0={d => yScale(d.y0)}
            yScale={yScale}
            defined={d => d.defined}
            fill={color}
            fillOpacity={0.8}
          />
        ))
      ) : (
        <AreaClosed
          data={actualPts}
          x={p => xScale(p.minute)}
          y={p => yScale(p.value)}
          yScale={yScale}
          fill={ACTUAL_FILL}
          fillOpacity={0.85}
        />
      )}

      {/* Stacked loss bands. */}
      {stackOrder.map((key, idx) => {
        const layer = buildLayer(idx);
        return (
          <AreaClosed
            key={`${key.kind}-${key.name}`}
            data={layer}
            x={d => xScale(d.minute)}
            y={d => yScale(d.y1)}
            y0={d => yScale(d.y0)}
            yScale={yScale}
            defined={d => d.defined}
            fill={colorFor(key)}
            fillOpacity={0.6}
          />
        );
      })}

      {/* Thin actual-line through the bands keeps the boundary readable. */}
      <LinePath
        data={actualPts}
        x={p => xScale(p.minute)}
        y={p => yScale(p.value)}
        stroke={ACTUAL_LINE}
        strokeWidth={1}
        strokeOpacity={0.85}
      />

      {/* Potential reference (dashed). */}
      <LinePath
        data={potentialPts}
        x={p => xScale(p.minute)}
        y={p => yScale(p.value)}
        stroke={COLORS.text}
        strokeWidth={1}
        strokeOpacity={0.55}
        strokeDasharray="3 2"
      />

      {/* Suppress unused param warning for rowH (kept in signature for future
          tuning consistency). */}
      {rowH < 0 ? <text>{rowH}</text> : null}
    </>
  );
}

function formatRate(n: number): string {
  if (n >= 100) return Math.round(n).toLocaleString('en-US');
  return n.toFixed(1);
}

function formatTickShort(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  if (n >= 100) return Math.round(n).toString();
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

function niceCeiling(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const scaled = v / base;
  // Finer steps than 1/2/5/10 — without 6 and 8, values like 55k (peak 50k +
  // 10% pad, common when the buffer sits at its limit) round all the way up
  // to 100k and waste half the row.
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const stepped = steps.find(s => scaled <= s) ?? 10;
  return stepped * base;
}
