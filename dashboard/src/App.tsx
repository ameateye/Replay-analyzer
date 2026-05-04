import { useState } from 'react';
import { RunOverview } from './components/RunOverview';
import { PhaseAnalyzer } from './components/PhaseAnalyzer';
import { defaultPhase, hasPhaseWidget } from './components/phaseRegistry';
import { GameDataProvider } from './server/GameDataContext';
import { runs, defaultRun } from './data';
import { fmtTime } from './theme';

export function App() {
  const [runName, setRunName] = useState<string>(defaultRun.runName);
  const run = runs.find(r => r.runName === runName) ?? defaultRun;

  // Track an explicit user pick separately from the resolved active phase.
  // When the run changes (or the picked phase has no widget for this run),
  // fall back to the run's first selectable phase without persisting that
  // fallback as a "user choice" — so picking a phase on run A then switching
  // to run B doesn't sticky the wrong selection forever.
  const [requestedPhase, setRequestedPhase] = useState<string | null>(null);
  const activePhase = requestedPhase && hasPhaseWidget(run, requestedPhase)
    ? requestedPhase
    : defaultPhase(run);

  const isPhaseSelectable = (name: string) => hasPhaseWidget(run, name);

  return (
    <GameDataProvider>
      <div className="dashboard">
        <header className="dashboard-header">
          <div>
            <h1>
              <span className="title-accent">▸</span>
              Replay analyzer
              <span className="title-run">· {run.runName}</span>
            </h1>
            <span className="meta">
              <span className="meta-label">run time</span>
              {fmtTime(run.durationMin)}
            </span>
          </div>
          {runs.length > 1 && (
            <div className="run-picker" role="tablist" aria-label="Select run">
              {runs.map(r => (
                <button
                  key={r.runName}
                  role="tab"
                  aria-selected={r.runName === runName}
                  className={r.runName === runName ? 'run-picker__tab run-picker__tab--active' : 'run-picker__tab'}
                  onClick={() => setRunName(r.runName)}
                >
                  {r.runName}
                </button>
              ))}
            </div>
          )}
        </header>
        <RunOverview
          run={run}
          activePhase={activePhase}
          onSelectPhase={setRequestedPhase}
          isPhaseSelectable={isPhaseSelectable}
        >
          <PhaseAnalyzer run={run} phaseName={activePhase} />
        </RunOverview>
      </div>
    </GameDataProvider>
  );
}
