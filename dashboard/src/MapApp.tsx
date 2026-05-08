import { useState } from 'react';
import { RunMapPlayer } from './components/RunMapPlayer';
import { runs, defaultRun } from './data';

// Standalone "map module" — shares chrome conventions with the dashboard
// (run picker + header) but has its own entry. Runs that don't have map
// data built yet will surface the fetch error inside the player.
export function MapApp() {
  const [runName, setRunName] = useState<string>(defaultRun.runName);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>
            <span className="title-accent">▸</span>
            Replay analyzer
            <span className="title-run">· map · {runName}</span>
          </h1>
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
      <RunMapPlayer runName={runName} />
    </div>
  );
}
