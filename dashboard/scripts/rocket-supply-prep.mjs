// Rocket-supply readiness: the tick at which the base has banked enough
// low-density structures / processing units / rocket fuel to finish the run.
//
// The silo needs 100 rocket parts. With 4× productivity-module-3 (+10% each)
// it only pays for ceil(100 / 1.4) = 72 ingredient-consuming crafts, and the
// rocket-part recipe takes 10 of each item per craft — so the run must bank
// 72 × 10 = 720 LDS, 720 processing units and 720 rocket fuel *over and above*
// everything else that eats those items.
//
// Competing consumers (all read generically from the recipes actually run in
// this save, via game-data/recipe-ingredients.json):
//   utility-science-pack   3 LDS + 2 processing-unit per craft
//   rocket-silo            200 processing-unit
//   productivity-module-2  5 processing-unit each  (16 for the 4 prod-3s)
//   productivity-module-3  5 processing-unit each
// Rocket fuel has no competing *recipe* consumer (burning it as fuel is not
// tracked by any collector, so a run that feeds furnaces rocket fuel would
// read as over-production here).
//
// PRODUCTIVITY — the one subtlety that makes or breaks the arithmetic.
// `machineProduction` samples carry `productsFinished`, and Factorio counts
// productivity-granted crafts in that number. Free crafts are real items but
// eat no ingredients, so:
//   supply      = productsFinished × outputCount
//   consumption = paid crafts × ingredientAmount
// Skipping the split over-charges yellow science by ~10% of its ingredients
// and makes the fastest runs read as if they never made enough LDS to launch.
//
// The split is MEASURED off the machine's own productivity bar
// (`productivityProgress` = `entity.bonus_progress`), not inferred from a
// formula. The bar advances continuously with crafting — verified on
// DS-1_59_01 unit 42045, where it gained 0.0486 every 300 ticks while crafting
// progress advanced 0.405 of a craft, and 0.405 × 0.12 = 0.0486 — so it reads
//   bar = b × (paid crafts + current partial progress) − grants
// which, together with productsFinished = paid + granted, inverts per sample to
//   paid   = (ΔproductsFinished + Δbar − b·Δcrafting) / (1 + b)
//   grants = ΔproductsFinished − paid
// `paid` lands on an integer to within 0.03 of a craft across every run — see
// ad-hoc-analysis/_prod_bar_check.mjs. Measuring rather than assuming matters:
// a machine whose recipe is cleared DISCARDS its accumulated bar (0.96 → 0),
// so grants run *below* floor(paid·b) — on DS-1_59_01 yellow science the bar
// shows 36 granted crafts where the formula would claim 38.
//
// Both bars belong to the machine and survive the block split that a module or
// beacon change causes, so the per-sample deltas chain across consecutive
// blocks of the same recipe; only a real recipe change re-anchors them.
//
// Output (see docs/architecture/per_run_data.md → rocketSupply):
//   {
//     requirement, partsRequired, itemsPerPart, siloProductivity,
//     readyTick, readyMin, bindingItem,
//     finishedTick, finishedMin, bindingFinishedItem,
//     grantedCrafts, worstCraftResidual,
//     items: [{ item, readyTick, readyMin, finishedTick, finishedMin,
//               produced, consumedOther, surplus, shortfall, consumers }]
//   }
//
// `readyTick` is the last tick at which net banked stock (produced − consumed
// by the competing recipes) rises to the requirement and stays there: from
// there on the run always holds a full rocket's worth of that item. It is the
// per-item answer to "when did this stop being what the rocket was waiting
// for". `finishedTick` is the stricter reading — cumulative production covers
// the requirement *plus* every competing craft the run will ever make, so if
// everything stopped there the run still launches. That's the one the chart
// marks; both are carried so they can be compared per run.
//
// The ledger closes positive for all three items on all 16 DS runs —
// DS-1_59_01 is the tightest at 1697 LDS produced, 972 to yellow science, 720
// to the rocket, 5 items of slack across the whole run. `shortfall` is the
// safety net for a run whose residual ever lands *under* the requirement,
// which would leave the crossing undefined: it records the gap and the
// thresholds fall back to the net reached at launch. A non-zero `shortfall`
// means that run's consumption side should be distrusted, not that the run
// was tight.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { RECIPES_GAME_DATA, tickToMin } from './lib/common.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DATA_DIR = path.resolve(SCRIPT_DIR, '..', '..', 'game-data');

const INGREDIENTS = JSON.parse(
  fs.readFileSync(path.join(GAME_DATA_DIR, 'recipe-ingredients.json'), 'utf8'),
);

// The three items a rocket part is made of. Each is also the name of the
// recipe that produces it, which is what lets supply and demand be read off
// the same machineProduction pass.
export const ROCKET_PART_ITEMS = [
  'low-density-structure',
  'processing-unit',
  'rocket-fuel',
];

// Base-2.0 rocket economics. Not derivable from any collector: rocket-silo
// module contents aren't captured, and the FBSR data dump this repo ships is
// Space-Age-enabled (50 parts × 1 item), so its rocket numbers don't describe
// these saves. Verified against the runs instead — rocket fuel has no other
// consumer and the tightest run produced 741, which only closes at 720.
export const PARTS_REQUIRED = 100;
export const ITEMS_PER_PART = 10;
export const SILO_PRODUCTIVITY = 0.4; // 4 × productivity-module-3
export const REQUIREMENT =
  Math.ceil(PARTS_REQUIRED / (1 + SILO_PRODUCTIVITY)) * ITEMS_PER_PART;

// Paid (ingredient-consuming) crafts in one sample, read off the machine's
// bars. `prev` carries the previous sample's bar + crafting progress; a bar
// that drops to 0 with nothing finished is a recipe clear discarding the
// accumulated bonus, not a grant, so it re-anchors instead of counting.
// Returns the rounded craft count plus the pre-rounding residual, which the
// caller aggregates as a data-quality signal.
function paidCrafts(sample, prev, bonus) {
  const [, finished, crafting, bar] = sample;
  if (bar === 0 && finished === 0 && prev.bar > 0) return { paid: 0, residual: 0 };
  const raw = (finished + (bar - prev.bar) - bonus * (crafting - prev.crafting)) / (1 + bonus);
  const paid = Math.max(0, Math.round(raw));
  return { paid, residual: Math.abs(raw - paid) };
}

export function buildRocketSupply(runDir, rocketLaunchTick) {
  const mpPath = path.join(runDir, 'machineProduction.json');
  if (!fs.existsSync(mpPath)) return null;
  const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  const period = mp.period;
  const N = Math.floor(rocketLaunchTick / period) + 1;
  const outputCount = RECIPES_GAME_DATA.outputCount ?? {};

  // produced[item][i] / consumed[item][i]: items gained / spent in period i.
  const produced = new Map();
  const consumed = new Map();
  const consumers = new Map(); // item -> { recipe -> total items spent }
  for (const item of ROCKET_PART_ITEMS) {
    produced.set(item, new Array(N).fill(0));
    consumed.set(item, new Array(N).fill(0));
    consumers.set(item, {});
  }

  // Which recipes in this save spend our three items? Read from the recipe
  // table rather than hard-coded, so a route change (extra modules, a
  // different science mix) is picked up without editing this file. rocket-part
  // is excluded on purpose — that IS the demand we're sizing.
  // The recipe table comes from a Space-Age-enabled dump, so a few entries
  // carry ingredients base 2.0 doesn't have (prod-3's biter-egg). None of that
  // touches the three items tracked here — their per-craft counts match.
  const spendOf = recipe => {
    if (recipe === 'rocket-part') return null;
    const ing = INGREDIENTS[recipe]?.ingredients;
    if (!ing) return null;
    const hits = ROCKET_PART_ITEMS.filter(i => ing[i] > 0).map(i => [i, ing[i]]);
    return hits.length ? hits : null;
  };

  let worstResidual = 0;
  let grantedCrafts = 0;

  for (const machine of mp.machines) {
    // Walk every block in order — including ones we don't score — so the bar
    // chaining sees the machine's true recipe history.
    let prev = null; // { recipe, bar, crafting }
    for (const block of machine.recipes ?? []) {
      const samples = block.production;
      if (!samples?.length) continue;
      const makes = ROCKET_PART_ITEMS.includes(block.recipe) ? block.recipe : null;
      const spends = spendOf(block.recipe);
      const factor = outputCount[block.recipe] ?? 1;
      const bonus = block.productivityBonus ?? 0;

      // A module/beacon swap splits the block without touching the bars, so a
      // same-recipe continuation carries them; a real recipe change starts over.
      const state = prev && prev.recipe === block.recipe
        ? { bar: prev.bar, crafting: prev.crafting }
        : { bar: 0, crafting: 0 };

      for (const sample of samples) {
        const tick = sample[0];
        if (tick > rocketLaunchTick) break; // production[] is tick-sorted
        const i = Math.min(N - 1, Math.max(0, Math.floor(tick / period)));
        if (makes) produced.get(makes)[i] += sample[1] * factor;
        if (spends || makes) {
          const { paid, residual } = paidCrafts(sample, state, bonus);
          if (residual > worstResidual) worstResidual = residual;
          if (spends) {
            grantedCrafts += sample[1] - paid;
            // Ingredients are drawn at craft *start*; attributing them to the
            // completing period is off by one craft time (21s for yellow),
            // immaterial against a 720-item budget.
            for (const [item, amount] of spends) {
              consumed.get(item)[i] += paid * amount;
              const tally = consumers.get(item);
              tally[block.recipe] = (tally[block.recipe] ?? 0) + paid * amount;
            }
          }
        }
        state.bar = sample[3];
        state.crafting = sample[2];
      }
      const last = samples[samples.length - 1];
      prev = { recipe: block.recipe, bar: last[3], crafting: last[2] };
    }
  }

  const items = ROCKET_PART_ITEMS.map(item => {
    const prod = produced.get(item);
    const cons = consumed.get(item);
    const totalProd = prod.reduce((a, b) => a + b, 0);
    const totalCons = cons.reduce((a, b) => a + b, 0);
    // A launched run banked the requirement by definition, so a residual below
    // it is ledger noise, not a real deficit — fall back to what was reached.
    const shortfall = Math.max(0, REQUIREMENT - (totalProd - totalCons));
    const readyTarget = REQUIREMENT - shortfall;

    let cumProd = 0;
    let cumCons = 0;
    let readyIdx = null;   // start of the final stretch that holds the target
    let belowSince = 0;    // first index of the current below-target stretch
    let finishedIdx = null;
    for (let i = 0; i < N; i++) {
      cumProd += prod[i];
      cumCons += cons[i];
      if (cumProd - cumCons >= readyTarget) {
        if (readyIdx === null) readyIdx = belowSince;
      } else {
        readyIdx = null;
        belowSince = i + 1;
      }
      if (finishedIdx === null && cumProd >= readyTarget + totalCons) finishedIdx = i;
    }
    const tickOf = idx => (idx === null ? null : Math.min(idx * period, rocketLaunchTick));
    const readyTick = tickOf(readyIdx);
    const finishedTick = tickOf(finishedIdx);
    return {
      item,
      readyTick,
      readyMin: readyTick === null ? null : tickToMin(readyTick),
      finishedTick,
      finishedMin: finishedTick === null ? null : tickToMin(finishedTick),
      produced: totalProd,
      consumedOther: +totalCons.toFixed(2),
      surplus: +(totalProd - totalCons - REQUIREMENT).toFixed(2),
      shortfall,
      consumers: Object.fromEntries(
        Object.entries(consumers.get(item)).sort((a, b) => b[1] - a[1]),
      ),
    };
  });

  // The run is supplied once every item is: the latest per-item tick. Both
  // readings get their own binding item — they can name different items, so
  // collapsing them into one summary would misattribute the constraint.
  const latest = key => {
    if (!items.every(r => r[key] !== null)) return null;
    return items.reduce((a, r) => (r[key] > a[key] ? r : a));
  };
  const ready = latest('readyTick');
  const finished = latest('finishedTick');

  return {
    requirement: REQUIREMENT,
    partsRequired: PARTS_REQUIRED,
    itemsPerPart: ITEMS_PER_PART,
    siloProductivity: SILO_PRODUCTIVITY,
    readyTick: ready?.readyTick ?? null,
    readyMin: ready?.readyMin ?? null,
    bindingItem: ready?.item ?? null,
    finishedTick: finished?.finishedTick ?? null,
    finishedMin: finished?.finishedMin ?? null,
    bindingFinishedItem: finished?.item ?? null,
    // Data-quality signal for the bar read: paid crafts are solved as a real
    // and rounded, so this is how far the worst single sample sat from a whole
    // craft. Most run/recipe pairs come out at exactly 0; the worst sample
    // across the 16 DS runs is 0.21. 0.5 is where rounding would flip to the
    // wrong craft count, so that's the line — approaching it means the bar
    // model no longer describes the save.
    grantedCrafts,
    worstCraftResidual: +worstResidual.toFixed(4),
    items,
  };
}
