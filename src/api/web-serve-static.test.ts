/**
 * How the bundled web server (web/serve.mjs) caches and compresses the static
 * bundle: only content-hashed `/assets/` files are immutable, everything else
 * revalidates (ETag / Last-Modified, 304), and text goes out gzip or brotli.
 *
 * Runs the real server as a child process over a throwaway bundle directory.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let web: ChildProcess;
let webPort: number;
let dist: string;
const SCRIPT = `export const answer = ${JSON.stringify('x'.repeat(4000))};\n`;
const INDEX = `<!doctype html><html><body><div id="root"></div>${'<!-- padding -->'.repeat(100)}</body></html>`;

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'octipus-serve-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'app-Ab12Cd34.js'), SCRIPT);
  writeFileSync(join(dist, 'octipus-artifact-client.js'), SCRIPT);
  writeFileSync(join(dist, 'logo.png'), Buffer.alloc(2048, 7));
  writeFileSync(join(dist, 'manifest.json'), '{"name":"Octipus"}');

  webPort = await freePort();
  web = spawn(process.execPath, [join(import.meta.dirname, '../../web/serve.mjs')], {
    env: { ...process.env, WEB_PORT: String(webPort), OCTIPUS_WEB_DIST_DIR: dist, INTERNAL_API_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    web.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('web bundle on')) resolve(); });
    web.once('exit', (code) => reject(new Error(`web/serve.mjs exited with ${code}`)));
  });
});

afterAll(() => {
  web?.kill();
  if (dist) rmSync(dist, { recursive: true, force: true });
});

/** A raw GET: no automatic decompression, unlike fetch. */
function request(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: webPort, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('web/serve.mjs caching', () => {
  test('a hashed asset is immutable', async () => {
    const res = await request('/assets/app-Ab12Cd34.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('an unhashed public file revalidates, and an unchanged one is a 304', async () => {
    const first = await request('/logo.png');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    expect(first.headers['last-modified']).toBeTruthy();

    const byTag = await request('/logo.png', { 'if-none-match': etag! });
    expect(byTag.status).toBe(304);
    expect(byTag.body).toHaveLength(0);

    const byDate = await request('/logo.png', { 'if-modified-since': first.headers['last-modified']! });
    expect(byDate.status).toBe(304);

    expect((await request('/logo.png', { 'if-none-match': 'W/"stale"' })).status).toBe(200);
  });

  test('a client-side route gets index.html, revalidated', async () => {
    const res = await request('/chat', { 'accept-encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-type']).toContain('text/html');
    expect(gunzipSync(res.body).toString()).toBe(INDEX);
  });
});

describe('web/serve.mjs compression', () => {
  test('gzip when asked, with Vary', async () => {
    const res = await request('/octipus-artifact-client.js', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    expect(gunzipSync(res.body).toString()).toBe(SCRIPT);
  });

  test('brotli when it is the only encoding asked for', async () => {
    const res = await request('/assets/app-Ab12Cd34.js', { 'accept-encoding': 'br' });
    expect(res.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(res.body).toString()).toBe(SCRIPT);
  });

  test('brotli once made, gzip until then, when both are accepted', async () => {
    let res = await request('/octipus-artifact-client.js', { 'accept-encoding': 'gzip, br' });
    expect(['gzip', 'br']).toContain(res.headers['content-encoding']);
    for (let i = 0; i < 50 && res.headers['content-encoding'] !== 'br'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      res = await request('/octipus-artifact-client.js', { 'accept-encoding': 'gzip, br' });
    }
    expect(res.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(res.body).toString()).toBe(SCRIPT);
  });

  test('as is: without Accept-Encoding, when refused with q=0, for small files and images', async () => {
    const plain = await request('/octipus-artifact-client.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(SCRIPT);

    expect((await request('/octipus-artifact-client.js', { 'accept-encoding': 'gzip;q=0, br;q=0' })).headers['content-encoding']).toBeUndefined();

    const small = await request('/manifest.json', { 'accept-encoding': 'gzip, br' });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.body.toString()).toBe('{"name":"Octipus"}');

    const image = await request('/logo.png', { 'accept-encoding': 'gzip, br' });
    expect(image.headers['content-encoding']).toBeUndefined();
    expect(image.headers.vary).toBeUndefined();
    expect(image.body).toHaveLength(2048);
  });
});
