import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.join(here, 'dist', 'server.js'),
  path.join(here, 'dist', 'src', 'server.js'),
  path.join(here, 'release', 'server.js'),
  path.join(here, 'release', 'src', 'server.js'),
  path.join(here, 'server', 'dist', 'server.js'),
  path.join(here, 'server', 'dist', 'src', 'server.js'),
];

const target = candidates.find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
});

if (!target) {
  console.error('[STARTUP] No server bundle found — run npm run build');
  process.exit(1);
}

await import(pathToFileURL(target).href);
