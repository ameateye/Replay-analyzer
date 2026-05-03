import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { loadGameData, type GameData } from './gameData';

const GameDataContext = createContext<GameData | null>(null);

export function GameDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<GameData | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGameData().then(
      d => { if (!cancelled) setData(d); },
      e => { if (!cancelled) setError(e); },
    );
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="loading-error">Failed to load game data: {error.message}</div>;
  if (!data) return <div className="loading">Loading game data…</div>;
  return <GameDataContext.Provider value={data}>{children}</GameDataContext.Provider>;
}

export function useGameData(): GameData {
  const v = useContext(GameDataContext);
  if (!v) throw new Error('useGameData must be used inside <GameDataProvider>');
  return v;
}
