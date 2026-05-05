// Burner-phase analysis widget. Renders two sections that share a
// burner-phase-scoped x-axis (0 → last burner removal + 5 min):
//
//   1. Burner miners — one ProductionRow per resource (count mode).
//      Right-margin headline reports "X burners running for Y minutes"
//      via a headlineOverride.
//
//   2. Manual gathering — wood / stone / coal cumulatively gathered by
//      the player from chopping trees and mining rocks. Pickups from
//      chests / miners are filtered out in prep (proximity heuristic).
//
// Display meta (label / color) for both sections lives in recipes.json
// under burnerPhaseDisplay / manualGatheringDisplay; the widget looks
// it up at runtime so editing labels takes effect on reload.
import { useMemo, useRef, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { ScaleLinear } from 'd3-scale';
import type { RefObject } from 'react';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { ProductionRow, type ProductionMode, type Recipe } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import { useGameData } from '../server/GameDataContext';
import './EndGameWidgets.css';

const W = 1500;
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const TOP_PAD = 8;
const ROW_H = 78;
const ROW_GAP = 6;
const X_AXIS_H = 32;

type RowData = Recipe & {
  key: string;
  mode: ProductionMode;
  runningMin?: number;
  cumAtPhaseEnd?: number;
};

type BurnerPhaseData = {
  durationMin: number;
  startMin: number;
  endMin: number | null;
  xMaxMin: number;
  minutes: number[];
  rows: RowData[];
};

type ManualGatheringData = {
  minutes: number[];
  rows: RowData[];
};

export function BurnerPhaseWidget({ run }: { run: Run }) {
  const bp = run.burnerPhase as BurnerPhaseData | null | undefined;
  const mg = (run as Run & { manualGathering?: ManualGatheringData | null }).manualGathering;
  const gameData = useGameData();
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xMax = bp?.xMaxMin ?? run.durationMin;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, xMax], range: [0, innerW] }),
    [xMax, innerW],
  );

  if (!bp) {
    return (
      <section className="end-game">
        <header className="end-game__header">
          <div>
            <h2>Burner phase</h2>
            <span className="end-game__sub">
              Miner activity not collected for this run — re-extract with the
              latest control.lua to populate burner counts.
            </span>
          </div>
        </header>
      </section>
    );
  }

  const burnerCfg = gameData.recipes.burnerPhaseDisplay;
  const burnerDisplayByKey = new Map(burnerCfg?.rows?.map(r => [r.key, r]) ?? []);
  const burnerRows = bp.rows
    .map(r => ({ row: r, display: burnerDisplayByKey.get(r.key) }))
    .filter((entry): entry is { row: RowData; display: NonNullable<typeof entry.display> } =>
      entry.display != null,
    );

  const rangeText = bp.endMin != null
    ? `${fmtTimeNoSec(bp.startMin)}–${fmtTimeNoSec(bp.endMin)}`
    : `from ${fmtTimeNoSec(bp.startMin)}`;
  const burnerEndX = bp.endMin != null ? xScale(bp.endMin) : null;

  return (
    <>
      <section className="end-game">
        <header className="end-game__header">
          <div>
            <h2>Burner phase</h2>
            <span className="end-game__sub">
              {rangeText} · active burner-mining-drills by resource patch
            </span>
          </div>
        </header>
        <div className="end-game__chart" ref={containerRef}>
          {renderRowSection({
            rows: burnerRows,
            minutes: bp.minutes,
            xScale,
            innerW,
            containerRef,
            setTooltip,
            phaseEndX: burnerEndX,
            phaseEndLabel: 'burner phase end',
            renderHeadline: (row) =>
              row.runningMin != null
                ? `${row.peakBufferWithInv} burners running for ${formatMin(row.runningMin)}`
                : undefined,
          })}
          <ChartTooltip state={tooltip} />
        </div>
      </section>

      <ManualGatheringSection
        data={mg ?? null}
        gameData={gameData}
        xScale={xScale}
        innerW={innerW}
        phaseEndX={burnerEndX}
      />
    </>
  );
}

// Companion section rendered immediately below the burner counts. Same
// x-axis scope (xScale comes from the parent), so the two charts read
// as a single time-aligned analysis of "what fueled the burner stack
// and when did it taper".
function ManualGatheringSection({
  data,
  gameData,
  xScale,
  innerW,
  phaseEndX,
}: {
  data: ManualGatheringData | null;
  gameData: ReturnType<typeof useGameData>;
  xScale: ScaleLinear<number, number>;
  innerW: number;
  phaseEndX: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  if (!data) {
    return (
      <section className="end-game">
        <header className="end-game__header">
          <div>
            <h2>Manual gathering</h2>
            <span className="end-game__sub">
              Player inventory / position not collected for this run.
            </span>
          </div>
        </header>
      </section>
    );
  }

  const cfg = gameData.recipes.manualGatheringDisplay;
  const displayByKey = new Map(cfg?.rows?.map(r => [r.key, r]) ?? []);
  const rows = data.rows
    .map(r => ({ row: r, display: displayByKey.get(r.key) }))
    .filter((entry): entry is { row: RowData; display: NonNullable<typeof entry.display> } =>
      entry.display != null,
    );

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Manual gathering</h2>
          <span className="end-game__sub">
            Wood chopped &amp; rocks mined by the player · pickups from chests / miners filtered out
          </span>
        </div>
      </header>
      <div className="end-game__chart" ref={containerRef}>
        {renderRowSection({
          rows,
          minutes: data.minutes,
          xScale,
          innerW,
          containerRef,
          setTooltip,
          phaseEndX,
          phaseEndLabel: 'burner phase end',
          renderHeadline: (row) =>
            row.cumAtPhaseEnd != null
              ? `${row.cumAtPhaseEnd.toLocaleString('en-US')} by burner end`
              : undefined,
        })}
        <ChartTooltip state={tooltip} />
      </div>
    </section>
  );
}

// Shared SVG body for both sections — N stacked ProductionRows + a
// shared bottom x-axis + an optional dashed marker at the burner-phase
// end. Pulled out so both sections render identically modulo content.
function renderRowSection({
  rows,
  minutes,
  xScale,
  innerW,
  containerRef,
  setTooltip,
  phaseEndX,
  phaseEndLabel,
  renderHeadline,
}: {
  rows: { row: RowData; display: { label: string; color: string } }[];
  minutes: number[];
  xScale: ScaleLinear<number, number>;
  innerW: number;
  containerRef: RefObject<HTMLDivElement>;
  setTooltip: (s: TooltipState) => void;
  phaseEndX: number | null;
  phaseEndLabel: string;
  renderHeadline?: (row: RowData) => string | undefined;
}) {
  void containerRef;
  const totalH = TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;
  const xTickValues = range(0, xScale.domain()[1] + 0.001, niceTickStep(xScale.domain()[1]));
  const stackH = rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP;

  return (
    <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
      <rect width={W} height={totalH} fill={COLORS.surface} />

      {rows.map(({ row, display }, i) => {
        const top = TOP_PAD + i * (ROW_H + ROW_GAP);
        const headline = renderHeadline?.(row);
        return (
          <Group key={row.key} top={top}>
            <ProductionRow
              recipe={row}
              minutes={minutes}
              mode={row.mode}
              xScale={xScale}
              innerW={innerW}
              rowH={ROW_H}
              marginLeft={MARGIN_LEFT}
              marginRight={MARGIN_RIGHT}
              totalW={W}
              containerRef={containerRef}
              setTooltip={setTooltip}
              metaOverride={{ label: display.label, color: display.color }}
              headlineOverride={headline}
            />
          </Group>
        );
      })}

      {phaseEndX != null && rows.length > 0 && (
        <Group left={MARGIN_LEFT} top={TOP_PAD}>
          <line
            x1={phaseEndX}
            x2={phaseEndX}
            y1={0}
            y2={stackH}
            stroke={COLORS.accent}
            strokeOpacity={0.6}
            strokeWidth={1.25}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
          <text
            x={phaseEndX + 6}
            y={12}
            fontFamily={FONT}
            fontSize={11}
            fill={COLORS.accent}
            letterSpacing={0.3}
            pointerEvents="none"
          >
            {phaseEndLabel}
          </text>
        </Group>
      )}

      <Group left={MARGIN_LEFT} top={TOP_PAD + stackH}>
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
            fontSize: 13,
            textAnchor: 'middle',
            dy: '0.4em',
          })}
        />
        <text
          x={innerW / 2}
          y={X_AXIS_H - 4}
          textAnchor="middle"
          fontFamily={FONT}
          fontSize={13}
          fill={COLORS.text}
        >
          game time
        </text>
      </Group>
    </svg>
  );
}

// 15-min ticks are good for full-run views, but useless when the chart
// only spans 15 min. Pick a tick step that yields ~6–10 ticks across
// the visible range.
function niceTickStep(maxMin: number): number {
  if (maxMin <= 5) return 0.5;
  if (maxMin <= 10) return 1;
  if (maxMin <= 30) return 2;
  if (maxMin <= 60) return 5;
  return 15;
}

function formatMin(min: number): string {
  if (min < 1) return `${Math.round(min * 60)} sec`;
  if (min < 10) return `${min.toFixed(1)} min`;
  return `${Math.round(min)} min`;
}
