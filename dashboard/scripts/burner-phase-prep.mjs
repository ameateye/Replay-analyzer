// Burner-phase analysis bundle. One Recipe-shaped row per resource (iron /
// copper / coal / stone), in `count` mode — the per-tick scalar series is
// the count of active burner-mining-drills attributed to that resource.
//
// Plugs into the same shape OilPhase / FullBuild use: rows carry `key` +
// `mode`, display meta (label / color) lives in recipes.json under
// burnerPhaseDisplay and is looked up at runtime.
//
// X-axis is scoped tightly to the burner phase: it ends at the last
// burner-mining-drill removal + 5 minutes (capped by rocket launch). This
// gives the chart ~9× more resolution than the full-run timeline since
// burner activity is concentrated in the first ~15 min.
//
// Each row also reports `runningMin` — total minutes the count was > 0,
// used by the widget headline ("X burners running for Y minutes").
//
// Returns null for legacy runs without minerActivity.json so the widget
// gracefully degrades to a "data missing" message.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = path.resolve(SCRIPT_DIR, '..', '..', 'game-data', 'recipes.json');
const RECIPES_GAME_DATA = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));

const STATUS_KEYS = ['no_ingredients', 'no_fuel', 'full_output', 'low_power', 'depleted', 'unknown'];
const POST_PHASE_PAD_TICKS = 5 * 60 * 60;

export function buildBurnerPhase(runDir, rocketLaunchTick, phases) {
  const minerPath = path.join(runDir, 'minerActivity.json');
  if (!fs.existsSync(minerPath)) return null;

  const cfg = RECIPES_GAME_DATA.burnerPhaseDisplay;
  const groups = cfg?.groups ?? [];
  const rowConfigs = cfg?.rows ?? [];
  if (rowConfigs.length === 0) return null;

  const data = JSON.parse(fs.readFileSync(minerPath, 'utf8'));
  const period = data.period;
  const burner = phases.find(p => p.name === 'Burner');

  // Last tick we want on the chart: latest burner removal across all
  // tracked resources, plus 5 min of tail; falls back to burner phase end
  // if no burners were ever removed (unusual). Capped by rocket launch.
  const lastRemoved = data.miners
    .filter(m => m.name === 'burner-mining-drill' && m.timeRemoved != null)
    .reduce((acc, m) => Math.max(acc, m.timeRemoved), 0);
  const baseEnd = lastRemoved > 0 ? lastRemoved : (burner?.endTick ?? rocketLaunchTick);
  const xMaxTick = Math.min(rocketLaunchTick, baseEnd + POST_PHASE_PAD_TICKS);

  const gridTicks = [];
  for (let t = 0; t <= xMaxTick; t += period) gridTicks.push(t);
  const minutes = gridTicks.map(t => +(t / 3600).toFixed(4));
  const N = gridTicks.length;

  const rows = rowConfigs.map(cfgRow => {
    const buffer = new Array(N).fill(0);
    for (const m of data.miners) {
      if (m.name !== 'burner-mining-drill') continue;
      if (m.resources?.[0] !== cfgRow.recipe) continue;
      const fromIdx = Math.max(0, Math.ceil(m.timeBuilt / period));
      const toIdx = m.timeRemoved != null
        ? Math.min(N, Math.ceil(m.timeRemoved / period))
        : N;
      for (let i = fromIdx; i < toIdx; i++) buffer[i]++;
    }
    const peak = buffer.reduce((m, v) => Math.max(m, v), 0);
    const activeSamples = buffer.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    const runningMin = +((activeSamples * period) / 3600).toFixed(2);
    return {
      ...makeCountRow(cfgRow.key, cfgRow.mode, cfgRow.recipe, buffer, peak, N),
      runningMin,
    };
  });

  return {
    durationMin: +(rocketLaunchTick / 3600).toFixed(4),
    startMin: burner?.startMin ?? 0,
    endMin: burner?.endMin ?? null,
    xMaxMin: +(xMaxTick / 3600).toFixed(4),
    xMaxTick,
    minutes,
    groups,
    rows,
  };
}

// Build a Recipe-shaped row whose only populated series is the per-tick
// count, parked in buffer + bufferWithInv so ProductionRow's line-mode
// renderer reads it without modification. All other Recipe fields are
// zero-filled so the row stays type-compatible.
function makeCountRow(key, mode, recipe, count, peak, N) {
  const zeros = () => new Array(N).fill(0);
  return {
    key,
    mode,
    recipe,
    chestCount: 0,
    finalCum: 0,
    peakActual: 0,
    peakPotential: 0,
    peakBuffer: peak,
    peakBufferWithInv: peak,
    actual: zeros(),
    potential: zeros(),
    itemsByLoss: [],
    fluidsByLoss: [],
    itemLoss: {},
    fluidLoss: {},
    statusLoss: Object.fromEntries(STATUS_KEYS.map(k => [k, zeros()])),
    cum: zeros(),
    buffer: count,
    bufferWithInv: count,
    bufferLimit: null,
    peakBufferLimit: 0,
    showBufferLimit: false,
  };
}
