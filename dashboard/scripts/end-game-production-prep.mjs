// End-game widget data: one Recipe-shaped row per recipe in
// recipes.json's `endGameDisplay`, on a shared per-period grid clipped to
// rocket launch. Combines production + buffer + player-inventory series via
// the shared lib/recipe-row builder so the React side can render every row
// through the same ProductionRow component.
//
// Inputs:
//   <runDir>/machineProduction.json
//   <runDir>/bufferAmounts.json
//   <runDir>/playerInventory.json
//   game-data/recipes.json  (loaded in lib/common.mjs)

import * as fs from 'fs';
import * as path from 'path';
import { RECIPES_GAME_DATA, buildGridTicks, tickToMin } from './lib/common.mjs';
import { buildRecipeRow } from './lib/recipe-row.mjs';

export function buildEndGameProduction(runDir, rocketLaunchTick) {
  const mp = JSON.parse(fs.readFileSync(path.join(runDir, 'machineProduction.json'), 'utf8'));
  const buf = JSON.parse(fs.readFileSync(path.join(runDir, 'bufferAmounts.json'), 'utf8'));
  const inv = JSON.parse(fs.readFileSync(path.join(runDir, 'playerInventory.json'), 'utf8'));

  const { gridTicks, minutes } = buildGridTicks(mp.period, rocketLaunchTick);
  const recipes = RECIPES_GAME_DATA.endGameDisplay.map(({ recipe }) =>
    buildRecipeRow(mp, buf, inv, recipe, gridTicks),
  );

  return { durationMin: tickToMin(rocketLaunchTick), minutes, recipes };
}
