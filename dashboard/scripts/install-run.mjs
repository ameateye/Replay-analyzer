// Register a built run with the dashboard's manifest. Two modes, both
// idempotent and additive (other manifest entries are untouched):
//
//   node scripts/install-run.mjs local <run-name>
//     Copies built-data/<run>.json + .map.json into dashboard/public/data/
//     and writes a relative-URL manifest entry. Zero external setup — the
//     deployed dashboard serves the JSONs as same-origin static assets.
//
//   node scripts/install-run.mjs url <run-name> <runUrl> <mapUrl>
//     Writes a manifest entry pointing at URLs you already uploaded
//     (R2, B2, S3, GitHub Pages, anywhere with CORS). Doesn't touch
//     built-data/ or public/data/. If a same-name local copy exists under
//     dashboard/public/data/, it's removed so the manifest stays the
//     single source of truth.
//
// `npm run install:local` and `npm run install:url` wrap these in
// dashboard/package.json.
//
// Manifest position: a fresh entry goes to the front (becomes the picker's
// default). An existing entry keeps its position; only its URLs change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const BUILT_DIR = path.join(REPO_ROOT, 'built-data');
const PUBLIC_DATA_DIR = path.join(DASHBOARD_ROOT, 'public', 'data');
const MANIFEST_PATH = path.join(DASHBOARD_ROOT, 'src', 'data', 'runs-manifest.json');

const [mode, name, ...rest] = process.argv.slice(2);
if (!mode || !name) {
  console.error('Usage:');
  console.error('  install-run.mjs local <run-name>');
  console.error('  install-run.mjs url <run-name> <runUrl> <mapUrl>');
  process.exit(1);
}

const manifest = fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  : { runs: [] };

function upsert(name, runUrl, mapUrl) {
  const i = manifest.runs.findIndex(r => r.name === name);
  if (i >= 0) {
    manifest.runs[i].runUrl = runUrl;
    manifest.runs[i].mapUrl = mapUrl;
  } else {
    manifest.runs.unshift({ name, runUrl, mapUrl });
  }
}

function writeManifest() {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`updated ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
}

if (mode === 'local') {
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
  upsert(name, `data/${name}.json`, `data/${name}.map.json`);
  writeManifest();
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
  upsert(name, runUrl, mapUrl);
  writeManifest();
  console.log(`installed ${name} (external URLs)`);
} else {
  console.error(`Unknown mode "${mode}". Expected: local | url`);
  process.exit(1);
}
