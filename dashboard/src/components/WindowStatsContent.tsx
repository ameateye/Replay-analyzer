// Tooltip body for a brushed time window — rendered with the same
// .chart-tooltip__* building blocks as the point-in-time tooltip, so when a
// window is selected the tooltip simply swaps to showing the window aggregate
// (produced / missed / by-reason) in place of the single-tick value.
import { fmtTime } from '../theme';
import { TooltipRow } from './Tooltip';
import type { WindowStats } from '../lib/windowStats';

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function WindowStatsContent({
  stats,
  label,
  color,
}: {
  stats: WindowStats | null;
  label: string;
  color: string;
}) {
  return (
    <>
      <div className="chart-tooltip__title">
        <span className="chart-tooltip__label">
          <span className="chart-tooltip__swatch" style={{ background: color }} />
          {label}
        </span>
        {stats && (
          <span className="time">
            {fmtTime(stats.startMin)}–{fmtTime(stats.endMin)}
          </span>
        )}
      </div>

      {!stats ? (
        <div className="chart-tooltip__note">drag a wider range…</div>
      ) : (
        <>
          <TooltipRow label="produced" value={fmtInt(stats.produced)} active />
          <TooltipRow label="missed" value={`${fmtInt(stats.missed)} · ~${stats.totalEquivMin.toFixed(1)} min`} />
          <TooltipRow label="of capacity" value={`${Math.round(stats.achievedPct)}%`} muted />
          {stats.losses.length > 0 ? (
            <>
              <div className="chart-tooltip__details-label">missed by reason</div>
              {stats.losses.map(l => (
                <TooltipRow
                  key={`${l.kind}:${l.key}`}
                  color={l.color}
                  label={l.label}
                  value={`${fmtInt(l.items)} · ~${l.equivMin.toFixed(1)}m`}
                />
              ))}
            </>
          ) : (
            <div className="chart-tooltip__note">ran at full capacity — no losses</div>
          )}
        </>
      )}
    </>
  );
}
