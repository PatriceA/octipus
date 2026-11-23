/**
 * The egress policy for shell commands (src/security/shell-egress.ts): when
 * a command gets the proxy, how it is wired for each runner, what the
 * operator is told, and that the proxy judges every connection by the policy.
 * The Linux runners for real: shell-egress.linux.e2e.test.ts.
 */
import { request as httpRequest, createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({ policy: undefined as unknown, sandbox: 'off' as 'off' | 'auto' | 'required', audits: [] as Array<Record<string, unknown>> }));

vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>();
  return {
    ...real,
    getConfig: () => {
      let base: Record<string, any> = {};
      try { base = real.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return { ...base, security: { ...(base.security ?? {}), egressPolicy: state.policy, shellSandbox: state.sandbox } };
    },
  };
});
vi.mock('@/db/repositories/audit-repository', () => ({
  auditRepository: { log: async (entry: Record<string, unknown>) => { state.audits.push(entry); } },
}));

const { cleanStaleShellSockets, prepareShellEgress, shellEgressStatus, egressEnforcementStatus } = await import('./shell-egress');
const { _forceNoSandboxRunnerForTests, _forceSandboxRunnerForTests, _resetSandboxDetectionForTests } = await import('./shell-sandbox');
const { withEgressSubject } = await import('./egress-policy');
const { ToolNotExecutedError } = await import('@/core/tool-execution-error');

const subject = { tool: 'shell', role: 'coding', userId: 'u1' };
const policy = (input: unknown) => { state.policy = egressPolicySchema.parse(input); };

let upstream: Server;
let upstreamPort = 0;
beforeAll(async () => {
  upstream = createServer((_req, res) => res.end('upstream-ok'));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

beforeEach(() => {
  policy({});
  state.sandbox = 'off';
  state.audits = [];
  _forceNoSandboxRunnerForTests();
});
afterEach(() => _resetSandboxDetectionForTests());

/** A plain-HTTP request through the proxy: the status and body. */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A CONNECT through the proxy: its status line. */
function tunnel(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = '';
    s.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', reject);
  });
}

const local = { resolve: async (host: string) => (host.endsWith('.test') ? ['127.0.0.1'] : ['93.184.216.34']), allowPrivateAddresses: true };

describe('prepareShellEgress', () => {
  test('no policy, no tool call, or a sandboxed command without network: nothing changes', async () => {
    expect(await prepareShellEgress(['echo'], { allowNetwork: true, subject })).toBeNull();
    policy({ default: 'deny' });
    expect(await prepareShellEgress(['echo'], { allowNetwork: true })).toBeNull();
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    expect(await prepareShellEgress(['echo'], { allowNetwork: false, mode: 'required', subject })).toBeNull();
  });

  test('requireEnforcement refuses a command no sandbox can confine', async () => {
    policy({ default: 'deny', requireEnforcement: true });
    const err = await prepareShellEgress(['curl', 'x'], { allowNetwork: true, subject }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolNotExecutedError);
    expect((err as Error).message).toMatch(/requires enforced network confinement.*security\.shellSandbox=off/);
  });

  test('bwrap: the command is bridged to the proxy socket and loses its own network', async () => {
    policy({ default: 'deny' });
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    const egress = await prepareShellEgress(['curl', 'https://x'], { allowNetwork: true, mode: 'required', subject });
    try {
      expect(egress?.enforcement).toBe('enforced');
      expect(egress?.wrap.allowNetwork).toBe(false);
      expect(egress?.argv).toContain(egress?.proxy.socketPath);
      expect(egress?.argv.slice(-2)).toEqual(['curl', 'https://x']);
      expect(egress?.wrap.extraReadWrite).toEqual([egress?.proxy.socketDir]);
      // The namespace's own loopback stays direct (a server the command started).
      expect(egress?.env).toEqual({ OCTIPUS_BRIDGE_NO_PROXY: 'localhost,127.0.0.1,::1', OCTIPUS_BRIDGE_TOKEN: egress?.proxy.socketToken });
    } finally { egress?.close(); }
  });

  test('the proxy socket answers only a client that sends this command\'s token', async () => {
    policy({ default: 'deny', rules: [{ action: 'allow', host: 'allowed.test' }] });
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, mode: 'required', subject, proxyOverrides: local });
    try {
      const socketPath = egress!.proxy.socketPath!;
      const ask = (prefix: string) => new Promise<string>((resolve) => {
        const s = connect(socketPath, () => s.write(`${prefix}GET http://allowed.test:${upstreamPort}/ HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`));
        let buf = '';
        s.on('data', (d: Buffer) => { buf += d.toString(); });
        s.on('close', () => resolve(buf));
        s.on('error', () => resolve(buf));
      });
      // Another sandbox that can see the socket, without the token: nothing.
      expect(await ask('')).toBe('');
      expect(await ask('wrong-token\n')).toBe('');
      // The command's own launcher, with it: served.
      expect(egress!.env.OCTIPUS_BRIDGE_TOKEN).toBe(egress!.proxy.socketToken);
      expect(await ask(`${egress!.proxy.socketToken}\n`)).toMatch(/^HTTP\/1\.1 200[\s\S]*upstream-ok/);
    } finally { egress?.close(); }
  });

  test('stale socket directories are removed only when their process is gone', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'octi-stale-'));
    try {
      const { mkdirSync, utimesSync, existsSync } = await import('node:fs');
      const past = new Date(Date.now() - 3_600_000);
      for (const name of ['egress-111111-aa', 'egress-222222-bb', `egress-${process.pid}-cc`, 'egress-legacy', 'unrelated']) {
        mkdirSync(join(parent, name));
        utimesSync(join(parent, name), past, past);
      }
      // 222222 is another live Octipus process of this user: its sockets stay.
      cleanStaleShellSockets(parent, Date.now() - 60_000, (pid) => pid === 222222);
      expect(existsSync(join(parent, 'egress-111111-aa'))).toBe(false);
      expect(existsSync(join(parent, 'egress-222222-bb'))).toBe(true);
      expect(existsSync(join(parent, `egress-${process.pid}-cc`))).toBe(true);
      expect(existsSync(join(parent, 'egress-legacy'))).toBe(false);
      expect(existsSync(join(parent, 'unrelated'))).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  test('a proxy socket directory carries its process id', async () => {
    policy({ default: 'deny' });
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, mode: 'required', subject });
    try { expect(egress?.proxy.socketDir).toMatch(new RegExp(`egress-${process.pid}-[^/]+$`)); }
    finally { egress?.close(); }
  });

  test('the proxy socket is not under the workspace root, which other sandboxed commands mount', async () => {
    policy({ default: 'deny' });
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    const runtime = mkdtempSync(join(tmpdir(), 'octi-xdg-'));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, mode: 'required', subject });
    try {
      expect(egress?.proxy.socketDir?.startsWith(join(runtime, 'octipus-shell-egress'))).toBe(true);
      const { getConfig } = await import('@/config');
      expect(egress?.proxy.socketDir?.startsWith(getConfig().workspace?.rootPath ?? '/nonexistent')).toBe(false);
    } finally {
      egress?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test('under a deny default the proxy refuses an unlisted name without resolving it', async () => {
    policy({ default: 'deny', rules: [{ action: 'allow', host: 'allowed.test' }] });
    const resolve = vi.fn(local.resolve);
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, subject, proxyOverrides: { resolve, allowPrivateAddresses: true } });
    try {
      expect(await viaProxy(egress!.proxy.port, `http://exfil-data.attacker.test:${upstreamPort}/`)).toMatchObject({ status: 403 });
      expect(await tunnel(egress!.proxy.port, `exfil-data.attacker.test:${upstreamPort}`)).toBe('HTTP/1.1 403 Forbidden');
      expect(resolve).not.toHaveBeenCalled();
    } finally { egress?.close(); }
  });

  test('sandbox-exec: only the proxy port on loopback', async () => {
    policy({ default: 'deny' });
    _forceSandboxRunnerForTests('sandbox-exec', '/usr/bin/sandbox-exec');
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, mode: 'required', subject });
    try {
      expect(egress).toMatchObject({ enforcement: 'enforced', argv: ['curl'], wrap: { allowNetwork: false, loopbackPorts: [egress?.proxy.port] } });
      expect(egress?.env.HTTPS_PROXY).toBe(egress?.proxy.url);
    } finally { egress?.close(); }
  });

  test('no sandbox: advisory proxy variables, and the proxy itself judges every request by the policy', async () => {
    policy({ default: 'deny', rules: [{ action: 'allow', host: 'allowed.test' }, { action: 'deny', host: 'blocked.test', note: 'no' }] });
    const egress = await withEgressSubject(subject, () => prepareShellEgress(['curl'], { allowNetwork: true, proxyOverrides: local }));
    try {
      expect(egress?.enforcement).toBe('advisory');
      expect(egress?.env).toMatchObject({ HTTP_PROXY: egress?.proxy.url, HTTPS_PROXY: egress?.proxy.url, NO_PROXY: '' });
      const port = egress!.proxy.port;
      expect(await viaProxy(port, `http://allowed.test:${upstreamPort}/`)).toEqual({ status: 200, body: 'upstream-ok' });
      expect(await viaProxy(port, `http://ALLOWED.test.:${upstreamPort}/`)).toEqual({ status: 200, body: 'upstream-ok' });
      const denied = await viaProxy(port, `http://blocked.test:${upstreamPort}/secret-path`);
      expect(denied.status).toBe(403);
      expect(denied.body).toContain('Egress policy denies blocked.test');
      expect(await viaProxy(port, `http://elsewhere.example:${upstreamPort}/`)).toMatchObject({ status: 403 });
      expect(await tunnel(port, `allowed.test:${upstreamPort}`)).toBe('HTTP/1.1 200 Connection Established');
      expect(await tunnel(port, `blocked.test:${upstreamPort}`)).toBe('HTTP/1.1 403 Forbidden');
      expect(await tunnel(port, `[::ffff:5db8:d822]:${upstreamPort}`)).toBe('HTTP/1.1 403 Forbidden');
      await vi.waitFor(() => expect(state.audits.length).toBeGreaterThanOrEqual(3));
      expect(state.audits[0]).toMatchObject({ action: 'permission_denied', resourceId: `blocked.test:${upstreamPort}`, details: { tool: 'shell', role: 'coding', path: 'shell-proxy' } });
      expect(JSON.stringify(state.audits)).not.toContain('secret-path');
    } finally { egress?.close(); }
  });

  test('private addresses stay refused through the proxy whatever the policy allows', async () => {
    policy({ rules: [{ action: 'allow', host: 'allowed.test' }] });
    const egress = await prepareShellEgress(['curl'], { allowNetwork: true, subject, proxyOverrides: { resolve: local.resolve } });
    try {
      expect(await viaProxy(egress!.proxy.port, `http://allowed.test:${upstreamPort}/`)).toMatchObject({ status: 403 });
    } finally { egress?.close(); }
  });
});

describe('operator status', () => {
  test('says plainly where the shell policy is advice only', () => {
    expect(shellEgressStatus().enforcement).toBe('not applicable');
    policy({ default: 'deny' });
    expect(shellEgressStatus()).toMatchObject({ enforcement: 'advisory', runner: null });
    expect(shellEgressStatus().detail).toMatch(/^NOT enforced/);
    state.sandbox = 'required';
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    expect(shellEgressStatus()).toMatchObject({ enforcement: 'enforced', runner: 'bwrap' });
    const all = egressEnforcementStatus();
    expect(all).toMatchObject({ active: true, default: 'deny', ruleCount: 0 });
    expect(all.paths.map((p) => p.enforcement)).toEqual(['enforced', 'enforced', 'enforced', 'partial', 'enforced', 'not covered', 'not covered', 'not covered', 'not covered', 'not covered', 'not covered']);
    expect(all.paths.map((p) => p.path).join('\n')).toMatch(/test_container: run/);
    expect(all.paths.map((p) => p.path).join('\n')).toMatch(/docker: compose_project, start_container, build_image, exec_command/);
    state.policy = egressPolicySchema.parse({ default: 'deny', requireEnforcement: true });
    expect(egressEnforcementStatus().paths.filter((p) => p.enforcement === 'refused').map((p) => p.path.split(':')[0])).toEqual(['docker', 'browser-ext', 'mcp_admin', 'test_container', expect.stringContaining('CLI-agent')]);
  });
});
