import { useState, type RefObject } from 'react';
import type { ScaleLinear } from 'd3-scale';
import { type ResearchInterval, packColor, packShort } from '../server/gameData';
import { useGameData } from '../server/GameDataContext';
import { COLORS, FONT, fmtTime } from '../theme';
import { containerXY, type TooltipState } from './Tooltip';

type Props = {
  innerW: number;
  xScale: ScaleLinear<number, number>;
  researchIntervals: ResearchInterval[];
  packsUsed: string[];
  containerRef: RefObject<HTMLDivElement>;
  setTooltip: (s: TooltipState) => void;
};

const ICON_SIZE = 22;
const ICON_ROW_GAP = 3;
const ICON_PAD = 2;
const ICON_TILT_DEG = 35;
const ROW_H = 14;
const ROW_GAP = 2;
const ICON_TO_PACKS_GAP = 8;
const MAX_NORMAL_ROWS = 2;

type IconPlacement = {
  iv: ResearchInterval;
  cx: number;
  row: number;
  tilted: boolean;
};

function placeIcons(
  intervals: ResearchInterval[],
  xScale: ScaleLinear<number, number>,
): IconPlacement[] {
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const rowRight: number[] = [];
  const placements: IconPlacement[] = [];
  for (const iv of sorted) {
    const cx = (xScale(iv.startMin) + xScale(iv.endMin)) / 2;
    const left = cx - ICON_SIZE / 2;
    const right = cx + ICON_SIZE / 2;
    let chosen = -1;
    for (let r = 0; r < MAX_NORMAL_ROWS; r++) {
      if ((rowRight[r] ?? -Infinity) + ICON_PAD <= left) { chosen = r; break; }
    }
    const tilted = chosen === -1;
    if (tilted) chosen = MAX_NORMAL_ROWS;
    rowRight[chosen] = right;
    placements.push({ iv, cx, row: chosen, tilted });
  }
  return placements;
}

export function getRibbonHeight(
  intervals: ResearchInterval[],
  xScale: ScaleLinear<number, number>,
  packCount: number,
): number {
  const placements = placeIcons(intervals, xScale);
  const rowsUsed = Math.max(MAX_NORMAL_ROWS, placements.reduce((m, p) => Math.max(m, p.row + 1), MAX_NORMAL_ROWS));
  const iconStrip = rowsUsed * ICON_SIZE + (rowsUsed - 1) * ICON_ROW_GAP;
  const packStrip = packCount * (ROW_H + ROW_GAP);
  return iconStrip + ICON_TO_PACKS_GAP + packStrip;
}

function buildResearchTooltip(iv: ResearchInterval) {
  const duration = fmtTime(iv.endMin - iv.startMin);
  const niceName = iv.name.replace(/-/g, ' ');
  return (
    <>
      <div className="chart-tooltip__title">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {iv.iconUrl && (
            <img
              src={iv.iconUrl}
              alt=""
              width={28}
              height={28}
              style={{ display: 'block', imageRendering: 'auto' }}
            />
          )}
          <span style={{ textTransform: 'capitalize' }}>{niceName}</span>
        </span>
        <span className="time">{duration}</span>
      </div>
      <div className="chart-tooltip__row chart-tooltip__row--muted">
        <span>{fmtTime(iv.startMin)} → {fmtTime(iv.endMin)}</span>
      </div>
    </>
  );
}

export function ResearchRibbon({
  innerW,
  xScale,
  researchIntervals,
  packsUsed,
  containerRef,
  setTooltip,
}: Props) {
  const gameData = useGameData();
  const [hoveredTech, setHoveredTech] = useState<string | null>(null);

  const placements = placeIcons(researchIntervals, xScale);
  const rowsUsed = Math.max(MAX_NORMAL_ROWS, placements.reduce((m, p) => Math.max(m, p.row + 1), MAX_NORMAL_ROWS));
  const iconStripH = rowsUsed * ICON_SIZE + (rowsUsed - 1) * ICON_ROW_GAP;
  const packsTop = iconStripH + ICON_TO_PACKS_GAP;

  const onIntervalEnter = (iv: ResearchInterval) => (e: React.MouseEvent) => {
    setHoveredTech(iv.name);
    const { x, y } = containerXY(e, containerRef);
    setTooltip({ x, y, placement: 'top', content: buildResearchTooltip(iv) });
  };
  const onMove = (iv: ResearchInterval) => (e: React.MouseEvent) => {
    const { x, y } = containerXY(e, containerRef);
    setTooltip({ x, y, placement: 'top', content: buildResearchTooltip(iv) });
  };
  const onLeave = () => {
    setHoveredTech(null);
    setTooltip(null);
  };

  // When a tech is hovered, dim everything that doesn't belong to it so the
  // packs it required pop on the lane chart below.
  const dimIcon = (name: string) => (hoveredTech != null && name !== hoveredTech ? 0.3 : 1);
  const dimSeg = (name: string) => (hoveredTech != null && name !== hoveredTech ? 0.18 : 0.85);

  return (
    <g>
      <text
        x={-10}
        y={iconStripH / 2 + 4}
        textAnchor="end"
        fontFamily={FONT}
        fontSize={12}
        fill={COLORS.text}
      >
        research
      </text>
      <line
        x1={0}
        x2={innerW}
        y1={iconStripH + ICON_TO_PACKS_GAP / 2}
        y2={iconStripH + ICON_TO_PACKS_GAP / 2}
        stroke={COLORS.grid}
        strokeWidth={1}
      />
      {placements.map(p => {
        const rowY = p.row * (ICON_SIZE + ICON_ROW_GAP);
        const cy = rowY + ICON_SIZE / 2;
        if (!p.iv.iconUrl) return null;
        return (
          <image
            key={p.iv.name}
            href={p.iv.iconUrl}
            x={p.cx - ICON_SIZE / 2}
            y={rowY}
            width={ICON_SIZE}
            height={ICON_SIZE}
            preserveAspectRatio="xMidYMid meet"
            transform={p.tilted ? `rotate(${ICON_TILT_DEG} ${p.cx} ${cy})` : undefined}
            opacity={dimIcon(p.iv.name)}
            style={{ cursor: 'pointer', transition: 'opacity 80ms linear' }}
            onMouseEnter={onIntervalEnter(p.iv)}
            onMouseMove={onMove(p.iv)}
            onMouseLeave={onLeave}
          />
        );
      })}
      {packsUsed.map((pack, idx) => {
        const rowY = packsTop + idx * (ROW_H + ROW_GAP);
        return (
          <g key={pack}>
            <rect x={0} y={rowY} width={innerW} height={ROW_H} fill="#f3f0e8" opacity={0.6} />
            <text
              x={-10}
              y={rowY + ROW_H - 3}
              textAnchor="end"
              fontFamily={FONT}
              fontSize={12}
              fill={COLORS.text}
            >
              {packShort(gameData, pack)}
            </text>
            {researchIntervals
              .filter(iv => iv.requiredPacks.includes(pack))
              .map((iv, i) => {
                const x = xScale(iv.startMin);
                const w = Math.max(1, xScale(iv.endMin) - x);
                const isHovered = hoveredTech === iv.name;
                return (
                  <rect
                    key={`${pack}-${iv.name}-${i}`}
                    x={x}
                    y={rowY}
                    width={w}
                    height={ROW_H}
                    fill={packColor(gameData, pack)}
                    opacity={dimSeg(iv.name)}
                    stroke={isHovered ? COLORS.textStrong : 'none'}
                    strokeWidth={isHovered ? 1 : 0}
                    style={{ cursor: 'pointer', transition: 'opacity 80ms linear' }}
                    onMouseEnter={onIntervalEnter(iv)}
                    onMouseMove={onMove(iv)}
                    onMouseLeave={onLeave}
                  />
                );
              })}
          </g>
        );
      })}
    </g>
  );
}
