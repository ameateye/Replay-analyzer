import { runMetas, mapUrlForMeta } from './index';

// Per-run map sidecar URL. Resolved through the manifest so the same lookup
// works for in-repo (relative URL under BASE_URL) and externally hosted runs
// (absolute URL in the manifest entry).
export function mapUrlFor(runName: string): string | null {
  const meta = runMetas.find(m => m.name === runName);
  return meta ? mapUrlForMeta(meta) : null;
}
