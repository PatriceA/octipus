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

/**
 * Resolve a URL path to a file inside ROOT, or null. Rejects traversal, and
 * treats an undecodable path as "no file" rather than throwing: a request for
 * `/%` is a malformed escape, and `decodeURIComponent` throws on it — inside a
 * synchronous request handler that is an uncaught exception and the process is
 * gone, from one curl.
 */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
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
  if (!existsSync(file)) {
    // The SPA fallback itself is missing — the bundle was never built, or was
    // built to the desktop `out/`. Say so instead of dying on a stream error.
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Web bundle not found at ${ROOT}. Run \`npm run build\` in web/.\n`);
    return;
  }
  // A hashed asset is immutable; index.html must never be cached or a deploy
  // leaves browsers asking for chunks that no longer exist.
  const isIndex = file.endsWith('index.html');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  const stream = createReadStream(file);
  // A read that fails mid-flight (file deleted by a redeploy, permissions)
  // must end the response, not the process.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// Last resort. A static server has no business exiting because one request
// went wrong, and there is no supervisor inside the container that would
// notice the difference between "crashed" and "idle".
server.on('clientError', (_err, socket) => {
  socket.destroy();
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`web server: uncaught ${err?.stack ?? err}\n`);
});

server.listen(PORT, () => {
  process.stdout.write(`web bundle on http://localhost:${PORT} (api → ${API.origin})\n`);
});
