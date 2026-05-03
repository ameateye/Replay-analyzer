import { RunOverview } from './components/RunOverview';
import { EndGameWidgets } from './components/EndGameWidgets';

export function App() {
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Replay analyzer · DS-2_19_20</h1>
        <span className="meta">Zaspar · 2:18:25 · Default Settings, solo</span>
      </header>
      <RunOverview />
      <EndGameWidgets />
    </div>
  );
}
