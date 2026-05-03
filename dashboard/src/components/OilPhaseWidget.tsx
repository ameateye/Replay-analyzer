// Oil-phase analysis widget with sub-tabs grouping rows by topic. Tab labels
// and groupings come from oilPhase.groups in the run data (driven by
// recipes.json oilPhaseDisplay.groups). One group at a time renders.
//
// Same column / x-axis as RunOverview + EndGameWidgets. Per-row mode is fixed
// in the data prep — there's no global mode toggle.
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

type OilPhaseRow = Recipe & {
  key: string;
  group: string;
  label: string;
  color: string;
  mode: ProductionMode;
};

type OilPhaseGroup = { id: string; label: string };

export function OilPhaseWidget({ run }: { run: Run }) {
  const op = run.oilPhase as
    | { durationMin: number; minutes: number[]; groups: OilPhaseGroup[]; rows: OilPhaseRow[] }
    | null
    | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [groupId, setGroupId] = useState<string | null>(null);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (!op) return null;

  const groups = op.groups?.length ? op.groups : [{ id: 'oil', label: 'Oil' }];
  const activeGroup = groupId ?? groups[0].id;
  const rows = op.rows.filter(r => (r.group ?? 'oil') === activeGroup);

  const totalH = TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;
  const xTickValues = range(0, run.durationMin + 0.001, 15);

  return (
    <section className="end-game">
      <header className="end-game__header">
        <div>
          <h2>Oil phase</h2>
          <span className="end-game__sub">
            Refinery throughput · oil buffers · red chips (oil-phase line) · tier-1 modules · blue science
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
          <rect width={W} height={totalH} fill={COLORS.bg} />

          {rows.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.key} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={op.minutes}
                  mode={r.mode}
                  xScale={xScale}
                  innerW={innerW}
                  rowH={ROW_H}
                  marginLeft={MARGIN_LEFT}
                  marginRight={MARGIN_RIGHT}
                  totalW={W}
                  containerRef={containerRef}
                  setTooltip={setTooltip}
                  metaOverride={{ label: r.label, color: r.color }}
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
