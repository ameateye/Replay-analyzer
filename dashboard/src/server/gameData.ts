// Game-data is reusable across runs and across charts: tech icons, tech-pack
// requirements, science-pack tiers/colors, recipe metadata, build-phase
// definitions. It lives behind /game-data/* — served by a Vite middleware in
// dev, copied into dist/ on build, and someday by a real API server.
// Components fetch it once at app startup via GameDataProvider.

// Honor Vite's configured base so the dashboard works both at the dev server
// root and when deployed under a subpath (vite.config.ts uses base: './').
const GAME_DATA_BASE = `${import.meta.env.BASE_URL}game-data`;

export type TechIconMap = Record<string, string>;
export type TechRequirementMap = Record<string, string[]>;
export type SciencePackDisplayMeta = Record<string, { color: string; short: string }>;
export type RecipeOutputCount = Record<string, number>;
export type EndGameRecipeDisplay = { recipe: string; label: string; color: string };
export type PhaseMeta = { name: string; color: string };

export type GameData = {
  techIcons: TechIconMap;
  techRequirements: TechRequirementMap;
  sciencePacks: {
    tierOrder: string[];
    displayMeta: SciencePackDisplayMeta;
  };
  recipes: {
    outputCount: RecipeOutputCount;
    endGameDisplay: EndGameRecipeDisplay[];
  };
  buildPhases: {
    baseMachineTypes: string[];
    phases: PhaseMeta[];
  };
};

async function fetchJson<T>(name: string): Promise<T> {
  const r = await fetch(`${GAME_DATA_BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json() as Promise<T>;
}

let cache: Promise<GameData> | null = null;

export function loadGameData(): Promise<GameData> {
  if (!cache) {
    cache = Promise.all([
      fetchJson<{ icons: TechIconMap }>('factorio-tech-icons.json'),
      fetchJson<{ technologies: TechRequirementMap }>('factorio-tech-requirements.json'),
      fetchJson<GameData['sciencePacks']>('science-packs.json'),
      fetchJson<GameData['recipes']>('recipes.json'),
      fetchJson<GameData['buildPhases']>('build-phases.json'),
    ]).then(([icons, reqs, sciencePacks, recipes, buildPhases]) => ({
      techIcons: icons.icons,
      techRequirements: reqs.technologies,
      sciencePacks,
      recipes,
      buildPhases,
    }));
  }
  return cache;
}

// ---------- helpers for components ----------

export function recipeMeta(gameData: GameData, recipe: string): EndGameRecipeDisplay {
  const m = gameData.recipes.endGameDisplay.find(r => r.recipe === recipe);
  if (m) return m;
  return { recipe, label: recipe, color: '#999999' };
}

export function phaseColor(gameData: GameData, phaseName: string): string {
  return gameData.buildPhases.phases.find(p => p.name === phaseName)?.color ?? '#999999';
}

export function packColor(gameData: GameData, pack: string): string {
  return gameData.sciencePacks.displayMeta[pack]?.color ?? '#999999';
}

export function packShort(gameData: GameData, pack: string): string {
  return gameData.sciencePacks.displayMeta[pack]?.short ?? pack;
}

// ---------- research-interval augmentation ----------

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
