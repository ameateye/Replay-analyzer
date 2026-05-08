import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DATA_DIR = path.resolve(__dirname, '..', 'game-data');

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
      // Recurse: subdirs (e.g. map-sprites/<run>.json) need to come along
      // so the build subpath matches the dev middleware.
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

export default defineConfig({
  plugins: [react(), gameDataServer()],
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
