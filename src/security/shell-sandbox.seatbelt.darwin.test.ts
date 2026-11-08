/**
 * The Seatbelt profile under the real /usr/bin/sandbox-exec (macOS only).
 *
 * shell-sandbox.seatbelt.test.ts checks the generated profile as a string and
 * stdio.seatbelt.test.ts the launch shape with the runner faked; neither runs
 * anything. This file does: it builds the launch the way a plugin package
 * server gets it (`prepareSandboxedLaunch`: read-only package directory, a
 * writable data directory, the egress proxy on a loopback port), spawns this
 * Node binary inside it, and probes from inside the child what
 * `buildSeatbeltProfile` promises. Then a shell-tool style wrap under
 * `required` runs /bin/echo and /bin/sh.
 *
 * Skipped on any other platform, or a macOS without /usr/bin/sandbox-exec:
 * there is nothing to run there. CI runs it on the macOS leg of the install
 * smoke workflow. On failure, each assertion prints the profile, the child's
 * output and the sandbox's own denial log lines for the child, so a red run
 * names the rule that is wrong.
 *
 * Only the sandbox mode is set (config mock) and the egress proxy is let to
 * reach a local "declared host" (resolver + `allowPrivateAddresses`, which
 * only the proxy's upstream side uses). Everything else is the real code.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const onMacWithSeatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

let sandboxMode: 'auto' | 'required' = 'auto';
vi.mock('@/config', async (original) => {
  const actual = await original<typeof import('@/config')>();
  return {
    ...actual,
    getConfig: () => {
      let real: Record<string, any> = {};
      try { real = actual.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return { ...real, security: { ...(real.security ?? {}), shellSandbox: sandboxMode } };
    },
  };
});

/** The declared host the proxy may tunnel to, and the local server it stands for. */
const ALLOWED_HOST = 'allowed.test';
vi.mock('@/security/egress-proxy', async (original) => {
  const actual = await original<typeof import('@/security/egress-proxy')>();
  return {
    ...actual,
    startEgressProxy: (options: import('@/security/egress-proxy').EgressProxyOptions) => actual.startEgressProxy({
      ...options,
      allowPrivateAddresses: true,
      resolve: async (host: string) => {
        if (host === ALLOWED_HOST) return ['127.0.0.1'];
        throw new Error(`test resolver: unknown host ${host}`);
      },
    }),
  };
});

import { prepareSandboxedLaunch, type SandboxedLaunch } from '@/mcp/transports/stdio';
import { buildIsolatedChildEnv } from '@/security/child-env';
import { _resetSandboxDetectionForTests, wrapCommand } from '@/security/shell-sandbox';

/**
 * Run inside the sandbox by this Node binary. A `.cjs` file so module
 * loading looks up no package.json. Every probe is caught: the result is one
 * JSON line on stdout, `{ ok, value }` or `{ ok: false, code }`.
 */
const PROBE_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const os = require('node:os');
const path = require('node:path');
const cfg = JSON.parse(process.argv[2]);
const results = {};
const codeOf = (e) => (e && (e.code || e.message)) || String(e);
function attempt(name, fn) {
  try { const value = fn(); results[name] = { ok: true, value: value === undefined ? null : value }; }
  catch (e) { results[name] = { ok: false, code: codeOf(e) }; }
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'TIMEOUT' }), ms))]);
}
function tcp(host, port) {
  return withTimeout(new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve({ ok: true, value: 'connected' }); });
    s.once('error', (e) => { s.destroy(); resolve({ ok: false, code: codeOf(e) }); });
  }), 5000);
}
/** CONNECT through the proxy; returns the status line and whatever the tunnel then sends. */
function tunnel(proxyPort, authority) {
  return withTimeout(new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: proxyPort });
    let buf = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.once('connect', () => s.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n'));
    s.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const status = buf.slice(0, buf.indexOf('\r\n'));
      const body = buf.slice(end + 4);
      if (!status.includes(' 200 ') || body.includes('upstream-ok')) finish({ ok: true, value: { status, body } });
    });
    s.once('end', () => finish({ ok: true, value: { status: buf.split('\r\n')[0], body: buf.slice(buf.indexOf('\r\n\r\n') + 4) } }));
    s.once('error', (e) => finish({ ok: false, code: codeOf(e) }));
  }), 8000);
}

attempt('builtin', () => require('node:crypto').createHash('sha256').update('x').digest('hex').length);
attempt('env', () => ({ HTTPS_PROXY: process.env.HTTPS_PROXY || null, TMPDIR: process.env.TMPDIR || null }));
attempt('writePackage', () => fs.writeFileSync(path.join(cfg.packageDir, 'planted.txt'), 'x'));
attempt('readPackage', () => fs.readFileSync(path.join(cfg.packageDir, 'manifest.json'), 'utf8'));
attempt('writeData', () => { const f = path.join(cfg.dataDir, 'state.json'); fs.writeFileSync(f, 'data-ok'); return fs.readFileSync(f, 'utf8'); });
attempt('writeTmp', () => { const f = path.join(os.tmpdir(), 'scratch.txt'); fs.writeFileSync(f, 'tmp-ok'); return { tmpdir: os.tmpdir(), content: fs.readFileSync(f, 'utf8') }; });
attempt('readHomeFile', () => fs.readFileSync(cfg.homeFile, 'utf8'));
attempt('listHome', () => fs.readdirSync(os.homedir()).length);
if (cfg.sshDir) attempt('listSsh', () => fs.readdirSync(cfg.sshDir).length);
if (cfg.brewVar) attempt('listBrewVar', () => fs.readdirSync(cfg.brewVar).length);
attempt('readOutsideFile', () => fs.readFileSync(cfg.outsideFile, 'utf8'));

(async () => {
  const proxyPort = Number(new URL(process.env.HTTPS_PROXY).port);
  results.tcpProxy = await tcp('127.0.0.1', proxyPort);
  results.tunnelAllowed = await tunnel(proxyPort, cfg.allowedAuthority);
  results.tunnelDenied = await tunnel(proxyPort, 'denied.test:443');
  results.tcpOtherLocal = await tcp('127.0.0.1', cfg.otherLocalPort);
  results.tcpUpstreamDirect = await tcp('127.0.0.1', cfg.upstreamPort);
  results.tcpInternet = await tcp('1.1.1.1', 443);
  results.dnsLookup = await withTimeout(new Promise((resolve) => {
    dns.lookup('example.com', (e, address) => resolve(e ? { ok: false, code: codeOf(e) } : { ok: true, value: address }));
  }), 8000);
})().catch((e) => { results.fatal = { ok: false, code: codeOf(e) }; })
  .finally(() => { process.stdout.write(JSON.stringify(results) + '\n'); process.exit(0); });
`;

interface Probe { ok: boolean; value?: any; code?: string }

interface ChildRun { pid: number | undefined; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error: string | null }

/** Spawn `argv` and collect everything it prints; never rejects (a hang ends in SIGKILL). */
function run(argv: string[], env: Record<string, string>, cwd: string, timeoutMs = 45_000): Promise<ChildRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ pid: undefined, code: null, signal: null, stdout: '', stderr: '', error: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let error: string | null = null;
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { error = `timed out after ${timeoutMs} ms`; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (err) => { error = String(err); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid, code, signal, stdout, stderr, error }); });
  });
}

/**
 * The sandbox's own denial reports for `pid` (sandbox-exec execs env, which
 * execs the command: one pid throughout). Best effort: `log show` can be slow
 * or empty, and this runs only on the failure path.
 */
function denialLog(pid: number | undefined): string {
  if (!pid) return '(no pid)';
  const out = spawnSync('/usr/bin/log', ['show', '--style', 'compact', '--last', '5m', '--predicate', `eventMessage CONTAINS "(${pid})" AND eventMessage CONTAINS "deny"`],
    { encoding: 'utf8', timeout: 30_000 });
  const lines = (out.stdout ?? '').split('\n').filter((l) => l.includes(`(${pid})`));
  return lines.length > 0 ? lines.slice(-80).join('\n') : `(no sandbox denials found for pid ${pid}; log show exit ${out.status}${out.stderr ? `: ${out.stderr.trim()}` : ''})`;
}

/**
 * Everything a failing assertion should print, built only on failure (the
 * denial log takes a few seconds to read): call the returned function.
 */
function diagnostics(argv: string[], result: ChildRun, extra = ''): () => string {
  let built: string | null = null;
  return () => {
    if (built !== null) return built;
    const profile = argv[0] === SANDBOX_EXEC && argv[1] === '-p' ? argv[2] : '(not a sandbox-exec argv)';
    built = [
      '',
      `--- argv (after the profile) ---\n${JSON.stringify(argv.slice(3))}`,
      `--- exit ---\ncode=${result.code} signal=${result.signal} spawnError=${result.error}`,
      `--- stdout ---\n${result.stdout}`,
      `--- stderr ---\n${result.stderr}`,
      extra,
      `--- profile ---\n${profile}`,
      `--- sandbox denials (log show) ---\n${denialLog(result.pid)}`,
    ].join('\n');
    return built;
  };
}

/** Fail with `message` and the diagnostics unless `condition` holds. */
function ensure(condition: boolean, message: string, report: () => string): void {
  if (!condition) expect.fail(`${message}${report()}`);
}

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(typeof address === 'object' && address ? address.port : 0);
  });
});
const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A sandbox denial as Node reports it. EACCES is accepted too: a POSIX permission bit would not be the sandbox, but neither is a success. */
const DENIED = ['EPERM', 'EACCES'];

describe.skipIf(!onMacWithSeatbelt)('Seatbelt under the real sandbox-exec (macOS)', () => {
  beforeEach(() => { _resetSandboxDetectionForTests(); });

  describe('a plugin package server launch (prepareSandboxedLaunch, egress proxy)', () => {
    let root: string;
    let packageDir: string;
    let dataDir: string;
    let homeFile: string;
    let outsideFile: string;
    let upstream: Server;
    let upstreamPort: number;
    let otherLocal: Server;
    let otherLocalPort: number;
    let otherLocalConnections = 0;
    let launch: SandboxedLaunch | null = null;
    let result: ChildRun;
    let probes: Record<string, Probe> = {};
    let report: () => string = () => '';

    beforeAll(async () => {
      sandboxMode = 'auto';
      _resetSandboxDetectionForTests();
      root = realpathSync(mkdtempSync(join(tmpdir(), 'seatbelt-e2e-')));
      packageDir = join(root, 'plugin-packages', 'demo-pkg');
      dataDir = join(root, 'plugin-data', 'demo-pkg');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'manifest.json'), '{"name":"demo-pkg"}');
      writeFileSync(join(packageDir, 'probe.cjs'), PROBE_SOURCE);
      // A file the server must not read: outside every allowed path (the
      // temp directory itself is not, only the per-spawn scratch under it).
      outsideFile = join(root, 'outside-secret.txt');
      writeFileSync(outsideFile, 'outside-secret');
      homeFile = join(homedir(), `.octipus-seatbelt-probe-${process.pid}`);
      writeFileSync(homeFile, 'home-secret');

      upstream = createServer((socket) => { socket.end('upstream-ok'); });
      upstreamPort = await listen(upstream);
      otherLocal = createServer((socket) => { otherLocalConnections += 1; socket.end('should-not-connect'); });
      otherLocalPort = await listen(otherLocal);

      const sshDir = join(homedir(), '.ssh');
      const cfg = {
        packageDir, dataDir, homeFile, outsideFile,
        sshDir: existsSync(sshDir) ? sshDir : null,
        brewVar: existsSync('/opt/homebrew/var') ? '/opt/homebrew/var' : null,
        allowedAuthority: `${ALLOWED_HOST}:${upstreamPort}`,
        upstreamPort, otherLocalPort,
      };
      // As serverFor builds it: isolated env, package files read-only, data
      // directory writable, declared hosts through the egress proxy.
      const env = buildIsolatedChildEnv({ OCTIPUS_PLUGIN_DATA_DIR: dataDir });
      launch = await prepareSandboxedLaunch([process.execPath, join(packageDir, 'probe.cjs'), JSON.stringify(cfg)], env, {
        root: packageDir, readOnlyRoot: true, writable: [dataDir], allowNetwork: true,
        egress: { label: 'demo-pkg', hosts: [`${ALLOWED_HOST}:${upstreamPort}`], runDir: join(root, 'plugin-run') },
      });
      result = await run(launch.argv, launch.env, packageDir);
      try {
        probes = JSON.parse(result.stdout.trim().split('\n').pop() ?? '');
      } catch {
        probes = {};
      }
      report = diagnostics(launch.argv, result, `--- probes ---\n${JSON.stringify(probes, null, 2)}\n--- node binary ---\n${process.execPath}`);
    }, 120_000);

    afterAll(async () => {
      launch?.cleanup();
      await launch?.proxy?.close();
      await Promise.all([upstream && closeServer(upstream), otherLocal && closeServer(otherLocal)]);
      rmSync(homeFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    });

    /** Assert a probe succeeded, or failed with a sandbox denial. */
    const allowed = (name: string) => {
      ensure(probes[name] !== undefined, `probe ${name} did not run`, report);
      ensure(probes[name].ok, `${name} should succeed inside the sandbox, got ${JSON.stringify(probes[name])}`, report);
    };
    const denied = (name: string) => {
      ensure(probes[name] !== undefined, `probe ${name} did not run`, report);
      ensure(!probes[name].ok, `${name} should be refused inside the sandbox, got ${JSON.stringify(probes[name])}`, report);
      ensure(DENIED.includes(String(probes[name].code)), `${name} failed, but not with a sandbox denial (${probes[name].code})`, report);
    };

    test('the launch is wrapped by sandbox-exec, with network held to the proxy', () => {
      ensure(launch?.argv[0] === SANDBOX_EXEC, `not wrapped by sandbox-exec: ${launch?.argv[0]}`, report);
      expect(launch?.networkEnforced).toBe(true);
      expect(launch?.proxy?.socketPath).toBeNull();
      expect(launch?.argv[2]).toContain(`(allow network-outbound (remote ip "localhost:${launch?.proxy?.port}"))`);
      expect(launch?.argv[2]).not.toContain('(allow network*)');
    });

    test('Node starts inside the profile and requires a builtin', () => {
      ensure(result.error === null, 'the child did not run to completion', report);
      ensure(result.code === 0, `node exited ${result.code} inside the sandbox`, report);
      ensure(probes.fatal === undefined, 'the probe script failed', report);
      allowed('builtin');
      expect(probes.builtin.value).toBe(64);
    });

    test('the package directory is readable but not writable', () => {
      allowed('readPackage');
      denied('writePackage');
      ensure(!existsSync(join(packageDir, 'planted.txt')), 'a file was planted in the package directory', report);
    });

    test('the data directory and TMPDIR (the per-spawn scratch) are writable', () => {
      allowed('writeData');
      expect(probes.writeData.value).toBe('data-ok');
      expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe('data-ok');
      allowed('writeTmp');
      expect(probes.writeTmp.value.content).toBe('tmp-ok');
      // TMPDIR is the scratch directory wrapCommand made, not the host's temp root.
      ensure(/octipus-shell-[^/]+\/$/.test(String(probes.env?.value?.TMPDIR)), `TMPDIR inside is ${probes.env?.value?.TMPDIR}`, report);
    });

    test('the home directory, ~/.ssh and other files outside the allowed paths are unreadable', () => {
      denied('readHomeFile');
      denied('listHome');
      if (probes.listSsh) denied('listSsh');
      denied('readOutsideFile');
    });

    test('package-manager data (/opt/homebrew/var) is unreadable', () => {
      if (!existsSync('/opt/homebrew/var')) return; // Intel runner or no Homebrew: nothing to probe
      denied('listBrewVar');
    });

    test('the proxy is reachable on its loopback port and tunnels only to the declared host', () => {
      ensure(probes.env?.value?.HTTPS_PROXY === launch?.proxy?.url, `HTTPS_PROXY inside is ${probes.env?.value?.HTTPS_PROXY}`, report);
      allowed('tcpProxy');
      allowed('tunnelAllowed');
      ensure(/^HTTP\/1\.1 200 /.test(probes.tunnelAllowed.value.status) && String(probes.tunnelAllowed.value.body).includes('upstream-ok'),
        `CONNECT to the declared host: ${JSON.stringify(probes.tunnelAllowed.value)}`, report);
      allowed('tunnelDenied');
      ensure(/^HTTP\/1\.1 403 /.test(probes.tunnelDenied.value.status), `CONNECT to an undeclared host: ${JSON.stringify(probes.tunnelDenied.value)}`, report);
    });

    test('no other TCP: another local port, the upstream directly, the internet', () => {
      // Only a connect is wrong; the code is checked after (Seatbelt refuses
      // at connect() with EPERM, not by a timeout).
      ensure(probes.tcpOtherLocal?.ok === false, `connected to another local port: ${JSON.stringify(probes.tcpOtherLocal)}`, report);
      ensure(otherLocalConnections === 0, 'the other local server saw a connection from the sandbox', report);
      ensure(probes.tcpUpstreamDirect?.ok === false, `connected to the upstream directly, around the proxy: ${JSON.stringify(probes.tcpUpstreamDirect)}`, report);
      ensure(probes.tcpInternet?.ok === false, `connected to 1.1.1.1:443 directly: ${JSON.stringify(probes.tcpInternet)}`, report);
      denied('tcpOtherLocal');
      denied('tcpInternet');
    });

    test('no DNS: name resolution fails inside the sandbox', () => {
      // The profile leaves out the DNS mach services and all UDP without
      // network: DNS answers could carry data out (buildSeatbeltProfile).
      ensure(probes.dnsLookup?.ok === false, `example.com resolved inside the sandbox: ${JSON.stringify(probes.dnsLookup)}`, report);
    });
  });

  describe('a shell-tool wrap under required', () => {
    let workspace: string;

    beforeAll(() => {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'seatbelt-shell-')));
    });
    afterAll(() => { rmSync(workspace, { recursive: true, force: true }); });

    const runWrapped = async (argv: string[]) => {
      sandboxMode = 'required';
      _resetSandboxDetectionForTests();
      const wrapped = wrapCommand(argv, { workspaceRoot: workspace, path: '/usr/bin:/bin' });
      try {
        const result = await run(wrapped.argv, { PATH: '/usr/bin:/bin', HOME: homedir() }, workspace);
        return { wrapped, result, report: diagnostics(wrapped.argv, result) };
      } finally {
        wrapped.cleanup();
      }
    };

    test('/bin/echo runs', async () => {
      const { wrapped, result, report } = await runWrapped(['/bin/echo', 'hello-from-seatbelt']);
      expect(wrapped.runner).toBe('sandbox-exec');
      ensure(result.code === 0 && result.stdout === 'hello-from-seatbelt\n', '/bin/echo failed inside the sandbox', report);
    }, 60_000);

    test('/bin/sh writes in the workspace', async () => {
      const { result, report } = await runWrapped(['/bin/sh', '-c', 'echo inside > out.txt && /bin/cat out.txt']);
      ensure(result.code === 0 && result.stdout === 'inside\n', '/bin/sh failed inside the sandbox', report);
      expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('inside\n');
    }, 60_000);
  });
});
