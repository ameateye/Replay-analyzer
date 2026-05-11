// Shared phase-lookup helper. Given the run's phase boundaries (from
// `computePhases` / `run.phases`) and the data collector's sample period,
// returns a function that maps any tick to the phase name covering it.
//
// Slack: machines built within `period` ticks BEFORE a phase boundary are
// bucketed to the NEXT phase. This matches the old `mixed-segment-prep`'s
// `timeBuilt >= mixed.startTick - mp.period` slack — without it, smelters
// placed seconds before a boundary (whose first production cycle lands
// inside the new phase) bucket to the previous phase and disappear from
// the new phase's filtered widget.
//
// Single source of truth for phase membership across:
//   - dashboard/scripts/production-cube-prep.mjs  (per-machine buildPhase)
//   - dashboard/scripts/map-prep.mjs              (per-entity buildPhase)
//   - any future phase-aware data layer

export const PRE_PHASE_SENTINEL = 'Earlier';

export function makePhaseLookup(phases, period) {
  const sorted = phases
    .filter(p => p.startTick != null && p.endTick != null)
    .slice()
    .sort((a, b) => a.startTick - b.startTick);
  return (tick) => {
    for (const p of sorted) {
      if (tick >= p.startTick - period && tick < p.endTick - period) return p.name;
    }
    const last = sorted[sorted.length - 1];
    if (last && tick >= last.endTick - period) return last.name;
    return PRE_PHASE_SENTINEL;
  };
}
