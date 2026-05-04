import { COLORS, FONT } from '../theme';
import { useGameData } from '../server/GameDataContext';
import { packColor, packShort } from '../server/gameData';

type Props = {
  packsUsed: string[];
};

export function Legend({ packsUsed }: Props) {
  const gameData = useGameData();
  const items: { fill: string; label: string; opacity: number; stroke?: string }[] = [
    { fill: COLORS.saturated, label: 'saturated', opacity: 0.95 },
    ...packsUsed.map(p => ({
      fill: packColor(gameData, p),
      label: `missing ${packShort(gameData, p)}`,
      opacity: 0.65,
    })),
    { fill: COLORS.potentialFill, label: 'potential', opacity: 1 },
    { fill: COLORS.idle, label: 'no research', opacity: 0.95, stroke: COLORS.idleBorder },
  ];
  const itemH = 16;
  const padTop = 24;
  const padBottom = 10;
  const padLeft = 9;
  const w = 142;
  const h = padTop + items.length * itemH + padBottom;

  return (
    <g>
      {/* Beveled Factorio frame: dark face, light bevel top + left, dark
          bevel bottom + right, no rounded corners. */}
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        fill={COLORS.panel}
        stroke={COLORS.borderStrong}
        strokeWidth={1}
      />
      <rect
        x={1.5}
        y={1.5}
        width={w - 3}
        height={h - 3}
        fill="none"
        stroke={COLORS.border}
        strokeWidth={1}
        opacity={0.9}
      />
      {/* Orange title strip. */}
      <rect width={w} height={3} fill={COLORS.accent} />
      <text
        x={padLeft}
        y={17}
        fontFamily={FONT}
        fontSize={10}
        fontWeight={700}
        fill={COLORS.textStrong}
        letterSpacing={1.2}
      >
        LEGEND
      </text>
      {items.map((it, i) => {
        const ry = padTop + i * itemH;
        return (
          <g key={it.label}>
            <rect
              x={padLeft}
              y={ry}
              width={11}
              height={11}
              fill={it.fill}
              opacity={it.opacity}
              stroke={it.stroke ?? 'none'}
              strokeWidth={it.stroke ? 0.5 : 0}
            />
            <text
              x={padLeft + 11 + 6}
              y={ry + 9}
              fontFamily={FONT}
              fontSize={11}
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
