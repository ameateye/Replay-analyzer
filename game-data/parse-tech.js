// Parse Factorio 2.0.x technology.lua → JSON of tech name -> required science packs.
// Handles both unit.ingredients and research_trigger (which means no science packs).

const fs = require('fs');
const path = require('path');

const LUA_PATH = process.argv[2] || '/tmp/technology.lua';
const OUT_PATH = process.argv[3] || path.join(__dirname, 'factorio-tech-requirements.json');
const SOURCE_URL = 'https://raw.githubusercontent.com/wube/factorio-data/2.0.76/base/prototypes/technology.lua';
const VERSION_TAG = '2.0.76';

const PACK_ORDER = [
  'automation-science-pack',
  'logistic-science-pack',
  'military-science-pack',
  'chemical-science-pack',
  'production-science-pack',
  'utility-science-pack',
  'space-science-pack'
];
const PACK_INDEX = Object.fromEntries(PACK_ORDER.map((p, i) => [p, i]));

const src = fs.readFileSync(LUA_PATH, 'utf8');

// Find each technology block by scanning for `type = "technology"` and then matching balanced braces
// from the opening `{` of that block.
function findBalancedBlock(text, startBraceIdx) {
  // text[startBraceIdx] should be '{'
  let depth = 0;
  let i = startBraceIdx;
  let inString = false;
  let stringChar = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < text.length) {
    const c = text[i];
    const c2 = text.substr(i, 2);
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c2 === ']]') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === stringChar) { inString = false; }
      i++;
      continue;
    }
    if (c2 === '--') {
      // Could be block comment --[[
      if (text.substr(i, 4) === '--[[') { inBlockComment = true; i += 4; continue; }
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return [startBraceIdx, i];
    }
    i++;
  }
  throw new Error('Unbalanced braces starting at ' + startBraceIdx);
}

// Find every `type = "technology"` occurrence, then walk backwards to the enclosing `{`.
const techRegex = /type\s*=\s*"technology"/g;
const blocks = [];
let m;
while ((m = techRegex.exec(src)) !== null) {
  // Walk backwards to find the matching '{' that opens this object.
  // We want the '{' such that the contents up to here have balanced braces (depth 0 at that '{').
  let i = m.index;
  let depth = 0;
  while (i > 0) {
    i--;
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  const [start, end] = findBalancedBlock(src, i);
  blocks.push(src.slice(start, end + 1));
}

console.error(`Found ${blocks.length} technology blocks.`);

function extractName(block) {
  const nm = block.match(/\bname\s*=\s*"([^"]+)"/);
  return nm ? nm[1] : null;
}

// Extract the `unit = { ... }` sub-block, then within it the `ingredients = { ... }` sub-block.
function extractSubBlock(block, key) {
  const re = new RegExp('\\b' + key + '\\s*=\\s*\\{');
  const mm = re.exec(block);
  if (!mm) return null;
  const braceIdx = mm.index + mm[0].length - 1; // index of '{'
  const [s, e] = findBalancedBlock(block, braceIdx);
  return block.slice(s, e + 1);
}

function extractIngredients(block) {
  const unitBlock = extractSubBlock(block, 'unit');
  if (!unitBlock) return null; // research_trigger or other
  const ingBlock = extractSubBlock(unitBlock, 'ingredients');
  if (!ingBlock) return null;
  // Ingredients look like: { {"automation-science-pack", 1}, {"logistic-science-pack", 1} }
  // Or: { { type = "item", name = "automation-science-pack", amount = 1 } }
  const packs = new Set();
  // Match shorthand pairs first: {"name", N}
  const shortRe = /\{\s*"([a-z0-9\-]+)"\s*,\s*\d+\s*\}/g;
  let mm;
  while ((mm = shortRe.exec(ingBlock)) !== null) {
    packs.add(mm[1]);
  }
  // Match named-form: name = "..."
  const namedRe = /name\s*=\s*"([a-z0-9\-]+)"/g;
  while ((mm = namedRe.exec(ingBlock)) !== null) {
    packs.add(mm[1]);
  }
  return packs;
}

const technologies = {};
const allPackSets = new Set();
let researchTriggerCount = 0;

for (const block of blocks) {
  const name = extractName(block);
  if (!name) continue;
  const packs = extractIngredients(block);
  if (packs === null) {
    // research_trigger tech — no science packs required
    technologies[name] = [];
    researchTriggerCount++;
    continue;
  }
  // Filter to known science packs (Space Age might add others — keep only the 7 vanilla)
  const filtered = [...packs].filter(p => PACK_INDEX[p] !== undefined);
  filtered.sort((a, b) => PACK_INDEX[a] - PACK_INDEX[b]);
  technologies[name] = filtered;
  allPackSets.add(filtered.join(','));
}

// Sort technologies alphabetically.
const sortedTechs = {};
for (const k of Object.keys(technologies).sort()) sortedTechs[k] = technologies[k];

const out = {
  meta: {
    source: SOURCE_URL,
    factorioVersion: `2.0.x (tag ${VERSION_TAG})`,
    generatedAt: new Date().toISOString(),
    techCount: Object.keys(sortedTechs).length
  },
  technologies: sortedTechs
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.error(`Wrote ${OUT_PATH}`);
console.error(`Tech count: ${out.meta.techCount}`);
console.error(`research_trigger techs (empty pack list): ${researchTriggerCount}`);

// Validation
const VALIDATION = [
  'automation','electric-mining-drill','logistic-science-pack','fast-inserter','gun-turret',
  'military','steel-processing','heavy-armor','radar','stone-wall','military-2','engine',
  'automation-2','logistics-2','advanced-material-processing','automobilism','fluid-handling',
  'oil-gathering','research-speed-1','research-speed-2','military-science-pack','plastics',
  'sulfur-processing','advanced-circuit','chemical-science-pack','modules','productivity-module',
  'speed-module','battery','advanced-oil-processing','lubricant','electric-engine','robotics',
  'construction-robotics','worker-robots-speed-1','worker-robots-speed-2','processing-unit',
  'mining-productivity-1','explosives','low-density-structure','land-mine',
  'advanced-material-processing-2','utility-science-pack','railway','production-science-pack',
  'speed-module-2','productivity-module-2','solar-energy','electric-energy-distribution-1',
  'flammables','rocket-fuel','concrete','electric-energy-accumulators','effect-transmission',
  'productivity-module-3','speed-module-3','rocket-silo','steam-power','electronics',
  'automation-science-pack','steel-axe','oil-processing','logistics'
];
const missing = VALIDATION.filter(t => !(t in sortedTechs));
if (missing.length) {
  console.error('MISSING VALIDATION TECHS: ' + missing.join(', '));
  process.exitCode = 2;
} else {
  console.error('All ' + VALIDATION.length + ' validation techs present.');
}

// Print distinct pack-set tiers
const tiers = [...allPackSets].sort();
console.error('Distinct pack-set tiers (' + tiers.length + '):');
for (const t of tiers) console.error('  [' + (t || '<empty>') + ']');
