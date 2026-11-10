/**
 * The host API through the egress proxy (docs/PLUGIN-PACKAGES.md#host-api):
 * `http://octipus-host.internal/api/plugin-host/…` reaches the host's own API
 * and nothing else — no other path, port or loopback service, no tunnel, no
 * DNS — and only for a package that declares host scopes. Runs against local
 * servers on 127.0.0.1.
 */
import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const wrapCommand = vi.fn();
vi.mock('@/security/shell-sandbox', async (original) => ({
  ...(await original<typeof import('@/security/shell-sandbox')>()),
  wrapCommand: (...args: unknown[]) => wrapCommand(...args),
  activeSandboxRunner: () => null,
}));
vi.mock('@/config', async (original) => ({
  ...(await original<typeof import('@/config')>()),
  getConfig: () => ({ workspace: { rootPath: '/srv/octipus' }, security: { shellSandbox: 'off' }, api: { host: '0.0.0.0', port: 3005 } }),
}));
vi.mock('@/security/vault', () => ({ getVault: () => ({ getSystemSecret: async () => null }) }));

import { hostApiPathAllowed, startEgressProxy } from '@/security/egress-proxy';

let api: Server;
let apiPort: number;
let other: Server;
let otherPort: number;
const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];

beforeAll(async () => {
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  api = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ reached: req.url }));
  });
  other = createServer((_req, res) => res.end('should never be reached'));
  apiPort = await listen(api);
  otherPort = await listen(other);
});

afterAll(async () => {
  await Promise.all([api, other].map((s) => new Promise((r) => s.close(r))));
});

beforeEach(() => { seen.length = 0; });

function forward(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectStatus(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort, '127.0.0.1');
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe('the host API path', () => {
  test('only /api/plugin-host/ with nothing that decodes into another path', () => {
    expect(hostApiPathAllowed('/api/plugin-host/notes')).toBe(true);
    expect(hostApiPathAllowed('/api/plugin-host/documents/abc')).toBe(true);
    for (const p of ['/api/notes', '/api/plugin-hostx/notes', '/api/plugin-host/%2e%2e/auth', '/api/plugin-host/../auth', '/api/plugin-host//notes',
      '/api/plugin-host/./notes', '/api/plugin-host/a\\b', '/']) {
      expect(hostApiPathAllowed(p), p).toBe(false);
    }
  });
});

describe('egress proxy with the host API', () => {
  test('forwards the host API path to the API, stamped with the package, without cookies or forwarding headers', async () => {
    const proxy = await startEgressProxy({ label: 'acme', allowed: [], hostApi: { host: '127.0.0.1', port: apiPort } });
    try {
      const res = await forward(proxy.port, 'http://octipus-host.internal/api/plugin-host/notes?limit=2', {
        authorization: 'Bearer ocph_x', cookie: 'session_token=abc', 'x-octipus-plugin-egress': 'forged', 'x-octipus-workspace': 'w',
        'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil',
      });
      expect(res).toMatchObject({ status: 200 });
      expect(JSON.parse(res.body)).toEqual({ reached: '/api/plugin-host/notes?limit=2' });
      const h = seen[0].headers;
      expect(h['x-octipus-plugin-egress']).toBe('acme');
      expect(h.authorization).toBe('Bearer ocph_x');
      for (const k of ['cookie', 'x-octipus-workspace', 'x-forwarded-for', 'x-forwarded-host']) expect(h[k], k).toBeUndefined();
      expect(h.host).toBe(`127.0.0.1:${apiPort}`);
    } finally {
      await proxy.close();
    }
  });

  test('refuses other paths, ports and tunnels to the host, and other loopback ports', async () => {
    const proxy = await startEgressProxy({ label: 'acme', allowed: [], hostApi: { host: '127.0.0.1', port: apiPort } });
    try {
      for (const url of [
        'http://octipus-host.internal/api/auth/me',
        'http://octipus-host.internal/api/plugin-host/%2e%2e/auth/me',
        'http://octipus-host.internal/api/plugin-host/../../api/auth/me',
        `http://octipus-host.internal:${apiPort}/api/plugin-host/notes`,
        'http://octipus-host.internal:8080/api/plugin-host/notes',
        `http://127.0.0.1:${apiPort}/api/plugin-host/notes`,
        `http://127.0.0.1:${otherPort}/`,
        `http://localhost:${apiPort}/api/plugin-host/notes`,
      ]) {
        expect((await forward(proxy.port, url)).status, url).toBe(403);
      }
      expect(await connectStatus(proxy.port, 'octipus-host.internal:80')).toMatch(/^HTTP\/1\.1 403/);
      expect(await connectStatus(proxy.port, 'octipus-host.internal:443')).toMatch(/^HTTP\/1\.1 403/);
      expect(seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  test('a package without host scopes reaches nothing by that name, even when it declares it as a host', async () => {
    const proxy = await startEgressProxy({ label: 'acme', allowed: ['octipus-host.internal'], allowPrivateAddresses: true, resolve: async () => ['127.0.0.1'] });
    try {
      expect((await forward(proxy.port, 'http://octipus-host.internal/api/plugin-host/notes')).status).toBe(403);
      expect(await connectStatus(proxy.port, 'octipus-host.internal:443')).toMatch(/^HTTP\/1\.1 403/);
      expect(seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});

describe('launch and server config', () => {
  test('host scopes alone start a proxy pointed at the host API', async () => {
    wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: false, runner: null, argv, cleanup: () => {} }));
    const { prepareSandboxedLaunch } = await import('@/mcp/transports/stdio');
    const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin' },
      { root: '/pkg', allowNetwork: false, egress: { label: 'acme', hosts: [], hostApi: { host: '127.0.0.1', port: apiPort } } });
    try {
      expect(launch.proxy).not.toBeNull();
      const res = await forward(Number(new URL(launch.env.HTTP_PROXY).port), 'http://octipus-host.internal/api/plugin-host/whoami');
      expect(res.status).toBe(200);
      expect(seen[0].headers['x-octipus-plugin-egress']).toBe('acme');
    } finally {
      launch.cleanup();
    }
  });

  const base = {
    name: 'acme', version: '1.0.0', apiVersion: '1.0.0', title: 'Acme', description: 'Acme',
    server: { command: 'node', args: ['server.mjs'] }, tools: { ping: { effect: 'read' as const } },
  };
  const row = (manifest: Record<string, unknown>, approvedHostScopes: string[] | null) => ({
    name: 'acme', version: '1.0.0', manifest, enabled: true, settings: {}, approvedHostScopes, installedBy: null, installedAt: new Date(), updatedAt: new Date(),
  });

  test('only declared and approved scopes reach the server, with OCTIPUS_HOST_URL and the host API target', async () => {
    const { serverFor } = await import('./service');
    const approved = await serverFor(row({ ...base, host: ['notes:read', 'tasks:write'] }, ['notes:read', 'notify']) as never);
    expect(approved.plugin?.hostScopes).toEqual(['notes:read']);
    expect(approved.env?.OCTIPUS_HOST_URL).toBe('http://octipus-host.internal');
    expect(approved.sandbox?.egress).toEqual({ label: 'acme', hosts: [], runDir: '/srv/octipus/plugin-run', hostApi: { host: '127.0.0.1', port: 3005 } });
    // No network host declared: the data stays in the house.
    expect(approved.plugin?.maxProtection).toBe(4);

    const unapproved = await serverFor(row({ ...base, host: ['notes:read'] }, null) as never);
    expect(unapproved.plugin?.hostScopes).toBeUndefined();
    expect(unapproved.env?.OCTIPUS_HOST_URL).toBeUndefined();
    expect(unapproved.sandbox?.egress).toBeUndefined();
  });

  test('the network status counts the host API as a host', async () => {
    const { networkStatus } = await import('./service');
    expect(networkStatus({ ...base, host: ['notes:read'] }, 'bwrap').state).toBe('restricted');
    expect(networkStatus({ ...base, host: ['notes:read'] }, 'bwrap').detail).toContain('the Octipus host API');
    expect(networkStatus(base, 'bwrap').state).toBe('offline');
  });
});
