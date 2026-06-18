import bundledManifest from './runs-manifest.json';
import sourcesConfig from './sources.json';

export type RunMeta = {
  name: string;
  runUrl: string;
  mapUrl: string;
};

// Loose Run type for v1: schema versioning + strict typing come later.
// Components access fields via optional chaining and cast their slices.
export type Run = {
  runName: string;
  durationTicks: number;
  durationMin: number;
  summary: any;
  phases: any[];
  labs: { perMinute: any[]; idleBands: any[] };
  research: any[];
  miners: any;
  manualGathering: any;
  production: any;
  stocks: any;
  flow: any;
  smelting: any;
};

// The run list is assembled at runtime from the *approved sources* in
// sources.json (see loadManifest), not baked into the bundle. That's what
// lets a newly uploaded run appear without a commit/redeploy: the live list
// lives at the source (R2), and only sources.json — the allowlist of origins
// the app may pull from — is in git. `runMetas`/`defaultMeta` are live
// bindings: empty until loadManifest() resolves, populated before first render
// (main.tsx / map-main.tsx await it). Consumers must read them at render time,
// not snapshot them at module load.
export let runMetas: RunMeta[] = [];
export let defaultMeta: RunMeta | undefined = undefined;

type Source =
  | { id: string; type: 'bundled' }
  | { id: string; type: 'remote'; manifestUrl: string };

const sources = (sourcesConfig.sources ?? []) as Source[];

function manifestRuns(json: any): RunMeta[] {
  return Array.isArray(json?.runs) ? (json.runs as RunMeta[]) : [];
}

async function fetchSourceMetas(src: Source): Promise<RunMeta[]> {
  if (src.type === 'bundled') return manifestRuns(bundledManifest);
  try {
    const res = await fetch(src.manifestUrl, { cache: 'no-cache' });
    if (!res.ok) return [];
    return manifestRuns(await res.json());
  } catch {
    // An unreachable approved source just contributes nothing — forks that
    // can't reach a remote source fall back to whatever else resolved.
    return [];
  }
}

// Dev-only: surface runs sitting in built-data/ that haven't been uploaded to
// a remote source yet, so a freshly-built run is previewable before publish.
// Served by vite.config.ts's localDataServer; absent in prod builds.
async function fetchDevLocalMetas(): Promise<RunMeta[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}local-data/_index`);
    if (!res.ok) return [];
    return manifestRuns(await res.json());
  } catch {
    return [];
  }
}

let manifestLoaded: Promise<void> | null = null;

// Load every approved source and merge their runs into one list, de-duped by
// name (earlier source wins). Idempotent; awaited once at startup. With the
// maintainer's bundled manifest empty, the whole list comes from R2; a fork
// with no reachable remote keeps using its committed bundled manifest.
export function loadManifest(): Promise<void> {
  if (manifestLoaded) return manifestLoaded;
  manifestLoaded = (async () => {
    const perSource = await Promise.all([
      ...sources.map(fetchSourceMetas),
      fetchDevLocalMetas(),
    ]);
    const seen = new Set<string>();
    const merged: RunMeta[] = [];
    for (const metas of perSource) {
      for (const m of metas) {
        if (!m?.name || seen.has(m.name)) continue;
        seen.add(m.name);
        merged.push(m);
      }
    }
    runMetas = merged;
    defaultMeta = merged[0];
  })();
  return manifestLoaded;
}

// In dev, prefer the local `built-data/` (or `dashboard/public/data/`) copy
// served by vite.config.ts's `localDataServer` middleware. The middleware
// 302-redirects to the source's URL when no local file exists, so this works
// regardless of which runs you've rebuilt locally. Set
// VITE_USE_REMOTE_DATA=1 to bypass and hit the source URL directly.
const PREFER_LOCAL =
  import.meta.env.DEV && !import.meta.env.VITE_USE_REMOTE_DATA;

function resolveUrl(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  return import.meta.env.BASE_URL + u.replace(/^\.?\//, '');
}

function localProxyUrl(name: string, kind: 'run' | 'map'): string {
  const suffix = kind === 'map' ? '.map.json' : '.json';
  return `${import.meta.env.BASE_URL}local-data/${name}${suffix}`;
}

export function runUrlFor(meta: RunMeta): string {
  return PREFER_LOCAL ? localProxyUrl(meta.name, 'run') : resolveUrl(meta.runUrl);
}

export function mapUrlForMeta(meta: RunMeta): string {
  return PREFER_LOCAL ? localProxyUrl(meta.name, 'map') : resolveUrl(meta.mapUrl);
}

const runCache = new Map<string, Promise<Run>>();

export function loadRun(name: string): Promise<Run> {
  const meta = runMetas.find(m => m.name === name) ?? defaultMeta;
  if (!meta) return Promise.reject(new Error('No runs available'));
  let cached = runCache.get(meta.name);
  if (!cached) {
    cached = fetch(runUrlFor(meta)).then(r => r.json() as Promise<Run>);
    runCache.set(meta.name, cached);
  }
  return cached;
}
