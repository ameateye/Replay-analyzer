// Mixed-phase health widget. Mirrors EndGameWidgets in shape (stacked rows
// sharing an SVG, ProductionRow per row, same .end-game CSS) but with two
// differences:
//   - x-axis is clipped to [oilEnd, mixedEnd] since the signals only mean
//     something inside the Mixed window
//   - each row has a fixed display mode (rate / buffer) chosen in the prep,
//     so there's no rate/cum/buffer tab bar
import { useMemo, useRef, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { ProductionRow, type ProductionMode, type Recipe } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import './EndGameWidgets.css';

const W = 1500;
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const TOP_PAD = 8;
const ROW_H = 78;
const ROW_GAP = 6;
const X_AXIS_H = 32;

type MixedRecipe = Recipe & { mode: ProductionMode };

export function MixedSegmentWidget({ run }: { run: Run }) {
  const ms = run.mixedSegment as
    | { startMin: number; endMin: number; minutes: number[]; recipes: MixedRecipe[] }
    | null
    | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  // x-axis matches RunOverview / EndGameWidgets exactly: domain [0, durationMin]
  // mapped to [0, innerW] with the same margins. Mixed-window data is sparse
  // and only renders inside [startMin, endMin] pixel range.
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (!ms) return null;

  const totalH = TOP_PAD + ms.recipes.length * ROW_H + (ms.recipes.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;

  const xTickValues = range(0, run.durationMin + 0.001, 15);

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Mixed segment</h2>
          <span className="end-game__sub">
            {fmtTimeNoSec(ms.startMin)}–{fmtTimeNoSec(ms.endMin)} · own copper · iron from buffers · plastic from main · outputs LDS + BC
          </span>
        </div>
      </header>
      <div className="end-game__chart" ref={containerRef}>
        <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
          <rect width={W} height={totalH} fill={COLORS.bg} />

          {ms.recipes.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.recipe} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={ms.minutes}
                  mode={r.mode}
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

          <Group
            left={MARGIN_LEFT}
            top={TOP_PAD + ms.recipes.length * ROW_H + (ms.recipes.length - 1) * ROW_GAP}
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
