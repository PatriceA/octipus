#!/usr/bin/env node
/**
 * Static server for the built web bundle.
 *
 * Forty lines of `node:http` rather than a framework, because a built SPA needs
 * exactly two things from a server: serve the file if it exists, and serve
 * `index.html` if it does not so client-side routes resolve on a hard refresh.
 * The previous server also rendered pages; this one has nothing to render.
 *
 * `/api`, `/a` and `/__artifacts__` are proxied to the backend so the browser
 * sees one origin and its session cookie is attached — the same contract the
 * old dev-server rewrites provided. Without it every authenticated call from a
 * hard-refreshed page would be cross-origin.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, 'dist');
const PORT = Number(process.env.WEB_PORT || process.argv[2] || 3007);
const API = new URL(process.env.INTERNAL_API_URL || `http://localhost:${process.env.API_PORT || 3005}`);
const PROXY_PREFIXES = ['/api/', '/a/', '/__artifacts__/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Resolve a URL path to a file inside ROOT, or null. Rejects traversal. */
function resolveFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, clean);
  if (!full.startsWith(ROOT)) return null;
  if (!existsSync(full)) return null;
  const stat = statSync(full);
  return stat.isFile() ? full : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (PROXY_PREFIXES.some((p) => url.pathname === p.slice(0, -1) || url.pathname.startsWith(p))) {
    const upstream = httpRequest(
      { hostname: API.hostname, port: API.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend unreachable' }));
    });
    req.pipe(upstream);
    return;
  }

  const file = resolveFile(url.pathname) ?? join(ROOT, 'index.html');
  // A hashed asset is immutable; index.html must never be cached or a deploy
  // leaves browsers asking for chunks that no longer exist.
  const isIndex = file.endsWith('index.html');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  process.stdout.write(`web bundle on http://localhost:${PORT} (api → ${API.origin})\n`);
});
