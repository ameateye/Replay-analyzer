// Stacked-area saturation chart. Renders as a sub-group inside the parent
// RunOverview SVG; takes a pre-built x scale so other layers (research ribbon,
// phase bands, phase strip, x-axis) align on the same time axis.
import { useState, type RefObject } from 'react';
import { AreaClosed, LinePath } from '@visx/shape';
import { AxisLeft } from '@visx/axis';
import { bisector } from 'd3-array';
import type { ScaleLinear } from 'd3-scale';
import type { Run } from '../data';
import { COLORS, FONT, PACK_COLOR, PACK_SHORT, fmtTime } from '../theme';
import { containerXY, TooltipRow, type TooltipState } from './Tooltip';

type Point = Run['points'][number];
type IdleRect = Run['idleRects'][number];
type Phase = Run['phases'][number];
type ResearchInterval = Run['researchIntervals'][number];

type Props = {
  innerW: number;
  innerH: number;
  xScale: ScaleLinear<number, number>;
  yScale: ScaleLinear<number, number>;
  points: Point[];
  idleRects: IdleRect[];
  packsUsed: string[];
  phases: Phase[];
  researchIntervals: ResearchInterval[];
  containerRef: RefObject<HTMLDivElement>;
  setTooltip: (s: TooltipState) => void;
};

const bisectByMinute = bisector<Point, number>(p => p.minute).left;

export function LabSaturationChart({
  innerW,
  innerH,
  xScale,
  yScale,
  points,
  idleRects,
  packsUsed,
  phases,
  researchIntervals,
  containerRef,
  setTooltip,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const saturatedLayer = points.map(p => ({
    minute: p.minute,
    y0: 0,
    y1: p.active ?? 0,
    defined: p.active !== null,
  }));

  const missingLayers = packsUsed.map((pack, packIdx) => {
    return points.map(p => {
      const sat = p.active ?? 0;
      let cumBefore = 0;
      for (let j = 0; j < packIdx; j++) {
        cumBefore += p.missingByPack?.[packsUsed[j]] ?? 0;
      }
      const here = p.missingByPack?.[pack] ?? 0;
      return {
        minute: p.minute,
        y0: sat + cumBefore,
        y1: sat + cumBefore + here,
        defined: p.missingByPack !== null && here > 0,
      };
    });
  });

  const isIdleAt = (minute: number) =>
    idleRects.some(r => minute >= r.startMin && minute <= r.startMin + r.widthMin);

  const phaseAt = (minute: number) =>
    phases.find(p => p.startMin != null && p.endMin != null && minute >= p.startMin && minute <= p.endMin);

  const researchAt = (minute: number) =>
    researchIntervals.find(iv => minute >= iv.startMin && minute <= iv.endMin);

  const handleMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fracX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const minute = xScale.invert(fracX * innerW);
    const i = clampIdx(bisectByMinute(points, minute), points.length);
    const idx = nearestOf(points, i, minute);
    setHoverIdx(idx);

    const p = points[idx];
    const phase = phaseAt(p.minute);
    const idle = isIdleAt(p.minute);
    const research = researchAt(p.minute);
    const missingEntries = packsUsed
      .map(pack => ({ pack, n: p.missingByPack?.[pack] ?? 0 }))
      .filter(e => e.n > 0)
      .sort((a, b) => b.n - a.n);
    const missingTotal = missingEntries.reduce((s, e) => s + e.n, 0);

    const { x, y } = containerXY(e, containerRef);
    setTooltip({
      x,
      y,
      placement: 'top',
      content: (
        <>
          <div className="chart-tooltip__title">
            <span style={{ color: phase?.color ?? '#fff' }}>{phase?.name ?? 'Run'}</span>
            <span className="time">{fmtTime(p.minute)}</span>
          </div>
          {research && (
            <div className="chart-tooltip__row chart-tooltip__row--muted" style={{ alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {research.iconUrl && (
                  <img src={research.iconUrl} alt="" width={16} height={16} style={{ display: 'block' }} />
                )}
                <span style={{ textTransform: 'capitalize' }}>{research.name.replace(/-/g, ' ')}</span>
              </span>
              <span />
            </div>
          )}
          {idle ? (
            <div className="chart-tooltip__note">research idle</div>
          ) : (
            <>
              <TooltipRow color={COLORS.saturated} label="active labs" value={fmt1(p.active ?? 0)} />
              <TooltipRow color={COLORS.potentialLine} label="total labs" value={fmt1(p.total)} />
              {missingEntries.length > 0 && (
                <>
                  <div className="chart-tooltip__sep" />
                  <div className="chart-tooltip__row chart-tooltip__row--muted">
                    <span>missing</span>
                    <span>{fmt1(missingTotal)}</span>
                  </div>
                  {missingEntries.map(({ pack, n }) => (
                    <TooltipRow
                      key={pack}
                      color={PACK_COLOR[pack]}
                      label={PACK_SHORT[pack] ?? pack}
                      value={fmt1(n)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </>
      ),
    });
  };

  const handleLeave = () => {
    setHoverIdx(null);
    setTooltip(null);
  };

  const hoverX = hoverIdx != null ? xScale(points[hoverIdx].minute) : null;

  return (
    <g>
      {/* Plot panel */}
      <rect width={innerW} height={innerH} fill={COLORS.surface} />

      {/* Potential baseline — fills under the total curve. Visible mainly
          during non-measurable spans where the saturation stack collapses. */}
      <AreaClosed
        data={points}
        x={p => xScale(p.minute)}
        y={p => yScale(p.total)}
        yScale={yScale}
        fill={COLORS.potentialFill}
        opacity={0.9}
      />

      {/* Y-grid */}
      {yScale.ticks(6).map(t => (
        <line
          key={`grid-${t}`}
          x1={0}
          x2={innerW}
          y1={yScale(t)}
          y2={yScale(t)}
          stroke={COLORS.grid}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
      ))}

      {/* Saturated bottom layer */}
      <AreaClosed
        data={saturatedLayer}
        x={d => xScale(d.minute)}
        y={d => yScale(d.y1)}
        y0={d => yScale(d.y0)}
        yScale={yScale}
        defined={d => d.defined}
        fill={COLORS.saturated}
        opacity={0.85}
      />

      {/* Missing-by-pack stacks, in canonical tier order */}
      {missingLayers.map((layer, i) => (
        <AreaClosed
          key={`miss-${packsUsed[i]}`}
          data={layer}
          x={d => xScale(d.minute)}
          y={d => yScale(d.y1)}
          y0={d => yScale(d.y0)}
          yScale={yScale}
          defined={d => d.defined}
          fill={PACK_COLOR[packsUsed[i]]}
          opacity={0.5}
        />
      ))}

      {/* Saturated top edge */}
      <LinePath
        data={points}
        x={p => xScale(p.minute)}
        y={p => yScale(p.active ?? 0)}
        defined={p => p.active !== null}
        stroke={COLORS.saturatedLine}
        strokeWidth={1.2}
        strokeOpacity={0.85}
      />

      {/* Total (potential) outline */}
      <LinePath
        data={points}
        x={p => xScale(p.minute)}
        y={p => yScale(p.total)}
        stroke={COLORS.potentialLine}
        strokeWidth={1.4}
        strokeOpacity={0.9}
      />

      {/* Idle bands — drawn ON TOP so meaningless saturation during research
          gaps is masked, with the underlying total faintly readable. */}
      {idleRects.map((r, i) => (
        <rect
          key={`idle-${i}`}
          x={xScale(r.startMin)}
          y={0}
          width={Math.max(1, xScale(r.startMin + r.widthMin) - xScale(r.startMin))}
          height={innerH}
          fill={COLORS.idle}
          opacity={0.85}
          stroke={COLORS.idleBorder}
          strokeWidth={0.5}
        />
      ))}

      <AxisLeft
        scale={yScale}
        numTicks={6}
        hideAxisLine
        hideTicks
        tickLabelProps={() => ({
          fill: COLORS.text,
          fontFamily: FONT,
          fontSize: 14,
          textAnchor: 'end',
          dx: '-0.6em',
          dy: '0.32em',
        })}
      />
      <text
        transform={`rotate(-90) translate(${-innerH / 2}, -42)`}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={15}
        fill={COLORS.text}
      >
        labs
      </text>

      {/* Hover crosshair + dot */}
      {hoverX != null && hoverIdx != null && (
        <g pointerEvents="none">
          <line
            x1={hoverX}
            x2={hoverX}
            y1={0}
            y2={innerH}
            stroke={COLORS.textStrong}
            strokeWidth={1}
            strokeOpacity={0.4}
            strokeDasharray="3 3"
          />
          <circle
            cx={hoverX}
            cy={yScale(points[hoverIdx].total)}
            r={3}
            fill={COLORS.potentialLine}
            stroke="#fff"
            strokeWidth={1}
          />
          {points[hoverIdx].active !== null && (
            <circle
              cx={hoverX}
              cy={yScale(points[hoverIdx].active ?? 0)}
              r={3}
              fill={COLORS.saturated}
              stroke="#fff"
              strokeWidth={1}
            />
          )}
        </g>
      )}

      {/* Mouse capture overlay — kept last so it sits above the data. */}
      <rect
        width={innerW}
        height={innerH}
        fill="transparent"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      />
    </g>
  );
}

function clampIdx(i: number, n: number): number {
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

function nearestOf(points: Point[], i: number, m: number): number {
  if (i <= 0) return 0;
  if (i >= points.length) return points.length - 1;
  const a = points[i - 1];
  const b = points[i];
  return m - a.minute < b.minute - m ? i - 1 : i;
}

// Lab counts can be fractional during partial-saturation aggregation.
// Show as integer when whole, otherwise one decimal.
function fmt1(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}
