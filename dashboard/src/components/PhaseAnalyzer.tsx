// Phase analyzer: tab bar driven by the run's phase list (same `phases` the
// run-overview uses). Each phase that has an analysis widget renders that
// widget when active; phases without one are shown as disabled tabs.
//
// To add a phase widget, add an entry to PHASE_WIDGETS keyed by the phase
// name (matching game-data/build-phases.json) → { dataKey, Widget }.
import { useState, type ComponentType } from 'react';
import type { Run } from '../data';
import { useGameData } from '../server/GameDataContext';
import { phaseColor } from '../server/gameData';
import { OilPhaseWidget } from './OilPhaseWidget';
import { MixedSegmentWidget } from './MixedSegmentWidget';
import { EndGameWidgets } from './EndGameWidgets';
import './PhaseAnalyzer.css';

type RunDataKey = 'oilPhase' | 'mixedSegment' | 'endGame';
type PhaseWidget = { dataKey: RunDataKey; Widget: ComponentType<{ run: Run }> };

const PHASE_WIDGETS: Record<string, PhaseWidget> = {
  'Oil':       { dataKey: 'oilPhase',     Widget: OilPhaseWidget },
  'Mixed':     { dataKey: 'mixedSegment', Widget: MixedSegmentWidget },
  'Late game': { dataKey: 'endGame',      Widget: EndGameWidgets },
};

export function PhaseAnalyzer({ run }: { run: Run }) {
  const gameData = useGameData();

  const tabs = run.phases.map(p => {
    const w = PHASE_WIDGETS[p.name];
    const enabled = !!w && run[w.dataKey] != null;
    return {
      name: p.name,
      enabled,
      Widget: w?.Widget,
      color: phaseColor(gameData, p.name),
    };
  });

  const firstEnabled = tabs.find(t => t.enabled) ?? tabs[0];
  const [active, setActive] = useState<string>(firstEnabled?.name ?? '');
  const activeTab = tabs.find(t => t.name === active);
  const ActiveWidget = activeTab?.enabled ? activeTab.Widget : undefined;

  return (
    <div className="phase-analyzer">
      <div className="phase-analyzer__tabs" role="tablist" aria-label="Phase">
        {tabs.map(t => {
          const isActive = t.enabled && t.name === active;
          return (
            <button
              key={t.name}
              role="tab"
              aria-selected={isActive}
              disabled={!t.enabled}
              className={isActive ? 'phase-analyzer__tab phase-analyzer__tab--active' : 'phase-analyzer__tab'}
              style={isActive ? { boxShadow: `inset 0 -3px 0 ${t.color}` } : undefined}
              onClick={() => t.enabled && setActive(t.name)}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      {ActiveWidget && <ActiveWidget run={run} />}
    </div>
  );
}
