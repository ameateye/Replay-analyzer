// Helpers for deriving buildPhases filter sets from a run's phase list.
// Build-time machine filters in the legacy preps used numeric timeBuilt
// boundaries (e.g. `m.timeBuilt < mixedStartTick`). In the cube schema each
// machine is bucketed to a phase name at build time, so render-time filters
// are expressed as a set of phase names instead. These helpers convert the
// common boundary expressions to phase-name sets so widgets can replicate
// the legacy filter semantics without hardcoding phase names.
//
// `Earlier` is the sentinel the cube uses for machines built before any
// tracked phase — these helpers add it to "before X" sets so machines that
// pre-date phase tracking still count toward early-phase widgets.

export type PhaseInfo = { name: string };

// Phase names that come strictly before `anchor`, plus the 'Earlier' sentinel.
// Returns null if `anchor` doesn't appear in `phases` (caller should skip
// the filter — degrade to "include all phases").
export function phasesBefore(phases: ReadonlyArray<PhaseInfo>, anchor: string): ReadonlySet<string> | null {
  const out = new Set<string>();
  for (const p of phases) {
    if (p.name === anchor) {
      out.add('Earlier');
      return out;
    }
    out.add(p.name);
  }
  return null;
}

// Phase names from `anchor` (inclusive) to the end. Returns null if
// `anchor` doesn't appear (caller should skip the filter).
export function phasesFrom(phases: ReadonlyArray<PhaseInfo>, anchor: string): ReadonlySet<string> | null {
  const out = new Set<string>();
  let seen = false;
  for (const p of phases) {
    if (p.name === anchor) seen = true;
    if (seen) out.add(p.name);
  }
  return seen ? out : null;
}
