/**
 * The bundled web server (web/serve.mjs) proxies `/api` to the backend and
 * appends its peer to `X-Forwarded-For`, so the backend can list it in
 * `trustedProxies` without letting a client of the web port pick its own
 * address (docs/CONFIGURATION.md, "Reverse proxy").
 *
 * Runs the real server as a child process against a stand-in backend that
 * records the forwarded header. (How `clientIp` reads such a header right to
 * left is covered by src/security/client-ip.test.ts.)
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let backend: Server;
let web: ChildProcess;
let webPort: number;
let seen: IncomingHttpHeaders[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

beforeAll(async () => {
  backend = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const apiPort = (backend.address() as AddressInfo).port;

  webPort = await freePort();
  web = spawn(process.execPath, [join(import.meta.dirname, '../../web/serve.mjs')], {
    env: { ...process.env, WEB_PORT: String(webPort), INTERNAL_API_URL: `http://127.0.0.1:${apiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    web.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('web bundle on')) resolve(); });
    web.once('exit', (code) => reject(new Error(`web/serve.mjs exited with ${code}`)));
  });
});

afterAll(async () => {
  web?.kill();
  await new Promise((r) => backend?.close(r));
});

async function forwardedFor(headers: Record<string, string>): Promise<string | undefined> {
  seen = [];
  const res = await fetch(`http://127.0.0.1:${webPort}/api/health`, { headers });
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(1);
  return seen[0]['x-forwarded-for'] as string | undefined;
}

describe('web/serve.mjs X-Forwarded-For', () => {
  test('appends the peer address to the header it forwards', async () => {
    const plain = await forwardedFor({});
    expect(plain).toMatch(/^(::ffff:)?127\.0\.0\.1$/);

    const forged = await forwardedFor({ 'x-forwarded-for': '6.6.6.6' });
    expect(forged).toMatch(/^6\.6\.6\.6, (::ffff:)?127\.0\.0\.1$/);
  });
});

test('a missing hashed asset returns an uncached 404 instead of the SPA HTML', async () => {
  const response = await fetch(`http://127.0.0.1:${webPort}/assets/missing-old-build.js`);
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toContain('Reload the page');
});
