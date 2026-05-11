// Oil-phase analysis widget with sub-tabs grouping rows by topic. Tab labels
// and groupings come from oilPhaseDisplay.groups in game-data (driven by
// recipes.json). One group at a time renders. Per-row mode is fixed in the
// config — there's no global mode toggle.
//
// Per-run data redesign step 3: rows are projected from the cube + stocks
// at render time, one row per entry in oilPhaseDisplay.rows. Supports:
//   - `mode: 'fluid-buffer'` → buildFluidBufferRow (tank-summed series)
//   - `components: [...]`   → buildCombinedRecipeRow (stack basic + advanced
//                             oil processing under one row)
//   - `machineFilter: 'before-mixed'` → buildPhases restricted to phases
//                             that come strictly before Mixed (Burner /
//                             Front side / Oil / Earlier)
//   - default              → buildRecipeRow
import { useMemo, useRef, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { range } from 'd3-array';
import type { Run } from '../data';
import { COLORS, FONT, fmtTimeNoSec } from '../theme';
import { ProductionRow } from './ProductionWidget';
import { ChartTooltip, type TooltipState } from './Tooltip';
import { useGameData } from '../server/GameDataContext';
import { buildRecipeRow, buildCombinedRecipeRow, buildFluidBufferRow } from '../lib/recipeRow';
import type { ProductionCube, StocksDataset } from '../lib/runDatasets';
import { phasesBefore } from '../lib/phaseSets';
import type { PhaseRowDisplay, ComponentDisplay } from '../server/gameData';
import './EndGameWidgets.css';

const W = 1500;
const MARGIN_LEFT = 120;
const MARGIN_RIGHT = 230;
const TOP_PAD = 8;
const ROW_H = 78;
const ROW_GAP = 6;
const X_AXIS_H = 32;

type BuiltRow = { key: string; display: PhaseRowDisplay; row: ReturnType<typeof buildRecipeRow> };

export function OilPhaseWidget({ run }: { run: Run }) {
  const gameData = useGameData();
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [groupId, setGroupId] = useState<string | null>(null);

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

  const beforeMixed = useMemo(() => phasesBefore(run.phases, 'Mixed'), [run.phases]);

  const allBuilt = useMemo<BuiltRow[]>(() => {
    const cfgRows = gameData.recipes.oilPhaseDisplay?.rows ?? [];
    return cfgRows.map(display => {
      const buildPhases = display.machineFilter === 'before-mixed' ? beforeMixed : null;

      let row;
      if (display.mode === 'fluid-buffer') {
        row = buildFluidBufferRow(stocks, { item: display.recipe, gridTicks });
      } else if (display.components && display.components.length > 0) {
        row = buildCombinedRecipeRow(cube, {
          rowRecipe: display.components[0].recipe,
          components: display.components.map((c: ComponentDisplay) => ({
            recipe: c.recipe,
            buildPhases,
          })),
          gridTicks,
        });
      } else {
        row = buildRecipeRow(cube, stocks, {
          recipe: display.recipe,
          buildPhases,
          gridTicks,
        });
      }
      return { key: display.key, display, row };
    });
  }, [cube, stocks, gameData, gridTicks, beforeMixed]);

  const cfg = gameData.recipes.oilPhaseDisplay;
  const groups = cfg?.groups?.length ? cfg.groups : [{ id: 'oil', label: 'Oil' }];
  const activeGroup = groupId ?? groups[0].id;
  const rows = allBuilt.filter(({ display }) => (display.group ?? 'oil') === activeGroup);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (rows.length === 0) return null;

  const totalH = TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;
  const xTickValues = range(0, run.durationMin + 0.001, 15);
  const hasRateRow = rows.some(({ display }) => display.mode === 'rate');

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Oil phase</h2>
          <span className="end-game__sub">
            Refinery throughput · oil buffers · red chips · tier-1 modules · blue science
          </span>
          {hasRateRow && (
            <span className="end-game__sub-key">
              <span className="key-item"><span className="key-swatch-fill" /> actual</span>
              <span className="key-item"><span className="key-swatch-loss" /> stalls</span>
              <span className="key-item"><span className="key-swatch-dash" /> potential</span>
            </span>
          )}
        </div>
        <div className="end-game__tabs" role="tablist">
          {groups.map(g => (
            <button
              key={g.id}
              role="tab"
              aria-selected={activeGroup === g.id}
              className={activeGroup === g.id ? 'end-game__tab end-game__tab--active' : 'end-game__tab'}
              onClick={() => setGroupId(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </header>
      <div className="end-game__chart" ref={containerRef}>
        <svg viewBox={`0 0 ${W} ${totalH}`} preserveAspectRatio="xMidYMid meet">
          <rect width={W} height={totalH} fill={COLORS.surface} />

          {rows.map(({ key, display, row }, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={key} top={top}>
                <ProductionRow
                  recipe={row}
                  minutes={minutes}
                  mode={display.mode as 'rate' | 'cum' | 'buffer' | 'fluid-buffer' | 'count' | 'twoLine'}
                  xScale={xScale}
                  innerW={innerW}
                  rowH={ROW_H}
                  marginLeft={MARGIN_LEFT}
                  marginRight={MARGIN_RIGHT}
                  totalW={W}
                  containerRef={containerRef}
                  setTooltip={setTooltip}
                  metaOverride={{ label: display.label, color: display.color }}
                  componentMeta={display.components}
                />
              </Group>
            );
          })}

          <Group
            left={MARGIN_LEFT}
            top={TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP}
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
