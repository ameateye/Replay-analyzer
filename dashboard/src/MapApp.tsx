import { useState } from 'react';
import { RunMapPlayer } from './components/RunMapPlayer';
import { runMetas, defaultMeta } from './data';

// Standalone "map module" — shares chrome conventions with the dashboard
// (run picker + header) but has its own entry. Runs that don't have map
// data built yet will surface the fetch error inside the player.
export function MapApp() {
  const [runName, setRunName] = useState<string>(defaultMeta.name);

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
        {runMetas.length > 1 && (
          <div className="run-picker" role="tablist" aria-label="Select run">
            {runMetas.map(m => (
              <button
                key={m.name}
                role="tab"
                aria-selected={m.name === runName}
                className={m.name === runName ? 'run-picker__tab run-picker__tab--active' : 'run-picker__tab'}
                onClick={() => setRunName(m.name)}
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
      </header>
      <RunMapPlayer runName={runName} />
    </div>
  );
}
