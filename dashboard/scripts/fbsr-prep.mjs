// Gap-fill orchestrator for the shared sprite store.
//
// Walks `extracted-data/<run>/*` to enumerate the (name, end-direction, end-bgt)
// variants the run needs plus its recipe and filter-item sets, diffs that
// against `game-data/map-sprite-meta.json` + `game-data/map-sprites.json`,
// and — only if the diff is non-empty — invokes the Java `SpriteEnumerator`
// CLI to render the missing variants and merge the result back into the
// shared store. See docs/specs/fbsr_elimination.md (Component C).
//
// Inputs:  extracted-data/<run>/{entityLayout,minerActivity,machineProduction,
//                                labContents,bufferAmounts,rocketLaunchTime}.json
//          game-data/map-sprite-meta.json   (current shared variant store)
//          game-data/map-sprites.json       (current shared atlas)
// Output:  updated game-data/{map-sprite-meta,map-sprites}.json (in place)
//          tools/output/<run>.variants.json (transient handoff to Java)
//          tools/output/<run>.sprite-build.json (Java output, transient)
//
// Idempotent: re-running with no new variants is a no-op and never spawns
// Java. CI never calls this script — it only ever runs `npm run build`,
// which reads the pre-built shared store.
//
// Usage:  node scripts/fbsr-prep.mjs <run-name>
//
// Build-time integration: build-run-data.mjs calls ensureSpriteCoverage()
// before map-prep so a fresh extraction with new entity variants
// auto-extends the shared store.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const FBSR_DIR  = resolve(ROOT, 'Factorio-FBSR', 'FactorioBlueprintStringRenderer');
const FBSR_JAR  = resolve(FBSR_DIR, 'target', 'FactorioBlueprintStringRenderer-0.0.1-SNAPSHOT.jar');
const FBSR_CP   = resolve(FBSR_DIR, 'target', 'cp.txt');
const JDK_HOME  = resolve(ROOT, 'tools', 'jdk21', 'jdk-21.0.11+10');
const JAVA_EXE  = resolve(JDK_HOME, 'bin', 'java.exe');

const META_PATH   = resolve(ROOT, 'game-data', 'map-sprite-meta.json');
const SPRITE_PATH = resolve(ROOT, 'game-data', 'map-sprites.json');

const LAYOUT_SCOPE = new Set([
  'transport-belt', 'fast-transport-belt', 'express-transport-belt',
  'underground-belt', 'fast-underground-belt', 'express-underground-belt',
  'splitter', 'fast-splitter', 'express-splitter',
  'burner-inserter', 'inserter', 'long-handed-inserter',
  'fast-inserter', 'filter-inserter', 'stack-inserter', 'stack-filter-inserter',
  'bulk-inserter',
]);

function readJsonOrNull(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}
function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

function foldDirection(e, cutoff) {
  let dir = e.direction ?? 0;
  let bgt = e.beltToGroundType ?? null;
  for (const m of e.mutations ?? []) {
    if (m.tick > cutoff) break;
    if (m.direction !== undefined) dir = m.direction;
    if (m.beltToGroundType !== undefined) bgt = m.beltToGroundType;
  }
  return { dir, bgt };
}

function variantKey(name, dir, bgt) {
  return `${name}|${dir ?? 0}|${bgt ?? '_'}`;
}

// Enumerate the (name, end-direction, end-bgt) variants, recipes, and
// filter-items the run will reference at render time. Mirrors the
// extraction performed by map-prep so the two stay in sync.
function collectRunNeeds(runDir, durationTick) {
  const variants = new Map();         // key → { name, direction, bgt }
  const recipes = new Set();
  const filterItems = new Set();

  function addVariant(name, dir, bgt) {
    const k = variantKey(name, dir, bgt);
    if (!variants.has(k)) variants.set(k, { name, direction: dir ?? 0, bgt: bgt ?? null });
  }

  // 1) entityLayout — belts / UBs / splitters / inserters in scope. Older
  //    extractions may pre-date this collector; treat as empty.
  const layout = readJsonOrNull(resolve(runDir, 'entityLayout.json'));
  for (const e of layout?.entities ?? []) {
    if (!LAYOUT_SCOPE.has(e.name)) continue;
    const { dir, bgt } = foldDirection(e, durationTick);
    addVariant(e.name, dir, bgt);
    // Splitter filters / inserter filters seed filterItems.
    if (e.name.endsWith('splitter')) {
      if (e.splitterFilter) filterItems.add(e.splitterFilter);
      for (const m of e.mutations ?? []) if (m.splitterFilter) filterItems.add(m.splitterFilter);
    }
    if (e.inserterFilters) {
      const seed = Array.isArray(e.inserterFilters) ? e.inserterFilters : [];
      for (const f of seed) filterItems.add(f);
    }
    for (const m of e.mutations ?? []) {
      const next = m.inserterFilters;
      if (Array.isArray(next)) for (const f of next) filterItems.add(f);
    }
  }

  // 2) minerActivity.
  const minerData = readJsonOrNull(resolve(runDir, 'minerActivity.json'));
  for (const m of minerData?.miners ?? []) addVariant(m.name, m.direction ?? 0, null);

  // 3) machineProduction — variants + recipes.
  const mp = readJsonOrNull(resolve(runDir, 'machineProduction.json'));
  for (const m of mp?.machines ?? []) {
    addVariant(m.name, m.direction ?? 0, null);
    for (const r of m.recipes ?? []) if (r?.recipe) recipes.add(r.recipe);
  }

  // 4) labs (no direction).
  const labData = readJsonOrNull(resolve(runDir, 'labContents.json'));
  for (const l of labData?.labs ?? []) addVariant(l.name, 0, null);

  // 5) buffers (no direction).
  const ba = readJsonOrNull(resolve(runDir, 'bufferAmounts.json'));
  for (const b of ba?.buffers ?? []) addVariant(b.name, 0, null);

  return { variants, recipes, filterItems };
}

function diffAgainstStore(needs, meta, sprites) {
  const missingVariants = [];
  for (const [k, v] of needs.variants) if (!meta[k]) missingVariants.push(v);
  const missingRecipes = [...needs.recipes].filter(r => !sprites[`r:${r}`]).sort();
  const missingFilters = [...needs.filterItems].filter(f => !sprites[`f:${f}`]).sort();
  return { missingVariants, missingRecipes, missingFilters };
}

function javaToolingReady() {
  if (!existsSync(FBSR_JAR)) return { ok: false, reason: `FBSR jar missing: ${FBSR_JAR}` };
  if (!existsSync(FBSR_CP))  return { ok: false, reason: `FBSR classpath file missing: ${FBSR_CP}` };
  if (!existsSync(JAVA_EXE)) return { ok: false, reason: `JDK launcher missing: ${JAVA_EXE}` };
  return { ok: true };
}

function invokeSpriteEnumerator(variantsPath, outputPath) {
  const cpRaw = readFileSync(FBSR_CP, 'utf-8').trim();
  const cp = `${FBSR_JAR};${cpRaw}`;
  const args = ['-cp', cp, 'com.demod.fbsr.cli.SpriteEnumerator', variantsPath, outputPath];
  const result = spawnSync(JAVA_EXE, args, {
    cwd: FBSR_DIR,                              // SpriteEnumerator loads profiles/vanilla relative to cwd
    env: { ...process.env, JAVA_HOME: JDK_HOME },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SpriteEnumerator exit code ${result.status}`);
}

function mergeStore(metaOut, spritesOut) {
  const meta    = existsSync(META_PATH)   ? readJson(META_PATH)   : {};
  const sprites = existsSync(SPRITE_PATH) ? readJson(SPRITE_PATH) : {};

  // SpriteEnumerator always numbers entity sids `s0`, `s1`, ... starting
  // from zero. The existing atlas already occupies a contiguous range, so
  // we remap each incoming `sN` to the next free index past the current
  // maximum before merging — and rewrite the meta layers' `sid` fields to
  // match. Recipe / filter sids are name-keyed (`r:<name>` / `f:<item>`)
  // and can't collide with the entity sid space.
  let maxSid = -1;
  for (const k of Object.keys(sprites)) {
    if (!/^s\d+$/.test(k)) continue;
    const n = Number(k.slice(1));
    if (n > maxSid) maxSid = n;
  }
  const sidRemap = new Map();
  for (const k of Object.keys(spritesOut)) {
    if (!/^s\d+$/.test(k)) continue;
    sidRemap.set(k, `s${++maxSid}`);
  }

  let metaAdded = 0, spritesAdded = 0;
  for (const [k, v] of Object.entries(metaOut)) {
    if (meta[k]) continue;            // never overwrite — existing entries are authoritative
    const layers = v.layers.map(l => ({ ...l, sid: sidRemap.get(l.sid) ?? l.sid }));
    meta[k] = { layers };
    metaAdded++;
  }
  for (const [k, v] of Object.entries(spritesOut)) {
    const targetKey = sidRemap.get(k) ?? k;
    if (sprites[targetKey]) continue; // existing entry wins (matches by name for r:/f:)
    sprites[targetKey] = v;
    spritesAdded++;
  }

  // Deterministic key order so the committed diff is stable.
  const sortedMeta = {};
  for (const k of Object.keys(meta).sort()) sortedMeta[k] = meta[k];
  writeFileSync(META_PATH,   JSON.stringify(sortedMeta, null, 2));
  writeFileSync(SPRITE_PATH, JSON.stringify(sprites));

  return { metaAdded, spritesAdded };
}

// Top-level entry — called inline by build-run-data and as the script's
// main(). Returns { status: 'ok' | 'gap-filled' | 'skipped' | 'no-tooling' }
// with a short description. Never throws on missing Java tooling; the
// pipeline degrades gracefully (map-prep just skips the missing variants).
export function ensureSpriteCoverage(runName) {
  const runDir = resolve(ROOT, 'extracted-data', runName);
  if (!existsSync(runDir)) {
    console.log(`fbsr-prep: extracted-data/${runName}/ not found — skipping`);
    return { status: 'skipped', reason: 'no-extracted-data' };
  }

  const rocket = readJsonOrNull(resolve(runDir, 'rocketLaunchTime.json'));
  const durationTick = rocket?.rocketLaunchTimes?.[0] ?? Number.MAX_SAFE_INTEGER;

  const needs = collectRunNeeds(runDir, durationTick);
  const meta    = existsSync(META_PATH)   ? readJson(META_PATH)   : {};
  const sprites = existsSync(SPRITE_PATH) ? readJson(SPRITE_PATH) : {};
  const { missingVariants, missingRecipes, missingFilters } = diffAgainstStore(needs, meta, sprites);

  if (missingVariants.length === 0 && missingRecipes.length === 0 && missingFilters.length === 0) {
    console.log(`fbsr-prep: store already covers ${runName} — no Java invocation needed`);
    return { status: 'ok' };
  }

  console.log(`fbsr-prep: ${runName} introduces ${missingVariants.length} variant(s), ${missingRecipes.length} recipe(s), ${missingFilters.length} filter item(s)`);

  const tooling = javaToolingReady();
  if (!tooling.ok) {
    console.warn(`fbsr-prep: Java tooling not ready (${tooling.reason}) — leaving store as-is`);
    console.warn('fbsr-prep: map-prep will skip the missing variants; populate Factorio-FBSR profiles/vanilla and rebuild the jar to backfill');
    return { status: 'no-tooling', reason: tooling.reason };
  }

  const variantsPayload = {
    variants: missingVariants,
    recipes: missingRecipes,
    filterItems: missingFilters,
  };
  const outDir = resolve(ROOT, 'tools', 'output');
  mkdirSync(outDir, { recursive: true });
  const variantsPath = resolve(outDir, `${runName}.variants.json`);
  const buildPath    = resolve(outDir, `${runName}.sprite-build.json`);
  writeFileSync(variantsPath, JSON.stringify(variantsPayload, null, 2));

  invokeSpriteEnumerator(variantsPath, buildPath);

  const built = readJson(buildPath);
  const { metaAdded, spritesAdded } = mergeStore(built.meta ?? {}, built.sprites ?? {});
  const buildSize = statSync(buildPath).size;
  console.log(`fbsr-prep: merged ${metaAdded} variant(s) and ${spritesAdded} sprite(s) into the shared store`);
  console.log(`fbsr-prep: variants payload=${variantsPath}, build output=${buildPath} (${buildSize} bytes)`);

  return { status: 'gap-filled', metaAdded, spritesAdded };
}

// CLI form.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const RUN = process.argv[2];
  if (!RUN) {
    console.error('usage: node fbsr-prep.mjs <run-name>');
    process.exit(1);
  }
  const result = ensureSpriteCoverage(RUN);
  if (result.status === 'no-tooling') process.exit(2);
}
