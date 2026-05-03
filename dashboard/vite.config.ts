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
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(GAME_DATA_DIR)) {
        if (f.endsWith('.json')) {
          fs.copyFileSync(path.join(GAME_DATA_DIR, f), path.join(dest, f));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), gameDataServer()],
  base: './',
});
