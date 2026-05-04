// Single SVG that lays out (top → bottom):
//   1. Research ribbon (tech icons + per-pack lanes)
//   2. Main chart plot (lab saturation, with phase bands overlayed)
//   3. Phase strip (named blocks with start/end/duration)
//   4. Shared x-axis (game time)
// Everything shares one x scale so the four sections line up exactly.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { useGameData } from '../server/GameDataContext';
import { augmentResearchIntervals } from '../server/gameData';
import { ResearchRibbon, getRibbonHeight } from './ResearchRibbon';
import { LabSaturationChart } from './LabSaturationChart';
import { PhaseBands } from './PhaseBands';
import { PhaseStrip } from './PhaseStrip';
import { Legend } from './Legend';
import { ChartTooltip, type TooltipState } from './Tooltip';
import './RunOverview.css';

const W = 1500;
// MARGIN_LEFT must match EndGameWidgets so the end-game plot region renders
// at the same pixel offset as this chart's plot region — both SVGs scale
// uniformly inside the same dashboard width. Wider than this chart strictly
// needs (its y-axis is just lab counts), but the end-game row labels need it.
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const MARGIN_TOP = 16;
// Layout order is: ribbon → plot → time axis → phase strip. The strip sits
// LAST so its active-phase chevron lands right at the SVG bottom, directly
// above the phase analyzer panel — no axis wedged in between to break the
// visual link from the active band into the analyzer below.
const MARGIN_BOTTOM = 0;
const RIBBON_TO_PLOT_GAP = 18;
const PLOT_H = 280;
const PLOT_TO_AXIS_GAP = 4;
const AXIS_H = 36;
const AXIS_TO_STRIP_GAP = 6;
const STRIP_H = 92;
// Extra space below the strip for the active-phase chevron to extend into.
const STRIP_BOTTOM_OVERHANG = 8;

type Props = {
  run: Run;
  activePhase?: string | null;
  onSelectPhase?: (name: string) => void;
  isPhaseSelectable?: (name: string) => boolean;
  children?: ReactNode;
};

export function RunOverview({ run, activePhase, onSelectPhase, isPhaseSelectable, children }: Props) {
  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const gameData = useGameData();

  const researchIntervals = useMemo(
    () => augmentResearchIntervals(run.researchIntervals, gameData),
    [run, gameData],
  );

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [innerW, run.durationMin],
  );

  const peakLabs = useMemo(
    () => run.points.reduce((m, p) => Math.max(m, p.total), 0),
    [run.points],
  );
  const yMax = niceCeiling(peakLabs * 1.15);
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: [0, yMax], range: [PLOT_H, 0], nice: true }),
    [yMax],
  );

  const ribbonH = getRibbonHeight(researchIntervals, xScale, run.packsUsed.length);

  const ribbonTop = MARGIN_TOP;
  const plotTop = ribbonTop + ribbonH + RIBBON_TO_PLOT_GAP;
  const axisTop = plotTop + PLOT_H + PLOT_TO_AXIS_GAP;
  const stripTop = axisTop + AXIS_H + AXIS_TO_STRIP_GAP;
  const totalH = stripTop + STRIP_H + STRIP_BOTTOM_OVERHANG + MARGIN_BOTTOM;

  const xTickValues = range(0, run.durationMin + 0.001, 15);

  return (
    <section className="run-overview">
      <header className="run-overview__header">
        <h2>Run overview</h2>
        <span className="run-overview__sub">
          Research throughput · lab saturation · build phases
        </span>
      </header>
      <div className="run-overview__chart" ref={containerRef}>
        <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
          <rect width={W} height={totalH} fill={COLORS.surface} />

          <Group left={MARGIN_LEFT} top={ribbonTop}>
            <ResearchRibbon
              innerW={innerW}
              xScale={xScale}
              researchIntervals={researchIntervals}
              packsUsed={run.packsUsed}
              containerRef={containerRef}
              setTooltip={setTooltip}
            />
          </Group>

          <Group left={MARGIN_LEFT} top={plotTop}>
            <LabSaturationChart
              innerW={innerW}
              innerH={PLOT_H}
              xScale={xScale}
              yScale={yScale}
              points={run.points}
              idleRects={run.idleRects}
              packsUsed={run.packsUsed}
              phases={run.phases}
              researchIntervals={researchIntervals}
              containerRef={containerRef}
              setTooltip={setTooltip}
            />
            <PhaseBands innerH={PLOT_H} xScale={xScale} phases={run.phases} />
          </Group>

          <Group left={MARGIN_LEFT} top={stripTop}>
            <PhaseStrip
              height={STRIP_H}
              innerW={innerW}
              xScale={xScale}
              phases={run.phases}
              activePhase={activePhase}
              onSelectPhase={onSelectPhase}
              isSelectable={isPhaseSelectable}
            />
          </Group>

          <Group left={MARGIN_LEFT} top={axisTop}>
            <AxisBottom
              scale={xScale}
              tickValues={xTickValues}
              tickFormat={(d: number | { valueOf(): number }) =>
                fmtTimeNoSec(typeof d === 'number' ? d : d.valueOf())}
              stroke={COLORS.axis}
              tickStroke={COLORS.axis}
              tickLabelProps={() => ({
                fill: COLORS.text,
                fontFamily: FONT,
                fontSize: 14,
                textAnchor: 'middle',
                dy: '0.4em',
              })}
            />
            <text
              x={innerW / 2}
              y={AXIS_H - 4}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={14}
              fill={COLORS.text}
            >
              game time
            </text>
          </Group>

          <Group left={W - MARGIN_RIGHT + 18} top={plotTop}>
            <Legend packsUsed={run.packsUsed} />
          </Group>
        </svg>
        <ChartTooltip state={tooltip} />
      </div>
      {children}
    </section>
  );
}

function niceCeiling(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const scaled = v / base;
  let stepped: number;
  if (scaled <= 1) stepped = 1;
  else if (scaled <= 2) stepped = 2;
  else if (scaled <= 5) stepped = 5;
  else stepped = 10;
  return stepped * base;
}
