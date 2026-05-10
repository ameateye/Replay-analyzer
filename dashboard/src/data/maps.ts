// Per-run FBSR map data lives next to the per-run summary JSONs but is
// emitted as a Vite asset (?url) instead of bundled — multi-MB per run, only
// fetched when RunMapPlayer is open. `import.meta.glob` resolves at build
// time and produces hashed asset URLs (better cache busting than the old
// public/map-data/ static path).

const mapUrls = import.meta.glob('./*.map.json', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function mapUrlFor(runName: string): string | null {
  return mapUrls[`./${runName}.map.json`] ?? null;
}
