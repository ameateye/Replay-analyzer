import manifestJson from './runs-manifest.json';

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

export const runMetas: RunMeta[] = manifestJson.runs;
export const defaultMeta: RunMeta = runMetas[0];

// In dev, prefer the local `built-data/` (or `dashboard/public/data/`) copy
// served by vite.config.ts's `localDataServer` middleware. The middleware
// 302-redirects to the manifest URL when no local file exists, so this works
// regardless of which runs you've rebuilt locally. Set
// VITE_USE_REMOTE_DATA=1 to bypass and hit the manifest URL directly.
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
  let cached = runCache.get(meta.name);
  if (!cached) {
    cached = fetch(runUrlFor(meta)).then(r => r.json() as Promise<Run>);
    runCache.set(meta.name, cached);
  }
  return cached;
}
