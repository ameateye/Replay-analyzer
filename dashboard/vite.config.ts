import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DATA_DIR = path.resolve(__dirname, '..', 'game-data');
const BUILT_DATA_DIR = path.resolve(__dirname, '..', 'built-data');
const PUBLIC_DATA_DIR = path.resolve(__dirname, 'public', 'data');
const MANIFEST_PATH = path.resolve(__dirname, 'src', 'data', 'runs-manifest.json');
const SOURCES_PATH = path.resolve(__dirname, 'src', 'data', 'sources.json');

// Serve sibling ../game-data/*.json at /game-data/* so the React app sees a
// single "server" endpoint for shared, cross-run data. In dev: middleware
// streams from disk. In build: copy the JSONs into dist/game-data so the
// static export keeps the same URL contract.
function gameDataServer(): Plugin {
  return {
    name: 'serve-game-data',
    configureServer(server) {
      server.middlewares.use('/game-data', (req, res, next) => {
        if (!req.url) return next();
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (!rel.endsWith('.json')) { res.statusCode = 404; return res.end(); }
        const filePath = path.join(GAME_DATA_DIR, rel);
        if (!filePath.startsWith(GAME_DATA_DIR + path.sep)) {
          res.statusCode = 403;
          return res.end();
        }
        fs.readFile(filePath, (err, data) => {
          if (err) { res.statusCode = 404; return res.end(); }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        });
      });
    },
    closeBundle() {
      if (!fs.existsSync(GAME_DATA_DIR)) return;
      const dest = path.resolve(__dirname, 'dist', 'game-data');
      // Recurse just in case game-data ever grows subdirs again — current
      // contents are all flat JSON files (incl. the shared map-sprites.json).
      const walk = (src: string, dst: string) => {
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src, { withFileTypes: true })) {
          const sp = path.join(src, f.name), dp = path.join(dst, f.name);
          if (f.isDirectory()) walk(sp, dp);
          else if (f.isFile() && f.name.endsWith('.json')) fs.copyFileSync(sp, dp);
        }
      };
      walk(GAME_DATA_DIR, dest);
    },
  };
}

// Resolve a run's external URLs in dev for the 302 fallback below. The
// maintainer's committed manifest is empty (runs live on R2), so pull the
// approved remote sources' manifests — cached for the dev server's lifetime —
// and merge the bundled manifest for forks. Mirrors src/data/index.ts.
type DevMeta = { runUrl: string; mapUrl: string };
let remoteMetaCache: Promise<Map<string, DevMeta>> | null = null;
function resolveRunMetas(): Promise<Map<string, DevMeta>> {
  if (remoteMetaCache) return remoteMetaCache;
  remoteMetaCache = (async () => {
    const map = new Map<string, DevMeta>();
    const add = (runs: any[]) => {
      for (const r of runs ?? []) {
        if (r?.name && !map.has(r.name)) map.set(r.name, { runUrl: r.runUrl, mapUrl: r.mapUrl });
      }
    };
    try {
      const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8')).sources ?? [];
      for (const s of sources) {
        if (s.type !== 'remote' || typeof s.manifestUrl !== 'string') continue;
        try {
          const res = await fetch(s.manifestUrl);
          if (res.ok) add(((await res.json()) as any).runs);
        } catch { /* unreachable source: skip */ }
      }
    } catch { /* no sources.json: skip */ }
    try { add(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).runs); } catch { /* no bundled manifest */ }
    return map;
  })();
  return remoteMetaCache;
}

// Dev-only run list of everything in built-data/, so a freshly-built run is
// previewable in the picker before it's uploaded to a source. The URLs are
// relative placeholders — the loader routes data through /local-data/ in dev
// regardless (PREFER_LOCAL), so they exist only to satisfy the RunMeta shape.
function builtDataIndex(): { runs: { name: string; runUrl: string; mapUrl: string }[] } {
  const runs: { name: string; runUrl: string; mapUrl: string }[] = [];
  if (fs.existsSync(BUILT_DATA_DIR)) {
    for (const f of fs.readdirSync(BUILT_DATA_DIR)) {
      if (f.endsWith('.map.json') || !f.endsWith('.json')) continue;
      const name = f.slice(0, -'.json'.length);
      runs.push({ name, runUrl: `local-data/${name}.json`, mapUrl: `local-data/${name}.map.json` });
    }
  }
  return { runs };
}

// Dev-only proxy: per-run JSONs are normally hosted externally (R2) per a
// source manifest, but during local development we prefer to read from a fresh
// `built-data/` (or `dashboard/public/data/` for install:local'd runs) so a
// rebuild is reflected immediately and there's no need to publish. The loader
// fetches `/local-data/<run>.json` in dev; this middleware decides between
// local file or a 302 to the source URL. It also serves `/local-data/_index`,
// the dev run list of built-data/. Override with `VITE_USE_REMOTE_DATA=1` on
// the loader side to bypass entirely.
function localDataServer(): Plugin {
  return {
    name: 'serve-local-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/local-data', (req, res, next) => {
        if (!req.url) return next();
        const fileName = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
        if (fileName === '_index') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          return res.end(JSON.stringify(builtDataIndex()));
        }
        if (!fileName.endsWith('.json') || fileName.includes('..') ||
            fileName.includes('/') || fileName.includes('\\')) {
          res.statusCode = 404;
          return res.end();
        }
        const builtPath = path.join(BUILT_DATA_DIR, fileName);
        const publicPath = path.join(PUBLIC_DATA_DIR, fileName);
        const localPath = fs.existsSync(builtPath) ? builtPath
                        : fs.existsSync(publicPath) ? publicPath
                        : null;
        if (localPath) {
          fs.readFile(localPath, (err, data) => {
            if (err) { res.statusCode = 500; return res.end(); }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(data);
          });
          return;
        }
        const isMap = fileName.endsWith('.map.json');
        const baseName = isMap
          ? fileName.slice(0, -'.map.json'.length)
          : fileName.slice(0, -'.json'.length);
        resolveRunMetas().then(metas => {
          const entry = metas.get(baseName);
          const target = entry && (isMap ? entry.mapUrl : entry.runUrl);
          if (typeof target === 'string' && /^https?:\/\//.test(target)) {
            res.statusCode = 302;
            res.setHeader('Location', target);
            return res.end();
          }
          res.statusCode = 404;
          res.end();
        }).catch(() => { res.statusCode = 404; res.end(); });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), gameDataServer(), localDataServer()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        map:  path.resolve(__dirname, 'map.html'),
      },
    },
  },
});
