/**
 * A plugin package's files are read-only in the sandbox (`workspaceReadOnly`)
 * and its data directory and the egress socket directory are the writable
 * mounts. Checks the argv for both runners without either being installed:
 * the runner's binary is made to "exist" for detection only.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

let fakeRunner: string | null = null;
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const KNOWN = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap', '/usr/bin/firejail', '/usr/local/bin/firejail', '/bin/firejail'];
  const existsSync = (p: import('node:fs').PathLike) => (KNOWN.includes(String(p)) ? String(p) === fakeRunner : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
vi.mock('@/config', async (original) => ({
  ...(await original<typeof import('@/config')>()),
  getConfig: () => ({ security: { shellSandbox: 'required' } }),
}));

import { _resetSandboxDetectionForTests, wrapCommand } from '@/security/shell-sandbox';

const pkg = '/srv/octipus/plugin-packages/demo-pkg';
const data = '/srv/octipus/plugin-data/demo-pkg';
const sock = '/srv/octipus/plugin-run/egress-abc123';

afterEach(() => { fakeRunner = null; _resetSandboxDetectionForTests(); });

/** The flags before the `--` that ends the runner's own. */
const flagsOf = (argv: string[]) => argv.slice(0, argv.lastIndexOf('--'));

describe('a read-only workspace with separate writable mounts', () => {
  test('bwrap: --ro-bind for the package, --bind for the data dir and socket dir', () => {
    fakeRunner = '/usr/bin/bwrap';
    const out = wrapCommand(['node', 'server.mjs'], { workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data, sock] });
    try {
      expect(out.runner).toBe('bwrap');
      const flags = flagsOf(out.argv);
      const at = flags.findIndex((a, i) => flags[i + 1] === pkg && flags[i + 2] === pkg);
      expect(flags[at]).toBe('--ro-bind');
      expect(flags.some((a, i) => (a === '--bind' || a === '--bind-try') && flags[i + 1] === pkg)).toBe(false);
      for (const p of [data, sock]) {
        expect(flags.some((a, i) => a === '--bind-try' && flags[i + 1] === p && flags[i + 2] === p)).toBe(true);
      }
      // The writable mounts come after the /tmp scratch, so they are not shadowed by it.
      const tmp = flags.findIndex((a, i) => a === '--bind' && flags[i + 2] === '/tmp');
      expect(flags.findIndex((a, i) => a === '--bind-try' && flags[i + 1] === sock)).toBeGreaterThan(tmp);
    } finally {
      out.cleanup();
    }
  });

  test('bwrap without the option still binds the workspace read-write', () => {
    fakeRunner = '/usr/bin/bwrap';
    const out = wrapCommand(['true'], { workspaceRoot: pkg });
    try {
      const flags = flagsOf(out.argv);
      expect(flags[flags.findIndex((a, i) => flags[i + 1] === pkg && flags[i + 2] === pkg)]).toBe('--bind');
    } finally {
      out.cleanup();
    }
  });

  test('firejail: the package whitelisted and --read-only, the data and socket dirs whitelisted writable', () => {
    fakeRunner = '/usr/bin/firejail';
    const out = wrapCommand(['node', 'server.mjs'], { workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data, sock] });
    expect(out.runner).toBe('firejail');
    const flags = flagsOf(out.argv);
    expect(flags).toContain(`--whitelist=${pkg}`);
    expect(flags).toContain(`--read-only=${pkg}`);
    for (const p of [data, sock]) {
      expect(flags).toContain(`--whitelist=${p}`);
      expect(flags).not.toContain(`--read-only=${p}`);
    }
    expect(flags).toContain('--private-tmp');
  });
});
