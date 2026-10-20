/**
 * Dev server for the dashboard: serves public/ and proxies /api to the backend.
 * Same-origin for the browser, so the backend needs no CORS. Local only.
 *
 * Env: WEB_PORT (default 5234), BACKEND_URL (default http://127.0.0.1:8787)
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEB_PORT) || 5234;
const BACKEND = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:8787');
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http
  .createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = http.request(
        { host: BACKEND.hostname, port: BACKEND.port, path: req.url, method: req.method, headers: { ...req.headers, host: BACKEND.host } },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `backend not reachable at ${BACKEND.origin}` }));
      });
      res.on('close', () => up.destroy());
      req.pipe(up);
      return;
    }
    const path = req.url.split('?')[0];
    const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => process.stderr.write(`[web] http://127.0.0.1:${PORT}  -> ${BACKEND.origin}\n`));
