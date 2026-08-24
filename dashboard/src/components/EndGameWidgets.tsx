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
import { COLORS, FONT, fmtTime, fmtTimeNoSec } from '../theme';
import { ProductionRow, type ProductionMode } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import { useGameData } from '../server/GameDataContext';
import { buildRecipeRow } from '../lib/recipeRow';
import type { ProductionCube, RocketSupply, StocksDataset } from '../lib/runDatasets';
import './EndGameWidgets.css';

const W = 1500;
// Match RunOverview: same total width and same MARGIN_LEFT / MARGIN_RIGHT so
// the plot regions of both SVGs line up horizontally (they share a viewBox
// width and scale uniformly with the dashboard container). Right margin stays
// reserved even though end-game has no legend, to keep innerW identical.
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
// Rows are spaced wide enough for a supply marker's caption to sit in the gap
// above its row instead of over the series.
const TOP_PAD = 13;
const ROW_H = 78;
const ROW_GAP = 14;
const X_AXIS_H = 32;

const TABS: { mode: ProductionMode; label: string }[] = [
  { mode: 'rate',   label: 'Rate' },
  { mode: 'cum',    label: 'Total' },
  { mode: 'buffer', label: 'Buffer' },
];

function KeyStripRate() {
  return (
    <span className="end-game__sub-key">
      <span className="key-item"><span className="key-swatch-fill" /> actual</span>
      <span className="key-item"><span className="key-swatch-loss" /> stalls</span>
      <span className="key-item"><span className="key-swatch-dash" /> potential</span>
    </span>
  );
}

export function EndGameWidgets({ run }: { run: Run }) {
  const [mode, setMode] = useState<ProductionMode>('rate');
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const gameData = useGameData();

  // Per-run data redesign step 3: project recipe rows from the cube + stocks
  // datasets at render time instead of reading the prebuilt run.endGame. The
  // grid is the cube's native period (5s) — same resolution every other
  // chart uses — so smoothed line rendering matches the pre-redesign output.
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

  const recipes = useMemo(
    () => {
      const capacityCfg = {
        chestSlots: gameData.recipes.chestSlots,
        stackSizes: gameData.recipes.stackSizes,
        tankCapacity: gameData.recipes.tankCapacity,
      };
      return gameData.recipes.endGameDisplay.map(({ recipe }) =>
        buildRecipeRow(cube, stocks, { recipe, gridTicks, capacityCfg }),
      );
    },
    [cube, stocks, gameData, gridTicks],
  );

  // Rocket-supply markers, keyed by recipe — the three rocket-part inputs are
  // named after the recipe that makes them, so the row lookup is direct. Runs
  // built before the prep existed simply carry no markers.
  const supply = run.rocketSupply as RocketSupply | undefined;
  const markers = useMemo(() => {
    const out = new Map<string, { minute: number; label: string }>();
    for (const r of supply?.items ?? []) {
      if (r.finishedMin == null) continue;
      out.set(r.item, { minute: r.finishedMin, label: `finished ${fmtTime(r.finishedMin)}` });
    }
    return out;
  }, [supply]);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;

  // X scale must match the run-overview chart exactly: [0, durationMin] →
  // [0, innerW]. End-game items start ~70 min in, so the left half of every
  // row is empty — that's the trade-off for keeping the time axis aligned
  // pixel-for-pixel with the overview above (so a vertical line at minute X
  // hits the same x-coordinate in both charts).
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  const totalH = TOP_PAD + recipes.length * ROW_H + (recipes.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;

  const xTickValues = range(0, run.durationMin + 0.001, 15);

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Late game · production</h2>
          <span className="end-game__sub">
            Blue chips · LDS · rocket fuel · purple science · yellow science
          </span>
          {mode === 'rate' && <KeyStripRate />}
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
          <rect width={W} height={totalH} fill={COLORS.surface} />

          {recipes.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.recipe} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={minutes}
                  mode={mode}
                  xScale={xScale}
                  innerW={innerW}
                  rowH={ROW_H}
                  marginLeft={MARGIN_LEFT}
                  marginRight={MARGIN_RIGHT}
                  totalW={W}
                  containerRef={containerRef}
                  setTooltip={setTooltip}
                  marker={markers.get(r.recipe)}
                />
              </Group>
            );
          })}

          {/* Shared x-axis below the last row */}
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
