import { useEffect, useState } from 'react';
import { RunOverview } from './components/RunOverview';
import { PhaseAnalyzer } from './components/PhaseAnalyzer';
import { defaultPhase, hasPhaseWidget } from './components/phaseRegistry';
import { GameDataProvider } from './server/GameDataContext';
import { RunPicker } from './components/RunPicker';
import { defaultMeta, loadRun, type Run } from './data';
import { fmtTime } from './theme';

export function App() {
  const [runName, setRunName] = useState<string>(defaultMeta?.name ?? '');
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    if (!runName) return;
    let cancelled = false;
    loadRun(runName).then(r => { if (!cancelled) setRun(r); });
    return () => { cancelled = true; };
  }, [runName]);

  // Track an explicit user pick separately from the resolved active phase.
  // When the run changes (or the picked phase has no widget for this run),
  // fall back to the run's first selectable phase without persisting that
  // fallback as a "user choice" — so picking a phase on run A then switching
  // to run B doesn't sticky the wrong selection forever.
  const [requestedPhase, setRequestedPhase] = useState<string | null>(null);
  const activePhase = run
    ? (requestedPhase && hasPhaseWidget(run, requestedPhase) ? requestedPhase : defaultPhase(run))
    : null;
  const isPhaseSelectable = (name: string) => (run ? hasPhaseWidget(run, name) : false);

  return (
    <GameDataProvider>
      <div className="dashboard">
        <header className="dashboard-header">
          <div>
            <h1>
              <span className="title-accent">▸</span>
              Replay analyzer
              <span className="title-run">· {runName}</span>
            </h1>
            <span className="meta">
              <span className="meta-label">run time</span>
              {run ? fmtTime(run.durationMin) : '…'}
            </span>
          </div>
          <RunPicker value={runName} onChange={setRunName} />
        </header>
        {run && activePhase ? (
          <RunOverview
            run={run}
            activePhase={activePhase}
            onSelectPhase={setRequestedPhase}
            isPhaseSelectable={isPhaseSelectable}
          >
            <PhaseAnalyzer run={run} phaseName={activePhase} />
          </RunOverview>
        ) : (
          <div className="dashboard-loading">
            {runName ? `Loading ${runName}…` : 'No runs available'}
          </div>
        )}
      </div>
    </GameDataProvider>
  );
}
