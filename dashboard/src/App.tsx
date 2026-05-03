import { useState } from 'react';
import { RunOverview } from './components/RunOverview';
import { EndGameWidgets } from './components/EndGameWidgets';
import { GameDataProvider } from './server/GameDataContext';
import { runs, defaultRun } from './data';
import { fmtTime } from './theme';

export function App() {
  const [runName, setRunName] = useState<string>(defaultRun.runName);
  const run = runs.find(r => r.runName === runName) ?? defaultRun;

  return (
    <GameDataProvider>
      <div className="dashboard">
        <header className="dashboard-header">
          <div>
            <h1>Replay analyzer · {run.runName}</h1>
            <span className="meta">{fmtTime(run.durationMin)}</span>
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
        <RunOverview run={run} />
        <EndGameWidgets run={run} />
      </div>
    </GameDataProvider>
  );
}
