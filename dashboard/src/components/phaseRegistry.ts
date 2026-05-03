// Map of run.phases[*].name → analysis widget. Shared by PhaseStrip (to know
// which phase blocks are clickable) and PhaseAnalyzer (to render the active
// phase's widget). Keys must match game-data/build-phases.json names.
import type { ComponentType } from 'react';
import type { Run } from '../data';
import { OilPhaseWidget } from './OilPhaseWidget';
import { MixedSegmentWidget } from './MixedSegmentWidget';
import { EndGameWidgets } from './EndGameWidgets';

type RunDataKey = 'oilPhase' | 'mixedSegment' | 'endGame';

export type PhaseWidgetEntry = {
  dataKey: RunDataKey;
  Widget: ComponentType<{ run: Run }>;
};

export const PHASE_WIDGETS: Record<string, PhaseWidgetEntry> = {
  'Oil':       { dataKey: 'oilPhase',     Widget: OilPhaseWidget },
  'Mixed':     { dataKey: 'mixedSegment', Widget: MixedSegmentWidget },
  'Late game': { dataKey: 'endGame',      Widget: EndGameWidgets },
};

export function hasPhaseWidget(run: Run, name: string): boolean {
  const w = PHASE_WIDGETS[name];
  return !!w && run[w.dataKey] != null;
}

// Phase that opens by default. Late game holds the rocket launch and the
// end-game production stack — the most common "what happened" view — so it
// wins over earlier-but-also-selectable phases like Oil or Mixed.
const DEFAULT_PHASE = 'Late game';

export function defaultPhase(run: Run): string | null {
  if (hasPhaseWidget(run, DEFAULT_PHASE)) return DEFAULT_PHASE;
  return run.phases.find(p => hasPhaseWidget(run, p.name))?.name ?? null;
}
