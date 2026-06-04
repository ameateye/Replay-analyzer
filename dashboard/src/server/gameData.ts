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

// Display config for the oil-phase / full-build widgets. Keyed by row `key`
// (which the per-run JSON also stores), so editing label/color/group/mode in
// recipes.json takes effect on the next page reload — no prep rebuild needed.
// Combined rows (rate-mode rows that aggregate multiple recipes) carry per-
// component label/color too.
export type ComponentDisplay = { recipe: string; label: string; color: string };
export type PhaseRowDisplay = {
  key: string;
  group: string;
  recipe: string;
  label: string;
  color: string;
  mode: string;
  components?: ComponentDisplay[];
  excludeInventory?: boolean;
  machineFilter?: string;
};
export type PhaseGroupDisplay = { id: string; label: string };
export type PhaseDisplay = { groups: PhaseGroupDisplay[]; rows: PhaseRowDisplay[] };

export type GameData = {
  techIcons: TechIconMap;
  techRequirements: TechRequirementMap;
  sciencePacks: {
    tierOrder: string[];
    displayMeta: SciencePackDisplayMeta;
  };
  recipes: {
    outputCount: RecipeOutputCount;
    // Buffer-capacity inputs: chestSlots is inventory slot count per chest
    // entity; stackSizes is item stack size; tankCapacity is the fluid
    // tank capacity. Joined at render time with `stocks.entities` to
    // derive chestCount + the buffer-limit reference line.
    chestSlots: Record<string, number>;
    stackSizes: Record<string, number>;
    tankCapacity: number;
    endGameDisplay: EndGameRecipeDisplay[];
    mixedSegmentDisplay: EndGameRecipeDisplay[];
    oilPhaseDisplay: PhaseDisplay;
    fullBuildDisplay: PhaseDisplay;
    burnerPhaseDisplay: PhaseDisplay;
    manualGatheringDisplay: PhaseDisplay;
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
  const m = gameData.recipes.endGameDisplay.find(r => r.recipe === recipe)
         ?? gameData.recipes.mixedSegmentDisplay.find(r => r.recipe === recipe);
  if (m) return m;
  return { recipe, label: recipe, color: '#999999' };
}

export function phaseRowDisplay(
  gameData: GameData,
  scope: 'oilPhase' | 'fullBuild',
  key: string,
): PhaseRowDisplay | null {
  const cfg = scope === 'oilPhase' ? gameData.recipes.oilPhaseDisplay : gameData.recipes.fullBuildDisplay;
  return cfg?.rows.find(r => r.key === key) ?? null;
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

// ---------- item-colour palette (used by the flow overlay) ----------

// Hand-picked colours per item — varies across hue + saturation + lightness
// so the eye can read a base map and identify what's flowing. Items not in
// the table fall back to a deterministic-hash palette.
const ITEM_COLORS: Record<string, string> = {
  'iron-ore':            '#6e7d96',
  'copper-ore':          '#c47a3a',
  'stone':               '#a89770',
  'coal':                '#202024',
  'uranium-ore':         '#5db04a',
  'iron-plate':          '#c5cad6',
  'copper-plate':        '#e08a3e',
  'steel-plate':         '#8a99b2',
  'stone-brick':         '#9c8a6a',
  'iron-gear-wheel':     '#8d96a8',
  'iron-stick':          '#b0a890',
  'copper-cable':        '#e6a463',
  'electronic-circuit':  '#3aa44b',
  'advanced-circuit':    '#c8403e',
  'processing-unit':     '#3266c4',
  'pipe':                '#a3a3a3',
  'pipe-to-ground':      '#7a7a85',
  'concrete':            '#6b6b70',
  'plastic-bar':         '#e0e0e0',
  'sulfur':              '#f0d435',
  'battery':             '#2c8a4a',
  'explosives':          '#d24c2c',
  'solid-fuel':          '#3a2a1c',
  'engine-unit':         '#7c6e5c',
  'electric-engine-unit':'#7e9b87',
  'flying-robot-frame':  '#b0c4d8',
  'low-density-structure':'#c7d8e6',
  'rocket-fuel':         '#a04030',
  'rocket-part':         '#c84028',
  'automation-science-pack': '#d24545',
  'logistic-science-pack':   '#3aa850',
  'military-science-pack':   '#6f6f6f',
  'chemical-science-pack':   '#3aa8b8',
  'production-science-pack': '#a850c8',
  'utility-science-pack':    '#e0c050',
};

const ITEM_COLOR_FALLBACKS = [
  '#7488a8', '#a06870', '#7c9c5e', '#8a78a8', '#a89060', '#5e8c98',
  '#a85c5c', '#5c98a8', '#a8985c', '#5c5ca8',
];

export function colorForItem(item: string | null | undefined): string {
  if (!item) return '#888888';
  const c = ITEM_COLORS[item];
  if (c) return c;
  let h = 0;
  for (let i = 0; i < item.length; i++) h = ((h * 31) + item.charCodeAt(i)) >>> 0;
  return ITEM_COLOR_FALLBACKS[h % ITEM_COLOR_FALLBACKS.length];
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
