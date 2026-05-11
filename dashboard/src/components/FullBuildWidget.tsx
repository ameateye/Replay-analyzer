// Full-build phase analysis widget. Shape mirrors OilPhaseWidget: stacked
// Recipe-shaped rows on the shared full-run x-axis, sub-tabs grouping rows
// (Yellow / Purple) so one group renders at a time.
//
// Per-run data redesign step 3: rows are projected from the cube + stocks
// at render time, one row per entry in fullBuildDisplay.rows.
// `machineFilter: 'after-full-build-start'` maps to buildPhases =
// { 'Full build', 'Late game' } — only machines built once the Full-build
// phase started count, matching the back-side furnace / late-game line
// semantics the legacy prep enforced.
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
import { phasesFrom } from '../lib/phaseSets';
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

export function FullBuildWidget({ run }: { run: Run }) {
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

  const fromFullBuild = useMemo(() => phasesFrom(run.phases, 'Full build'), [run.phases]);
  const fullBuild = run.phases.find(p => p.name === 'Full build') as
    | { startMin: number | null; endMin: number | null }
    | undefined;

  const allBuilt = useMemo<BuiltRow[]>(() => {
    const cfgRows = gameData.recipes.fullBuildDisplay?.rows ?? [];
    return cfgRows.map(display => {
      const buildPhases = display.machineFilter === 'after-full-build-start' ? fromFullBuild : null;

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
      // `excludeInventory` rows track items that flow through the player
      // inventory but get immediately installed (e.g. prod modules) — the
      // chest-only count is the meaningful stockpile.
      if (display.excludeInventory) {
        row.bufferWithInv = row.buffer.slice();
        row.peakBufferWithInv = row.peakBuffer;
      }
      return { key: display.key, display, row };
    });
  }, [cube, stocks, gameData, gridTicks, fromFullBuild]);

  const cfg = gameData.recipes.fullBuildDisplay;
  const groups = cfg?.groups?.length ? cfg.groups : [{ id: 'purple', label: 'Purple' }];
  const activeGroup = groupId ?? groups[0].id;
  const rows = allBuilt.filter(({ display }) => (display.group ?? 'purple') === activeGroup);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (rows.length === 0 || !fullBuild?.startMin) return null;

  const totalH = TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;
  const xTickValues = range(0, run.durationMin + 0.001, 15);

  const rangeText = fullBuild.endMin != null
    ? `${fmtTimeNoSec(fullBuild.startMin)}–${fmtTimeNoSec(fullBuild.endMin)}`
    : `from ${fmtTimeNoSec(fullBuild.startMin)}`;
  const subText = activeGroup === 'yellow'
    ? 'Utility (yellow) science · rate + cumulative'
    : 'Production (purple) science + key inputs · rail · electric furnaces · prod-module buffer · back-side steel';

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Full-build phase</h2>
          <span className="end-game__sub">
            {rangeText} · {subText}
          </span>
          <span className="end-game__sub-key">
            <span className="key-item"><span className="key-swatch-fill" /> actual</span>
            <span className="key-item"><span className="key-swatch-loss" /> stalls</span>
            <span className="key-item"><span className="key-swatch-dash" /> potential</span>
          </span>
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
