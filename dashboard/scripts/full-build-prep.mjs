// Full-build phase analysis bundle. Produces one row per entry in
// recipes.json's `fullBuildDisplay`, in the same Recipe shape ProductionRow
// already consumes — so the React side renders these as ordinary rows with a
// per-row fixed display mode.
//
// Two groups are surfaced as tabs:
//   - Yellow: utility-science-pack (rate + cumulative). Same data as the
//     end-game chart but contextualized to the Full-build phase.
//   - Purple: production-science-pack (rate + cumulative) plus its key inputs
//     so the chart shows whether purple is input-limited.
//       - rail: rate (loss bands flag stalls)
//       - electric-furnace: rate (loss bands flag stalls)
//       - productivity-module: buffer (chests + player inventory)
//       - steel-plate: rate restricted to the "back side" steel-furnace
//         stack, i.e. machines built at/after the Full-build phase start
//
// `machineFilter: 'after-full-build-start'` mirrors oil-phase's
// `before-mixed` knob. It uses the Full-build phase startTick as the
// boundary; machines built at-or-after that tick contribute to the rate.

import * as fs from 'fs';
import * as path from 'path';
import { RECIPES_GAME_DATA, buildGridTicks, tickToMin } from './lib/common.mjs';
import { buildRecipeRow } from './lib/recipe-row.mjs';

export function buildFullBuildPhase(runDir, rocketLaunchTick, phases) {
  const cfgRaw = RECIPES_GAME_DATA.fullBuildDisplay;
  if (!cfgRaw) return null;
  // groups (cfgRaw.groups) are read at runtime directly from
  // gameData.recipes.fullBuildDisplay — not echoed into the per-run JSON.
  const config = cfgRaw.rows ?? [];
  if (config.length === 0) return null;

  const fullBuild = phases.find(p => p.name === 'Full build');
  if (fullBuild?.startTick == null) return null;
  const fullBuildStartTick = fullBuild.startTick;

  const mp  = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const { gridTicks, minutes } = buildGridTicks(mp.period, rocketLaunchTick);

  const rows = config.map(cfg => {
    // key + mode kept; the runtime widget pulls label / color / group from
    // gameData.recipes.fullBuildDisplay so editing recipes.json doesn't
    // require a prep rebuild.
    const stub = { key: cfg.key, mode: cfg.mode };

    const machineFilter = cfg.machineFilter === 'after-full-build-start'
      ? (m => m.timeBuilt >= fullBuildStartTick - mp.period)
      : null;

    const row = buildRecipeRow(mp, buf, inv, cfg.recipe, gridTicks, machineFilter);

    // Some buffer rows track items that flow through the player inventory but
    // are immediately installed (e.g. prod modules). For those, including the
    // player-inventory contribution misrepresents the stockpile — collapse
    // bufferWithInv onto chest-only.
    if (cfg.excludeInventory) {
      row.bufferWithInv = row.buffer.slice();
      row.peakBufferWithInv = row.peakBuffer;
    }

    return { ...row, ...stub };
  });

  return {
    durationMin: tickToMin(rocketLaunchTick),
    startMin: tickToMin(fullBuildStartTick),
    endMin: fullBuild.endTick != null ? tickToMin(fullBuild.endTick) : null,
    minutes,
    rows,
  };
}
