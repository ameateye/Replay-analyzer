// Translucent phase tints + boundary lines, painted UNDER the chart data so the
// underlying lines stay legible. Same x scale as the rest of the overview.
import type { ScaleLinear } from 'd3-scale';
import type { Run } from '../data';
import { useGameData } from '../server/GameDataContext';
import { phaseColor } from '../server/gameData';

type Phase = Run['phases'][number];

type Props = {
  innerH: number;
  xScale: ScaleLinear<number, number>;
  phases: Phase[];
  showBoundaryLines?: boolean;
  bandOpacity?: number;
};

export function PhaseBands({
  innerH,
  xScale,
  phases,
  showBoundaryLines = true,
  bandOpacity = 0.18,
}: Props) {
  const gameData = useGameData();
  return (
    <g pointerEvents="none">
      {phases.map(p => {
        if (p.startMin == null || p.endMin == null) return null;
        const x = xScale(p.startMin);
        const w = Math.max(1, xScale(p.endMin) - x);
        return (
          <rect
            key={`band-${p.name}`}
            x={x}
            y={0}
            width={w}
            height={innerH}
            fill={phaseColor(gameData, p.name)}
            opacity={bandOpacity}
          />
        );
      })}
      {showBoundaryLines && phases.slice(0, -1).map(p => {
        if (p.endMin == null) return null;
        const x = xScale(p.endMin);
        return (
          <line
            key={`bound-${p.name}`}
            x1={x}
            x2={x}
            y1={0}
            y2={innerH}
            stroke={phaseColor(gameData, p.name)}
            strokeWidth={1.2}
            strokeDasharray="4 3"
            opacity={0.5}
          />
        );
      })}
    </g>
  );
}
