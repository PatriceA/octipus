/**
 * The egress policy on a sandboxed shell command, for real (Linux).
 *
 * Alongside shell-sandbox.linux.e2e.test.ts: a shell-tool command
 * (`LocalShellOperations.exec`, `network: true`, `security.shellSandbox:
 * required`) runs this Node binary under each installed runner, inside a tool
 * call, with a policy that allows one host and denies another. From inside
 * the sandbox it fetches both through the proxy the bridge exposes, tunnels to
 * both, and tries the upstream directly. The policy must decide at the
 * proxy: nothing parses the command.
 *
 * As in the sibling file, only the configuration is set (config mock) and
 * the proxy is let to reach the local upstream (resolver +
 * `allowPrivateAddresses`). Skipped off Linux and per runner where it is
 * missing or cannot start a sandbox here, unless OCTIPUS_SANDBOX_E2E=required.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({ policy: undefined as unknown, root: '' }));
vi.mock('@/config', async (original) => {
  const actual = await original<typeof import('@/config')>();
  return {
    ...actual,
    getConfig: () => {
      let real: Record<string, any> = {};
      try { real = actual.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return {
        ...real,
        workspace: { ...(real.workspace ?? {}), rootPath: state.root },
        security: { ...(real.security ?? {}), shellSandbox: 'required', egressPolicy: state.policy },
      };
    },
  };
});
vi.mock('@/security/egress-proxy', async (original) => {
  const actual = await original<typeof import('@/security/egress-proxy')>();
  return {
    ...actual,
    startEgressProxy: (options: import('@/security/egress-proxy').EgressProxyOptions) => actual.startEgressProxy({
      ...options,
      allowPrivateAddresses: true,
      resolve: async (host: string) => {
        if (host.endsWith('.test')) return ['127.0.0.1'];
        throw new Error(`test resolver: unknown host ${host}`);
      },
    }),
  };
});
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));

import { withEgressSubject } from '@/security/egress-policy';
import { _forceSandboxRunnerForTests, _resetSandboxDetectionForTests, type SandboxRunner } from '@/security/shell-sandbox';
import { LocalShellOperations } from '@/tools/shell/local-operations';

const RUNNERS: Array<{ runner: SandboxRunner; binary: string; smoke: string[] }> = [
  { runner: 'bwrap', binary: '/usr/bin/bwrap', smoke: ['--ro-bind', '/', '/', '--unshare-net', '--', '/bin/true'] },
  { runner: 'firejail', binary: '/usr/bin/firejail', smoke: ['--quiet', '--noprofile', '--net=none', '--', '/bin/true'] },
];
const REQUIRED = process.env.OCTIPUS_SANDBOX_E2E === 'required';
const onLinux = process.platform === 'linux';
const present = onLinux ? RUNNERS.filter((r) => existsSync(r.binary)) : [];
const usable = present.map((r) => {
  const out = REQUIRED ? null : spawnSync(r.binary, r.smoke, { encoding: 'utf8', timeout: 20_000 });
  const ok = out === null || out.status === 0;
  if (!ok) console.warn(`[shell egress e2e] ${r.runner} cannot start a sandbox here, skipping it: ${(out?.stderr ?? '').trim().split('\n').pop()}`);
  return { ...r, usable: ok };
});

/** Run inside the sandbox: one JSON line of results. */
const PROBE = String.raw`'use strict';
const http = require('node:http');
const net = require('node:net');
const port = Number(process.argv[2]);
const proxy = new URL(process.env.HTTP_PROXY || 'http://0.0.0.0:1');
const codeOf = (e) => (e && (e.code || e.message)) || String(e);
const timed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, code: 'TIMEOUT' }), 8000))]);
const get = (url) => timed(new Promise((resolve) => {
  const req = http.request({ host: proxy.hostname, port: Number(proxy.port), path: url, headers: { host: new URL(url).host } }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
  });
  req.on('error', (e) => resolve({ ok: false, code: codeOf(e) }));
  req.end();
}));
const tunnel = (authority) => timed(new Promise((resolve) => {
  const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => s.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n'));
  let buf = '';
  s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) { s.destroy(); resolve({ ok: true, status: buf.split('\r\n')[0] }); } });
  s.on('error', (e) => resolve({ ok: false, code: codeOf(e) }));
}));
const direct = (p) => p === Number(proxy.port) ? Promise.resolve({ ok: false, code: 'RELAY_PORT' }) : timed(new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
  s.once('error', (e) => resolve({ ok: false, code: codeOf(e) }));
}));
/** A server the command starts itself, fetched by curl (which honours the proxy variables and NO_PROXY). */
const ownLoopback = () => timed(new Promise((resolve) => {
  if (!require('node:fs').existsSync('/usr/bin/curl')) { resolve({ ok: false, code: 'NO_CURL' }); return; }
  const srv = http.createServer((_q, r) => r.end('inner-ok'));
  srv.listen(0, '127.0.0.1', () => {
    require('node:child_process').execFile('/usr/bin/curl', ['-s', '--max-time', '5', 'http://localhost:' + srv.address().port + '/'], (err, stdout) => {
      srv.close();
      resolve(err ? { ok: false, code: codeOf(err) } : { ok: true, body: stdout });
    });
  });
}));
(async () => {
  const out = {
    proxyVar: process.env.HTTP_PROXY || null,
    noProxy: process.env.NO_PROXY,
    bridgeVarLeaked: 'OCTIPUS_BRIDGE_NO_PROXY' in process.env || 'OCTIPUS_BRIDGE_TOKEN' in process.env,
    ownLoopback: await ownLoopback(),
    allowed: await get('http://allowed.test:' + port + '/'),
    denied: await get('http://denied.test:' + port + '/'),
    unlisted: await get('http://unlisted.test:' + port + '/'),
    tunnelAllowed: await tunnel('allowed.test:' + port),
    tunnelDenied: await tunnel('denied.test:' + port),
    direct: await direct(port),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
})();
`;

describe.skipIf(!onLinux || present.length === 0)('shell egress policy under a real Linux sandbox', () => {
  let upstream: Server;
  let port = 0;
  let workspace: string;

  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end('upstream-ok'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    port = (upstream.address() as { port: number }).port;
    // Under $HOME, for firejail's whitelist (it hides the host's /tmp).
    workspace = realpathSync(mkdtempSync(join(homedir(), '.octipus-shell-egress-')));
    state.root = workspace;
    writeFileSync(join(workspace, 'probe.cjs'), PROBE);
    state.policy = egressPolicySchema.parse({
      default: 'deny',
      rules: [{ action: 'deny', host: 'denied.test', note: 'e2e deny' }],
      tools: { shell: { rules: [{ action: 'allow', host: 'allowed.test' }, { action: 'allow', host: 'denied.test' }] } },
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(workspace, { recursive: true, force: true });
    _resetSandboxDetectionForTests();
  });

  describe.each(usable)('$runner', ({ runner, binary, usable: runnerUsable }) => {
    test.skipIf(!runnerUsable)('allowed through the proxy, denied by the policy, no way around it', async () => {
      _resetSandboxDetectionForTests();
      _forceSandboxRunnerForTests(runner, binary);
      const ops = new LocalShellOperations();
      const result = await withEgressSubject({ tool: 'shell', role: 'coding' }, () =>
        ops.exec(`${process.execPath} probe.cjs ${port}`, workspace, { timeout: 60_000, allowNetwork: true, sandboxMode: 'required', extraReadOnly: [process.execPath] }));
      const report = `\nexit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.exitCode, report).toBe(0);
      const probes = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
      expect(probes.proxyVar, report).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(probes.allowed, report).toMatchObject({ ok: true, status: 200, body: 'upstream-ok' });
      // Deny wins over the tool's allow; an unlisted host gets the default (deny).
      expect(probes.denied, report).toMatchObject({ ok: true, status: 403 });
      expect(probes.denied.body, report).toContain('e2e deny');
      expect(probes.unlisted, report).toMatchObject({ ok: true, status: 403 });
      expect(probes.tunnelAllowed, report).toMatchObject({ ok: true, status: 'HTTP/1.1 200 Connection Established' });
      expect(probes.tunnelDenied, report).toMatchObject({ ok: true, status: 'HTTP/1.1 403 Forbidden' });
      // Its own loopback (a server it started) is not sent to the proxy.
      expect(probes.noProxy, report).toBe('localhost,127.0.0.1,::1');
      expect(probes.bridgeVarLeaked, report).toBe(false);
      if (probes.ownLoopback.code !== 'NO_CURL') expect(probes.ownLoopback, report).toMatchObject({ ok: true, body: 'inner-ok' });
      // The command's own network namespace has no route to the upstream.
      expect(probes.direct.ok, report).toBe(false);
    }, 90_000);
  });
});
