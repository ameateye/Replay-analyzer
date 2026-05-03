import { COLORS, FONT, PACK_COLOR, PACK_SHORT } from '../theme';

type Props = {
  packsUsed: string[];
};

export function Legend({ packsUsed }: Props) {
  const items: { fill: string; label: string; opacity: number; stroke?: string }[] = [
    { fill: COLORS.saturated, label: 'saturated', opacity: 0.85 },
    ...packsUsed.map(p => ({ fill: PACK_COLOR[p], label: `missing ${PACK_SHORT[p]}`, opacity: 0.5 })),
    { fill: COLORS.potentialFill, label: 'potential (no research)', opacity: 1 },
    { fill: COLORS.idle, label: 'no active research', opacity: 0.9, stroke: COLORS.idleBorder },
  ];
  const itemH = 20;
  const padTop = 14;
  const padBottom = 12;
  const w = 190;
  const h = padTop + items.length * itemH + padBottom;

  return (
    <g>
      <rect width={w} height={h} rx={4} ry={4} fill={COLORS.surface} stroke={COLORS.axis} />
      {items.map((it, i) => {
        const ry = padTop + i * itemH;
        return (
          <g key={it.label}>
            <rect
              x={12}
              y={ry}
              width={14}
              height={14}
              fill={it.fill}
              opacity={it.opacity}
              stroke={it.stroke ?? 'none'}
              strokeWidth={it.stroke ? 0.5 : 0}
            />
            <text
              x={12 + 14 + 8}
              y={ry + 14 - 3}
              fontFamily={FONT}
              fontSize={12.5}
              fill={COLORS.text}
            >
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
