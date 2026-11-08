/**
 * The Linux runners (bubblewrap, firejail) for real.
 *
 * shell-sandbox.test.ts and the stdio transport tests check the argv each
 * runner gets with the runner faked; nothing there runs it. This file does,
 * once per runner installed: it builds the launch the way a plugin package
 * server gets it (`prepareSandboxedLaunch`: read-only package directory, a
 * writable data directory, the egress proxy reached through its Unix socket
 * and the in-sandbox launcher bridge), spawns this Node binary inside it, and
 * probes from inside the child what the runner's flags promise. Then a
 * shell-tool style wrap under `required` runs /bin/echo and /bin/sh.
 *
 * Detection prefers bwrap over firejail, so each runner is forced explicitly
 * (`_forceSandboxRunnerForTests`). The whole file is skipped off Linux and
 * per runner where its binary is missing. A runner that is installed but
 * cannot start a sandbox here (bwrap on a host that restricts unprivileged
 * user namespaces, see docs/MULTI-USER.md) is skipped too, with the reason
 * printed — unless OCTIPUS_SANDBOX_E2E=required, which CI sets
 * (.github/workflows/install-smoke.yml): there a runner that does not work
 * fails the run. On failure, each assertion prints the argv, the exit, the
 * child's output and the runner's version, so a red run names what broke.
 *
 * Only the sandbox mode is set (config mock) and the egress proxy is let to
 * reach a local "declared host" (resolver + `allowPrivateAddresses`, which
 * only the proxy's upstream side uses). Everything else is the real code.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

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

import { ownNodeBinary, prepareSandboxedLaunch, type SandboxedLaunch } from '@/mcp/transports/stdio';
import { buildIsolatedChildEnv } from '@/security/child-env';
import { _forceSandboxRunnerForTests, _resetSandboxDetectionForTests, type SandboxRunner, wrapCommand } from '@/security/shell-sandbox';

const RUNNERS: Array<{ runner: SandboxRunner; binary: string; version: string[]; smoke: string[] }> = [
  { runner: 'bwrap', binary: '/usr/bin/bwrap', version: ['--version'], smoke: ['--ro-bind', '/', '/', '--unshare-net', '--', '/bin/true'] },
  { runner: 'firejail', binary: '/usr/bin/firejail', version: ['--version'], smoke: ['--quiet', '--noprofile', '--net=none', '--', '/bin/true'] },
];
const REQUIRED = process.env.OCTIPUS_SANDBOX_E2E === 'required';
const onLinux = process.platform === 'linux';

/** The runner's version line, for the diagnostics. */
function runnerVersion(binary: string, args: string[]): string {
  const out = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000 });
  return `${(out.stdout ?? '').split('\n')[0] ?? ''}${out.error ? ` (error: ${out.error.message})` : ''}`.trim() || `(exit ${out.status})`;
}

/**
 * Why `binary` cannot run a trivial sandbox here, or null when it can. Only
 * consulted when OCTIPUS_SANDBOX_E2E is not `required`.
 */
function smokeFailure(binary: string, args: string[]): string | null {
  const out = spawnSync(binary, args, { encoding: 'utf8', timeout: 20_000 });
  if (out.status === 0) return null;
  return `exit ${out.status}${out.error ? `, ${out.error.message}` : ''}: ${(out.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`;
}

const present = onLinux ? RUNNERS.filter((r) => existsSync(r.binary)) : [];
const usable = present.map((r) => {
  const failure = REQUIRED ? null : smokeFailure(r.binary, r.smoke);
  if (failure) console.warn(`[sandbox e2e] ${r.runner} is installed but cannot start a sandbox on this host, skipping it (set OCTIPUS_SANDBOX_E2E=required to fail instead): ${failure}`);
  return { ...r, usable: failure === null };
});

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
attempt('env', () => ({ HTTPS_PROXY: process.env.HTTPS_PROXY || null, TMPDIR: process.env.TMPDIR || null, tmpdir: os.tmpdir() }));
attempt('writePackage', () => fs.writeFileSync(path.join(cfg.packageDir, 'planted.txt'), 'x'));
attempt('readPackage', () => fs.readFileSync(path.join(cfg.packageDir, 'manifest.json'), 'utf8'));
attempt('writeData', () => { const f = path.join(cfg.dataDir, 'state.json'); fs.writeFileSync(f, 'data-ok'); return fs.readFileSync(f, 'utf8'); });
attempt('writeTmp', () => { const f = path.join(os.tmpdir(), cfg.tmpName); fs.writeFileSync(f, 'tmp-ok'); return { path: f, content: fs.readFileSync(f, 'utf8') }; });
attempt('readHomeFile', () => fs.readFileSync(cfg.homeFile, 'utf8'));
attempt('listHome', () => fs.readdirSync(os.homedir()));
attempt('readSshFile', () => fs.readFileSync(cfg.sshFile, 'utf8'));
attempt('listSsh', () => fs.readdirSync(cfg.sshDir));
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

interface ChildRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error: string | null }

/** Spawn `argv` and collect everything it prints; never rejects (a hang ends in SIGKILL). */
function run(argv: string[], env: Record<string, string>, cwd: string, timeoutMs = 45_000): Promise<ChildRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let error: string | null = null;
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { error = `timed out after ${timeoutMs} ms`; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (err) => { error = String(err); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, error }); });
  });
}

/** Everything a failing assertion should print. The launcher's inline source is shortened. */
function diagnostics(argv: string[], result: ChildRun, version: string, extra = ''): () => string {
  const shown = argv.map((a) => (a.length > 300 ? `${a.slice(0, 60)}…(${a.length} chars)` : a));
  return () => [
    '',
    `--- runner ---\n${version}`,
    `--- argv ---\n${JSON.stringify(shown)}`,
    `--- exit ---\ncode=${result.code} signal=${result.signal} spawnError=${result.error}`,
    `--- stdout ---\n${result.stdout}`,
    `--- stderr ---\n${result.stderr}`,
    extra,
  ].join('\n');
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

/**
 * A refusal as Node reports it inside a Linux sandbox. Paths the runner does
 * not mount simply do not exist there (ENOENT); a read-only bind refuses
 * writes with EROFS; EACCES/EPERM would be a permission bit or seccomp, which
 * is not success either.
 */
const DENIED = ['ENOENT', 'EROFS', 'EACCES', 'EPERM'];

describe.skipIf(!onLinux || present.length === 0)('Linux sandbox runners for real', () => {
  describe.each(usable)('$runner', ({ runner, binary, version: versionArgs, usable: runnerUsable }) => {
    const version = `${binary}: ${runnerVersion(binary, versionArgs)}`;
    const force = () => { _resetSandboxDetectionForTests(); _forceSandboxRunnerForTests(runner, binary); };

    describe.skipIf(!runnerUsable)('a plugin package server launch (prepareSandboxedLaunch, egress proxy)', () => {
      let root: string;
      let packageDir: string;
      let dataDir: string;
      let homeFile: string;
      let outsideFile: string;
      let sshDir: string;
      let sshFile: string;
      let createdSsh = false;
      let tmpName: string;
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
        force();
        // Not under /tmp: firejail's --private-tmp hides the host's /tmp, and
        // bwrap mounts a scratch over it. Installs keep plugin packages under
        // the Octipus home, which both runners mount by path; so does this.
        root = realpathSync(mkdtempSync(join(homedir(), `.octipus-sandbox-e2e-${runner}-`)));
        packageDir = join(root, 'plugin-packages', 'demo-pkg');
        dataDir = join(root, 'plugin-data', 'demo-pkg');
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, 'manifest.json'), '{"name":"demo-pkg"}');
        writeFileSync(join(packageDir, 'probe.cjs'), PROBE_SOURCE);
        // Files the server must not read: beside the package (not mounted),
        // directly in $HOME, and in ~/.ssh (created for the run when absent).
        outsideFile = join(root, 'outside-secret.txt');
        writeFileSync(outsideFile, 'outside-secret');
        homeFile = join(homedir(), `.octipus-sandbox-probe-${runner}-${process.pid}`);
        writeFileSync(homeFile, 'home-secret');
        sshDir = join(homedir(), '.ssh');
        if (!existsSync(sshDir)) { mkdirSync(sshDir, { mode: 0o700 }); createdSsh = true; }
        sshFile = join(sshDir, `octipus-sandbox-probe-${runner}-${process.pid}`);
        writeFileSync(sshFile, 'ssh-secret', { mode: 0o600 });
        tmpName = `octipus-sandbox-tmp-${runner}-${process.pid}.txt`;

        upstream = createServer((socket) => { socket.end('upstream-ok'); });
        upstreamPort = await listen(upstream);
        otherLocal = createServer((socket) => { otherLocalConnections += 1; socket.end('should-not-connect'); });
        otherLocalPort = await listen(otherLocal);

        const cfg = {
          packageDir, dataDir, homeFile, outsideFile, sshDir, sshFile, tmpName,
          allowedAuthority: `${ALLOWED_HOST}:${upstreamPort}`,
          upstreamPort, otherLocalPort,
        };
        // As serverFor builds it: isolated env, package files read-only, data
        // directory writable, declared hosts through the egress proxy. A
        // host TMPDIR is passed on, as an operator's would be: it must not
        // point the server outside its private /tmp.
        const env = buildIsolatedChildEnv({ OCTIPUS_PLUGIN_DATA_DIR: dataDir });
        env.TMPDIR = root;
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
        report = diagnostics(launch.argv, result, version,
          `--- probes ---\n${JSON.stringify(probes, null, 2)}\n--- node binary ---\n${process.execPath} (listed: ${JSON.stringify(ownNodeBinary())})`);
      }, 120_000);

      afterAll(async () => {
        launch?.cleanup();
        await launch?.proxy?.close();
        await Promise.all([upstream && closeServer(upstream), otherLocal && closeServer(otherLocal)]);
        rmSync(homeFile, { force: true });
        rmSync(sshFile, { force: true });
        if (createdSsh) rmSync(sshDir, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        _resetSandboxDetectionForTests();
      });

      /** Assert a probe succeeded, or failed with a sandbox refusal. */
      const allowed = (name: string) => {
        ensure(probes[name] !== undefined, `probe ${name} did not run`, report);
        ensure(probes[name].ok, `${name} should succeed inside the sandbox, got ${JSON.stringify(probes[name])}`, report);
      };
      const denied = (name: string) => {
        ensure(probes[name] !== undefined, `probe ${name} did not run`, report);
        ensure(!probes[name].ok, `${name} should be refused inside the sandbox, got ${JSON.stringify(probes[name])}`, report);
        ensure(DENIED.includes(String(probes[name].code)), `${name} failed, but not with a sandbox refusal (${probes[name].code})`, report);
      };

      test('the launch is wrapped by the runner, through the bridge, with network enforced', () => {
        ensure(launch?.argv[0] === binary, `not wrapped by ${binary}: ${launch?.argv[0]}`, report);
        expect(launch?.networkEnforced).toBe(true);
        expect(launch?.proxy?.socketPath).toBeTruthy();
        expect(launch?.argv).toContain(launch?.proxy?.socketPath);
        expect(launch?.argv).toContain(runner === 'bwrap' ? '--unshare-net' : '--net=none');
      });

      test('Node starts inside the sandbox and requires a builtin', () => {
        ensure(result.error === null, 'the child did not run to completion', report);
        ensure(result.code === 0, `node exited ${result.code} inside the sandbox`, report);
        ensure(probes.fatal === undefined, 'the probe script failed', report);
        allowed('builtin');
        expect(probes.builtin.value).toBe(64);
      });

      test('the package directory is readable but not writable', () => {
        allowed('readPackage');
        expect(probes.readPackage.value).toBe('{"name":"demo-pkg"}');
        denied('writePackage');
        ensure(!existsSync(join(packageDir, 'planted.txt')), 'a file was planted in the package directory', report);
      });

      test('the data directory and the temp directory are writable, and the temp directory is private', () => {
        allowed('writeData');
        expect(probes.writeData.value).toBe('data-ok');
        expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe('data-ok');
        allowed('writeTmp');
        expect(probes.writeTmp.value.content).toBe('tmp-ok');
        // Written to the sandbox's own /tmp, not the host's /tmp nor the host TMPDIR.
        ensure(probes.env?.value?.tmpdir === '/tmp', `os.tmpdir() inside is ${probes.env?.value?.tmpdir}`, report);
        ensure(!existsSync(join('/tmp', tmpName)) && !existsSync(join(root, tmpName)), 'the temp file reached the host', report);
      });

      test('$HOME files, ~/.ssh and files beside the package are unreadable', () => {
        denied('readHomeFile');
        denied('readSshFile');
        denied('listSsh');
        denied('readOutsideFile');
        // bwrap shows $HOME only as the synthetic parents of what it mounts,
        // firejail only what it whitelists: listing it may work, but must not
        // show the home directory's own files.
        if (probes.listHome?.ok) {
          const names: string[] = probes.listHome.value;
          ensure(!names.includes(basename(homeFile)) && !names.includes('.ssh'), `$HOME lists host files: ${JSON.stringify(names)}`, report);
        }
      });

      test('the proxy is reachable through the launcher bridge and tunnels only to the declared host', () => {
        ensure(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(probes.env?.value?.HTTPS_PROXY)), `HTTPS_PROXY inside is ${probes.env?.value?.HTTPS_PROXY}`, report);
        allowed('tcpProxy');
        allowed('tunnelAllowed');
        ensure(/^HTTP\/1\.1 200 /.test(probes.tunnelAllowed.value.status) && String(probes.tunnelAllowed.value.body).includes('upstream-ok'),
          `CONNECT to the declared host: ${JSON.stringify(probes.tunnelAllowed.value)}`, report);
        allowed('tunnelDenied');
        ensure(/^HTTP\/1\.1 403 /.test(probes.tunnelDenied.value.status), `CONNECT to an undeclared host: ${JSON.stringify(probes.tunnelDenied.value)}`, report);
      });

      test('no other TCP: another local port, the upstream directly, the internet (network namespace)', () => {
        ensure(probes.tcpOtherLocal?.ok === false, `connected to another local port: ${JSON.stringify(probes.tcpOtherLocal)}`, report);
        ensure(otherLocalConnections === 0, 'the other local server saw a connection from the sandbox', report);
        ensure(probes.tcpUpstreamDirect?.ok === false, `connected to the upstream directly, around the proxy: ${JSON.stringify(probes.tcpUpstreamDirect)}`, report);
        ensure(probes.tcpInternet?.ok === false, `connected to 1.1.1.1:443 directly: ${JSON.stringify(probes.tcpInternet)}`, report);
      });

      test('no DNS: name resolution fails inside the sandbox', () => {
        ensure(probes.dnsLookup?.ok === false, `example.com resolved inside the sandbox: ${JSON.stringify(probes.dnsLookup)}`, report);
      });
    });

    describe.skipIf(!runnerUsable)('a shell-tool wrap under required', () => {
      let workspace: string;

      beforeAll(() => {
        // Under $HOME for firejail's sake, as above.
        workspace = realpathSync(mkdtempSync(join(homedir(), `.octipus-sandbox-shell-${runner}-`)));
      });
      afterAll(() => {
        rmSync(workspace, { recursive: true, force: true });
        _resetSandboxDetectionForTests();
      });

      const runWrapped = async (argv: string[]) => {
        sandboxMode = 'required';
        force();
        const wrapped = wrapCommand(argv, { workspaceRoot: workspace, path: '/usr/bin:/bin' });
        try {
          const result = await run(wrapped.argv, { PATH: '/usr/bin:/bin', HOME: homedir() }, workspace);
          return { wrapped, result, report: diagnostics(wrapped.argv, result, version) };
        } finally {
          wrapped.cleanup();
        }
      };

      test('/bin/echo runs', async () => {
        const { wrapped, result, report } = await runWrapped(['/bin/echo', `hello-from-${runner}`]);
        expect(wrapped.runner).toBe(runner);
        ensure(result.code === 0 && result.stdout === `hello-from-${runner}\n`, '/bin/echo failed inside the sandbox', report);
      }, 60_000);

      test('/bin/sh writes in the workspace', async () => {
        const { result, report } = await runWrapped(['/bin/sh', '-c', 'echo inside > out.txt && /bin/cat out.txt']);
        ensure(result.code === 0 && result.stdout === 'inside\n', '/bin/sh failed inside the sandbox', report);
        expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('inside\n');
      }, 60_000);
    });
  });
});
