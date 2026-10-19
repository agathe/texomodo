/**
 * `texomodo serve`: tiny static server for local development (no dependencies).
 * Serves the publish directory like Netlify does. Honors PORT, so it also
 * works as a Railway / any-host start command.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export function serve({ root, siteDir = 'site', port = Number(process.env.PORT) || 8080, log = console.log } = {}) {
  const base = join(root, siteDir);
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(base, pathname));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const size = statSync(file).size;
      res.writeHead(200, {
        'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  server.listen(port, () => log(`serve: http://localhost:${port}  (root: ${base})`));
  return server;
}
