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
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const BIN_BASH = join(BIN_DIR, 'octi');

function runBash(args: string[]): { stdout: string; code: number } {
  const home = mkdtempSync(join(tmpdir(), 'octi-cli-test-'));
  try {
    const stdout = execFileSync('bash', [BIN_BASH, ...args], {
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
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

  test('compiled dispatcher resolves a custom install through its executable symlink', async () => {
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
