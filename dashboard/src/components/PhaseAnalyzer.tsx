// Renders the analysis widget for the phase currently selected in the
// run-overview phase strip. Selection lives in App; this component just
// reads it. Phases without a registered widget render nothing.
import type { Run } from '../data';
import { useGameData } from '../server/GameDataContext';
import { phaseColor } from '../server/gameData';
import { PHASE_WIDGETS } from './phaseRegistry';
import './PhaseAnalyzer.css';

export function PhaseAnalyzer({ run, phaseName }: { run: Run; phaseName: string | null }) {
  const gameData = useGameData();
  if (!phaseName) return null;
  const entry = PHASE_WIDGETS[phaseName];
  if (!entry || run[entry.dataKey] == null) return null;
  const Widget = entry.Widget;
  const color = phaseColor(gameData, phaseName);
  return (
    <div className="phase-analyzer" style={{ borderTopColor: color }}>
      <Widget run={run} />
    </div>
  );
}
