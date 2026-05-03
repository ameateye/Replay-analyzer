// Phase strip rendered as a sub-group inside the parent SVG, sharing the
// time x scale with the chart and x-axis above/below.
import type { ScaleLinear } from 'd3-scale';
import type { Run } from '../data';
import { COLORS, FONT, fmtTime } from '../theme';

type Phase = Run['phases'][number];

type Props = {
  height: number;
  innerW: number;
  xScale: ScaleLinear<number, number>;
  phases: Phase[];
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
].join('\n');

export function PhaseStrip({ height, innerW, xScale, phases }: Props) {
  void innerW;
  const accentH = 4;

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
      <g transform="translate(-18, 32)" style={{ cursor: 'help' }}>
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
        return (
          <g key={p.name}>
            <rect x={x} y={0} width={w} height={height} fill={p.color} opacity={0.18} />
            <rect x={x} y={0} width={w} height={accentH} fill={p.color} />
            <text
              x={cx}
              y={accentH + 18}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={fontMain}
              fontWeight={700}
              fill={p.color}
            >
              {p.name}
            </text>
            <text
              x={cx}
              y={accentH + 36}
              textAnchor="middle"
              fontFamily={FONT}
              fontSize={fontTime}
              fill={COLORS.text}
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
              fill={p.color}
            >
              {duration}
            </text>
          </g>
        );
      })}
    </g>
  );
}
