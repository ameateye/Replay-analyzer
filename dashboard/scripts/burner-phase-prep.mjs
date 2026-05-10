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
import { RECIPES_GAME_DATA, buildGridTicks, emptyRecipeRow, tickToMin } from './lib/common.mjs';

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

  const { gridTicks, minutes, N } = buildGridTicks(period, xMaxTick);

  const rows = rowConfigs.map(cfgRow => {
    const count = new Array(N).fill(0);
    for (const m of data.miners) {
      if (m.name !== 'burner-mining-drill') continue;
      if (m.resources?.[0] !== cfgRow.recipe) continue;
      const fromIdx = Math.max(0, Math.ceil(m.timeBuilt / period));
      const toIdx = m.timeRemoved != null
        ? Math.min(N, Math.ceil(m.timeRemoved / period))
        : N;
      for (let i = fromIdx; i < toIdx; i++) count[i]++;
    }
    const peak = count.reduce((m, v) => Math.max(m, v), 0);
    const activeSamples = count.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    const runningMin = +((activeSamples * period) / 3600).toFixed(2);

    // Park the count series in buffer + bufferWithInv so ProductionRow's
    // line-mode renderer reads it without modification. Every other field
    // is the empty-row default.
    return {
      ...emptyRecipeRow(N),
      key: cfgRow.key,
      mode: cfgRow.mode,
      recipe: cfgRow.recipe,
      peakBuffer: peak,
      peakBufferWithInv: peak,
      buffer: count,
      bufferWithInv: count,
      runningMin,
    };
  });

  return {
    durationMin: tickToMin(rocketLaunchTick),
    startMin: burner?.startMin ?? 0,
    endMin: burner?.endMin ?? null,
    xMaxMin: tickToMin(xMaxTick),
    xMaxTick,
    minutes,
    groups,
    rows,
  };
}
