/**
 * Smoke tests for the `octi` launcher.
 *
 * These sat dead through the whole Node migration: the file imported
 * `bun:test` and used `Bun.spawn`, and `bin/` was not in vitest's globs, so
 * nothing ran them — which is how `bin/octi.cmd` kept demanding bun, and how
 * `octi start` could change shape with no test noticing.
 *
 * The bash dispatcher is driven directly with an isolated $HOME, so the
 * destructive paths (PID files, log files) cannot touch a real install. Only
 * the commands that do NOT start processes are exercised.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const BIN_BASH = join(BIN_DIR, 'octi');

function runBash(args: string[], env: Record<string, string | undefined> = {}): { stdout: string; code: number } {
  const home = mkdtempSync(join(tmpdir(), 'octi-cli-test-'));
  try {
    const stdout = execFileSync('bash', [BIN_BASH, ...args], {
      env: { ...process.env, API_PORT: '1', WEB_PORT: '2', OCTIPUS_INSIDE_PID: '', HOME: home, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

function isolatedBashProject(envFile: string): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'octi-cli-project-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const script = join(bin, 'octi');
  copyFileSync(BIN_BASH, script);
  writeFileSync(join(root, '.env'), envFile);
  return { root, script };
}

/** Strip the ANSI the banner and log helpers emit unconditionally. */
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('octi help', () => {
  const help = plain(runBash(['help']).stdout);

  test('exits 0 and prints usage', () => {
    expect(runBash(['help']).code).toBe(0);
    expect(help).toContain('Usage:');
  });

  test('start is described as backend-first, not "backend + web UI"', () => {
    // The whole point of the change: a terminal user should not have to opt
    // out of a browser.
    expect(help).toMatch(/start \[client\]\s+Start the backend/);
    expect(help).not.toContain('backend + web UI');
    expect(help).not.toContain('--backend-only');
  });

  test('lists the clients you can attach', () => {
    for (const client of ['tui', 'open', 'desktop', 'edit']) {
      expect(help).toMatch(new RegExp(`^\\s+${client}\\b`, 'm'));
    }
  });

  test('says the client names double as start targets', () => {
    expect(help).toContain('octi start tui');
  });
});

describe('octi start argument parsing', () => {
  test('rejects an unknown target instead of silently starting', () => {
    const r = runBash(['start', 'bogus']);
    expect(r.code).toBe(1);
    expect(plain(r.stdout)).toContain('Unknown target: bogus');
  });

  test('names the targets it does accept', () => {
    expect(plain(runBash(['start', 'bogus']).stdout)).toContain('tui, web, desktop');
  });
});

describe('octi unknown command', () => {
  test('exits 1 and shows help', () => {
    const r = runBash(['definitely-not-a-command']);
    expect(r.code).toBe(1);
    expect(plain(r.stdout)).toContain('Unknown command');
  });
});

describe('launcher scripts are on the current runtime', () => {
  // The Node migration never reached the Windows launcher: it checked for bun
  // and ran `bun run start`, so `octi start` on Windows could not work at all.
  // Neither script is executed by CI on the other platform, so the only thing
  // that catches this is reading them.
  const scripts = ['octi', 'octi.cmd', 'octi.mjs'];

  for (const name of scripts) {
    test(`${name} does not invoke bun`, () => {
      const source = readFileSync(join(BIN_DIR, name), 'utf8');
      expect(source).not.toMatch(/\bbun\b(?!dle)/);
    });
  }

  test('neither launcher clears a Next.js build directory', () => {
    // The web app is built by Vite into web/dist; `.next` has not existed
    // since the migration, so clearing it cleared nothing.
    for (const name of ['octi', 'octi.cmd']) {
      expect(readFileSync(join(BIN_DIR, name), 'utf8')).not.toContain('.next');
    }
  });

  test('dispatchers do not assume external PostgreSQL is on localhost:5432', () => {
    expect(readFileSync(join(BIN_DIR, 'octi'), 'utf8')).not.toContain('check_service "localhost" "5432"');
    expect(readFileSync(join(BIN_DIR, 'octi.cmd'), 'utf8')).not.toContain('call :check_port 5432');
  });
});

describe('launcher project configuration', () => {
  test('bash dispatcher reads API and web ports from the checkout .env', () => {
    const { root, script } = isolatedBashProject(
      'STORAGE_MODE=embedded\nAPI_PORT=49123\nWEB_PORT=49124\n',
    );
    const home = mkdtempSync(join(tmpdir(), 'octi-cli-home-'));
    const stdout = execFileSync('bash', [script, 'status'], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: '1', API_PORT: '', WEB_PORT: '' },
      encoding: 'utf8',
    });
    expect(plain(stdout)).toContain('http://localhost:49123');
    expect(plain(stdout)).toContain('http://localhost:49124');
  });

  // Windows has no executable bit and will not run an extensionless file, so
  // the symlink this asserts on is a POSIX-only shape. The dispatcher itself
  // is covered on both platforms by the cases above.
  test.skipIf(process.platform === 'win32')('compiled dispatcher resolves a custom install through its executable symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-cli-link-'));
    const app = join(root, 'custom-app');
    const dist = join(app, 'dist');
    const pathDir = join(root, 'path');
    const cwd = join(root, 'elsewhere');
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(app, 'bin'));
    mkdirSync(pathDir);
    mkdirSync(cwd);
    writeFileSync(join(app, 'package.json'), '{"version":"9.8.7"}\n');
    const executable = join(dist, 'octi');
    await build({
      entryPoints: [join(BIN_DIR, 'octi.ts')],
      outfile: executable,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: { js: '#!/usr/bin/env node' },
      logLevel: 'silent',
    });
    chmodSync(executable, 0o755);
    const link = join(pathDir, 'octi');
    symlinkSync(executable, link);
    const stdout = execFileSync(link, ['version'], {
      cwd,
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(stdout).toContain('Octipus v9.8.7');
  });
});

describe('octi recovery', () => {
  test('explains recovery mode and that the token comes with the first start', () => {
    const { stdout, code } = runBash(['recovery'], { OCTIPUS_RECOVERY_TOKEN: undefined });
    const out = plain(stdout);
    expect(code).toBe(0);
    expect(out).toContain('No supervisor is running');
    expect(out).toContain('/api/recovery');
    expect(out).toContain('No token yet');
  });

  test('is listed in help', () => {
    expect(plain(runBash(['help']).stdout)).toMatch(/^\s+recovery\b/m);
  });
});

describe('octi stop/restart from inside the backend', () => {
  test.skipIf(process.platform === 'win32')('started services survive cleanup of the launching process group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-detached-'));
    const pidFile = join(root, 'service.pid');
    const portFile = join(root, 'service.port');
    const entry = join(root, 'server.cjs');
    writeFileSync(entry, `require('node:http').createServer((_,res)=>res.end('alive')).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync(process.argv[2],String(this.address().port))});`);
    const helper = readFileSync(BIN_BASH, 'utf8').match(/^start_detached\(\) \{[\s\S]*?^\}/m)![0];
    const launcher = spawn('bash', ['-c', `${helper}\nstart_detached "$1" "$2" "$3" "$4" "$5"\nsleep 30`, '--', pidFile, join(root, 'service.log'), process.execPath, entry, portFile], { detached: true, stdio: 'ignore' });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(portFile) && existsSync(pidFile)).toBe(true));
      pid = Number(readFileSync(pidFile, 'utf8'));
      const exited = once(launcher, 'exit');
      process.kill(-launcher.pid!, 'SIGTERM');
      await exited;
      const response = await fetch(`http://127.0.0.1:${readFileSync(portFile, 'utf8')}/`);
      expect(await response.text()).toBe('alive');
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
      if (pid) { try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    }
  });

  test('hands off to a detached copy, which does the work instead of handing off again', async () => {
    // An isolated checkout and HOME, and ports nothing listens on: the
    // detached `stop` only ever touches this temp install.
    const { root, script } = isolatedBashProject('API_PORT=1\nWEB_PORT=2\n');
    const home = mkdtempSync(join(tmpdir(), 'octi-cli-test-'));
    // OCTI_HANDED_OFF is what an earlier hand-off used to leave in the
    // environment of the backend it started; it must not stop this one.
    const env = { ...process.env, API_PORT: '1', WEB_PORT: '2', HOME: home, NO_COLOR: '1', OCTIPUS_INSIDE_PID: String(process.pid), OCTI_HANDED_OFF: '1' };
    const out = plain(execFileSync('bash', [script, 'stop'], { env, encoding: 'utf8', cwd: root }));
    expect(out).toContain("'stop' handed off to a detached process");

    const log = join(home, '.octipus', 'stop.log');
    const deadline = Date.now() + 20_000;
    let text = '';
    while (Date.now() < deadline) {
      text = existsSync(log) ? plain(readFileSync(log, 'utf8')) : '';
      if (text.includes('No Octipus processes were running')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(text).toContain('No Octipus processes were running');
    expect(text).not.toContain('handed off');
  }, 30_000);

  test.skipIf(process.platform === 'win32').each([false, true])('stop cleans up only a listener belonging to its checkout (owned=%s)', async owned => {
    const { root, script } = isolatedBashProject('API_PORT=1\nWEB_PORT=2\n');
    const home = mkdtempSync(join(tmpdir(), 'octi-port-owner-'));
    const source = `require('node:http').createServer((_,res)=>res.end('unrelated')).listen(0,'127.0.0.1',function(){console.log(this.address().port)});`;
    const entry = join(root, 'listener.cjs');
    writeFileSync(entry, source);
    const child = spawn(process.execPath, owned ? [entry] : ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const [data] = await once(child.stdout!, 'data');
      const port = String(data).trim();
      const exited = once(child, 'exit');
      execFileSync('bash', [script, 'stop'], {
        env: { ...process.env, HOME: home, API_PORT: port, WEB_PORT: port, OCTIPUS_INSIDE_PID: '' },
        cwd: root, stdio: 'pipe', timeout: 20_000,
      });
      if (owned) {
        await exited;
        expect(child.signalCode).toBe('SIGTERM');
      } else {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        expect(await response.text()).toBe('unrelated');
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }
  }, 30_000);
});
