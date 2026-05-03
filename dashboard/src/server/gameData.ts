// Game-data is reusable across runs and across charts: tech icons, tech-pack
// requirements, etc. It lives behind /game-data/* — served by a Vite
// middleware in dev, copied into dist/ on build, and someday by a real API
// server. Components fetch it once at app startup via GameDataProvider.

// Honor Vite's configured base so the dashboard works both at the dev server
// root and when deployed under a subpath (vite.config.ts uses base: './').
const GAME_DATA_BASE = `${import.meta.env.BASE_URL}game-data`;

export type TechIconMap = Record<string, string>;
export type TechRequirementMap = Record<string, string[]>;

export type GameData = {
  techIcons: TechIconMap;
  techRequirements: TechRequirementMap;
};

let cache: Promise<GameData> | null = null;

export function loadGameData(): Promise<GameData> {
  if (!cache) {
    cache = Promise.all([
      fetch(`${GAME_DATA_BASE}/factorio-tech-icons.json`).then(r => {
        if (!r.ok) throw new Error(`tech-icons: ${r.status}`);
        return r.json() as Promise<{ icons: TechIconMap }>;
      }),
      fetch(`${GAME_DATA_BASE}/factorio-tech-requirements.json`).then(r => {
        if (!r.ok) throw new Error(`tech-requirements: ${r.status}`);
        return r.json() as Promise<{ technologies: TechRequirementMap }>;
      }),
    ]).then(([icons, reqs]) => ({
      techIcons: icons.icons,
      techRequirements: reqs.technologies,
    }));
  }
  return cache;
}

export type ResearchIntervalBase = {
  name: string;
  startMin: number;
  endMin: number;
};

export type ResearchInterval = ResearchIntervalBase & {
  iconUrl: string | null;
  requiredPacks: string[];
};

// Decorate run-derived intervals with the icon URL and pack-requirements
// looked up from game-data. Doing it here (not at build time) keeps the
// per-run JSON free of game-data duplication.
export function augmentResearchIntervals(
  intervals: ResearchIntervalBase[],
  gameData: GameData,
): ResearchInterval[] {
  return intervals.map(iv => ({
    ...iv,
    iconUrl: gameData.techIcons[iv.name] ?? null,
    requiredPacks: gameData.techRequirements[iv.name] ?? [],
  }));
}
