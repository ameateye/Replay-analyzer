// Map of run.phases[*].name → analysis widget. Shared by PhaseStrip (to know
// which phase blocks are clickable) and PhaseAnalyzer (to render the active
// phase's widget). Keys must match game-data/build-phases.json names.
import type { ComponentType } from 'react';
import type { Run } from '../data';
import { BurnerPhaseWidget } from './BurnerPhaseWidget';
import { OilPhaseWidget } from './OilPhaseWidget';
import { MixedSegmentWidget } from './MixedSegmentWidget';
import { FullBuildWidget } from './FullBuildWidget';
import { EndGameWidgets } from './EndGameWidgets';

// Per-run-data redesign step 4: four of these widgets (Oil / Mixed /
// Full build / Late game) read from the shared `production` cube +
// `stocks` dataset at render time. Burner uses minerActivity (its own
// prep) so it still gates on its own prebuilt field.
type RunDataKey = 'burnerPhase' | 'production';

export type PhaseWidgetEntry = {
  dataKey: RunDataKey;
  Widget: ComponentType<{ run: Run }>;
  // When true, the widget renders its own "data not collected" fallback
  // and stays clickable on runs that don't have the underlying data
  // (e.g. legacy extracts without minerActivity.json). Default false:
  // the block is only selectable when run[dataKey] is populated.
  optionalData?: boolean;
};

export const PHASE_WIDGETS: Record<string, PhaseWidgetEntry> = {
  'Burner':     { dataKey: 'burnerPhase',    Widget: BurnerPhaseWidget,    optionalData: true },
  'Oil':        { dataKey: 'production',     Widget: OilPhaseWidget                           },
  'Mixed':      { dataKey: 'production',     Widget: MixedSegmentWidget                       },
  'Full build': { dataKey: 'production',     Widget: FullBuildWidget                          },
  'Late game':  { dataKey: 'production',     Widget: EndGameWidgets                           },
};

export function hasPhaseWidget(run: Run, name: string): boolean {
  const w = PHASE_WIDGETS[name];
  if (!w) return false;
  return w.optionalData || run[w.dataKey] != null;
}

// Phase that opens by default. Late game holds the rocket launch and the
// end-game production stack — the most common "what happened" view — so it
// wins over earlier-but-also-selectable phases like Oil or Mixed.
const DEFAULT_PHASE = 'Late game';

export function defaultPhase(run: Run): string | null {
  if (hasPhaseWidget(run, DEFAULT_PHASE)) return DEFAULT_PHASE;
  return run.phases.find(p => hasPhaseWidget(run, p.name))?.name ?? null;
}
