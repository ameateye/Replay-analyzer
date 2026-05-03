// Lightweight HTML tooltip overlay positioned in container-relative pixels.
// Charts compute the container coords (using a shared containerRef) and push
// a TooltipState into the parent via a setter. One tooltip per chart section.
//
// Positioning runs in two stages: the chart provides a *desired* anchor (mouse
// position + initial placement); a useLayoutEffect then measures the rendered
// tooltip and clamps it inside the container, flipping above→below the cursor
// when there's no room above. This keeps the tooltip from clipping at edges.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import './Tooltip.css';

export type TooltipState = {
  x: number;
  y: number;
  placement: 'top' | 'right';
  content: ReactNode;
} | null;

export function ChartTooltip({ state }: { state: TooltipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setPos(null);
      return;
    }
    const tip = ref.current;
    const parent = tip.offsetParent as HTMLElement | null;
    if (!parent) return;
    const cw = parent.clientWidth;
    const ch = parent.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const PAD = 6;
    const GAP = 12;

    let left: number;
    let top: number;

    if (state.placement === 'right') {
      left = state.x + GAP;
      top = state.y - th / 2;
      // Flip to left side if it overflows right
      if (left + tw > cw - PAD) left = state.x - GAP - tw;
    } else {
      // 'top' — center horizontally, sit above cursor
      left = state.x - tw / 2;
      top = state.y - GAP - th;
      // Flip below cursor if there's no room above
      if (top < PAD) top = state.y + GAP;
    }

    // Clamp within container
    if (left < PAD) left = PAD;
    if (left + tw > cw - PAD) left = cw - PAD - tw;
    if (top < PAD) top = PAD;
    if (top + th > ch - PAD) top = ch - PAD - th;

    setPos({ left, top });
  }, [state]);

  if (!state) return null;

  // First render (before useLayoutEffect runs) hides the tooltip to avoid a
  // flash at the wrong location. useLayoutEffect runs synchronously before
  // paint, so the user only ever sees the clamped position.
  const style = pos
    ? { left: pos.left, top: pos.top }
    : { left: 0, top: 0, visibility: 'hidden' as const };

  return (
    <div ref={ref} className="chart-tooltip" style={style}>
      {state.content}
    </div>
  );
}

// Shared helper for converting a pointer event to container-relative pixels.
export function containerXY(
  e: { clientX: number; clientY: number },
  containerRef: RefObject<HTMLDivElement>,
): { x: number; y: number } {
  const el = containerRef.current;
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// Color swatch + label + value triplet used inside tooltip bodies.
export function TooltipRow({
  color,
  label,
  value,
  muted,
  active,
}: {
  color?: string;
  label: string;
  value: string;
  muted?: boolean;
  active?: boolean;
}) {
  const cls = ['chart-tooltip__row'];
  if (muted) cls.push('chart-tooltip__row--muted');
  if (active) cls.push('chart-tooltip__row--active');
  return (
    <div className={cls.join(' ')}>
      <span className="chart-tooltip__label">
        {color != null && (
          <span className="chart-tooltip__swatch" style={{ background: color }} />
        )}
        {label}
      </span>
      <span className="chart-tooltip__value">{value}</span>
    </div>
  );
}
