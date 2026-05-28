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

function resolveUrl(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  return import.meta.env.BASE_URL + u.replace(/^\.?\//, '');
}

export function runUrlFor(meta: RunMeta): string {
  return resolveUrl(meta.runUrl);
}

export function mapUrlForMeta(meta: RunMeta): string {
  return resolveUrl(meta.mapUrl);
}

const runCache = new Map<string, Promise<Run>>();

export function loadRun(name: string): Promise<Run> {
  const meta = runMetas.find(m => m.name === name) ?? defaultMeta;
  let cached = runCache.get(meta.name);
  if (!cached) {
    cached = fetch(resolveUrl(meta.runUrl)).then(r => r.json() as Promise<Run>);
    runCache.set(meta.name, cached);
  }
  return cached;
}
