// Mixed-phase health: five Recipe-shaped rows describing whether the post-oil
// "Mixed" segment is running cleanly. Same Recipe shape as the end-game rows
// so the React side reuses ProductionRow on the shared full-run x-axis:
//
//   copper-plate (mixed-only) — own copper, all 4 lanes should be working.
//                               Machine-filtered to furnaces built during the
//                               Mixed phase; the time series itself spans the
//                               full run so the chart aligns with the overview.
//   iron-plate (buffer mode)  — Mixed iron is drawn from buffer chests.
//   plastic-bar (mixed-only)  — same machine filter as copper.
//   low-density-structure     — output; rate-mode stack surfaces plastic-bar
//                               stalls when plastic is input-limited.
//   processing-unit           — output; same purpose as LDS.
//
// startMin / endMin are kept on the result so the header can show the Mixed
// window range, even though the chart data is full-run.

import * as fs from 'fs';
import * as path from 'path';
import { buildGridTicks, tickToMin } from './lib/common.mjs';
import { buildRecipeRow } from './lib/recipe-row.mjs';

export function buildMixedSegment(runDir, phases, rocketLaunchTick) {
  const mixed = phases.find(p => p.name === 'Mixed');
  if (mixed?.startTick == null || mixed?.endTick == null) return null;

  const mp = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const { gridTicks, minutes } = buildGridTicks(mp.period, rocketLaunchTick);

  // Mixed-segment machines = those built during the Mixed phase, distinguished
  // from earlier dedicated lines on the main bus (e.g. the original Oil-phase
  // plastic plants). The −period slack catches machines that started
  // construction just before the boundary.
  const builtDuringMixed = (recipe) => (m) =>
    m.recipes
    && m.recipes.some(r => r.recipe === recipe)
    && m.timeBuilt >= mixed.startTick - mp.period;

  const recipes = [
    { recipe: 'copper-plate',          mode: 'rate',   filter: builtDuringMixed('copper-plate') },
    { recipe: 'iron-plate',            mode: 'buffer' },
    { recipe: 'plastic-bar',           mode: 'rate',   filter: builtDuringMixed('plastic-bar')  },
    { recipe: 'low-density-structure', mode: 'rate'   },
    { recipe: 'processing-unit',       mode: 'rate'   },
  ].map(({ recipe, mode, filter }) => ({
    ...buildRecipeRow(mp, buf, inv, recipe, gridTicks, filter ?? null),
    mode,
  }));

  return {
    startMin: tickToMin(mixed.startTick),
    endMin:   tickToMin(mixed.endTick),
    minutes,
    recipes,
  };
}
