import { useState } from 'react';
import { RunMapPlayer } from './components/RunMapPlayer';
import { RunPicker } from './components/RunPicker';
import { defaultMeta } from './data';

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
        <RunPicker value={runName} onChange={setRunName} />
      </header>
      <RunMapPlayer runName={runName} />
    </div>
  );
}
