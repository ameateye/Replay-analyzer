// Register a built run with the dashboard. The deployed app assembles its run
// list at runtime by merging the *approved sources* in src/data/sources.json
// (see src/data/index.ts), so how you register depends on which source a run
// should live in. All modes are idempotent and additive.
//
//   node scripts/install-run.mjs r2 <run-name> <runUrl> <mapUrl> [--source <id>]
//     The no-git path. Updates the live runs-manifest.json ON the remote
//     source's R2 bucket (download → upsert → upload via wrangler) so the run
//     appears in the deployed app immediately — no commit, no redeploy. Upload
//     the run/map objects to R2 yourself first (wrangler r2 object put); this
//     verifies both URLs resolve before registering. Touches nothing in git.
//
//   node scripts/install-run.mjs local <run-name>
//     The zero-setup fork path. Copies built-data/<run>.json + .map.json into
//     dashboard/public/data/ and writes a relative-URL entry into the committed
//     bundled manifest (src/data/runs-manifest.json). Commit to publish.
//
//   node scripts/install-run.mjs url <run-name> <runUrl> <mapUrl>
//     Writes an external-URL entry into the committed bundled manifest. Commit
//     to publish. Use when you host elsewhere but still want a git-tracked
//     entry; drops any stale dashboard/public/data/ copy.
//
// `npm run install:local` and `npm run install:url` wrap the latter two.
//
// Manifest position: a fresh entry goes to the front (becomes the picker's
// default). An existing entry keeps its position; only its URLs change.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const BUILT_DIR = path.join(REPO_ROOT, 'built-data');
const PUBLIC_DATA_DIR = path.join(DASHBOARD_ROOT, 'public', 'data');
const MANIFEST_PATH = path.join(DASHBOARD_ROOT, 'src', 'data', 'runs-manifest.json');
const SOURCES_PATH = path.join(DASHBOARD_ROOT, 'src', 'data', 'sources.json');
const R2_MANIFEST_KEY = 'runs-manifest.json';

const [mode, name, ...rest] = process.argv.slice(2);
if (!mode || !name) {
  console.error('Usage:');
  console.error('  install-run.mjs r2 <run-name> <runUrl> <mapUrl> [--source <id>]');
  console.error('  install-run.mjs local <run-name>');
  console.error('  install-run.mjs url <run-name> <runUrl> <mapUrl>');
  process.exit(1);
}

// Upsert a run into a manifest object in place: new entries go to the front
// (newest = picker default); existing entries keep position, only URLs change.
function upsert(manifest, runName, runUrl, mapUrl) {
  const i = manifest.runs.findIndex(r => r.name === runName);
  if (i >= 0) {
    manifest.runs[i].runUrl = runUrl;
    manifest.runs[i].mapUrl = mapUrl;
  } else {
    manifest.runs.unshift({ name: runName, runUrl, mapUrl });
  }
}

function readManifestFile() {
  return fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { runs: [] };
}

function writeManifestFile(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`updated ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
}

// Run through a shell so Windows resolves npx.cmd (execFileSync can't spawn a
// .cmd directly). Args here are bucket keys, file paths and URLs — no spaces or
// quotes — so simple double-quoting is sufficient.
function wrangler(args) {
  const quoted = args.map(a => `"${a}"`).join(' ');
  return execSync(`npx --yes wrangler ${quoted}`, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

if (mode === 'r2') {
  const [runUrl, mapUrl, ...flags] = rest;
  if (!runUrl || !mapUrl) {
    console.error('install-run.mjs r2 <run-name> <runUrl> <mapUrl> [--source <id>]');
    process.exit(1);
  }
  if (!/^https?:\/\//.test(runUrl) || !/^https?:\/\//.test(mapUrl)) {
    console.error('Both URLs must start with http(s)://');
    process.exit(1);
  }
  const sourceFlagIdx = flags.indexOf('--source');
  const sourceId = sourceFlagIdx >= 0 ? flags[sourceFlagIdx + 1] : null;

  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8')).sources ?? [];
  const remotes = sources.filter(s => s.type === 'remote');
  const source = sourceId
    ? remotes.find(s => s.id === sourceId)
    : remotes[0];
  if (!source) {
    console.error(sourceId
      ? `No remote source "${sourceId}" in ${path.relative(REPO_ROOT, SOURCES_PATH)}.`
      : `No remote source in ${path.relative(REPO_ROOT, SOURCES_PATH)}.`);
    process.exit(1);
  }
  if (!source.bucket) {
    console.error(`Source "${source.id}" needs a "bucket" field (the wrangler R2 bucket to upload the manifest to).`);
    process.exit(1);
  }

  // Confirm the data is actually published before pointing the manifest at it,
  // so a registration can't leave the live list with a 404 entry.
  for (const [label, url] of [['run', runUrl], ['map', mapUrl]]) {
    let ok = false;
    try { ok = (await fetch(url, { method: 'HEAD' })).ok; } catch { ok = false; }
    if (!ok) {
      console.error(`${label} URL is not reachable yet: ${url}`);
      console.error('Upload the object to R2 first (wrangler r2 object put …), then re-run.');
      process.exit(1);
    }
  }

  const tmp = path.join(os.tmpdir(), `runs-manifest.${process.pid}.json`);
  let manifest = { runs: [] };
  try {
    wrangler(['r2', 'object', 'get', `${source.bucket}/${R2_MANIFEST_KEY}`, '--file', tmp, '--remote']);
    manifest = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } catch {
    console.log(`no existing ${R2_MANIFEST_KEY} on ${source.bucket} — starting a fresh manifest`);
  }
  if (!Array.isArray(manifest.runs)) manifest.runs = [];

  upsert(manifest, name, runUrl, mapUrl);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  wrangler(['r2', 'object', 'put', `${source.bucket}/${R2_MANIFEST_KEY}`, '--file', tmp, '--content-type', 'application/json', '--remote']);
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }

  console.log(`installed ${name} → source "${source.id}" (${manifest.runs.length} runs live, no git)`);
} else if (mode === 'local') {
  if (rest.length !== 0) {
    console.error('install-run.mjs local takes only a run name.');
    process.exit(1);
  }
  const srcRun = path.join(BUILT_DIR, `${name}.json`);
  const srcMap = path.join(BUILT_DIR, `${name}.map.json`);
  if (!fs.existsSync(srcRun)) {
    console.error(`Missing ${srcRun} — build it first: npm run data <extracted-data/${name}>`);
    process.exit(1);
  }
  if (!fs.existsSync(srcMap)) {
    console.error(`Missing ${srcMap} — every run must ship a map sidecar.`);
    process.exit(1);
  }
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  fs.copyFileSync(srcRun, path.join(PUBLIC_DATA_DIR, `${name}.json`));
  fs.copyFileSync(srcMap, path.join(PUBLIC_DATA_DIR, `${name}.map.json`));
  const manifest = readManifestFile();
  upsert(manifest, name, `data/${name}.json`, `data/${name}.map.json`);
  writeManifestFile(manifest);
  console.log(`installed ${name} (local copy under dashboard/public/data/)`);
} else if (mode === 'url') {
  const [runUrl, mapUrl] = rest;
  if (!runUrl || !mapUrl) {
    console.error('install-run.mjs url <run-name> <runUrl> <mapUrl>');
    process.exit(1);
  }
  if (!/^https?:\/\//.test(runUrl) || !/^https?:\/\//.test(mapUrl)) {
    console.error('Both URLs must start with http(s)://');
    process.exit(1);
  }
  // If a previous local copy exists, drop it — the manifest now points
  // externally and the dashboard would otherwise have two paths to the
  // same run.
  const staleRun = path.join(PUBLIC_DATA_DIR, `${name}.json`);
  const staleMap = path.join(PUBLIC_DATA_DIR, `${name}.map.json`);
  if (fs.existsSync(staleRun)) { fs.unlinkSync(staleRun); console.log(`removed stale ${path.relative(REPO_ROOT, staleRun)}`); }
  if (fs.existsSync(staleMap)) { fs.unlinkSync(staleMap); console.log(`removed stale ${path.relative(REPO_ROOT, staleMap)}`); }
  const manifest = readManifestFile();
  upsert(manifest, name, runUrl, mapUrl);
  writeManifestFile(manifest);
  console.log(`installed ${name} (external URLs)`);
} else {
  console.error(`Unknown mode "${mode}". Expected: r2 | local | url`);
  process.exit(1);
}
