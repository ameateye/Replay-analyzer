// Mixed-phase health widget. Mirrors EndGameWidgets in shape (stacked rows
// sharing an SVG, ProductionRow per row, same .end-game CSS) but with two
// differences:
//   - x-axis is clipped to [oilEnd, mixedEnd] since the signals only mean
//     something inside the Mixed window
//   - each row has a fixed display mode (rate / buffer); no tab bar
//
// Per-run data redesign step 3: rows are projected from the cube + stocks
// at render time. `copper-plate` and `plastic-bar` are restricted to
// `buildPhases: { Mixed }` to mirror the old `builtDuringMixed(...)`
// machine filter — only the Mixed-phase furnaces count for these rows.
import { useMemo, useRef, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { ProductionRow, type ProductionMode } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import { buildRecipeRow } from '../lib/recipeRow';
import { phasesFrom } from '../lib/phaseSets';
import type { ProductionCube, StocksDataset } from '../lib/runDatasets';
import './EndGameWidgets.css';

const W = 1500;
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const TOP_PAD = 8;
const ROW_H = 78;
const ROW_GAP = 6;
const X_AXIS_H = 32;

// Per-row config. `fromMixed` mirrors the old `builtDuringMixed(recipe)`
// predicate from `mixed-segment-prep.mjs`, which was
// `m.timeBuilt >= mixed.startTick - period` — i.e. every machine built
// from Mixed onward, not strictly Mixed-phase machines. We materialize that
// as `phasesFrom('Mixed') = { Mixed, Full build, Late game } + 'Earlier'`-less.
// Rows without `fromMixed` aggregate across every phase. `buffer` mode reads
// stocks only, so the production filter is irrelevant there.
const MIXED_ROWS: Array<{
  recipe: string;
  mode: ProductionMode;
  fromMixed?: boolean;
}> = [
  { recipe: 'copper-plate',          mode: 'rate',   fromMixed: true },
  { recipe: 'iron-plate',            mode: 'buffer'                  },
  { recipe: 'plastic-bar',           mode: 'rate',   fromMixed: true },
  { recipe: 'low-density-structure', mode: 'rate'                    },
  { recipe: 'processing-unit',       mode: 'rate'                    },
];

export function MixedSegmentWidget({ run }: { run: Run }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  const mixed = run.phases.find(p => p.name === 'Mixed') as
    | { startMin: number | null; endMin: number | null }
    | undefined;

  const cube = run.production as unknown as ProductionCube;
  const stocks = run.stocks as unknown as StocksDataset;
  const period = cube.period;
  const lastTick = run.durationTicks;

  const gridTicks = useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t <= lastTick; t += period) arr.push(t);
    return arr;
  }, [lastTick, period]);

  const minutes = useMemo(() => gridTicks.map(t => +(t / 3600).toFixed(4)), [gridTicks]);

  const fromMixed = useMemo(() => phasesFrom(run.phases, 'Mixed'), [run.phases]);

  const recipes = useMemo(
    () => MIXED_ROWS.map(({ recipe, mode, fromMixed: useFromMixed }) => ({
      ...buildRecipeRow(cube, stocks, {
        recipe,
        gridTicks,
        buildPhases: useFromMixed ? fromMixed : null,
      }),
      mode,
    })),
    [cube, stocks, gridTicks, fromMixed],
  );

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (!mixed || mixed.startMin == null || mixed.endMin == null) return null;

  const totalH = TOP_PAD + recipes.length * ROW_H + (recipes.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;

  const xTickValues = range(0, run.durationMin + 0.001, 15);

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Mixed phase</h2>
          <span className="end-game__sub">
            {fmtTimeNoSec(mixed.startMin)}–{fmtTimeNoSec(mixed.endMin)} · own copper · iron from buffers · plastic from main · outputs LDS + BC
          </span>
          <span className="end-game__sub-key">
            <span className="key-item"><span className="key-swatch-fill" /> actual</span>
            <span className="key-item"><span className="key-swatch-loss" /> stalls</span>
            <span className="key-item"><span className="key-swatch-dash" /> potential</span>
          </span>
        </div>
      </header>
      <div className="end-game__chart" ref={containerRef}>
        <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
          <rect width={W} height={totalH} fill={COLORS.surface} />

          {recipes.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.recipe} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={minutes}
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
            top={TOP_PAD + recipes.length * ROW_H + (recipes.length - 1) * ROW_GAP}
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
