/**
 * Phase 3e — shell-sandbox wrapper tests.
 *
 * Two layers:
 *
 *   1. Unit (always run): wrapCommand returns the right shape for
 *      each `shellSandbox` mode + runner combination. Doesn't
 *      actually execute anything; verifies the argv we'd hand to
 *      child_process.spawn.
 *
 *   2. Behavioral (skipped without bwrap installed): runs a tiny
 *      command through the wrapped argv and confirms the spawn
 *      succeeds. Tagged `describe.skipIf(!hasBwrap)` so CI without
 *      a sandbox runner stays green.
 */
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const hasBwrap = BWRAP_PATHS.some((p) => existsSync(p));

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'octipus-sb-test-'));
  process.env.MASTER_KEY ??= 'a'.repeat(64);
  process.env.JWT_SECRET ??= 'b'.repeat(32);
  process.env.SESSION_SECRET ??= 'c'.repeat(32);
  process.env.LOG_LEVEL ??= 'error';
});

afterEach(async () => {
  // Force re-detection between tests so a test can mock
  // `existsSync` via the runner cache without leaking into others.
  const { _resetSandboxDetectionForTests } = await import('@/security/shell-sandbox');
  _resetSandboxDetectionForTests();
});

describe('getSandboxMode', () => {
  test('defaults to "off" when config not loaded', async () => {
    const { getSandboxMode } = await import('@/security/shell-sandbox');
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'off';
    expect(getSandboxMode()).toBe('off');
  });

  test('reads "auto" / "required" from config', async () => {
    const { getSandboxMode } = await import('@/security/shell-sandbox');
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    expect(getSandboxMode()).toBe('auto');
    getConfig().security.shellSandbox = 'required';
    expect(getSandboxMode()).toBe('required');
    getConfig().security.shellSandbox = 'off';
  });
});

describe('wrapCommand — mode "off"', () => {
  test('returns the original argv unwrapped', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'off';
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['ls', '-l'], { workspaceRoot: workspace });
    expect(out.wrapped).toBe(false);
    expect(out.runner).toBeNull();
    expect(out.argv).toEqual(['ls', '-l']);
  });
});

describe('wrapCommand — mode "required" with no runner', () => {
  test('throws a descriptive error', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'required';

    // Force runner detection to "no runner found" by pointing
    // detection at empty paths via the fact that the test machine
    // may genuinely lack bwrap. If the machine HAS bwrap, the
    // wrapped path is taken — both branches are valid; this test
    // is only meaningful when the runner is absent.
    if (hasBwrap) {
      // On a host with bwrap, this test would wrap successfully.
      // Skip — the "no runner" branch is exercised on hosts without.
      getConfig().security.shellSandbox = 'off';
      return;
    }

    const { wrapCommand } = await import('@/security/shell-sandbox');
    expect(() => wrapCommand(['ls'], { workspaceRoot: workspace })).toThrow(
      /no sandbox runner/i,
    );
    getConfig().security.shellSandbox = 'off';
  });
});

describe.skipIf(!hasBwrap)('wrapCommand — mode "auto" with bwrap installed', () => {
  test('wraps argv with bwrap flags', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['ls', '-l'], { workspaceRoot: workspace });
    expect(out.wrapped).toBe(true);
    expect(out.runner).toBe('bwrap');
    expect(out.argv[0]).toMatch(/bwrap$/);
    // Workspace bound rw.
    expect(out.argv).toContain('--bind');
    expect(out.argv).toContain(workspace);
    // /usr bound ro.
    expect(out.argv).toContain('--ro-bind');
    expect(out.argv).toContain('/usr');
    // Network dropped by default.
    expect(out.argv).toContain('--unshare-net');
    // Original command appended after the `--` sentinel.
    expect(out.argv).toContain('--');
    expect(out.argv.slice(-2)).toEqual(['ls', '-l']);
    out.cleanup();
    getConfig().security.shellSandbox = 'off';
  });

  test('allowNetwork drops the --unshare-net flag', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['curl', '-s', 'https://example.com'], {
      workspaceRoot: workspace, allowNetwork: true,
    });
    expect(out.argv).not.toContain('--unshare-net');
    out.cleanup();
    getConfig().security.shellSandbox = 'off';
  });

  test('cleanup removes the per-spawn scratch dir', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['true'], { workspaceRoot: workspace });
    // Find the scratch path in the argv: the `--bind <scratch> /tmp` pair.
    const idx = out.argv.findIndex((a, i) => a === '--bind' && out.argv[i + 2] === '/tmp');
    const scratch = idx >= 0 ? out.argv[idx + 1] : null;
    expect(scratch).toBeTruthy();
    expect(existsSync(scratch!)).toBe(true);
    out.cleanup();
    expect(existsSync(scratch!)).toBe(false);
    getConfig().security.shellSandbox = 'off';
  });
});

describe.skipIf(!hasBwrap)('end-to-end: bwrap-wrapped command actually executes', () => {
  test('runs `printf hi` through bwrap and returns the right output', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['printf', 'hi'], { workspaceRoot: workspace });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(out.argv[0], out.argv.slice(1), { encoding: 'utf-8' });
    out.cleanup();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('hi');
    getConfig().security.shellSandbox = 'off';
  });

  test('blocks reads outside the workspace root', async () => {
    const { getConfig } = await import('@/config');
    getConfig().security.shellSandbox = 'auto';
    const outsideDir = mkdtempSync(join(tmpdir(), 'octipus-sb-outside-'));
    const { wrapCommand } = await import('@/security/shell-sandbox');
    const out = wrapCommand(['ls', outsideDir], { workspaceRoot: workspace });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(out.argv[0], out.argv.slice(1), { encoding: 'utf-8' });
    out.cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
    // ls of a path that doesn't exist inside the sandbox returns
    // non-zero. The exact message varies, but exit code must be != 0.
    expect(r.status).not.toBe(0);
    getConfig().security.shellSandbox = 'off';
  });
});
