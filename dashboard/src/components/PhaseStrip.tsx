// Phase strip rendered as a sub-group inside the parent SVG, sharing the
// time x scale with the chart and x-axis above/below. Doubles as the
// selector for the phase analyzer below: phases with a registered widget
// are clickable; the active one gets a thicker accent + brighter band.
import type { ScaleLinear } from 'd3-scale';
import type { Run } from '../data';
import { useGameData } from '../server/GameDataContext';
import { phaseColor } from '../server/gameData';
import { COLORS, FONT, fmtTime } from '../theme';
import './PhaseStrip.css';

type Phase = Run['phases'][number];

type Props = {
  height: number;
  innerW: number;
  xScale: ScaleLinear<number, number>;
  phases: Phase[];
  activePhase?: string | null;
  onSelectPhase?: (name: string) => void;
  isSelectable?: (name: string) => boolean;
};

const PHASE_INFO = [
  'Phase boundaries',
  '',
  '• Burner — ends when electric mining drill research finishes',
  '• Front side — ends when the player leaves the base to place the first pumpjack',
  '• Oil — ends when the player leaves the base after the in-base roboports are placed',
  '• Mixed — ends when the player leaves the base after blue circuits and low-density structures are being produced',
  '• Full build — ends when the first yellow science pack machine starts working',
  '• Late game — ends at the rocket launch',
  '',
  '"Leaving the base" = player walks outside the area covered by base machines and stays out for at least 30 seconds.',
  '',
  'Click a colored phase block to load its analyzer below.',
].join('\n');

export function PhaseStrip({
  height, innerW, xScale, phases, activePhase, onSelectPhase, isSelectable,
}: Props) {
  void innerW;
  const gameData = useGameData();
  const accentH = 4;
  const activeAccentH = 7;

  return (
    <g>
      <text
        x={-10}
        y={14}
        textAnchor="end"
        fontFamily={FONT}
        fontSize={12}
        fill={COLORS.text}
        letterSpacing={0.6}
      >
        PHASES
      </text>
      <text
        x={-10}
        y={28}
        textAnchor="end"
        fontFamily={FONT}
        fontSize={9.5}
        fill={COLORS.text}
        letterSpacing={0.3}
        opacity={0.75}
      >
        click to load ↓
      </text>
      <g transform="translate(-18, 50)" style={{ cursor: 'help' }}>
        <title>{PHASE_INFO}</title>
        <circle r={7} fill="none" stroke={COLORS.axis} strokeWidth={1} />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily={FONT}
          fontSize={10}
          fontStyle="italic"
          fontWeight={600}
          fill={COLORS.text}
        >
          i
        </text>
      </g>
      {phases.map(p => {
        if (p.startMin == null || p.endMin == null) return null;
        const x = xScale(p.startMin);
        const w = Math.max(1, xScale(p.endMin) - x);
        const cx = x + w / 2;
        const duration = fmtTime(p.endMin - p.startMin);
        const range = `${fmtTime(p.startMin)} → ${fmtTime(p.endMin)}`;
        const compact = w < 90;
        const fontMain = w < 70 ? 12 : 14;
        const fontTime = compact ? 9.5 : 11;
        const color = phaseColor(gameData, p.name);
        const selectable = isSelectable?.(p.name) ?? false;
        const isActive = selectable && activePhase === p.name;
        const fillOpacity = isActive ? 0.32 : selectable ? 0.18 : 0.10;
        const thisAccentH = isActive ? activeAccentH : accentH;
        const onClick = selectable ? () => onSelectPhase?.(p.name) : undefined;
        const cursor = selectable ? 'pointer' : 'default';
        const className = [
          'phase-strip__block',
          selectable ? 'phase-strip__block--selectable' : '',
          isActive   ? 'phase-strip__block--active'     : '',
        ].filter(Boolean).join(' ');
        return (
          <g
            key={p.name}
            className={className}
            onClick={onClick}
            style={{ cursor }}
            role={selectable ? 'button' : undefined}
            aria-pressed={selectable ? isActive : undefined}
            aria-label={selectable ? `Select ${p.name} phase analyzer` : undefined}
          >
            <rect
              className="phase-strip__block-fill"
              x={x} y={0} width={w} height={height}
              fill={color}
              opacity={fillOpacity}
            />
            <rect x={x} y={0} width={w} height={thisAccentH} fill={color} />
            {isActive && (
              <>
                <rect
                  x={x + 0.5}
                  y={0.5}
                  width={w - 1}
                  height={height - 1}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                />
                {/* Downward chevron tying the active block to the analyzer
                    panel below — visually says "this controls that". */}
                <polygon
                  points={`${cx - 7},${height} ${cx + 7},${height} ${cx},${height + 7}`}
                  fill={color}
                />
              </>
            )}
            <text
              x={cx}
              y={thisAccentH + 18}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={fontMain}
              fontWeight={700}
              fill={color}
              pointerEvents="none"
            >
              {p.name}
            </text>
            <text
              x={cx}
              y={thisAccentH + 36}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={fontTime}
              fill={COLORS.text}
              pointerEvents="none"
            >
              {range}
            </text>
            <text
              x={cx}
              y={height - 22}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={10}
              fill={COLORS.text}
              letterSpacing={0.4}
              pointerEvents="none"
            >
              DURATION
            </text>
            <text
              x={cx}
              y={height - 6}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={fontMain}
              fontWeight={600}
              fill={color}
              pointerEvents="none"
            >
              {duration}
            </text>
          </g>
        );
      })}
    </g>
  );
}
