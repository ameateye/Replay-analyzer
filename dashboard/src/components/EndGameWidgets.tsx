// End-game production stack: 5 single-row charts (blue chips, LDS, rocket
// fuel, purple, yellow). One mode at a time — the tab bar replaces the chart
// content rather than overlaying. The x scale is shared across rows AND
// matches the run-overview chart above (same total width and margins) so the
// time axis reads continuously down the page.
import { useMemo, useRef, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { ProductionRow, type ProductionMode } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import './EndGameWidgets.css';

const W = 1500;
// Match RunOverview: same total width and same MARGIN_LEFT / MARGIN_RIGHT so
// the plot regions of both SVGs line up horizontally (they share a viewBox
// width and scale uniformly with the dashboard container). Right margin stays
// reserved even though end-game has no legend, to keep innerW identical.
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const TOP_PAD = 8;
const ROW_H = 78;
const ROW_GAP = 6;
const X_AXIS_H = 32;

const TABS: { mode: ProductionMode; label: string }[] = [
  { mode: 'rate',   label: 'Production rate' },
  { mode: 'cum',    label: 'Cumulative' },
  { mode: 'buffer', label: 'Buffer (incl. player inv.)' },
];

export function EndGameWidgets({ run }: { run: Run }) {
  const [mode, setMode] = useState<ProductionMode>('rate');
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const eg = run.endGame;

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;

  // X scale must match the run-overview chart exactly: [0, durationMin] →
  // [0, innerW]. End-game items start ~70 min in, so the left half of every
  // row is empty — that's the trade-off for keeping the time axis aligned
  // pixel-for-pixel with the overview above (so a vertical line at minute X
  // hits the same x-coordinate in both charts).
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, eg.durationMin], range: [0, innerW] }),
    [eg.durationMin, innerW],
  );

  const totalH = TOP_PAD + eg.recipes.length * ROW_H + (eg.recipes.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;

  const xTickValues = range(0, eg.durationMin + 0.001, 15);

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>End-game production</h2>
          <span className="end-game__sub">
            Blue chips · LDS · rocket fuel · purple science · yellow science
          </span>
        </div>
        <div className="end-game__tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.mode}
              role="tab"
              aria-selected={mode === t.mode}
              className={mode === t.mode ? 'end-game__tab end-game__tab--active' : 'end-game__tab'}
              onClick={() => setMode(t.mode)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="end-game__chart" ref={containerRef}>
        <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
          <rect width={W} height={totalH} fill={COLORS.bg} />

          {eg.recipes.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.recipe} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={eg.minutes}
                  mode={mode}
                  xScale={xScale}
                  innerW={innerW}
                  rowH={ROW_H}
                  marginLeft={MARGIN_LEFT}
                  marginRight={MARGIN_RIGHT}
                  totalW={W}
                  containerRef={containerRef}
                  setTooltip={setTooltip}
                />
              </Group>
            );
          })}

          {/* Shared x-axis below the last row */}
          <Group
            left={MARGIN_LEFT}
            top={TOP_PAD + eg.recipes.length * ROW_H + (eg.recipes.length - 1) * ROW_GAP}
          >
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
        <ChartTooltip state={tooltip} />
      </div>
    </section>
  );
}
