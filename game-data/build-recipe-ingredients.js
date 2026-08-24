// Build a recipe-name → { ingredients, products, energy } table from Factorio's
// real prototype data (data-raw), the same source FBSR reads.
//
// Source: the FBSR vanilla data dump produced when FBSR enumerates sprites:
//   Factorio-FBSR/.../build/vanilla/data/script-output/data-raw-dump.json
// This is a dump of the *installed* Factorio's `data.raw` (game version is
// whatever FBSR's `build vanilla` step ran against — currently 2.0.x with the
// builtin base/quality/elevated-rails/space-age mods). The early/mid-game base
// recipes the DS runs touch are identical between base-only and Space Age, so
// the extra Space Age recipes in the set are harmless: the consumer looks up by
// recipe name and ignores anything it doesn't query.
//
// Output: game-data/recipe-ingredients.json
//   { "<recipe>": { "ingredients": { "<item>": <count>, … },
//                   "products":    { "<item>": <count>, … },
//                   "energy": <seconds> } }
// `ingredients` is the field the player-activity craft ledger consumes
// (INGREDIENTS[recipe] → { item: count }); products + energy are included
// because they're free from the same record and useful elsewhere.
//
// Both fluids and items are flattened into the same maps (keyed by name);
// the consumer only cares about item names it tracks, so the fluid/item
// distinction is dropped. Result `probability` (e.g. uranium processing) is
// multiplied into the expected product count so `products` is the expected
// yield per craft.
//
// Usage:
//   node game-data/build-recipe-ingredients.js [path-to-data-raw-dump.json] [out.json]

const fs = require('fs');
const path = require('path');

const DEFAULT_DUMP = path.join(
  __dirname, '..',
  'Factorio-FBSR', 'FactorioBlueprintStringRenderer',
  'build', 'vanilla', 'data', 'script-output', 'data-raw-dump.json'
);

const DUMP_PATH = process.argv[2] || DEFAULT_DUMP;
const OUT_PATH = process.argv[3] || path.join(__dirname, 'recipe-ingredients.json');

// Factorio serialises Lua arrays as JSON arrays normally, but a sparse/edited
// table can come through as an object keyed by "1","2",…. Normalise both.
function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : Object.values(x);
}

// Sum a list of {name, amount, probability?} into a name→count map. Duplicate
// names (rare, but legal) accumulate. Probability scales the expected count.
function foldAmounts(list) {
  const out = {};
  for (const e of asArray(list)) {
    if (!e || e.name == null) continue;
    let amt = e.amount;
    if (amt == null && (e.amount_min != null || e.amount_max != null)) {
      amt = ((e.amount_min || 0) + (e.amount_max || 0)) / 2;
    }
    if (amt == null) continue;
    if (e.probability != null) amt *= e.probability;
    out[e.name] = (out[e.name] || 0) + amt;
  }
  return out;
}

function main() {
  if (!fs.existsSync(DUMP_PATH)) {
    console.error('Data dump not found:', DUMP_PATH);
    console.error('Run FBSR\'s `build vanilla` step to produce data-raw-dump.json,');
    console.error('or pass an explicit path as the first argument.');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const recipes = raw.recipe;
  if (!recipes) {
    console.error('No `recipe` key in dump — is this a data-raw dump?');
    process.exit(1);
  }

  const out = {};
  for (const name of Object.keys(recipes).sort()) {
    const r = recipes[name];
    const ingredients = foldAmounts(r.ingredients);
    const products = foldAmounts(r.results);
    const entry = { ingredients, products };
    // energy_required defaults to 0.5s in Factorio when omitted.
    entry.energy = r.energy_required != null ? r.energy_required : 0.5;
    out[name] = entry;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0) + '\n');
  console.log('Wrote', Object.keys(out).length, 'recipes →', OUT_PATH);
}

main();
