/**
 * Per-host network for plugin packages (docs/PLUGIN-PACKAGES.md#network):
 * the egress proxy lets through only declared hosts, the server is pointed at
 * it, and a package without hosts stays as it was. Everything runs against
 * local servers on 127.0.0.1 — no internet needed.
 */
import { spawn } from 'node:child_process';
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
  getConfig: () => ({ workspace: { rootPath: '/srv/octipus' }, security: { shellSandbox: 'off' } }),
}));
vi.mock('@/security/vault', () => ({ getVault: () => ({ getSystemSecret: async () => null }) }));

import { bridgedArgv, hostAllowed, parseAuthority, startEgressProxy } from '@/security/egress-proxy';
import { coreLogger } from '@/utils/logger';

let upstream: Server;
let upstreamPort: number;
let otherPort: number;
let other: Server;

beforeAll(async () => {
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  upstream = createServer((req, res) => res.end(`hello from upstream ${req.url}`));
  other = createServer((_req, res) => res.end('should never be reached'));
  upstreamPort = await listen(upstream);
  otherPort = await listen(other);
});

afterAll(async () => {
  await Promise.all([upstream, other].map((s) => new Promise((r) => s.close(r))));
});

/** A plain-HTTP request forwarded through the proxy. */
function forward(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A CONNECT tunnel through the proxy, then one HTTP request through it. */
function tunnel(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort, '127.0.0.1');
    let data = '';
    let sent = false;
    sock.on('data', (c) => {
      data += c;
      if (!sent && data.startsWith('HTTP/1.1 200')) {
        sent = true;
        sock.write('GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      }
    });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe('host matching', () => {
  test('exact hosts on 443/80, a wildcard for subdomains only, an explicit port alone', () => {
    expect(hostAllowed(['api.example.com'], 'api.example.com', 443)).toBe(true);
    expect(hostAllowed(['api.example.com'], 'API.example.com.', 80)).toBe(true);
    expect(hostAllowed(['api.example.com'], 'api.example.com', 22)).toBe(false);
    expect(hostAllowed(['api.example.com'], 'evil.com', 443)).toBe(false);
    expect(hostAllowed(['api.example.com'], 'api.example.com.evil.com', 443)).toBe(false);
    expect(hostAllowed(['*.example.com'], 'a.b.example.com', 443)).toBe(true);
    expect(hostAllowed(['*.example.com'], 'example.com', 443)).toBe(false);
    expect(hostAllowed(['*.example.com'], 'badexample.com', 443)).toBe(false);
    expect(hostAllowed(['api.example.com:8443'], 'api.example.com', 8443)).toBe(true);
    expect(hostAllowed(['api.example.com:8443'], 'api.example.com', 443)).toBe(false);
    expect(hostAllowed([], 'api.example.com', 443)).toBe(false);
  });

  test('CONNECT authorities', () => {
    expect(parseAuthority('api.example.com:443')).toEqual({ host: 'api.example.com', port: 443 });
    expect(parseAuthority('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(parseAuthority('api.example.com')).toBeNull();
    expect(parseAuthority('a:99999')).toBeNull();
  });
});

describe('egress proxy', () => {
  test('forwards and tunnels to a declared host; refuses an undeclared one with 403 and logs it', async () => {
    const warn = vi.spyOn(coreLogger, 'warn');
    const proxy = await startEgressProxy({ label: 'demo-pkg', allowed: [`127.0.0.1:${upstreamPort}`] });
    try {
      expect(await forward(proxy.port, `http://127.0.0.1:${upstreamPort}/x`)).toEqual({ status: 200, body: 'hello from upstream /x' });
      expect(await tunnel(proxy.port, `127.0.0.1:${upstreamPort}`)).toContain('hello from upstream /tunnelled');

      const refused = await forward(proxy.port, `http://127.0.0.1:${otherPort}/x`);
      expect(refused.status).toBe(403);
      expect(refused.body).not.toContain('should never be reached');
      expect(await tunnel(proxy.port, `127.0.0.1:${otherPort}`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await tunnel(proxy.port, 'internet.example.org:443')).toMatch(/^HTTP\/1\.1 403/);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pkg: 'demo-pkg', host: '127.0.0.1', port: otherPort }), expect.stringContaining('refused'));
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pkg: 'demo-pkg', host: 'internet.example.org', port: 443 }), expect.any(String));
    } finally {
      warn.mockRestore();
      await proxy.close();
    }
  });

  test.skipIf(process.platform === 'win32')('the sandbox launcher reaches the proxy over its Unix socket and points the command at it', async () => {
    const proxy = await startEgressProxy({ label: 'demo-pkg', allowed: [`127.0.0.1:${upstreamPort}`], unixSocket: true });
    try {
      expect(proxy.socketPath).toBeTruthy();
      // The command a sandboxed package would run: it only knows HTTP_PROXY.
      const client = `
        const http = require('node:http');
        const p = new URL(process.env.HTTP_PROXY);
        const get = (port) => new Promise((r) => http.get({ host: p.hostname, port: p.port, path: 'http://127.0.0.1:' + port + '/via-bridge' },
          (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(res.statusCode + ' ' + b)); }));
        (async () => console.log(JSON.stringify({ ok: await get(${upstreamPort}), refused: await get(${otherPort}),
          noProxy: process.env.NO_PROXY, sameAll: process.env.ALL_PROXY === process.env.HTTPS_PROXY })))();`;
      const argv = bridgedArgv([process.execPath, '-e', client], proxy.socketPath as string);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))));
      });
      const result = JSON.parse(out);
      expect(result.ok).toBe('200 hello from upstream /via-bridge');
      expect(result.refused).toMatch(/^403 /);
      expect(result.noProxy).toBe('');
      expect(result.sameAll).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});

describe('launching a sandboxed server', () => {
  beforeEach(() => { wrapCommand.mockReset(); });

  test('without a sandbox, the server is pointed at the proxy (advisory) with NO_PROXY cleared', async () => {
    wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: false, runner: null, argv, cleanup: () => {} }));
    const { prepareSandboxedLaunch } = await import('@/mcp/transports/stdio');
    const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin', NO_PROXY: '*' },
      { root: '/pkg', allowNetwork: true, egress: { label: 'demo-pkg', hosts: [`127.0.0.1:${upstreamPort}`] } });
    try {
      expect(launch.networkEnforced).toBe(false);
      expect(launch.argv).toEqual(['node', 'server.mjs']);
      const url = launch.env.HTTPS_PROXY;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      for (const k of ['HTTP_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) expect(launch.env[k]).toBe(url);
      expect(launch.env.NO_PROXY).toBe('');
      expect(launch.env.no_proxy).toBe('');
      expect(launch.env.PATH).toBe('/usr/bin');
      // The proxy it points at is live and holds the line.
      expect((await forward(Number(new URL(url).port), `http://127.0.0.1:${upstreamPort}/`)).status).toBe(200);
      expect((await forward(Number(new URL(url).port), `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
    } finally {
      launch.cleanup();
    }
  });

  test.skipIf(process.platform === 'win32')('with a sandbox, direct network stays off and only the proxy socket is mounted in', async () => {
    wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: true, runner: 'bwrap', argv: ['bwrap', '--unshare-net', '--', ...argv], cleanup: () => {} }));
    const { prepareSandboxedLaunch } = await import('@/mcp/transports/stdio');
    const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin' },
      { root: '/pkg', allowNetwork: true, egress: { label: 'demo-pkg', hosts: ['api.example.com'] } });
    try {
      expect(launch.networkEnforced).toBe(true);
      const opts = wrapCommand.mock.calls[0][1];
      expect(opts.allowNetwork).toBe(false);
      expect(opts.extraReadWrite).toEqual([launch.proxy?.socketDir]);
      expect(opts.extraReadOnly).toEqual([process.execPath]);
      expect(launch.argv.slice(0, 4)).toEqual(['bwrap', '--unshare-net', '--', process.execPath]);
      expect(launch.argv).toContain(launch.proxy?.socketPath);
      expect(launch.argv.slice(-2)).toEqual(['node', 'server.mjs']);
      // The launcher sets the proxy variables inside; none leak to the host spawn.
      expect(launch.env.HTTPS_PROXY).toBeUndefined();
    } finally {
      launch.cleanup();
    }
  });

  test('a server without hosts is wrapped exactly as before: no proxy, no variables', async () => {
    wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: true, runner: 'bwrap', argv: ['bwrap', '--unshare-net', '--', ...argv], cleanup: () => {} }));
    const { prepareSandboxedLaunch } = await import('@/mcp/transports/stdio');
    const env = { PATH: '/usr/bin' };
    const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], env, { root: '/pkg', allowNetwork: false });
    expect(launch.proxy).toBeNull();
    expect(launch.env).toBe(env);
    expect(launch.argv).toEqual(['bwrap', '--unshare-net', '--', 'node', 'server.mjs']);
    expect(wrapCommand).toHaveBeenCalledWith(['node', 'server.mjs'], { workspaceRoot: '/pkg', allowNetwork: false, path: '/usr/bin' });
  });
});

describe('the server a package runs as', () => {
  const base = {
    name: 'demo-pkg', version: '1.0.0', apiVersion: '1.0.0', title: 'Demo', description: 'Demo',
    server: { command: 'node', args: ['server.mjs'] }, tools: { ping: { effect: 'read' as const } },
  };
  const row = (manifest: Record<string, unknown>) => ({
    name: 'demo-pkg', version: '1.0.0', manifest, enabled: true, settings: {}, installedBy: null, installedAt: new Date(), updatedAt: new Date(),
  });

  test('no network: fully offline, no egress, maxProtection 4', async () => {
    const { serverFor } = await import('./service');
    const server = await serverFor(row(base) as never);
    expect(server.sandbox).toEqual({ root: expect.stringContaining('demo-pkg'), allowNetwork: false });
    expect(server.plugin?.maxProtection).toBe(4);
  });

  test('declared hosts go to the egress proxy; maxProtection still 1 when undeclared', async () => {
    const { serverFor } = await import('./service');
    const server = await serverFor(row({ ...base, network: ['api.example.com', '*.cdn.example.com:8443'] }) as never);
    expect(server.sandbox?.egress).toEqual({ label: 'demo-pkg', hosts: ['api.example.com', '*.cdn.example.com:8443'] });
    expect(server.plugin?.maxProtection).toBe(1);
    const declared = await serverFor(row({ ...base, network: ['api.example.com'], maxProtection: 3 }) as never);
    expect(declared.plugin?.maxProtection).toBe(3);
  });

  test('the status tells an operator whether network is enforced', async () => {
    const { networkStatus } = await import('./service');
    const m = { ...base, network: ['api.example.com'] };
    expect(networkStatus(m, 'bwrap').state).toBe('restricted');
    expect(networkStatus(base, 'firejail').state).toBe('offline');
    const advisory = networkStatus(m, null);
    expect(advisory.state).toBe('not_enforced');
    expect(advisory.detail).toMatch(/Network not enforced on this platform/);
    expect(networkStatus(base, null).state).toBe('not_enforced');
  });

  test('manifest hosts may carry a port; a bad one is refused', async () => {
    const { parseManifest, ManifestError } = await import('./manifest');
    expect(parseManifest({ ...base, network: ['api.example.com:8443', '*.example.com'] }).network).toHaveLength(2);
    expect(() => parseManifest({ ...base, network: ['api.example.com:70000'] })).toThrow(ManifestError);
    expect(() => parseManifest({ ...base, network: ['127.0.0.1'] })).toThrow(ManifestError);
  });
});
