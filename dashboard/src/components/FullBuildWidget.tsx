// Full-build phase analysis widget. Shape mirrors OilPhaseWidget: stacked
// Recipe-shaped rows on the shared full-run x-axis, sub-tabs grouping rows
// (Yellow / Purple) so one group renders at a time.
//
// Yellow tab: utility-science-pack rate + cumulative — same data the end-game
// chart shows, surfaced again here in its build-phase context.
// Purple tab: production-science-pack rate + cumulative, plus its key inputs
// so the chart shows whether purple is input-limited:
//   - rail rate (loss bands flag stalls in steel/iron-stick/stone supply)
//   - electric-furnace rate (loss bands flag stalls in steel/AC/stone-brick)
//   - productivity-module buffer (chests + player inv)
//   - steel-plate rate restricted to the back-side furnace stack
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

type FullBuildRow = Recipe & {
  key: string;
  group: string;
  label: string;
  color: string;
  mode: ProductionMode;
};

type FullBuildGroup = { id: string; label: string };

type FullBuildPhaseData = {
  durationMin: number;
  startMin: number;
  endMin: number | null;
  minutes: number[];
  groups: FullBuildGroup[];
  rows: FullBuildRow[];
};

export function FullBuildWidget({ run }: { run: Run }) {
  const fb = run.fullBuildPhase as FullBuildPhaseData | null | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [groupId, setGroupId] = useState<string | null>(null);

  const innerW = W - MARGIN_LEFT - MARGIN_RIGHT;
  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, run.durationMin], range: [0, innerW] }),
    [run.durationMin, innerW],
  );

  if (!fb) return null;

  const groups = fb.groups?.length ? fb.groups : [{ id: 'purple', label: 'Purple' }];
  const activeGroup = groupId ?? groups[0].id;
  const rows = fb.rows.filter(r => (r.group ?? 'purple') === activeGroup);

  const totalH = TOP_PAD + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP + X_AXIS_H + TOP_PAD;
  const xTickValues = range(0, run.durationMin + 0.001, 15);

  const rangeText = fb.endMin != null
    ? `${fmtTimeNoSec(fb.startMin)}–${fmtTimeNoSec(fb.endMin)}`
    : `from ${fmtTimeNoSec(fb.startMin)}`;
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
          <rect width={W} height={totalH} fill={COLORS.bg} />

          {rows.map((r, i) => {
            const top = TOP_PAD + i * (ROW_H + ROW_GAP);
            return (
              <Group key={r.key} top={top}>
                <ProductionRow
                  recipe={r}
                  minutes={fb.minutes}
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
