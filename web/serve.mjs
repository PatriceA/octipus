#!/usr/bin/env node
/**
 * Static server for the built web bundle.
 *
 * Plain `node:http` rather than a framework, because a built SPA needs
 * exactly two things from a server: serve the file if it exists, and serve
 * `index.html` if it does not so client-side routes resolve on a hard refresh.
 * The previous server also rendered pages; this one has nothing to render.
 *
 * `/api`, `/a` and `/__artifacts__` are proxied to the backend so the browser
 * sees one origin and its session cookie is attached — the same contract the
 * old dev-server rewrites provided. Without it every authenticated call from a
 * hard-refreshed page would be cross-origin.
 *
 * Caching: only `/assets/` (content-hashed by the build) is immutable. The
 * rest — index.html and the unhashed `public/` files (logo, manifest, the
 * artifact client script…) — is `no-cache` with an ETag, so a deploy shows up
 * on the next load and an unchanged file costs a 304. Text is sent gzip or
 * brotli compressed, compressed once per file and kept in memory.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, process.env.OCTIPUS_WEB_DIST_DIR || 'dist');
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
 * Worth compressing. Not `.map`: hidden sourcemaps are fetched only by someone
 * debugging, and at 1–2 MB each they would crowd the cache below.
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
/** Smaller than this, the compressed copy saves less than its headers cost. */
const MIN_COMPRESS_BYTES = 1024;
/** Larger files are streamed as they are rather than held in memory. */
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;
/** Upper bound of the compressed copies kept, least recently used dropped first. */
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * Compressed copies by file path, valid while the file's size and mtime match
 * (a rebuild rewrites dist/ under a running server). A Map in use order: a hit
 * moves its entry to the end, eviction takes from the front.
 *
 * @type {Map<string, { size: number, mtimeMs: number, gzip?: Buffer, br?: Buffer, brPending?: boolean }>}
 */
const compressed = new Map();
let compressedBytes = 0;

function entryBytes(entry) {
  return (entry.gzip?.length ?? 0) + (entry.br?.length ?? 0);
}

function dropEntry(path) {
  const entry = compressed.get(path);
  if (!entry) return;
  compressedBytes -= entryBytes(entry);
  compressed.delete(path);
}

function cacheEntry(path, info) {
  let entry = compressed.get(path);
  if (entry && (entry.size !== info.size || entry.mtimeMs !== info.mtimeMs)) {
    dropEntry(path);
    entry = undefined;
  }
  if (!entry) entry = { size: info.size, mtimeMs: info.mtimeMs };
  compressed.delete(path);
  compressed.set(path, entry);
  return entry;
}

function storeEncoded(path, entry, encoding, buffer) {
  // The file changed (or was evicted) while this copy was being made.
  if (compressed.get(path) !== entry) return;
  compressedBytes -= entryBytes(entry);
  entry[encoding] = buffer;
  compressedBytes += entryBytes(entry);
  for (const [key] of compressed) {
    if (compressedBytes <= CACHE_BUDGET_BYTES || key === path) break;
    dropEntry(key);
  }
}

/** The encodings the request accepts (`q=0` refuses one), among those served. */
function acceptedEncodings(header) {
  const accepted = new Set();
  for (const part of String(header ?? '').split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    if (token === 'br' || token === 'gzip') accepted.add(token);
  }
  return accepted;
}

/**
 * The compressed body to send, or null to send the file as it is. Brotli at
 * its best setting takes ~0.5 s on the largest chunk, so the first request
 * for a file gets gzip (a few ms) while the brotli copy is made in the
 * background for the requests after it.
 */
async function encodedBody(path, info, accepted) {
  if (info.size < MIN_COMPRESS_BYTES || info.size > MAX_COMPRESS_BYTES) return null;
  if (!accepted.has('br') && !accepted.has('gzip')) return null;
  const entry = cacheEntry(path, info);
  if (accepted.has('br') && entry.br) return { encoding: 'br', body: entry.br };
  if (accepted.has('gzip') && entry.gzip) {
    if (accepted.has('br')) startBrotli(path, entry);
    return { encoding: 'gzip', body: entry.gzip };
  }
  const raw = await readFile(path);
  if (!accepted.has('gzip')) {
    // Brotli only: wait for it rather than send the file uncompressed.
    const body = await brotliOf(raw);
    storeEncoded(path, entry, 'br', body);
    return { encoding: 'br', body };
  }
  if (accepted.has('br')) startBrotli(path, entry, raw);
  const body = await gzipAsync(raw, { level: 9 });
  storeEncoded(path, entry, 'gzip', body);
  return { encoding: 'gzip', body };
}

function brotliOf(raw) {
  return brotliAsync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

function startBrotli(path, entry, raw) {
  if (entry.br || entry.brPending) return;
  entry.brPending = true;
  (raw ? Promise.resolve(raw) : readFile(path))
    .then(brotliOf)
    .then((body) => storeEncoded(path, entry, 'br', body))
    .catch((err) => process.stderr.write(`web server: brotli of ${path} failed: ${err?.message ?? err}\n`))
    .finally(() => { entry.brPending = false; });
}

/**
 * Resolve a URL path to a file inside ROOT, or null. Rejects traversal, and
 * treats an undecodable path as "no file" rather than throwing: a request for
 * `/%` is a malformed escape, and `decodeURIComponent` throws on it — inside a
 * synchronous request handler that is an uncaught exception and the process is
 * gone, from one curl.
 */
async function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, clean);
  if (!full.startsWith(ROOT)) return null;
  const info = await statFile(full);
  return info ? { path: full, info } : null;
}

/** The file's stat, or null when there is no regular file at `path`. */
async function statFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Is the browser's copy (If-None-Match, else If-Modified-Since) still current? */
function notModified(req, etag, mtimeMs) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) return ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*');
  const ifModifiedSince = Date.parse(req.headers['if-modified-since'] ?? '');
  // HTTP dates have whole seconds; the mtime has fractions.
  return Number.isFinite(ifModifiedSince) && Math.floor(mtimeMs / 1000) * 1000 <= ifModifiedSince;
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    process.stderr.write(`web server: ${req.method} ${req.url} failed: ${err?.stack ?? err}\n`);
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error\n');
    }
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (PROXY_PREFIXES.some((p) => url.pathname === p.slice(0, -1) || url.pathname.startsWith(p))) {
    // Append the peer to X-Forwarded-For, as nginx's
    // `$proxy_add_x_forwarded_for` does. The backend reads the header right to
    // left from its trusted proxies, so with this server trusted the hop it
    // added is the client, and whatever a client wrote further left is
    // ignored. Passing the header through untouched would let any client of
    // this port choose its own address.
    const headers = { ...req.headers };
    const peer = req.socket.remoteAddress;
    if (peer) {
      const prior = req.headers['x-forwarded-for'];
      headers['x-forwarded-for'] = prior ? `${prior}, ${peer}` : peer;
    }
    const upstream = httpRequest(
      { hostname: API.hostname, port: API.port, path: req.url, method: req.method, headers },
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

  const hashed = url.pathname.startsWith('/assets/');
  const asset = await resolveFile(url.pathname);
  // Missing chunks are not SPA routes. Returning HTML as JavaScript hides the
  // actual failure behind a misleading MIME/type error in the browser.
  if (!asset && hashed) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Asset not found. Reload the page to load the current version.\n');
    return;
  }
  const indexPath = join(ROOT, 'index.html');
  const file = asset ?? { path: indexPath, info: await statFile(indexPath) };
  if (!file.info) {
    // The SPA fallback itself is missing — the bundle was never built, or was
    // built to the desktop `out/`. Say so instead of dying on a stream error.
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Web bundle not found at ${ROOT}. Run \`npm run build\` in web/.\n`);
    return;
  }
  // A hashed asset is immutable. Anything else is revalidated on every use —
  // index.html above all, or a deploy leaves browsers asking for chunks that
  // no longer exist.
  const { path, info } = file;
  const ext = extname(path);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    etag,
    'last-modified': new Date(info.mtimeMs).toUTCString(),
  };
  if (COMPRESSIBLE.has(ext)) headers.vary = 'Accept-Encoding';
  if (notModified(req, etag, info.mtimeMs)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const encoded = COMPRESSIBLE.has(ext) ? await encodedBody(path, info, acceptedEncodings(req.headers['accept-encoding'])) : null;
  if (encoded) {
    res.writeHead(200, { ...headers, 'content-encoding': encoded.encoding, 'content-length': encoded.body.length });
    res.end(req.method === 'HEAD' ? undefined : encoded.body);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  // A read that fails mid-flight (file deleted by a redeploy, permissions)
  // must end the response, not the process.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

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
