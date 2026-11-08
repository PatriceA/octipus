/**
 * A package that declares hosts, on a platform where no sandbox wraps it
 * (Windows; Linux without bwrap/firejail): under `security.shellSandbox:
 * required` it is refused instead of launched with an advisory proxy. The
 * runner is faked; nothing is executed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

let mode: 'off' | 'auto' | 'required' = 'required';
vi.mock('@/security/shell-sandbox', async (original) => ({
  ...(await original<typeof import('@/security/shell-sandbox')>()),
  getSandboxMode: () => mode,
  activeSandboxRunner: () => null,
  wrapCommand: (argv: string[]) => ({ wrapped: false, runner: null, argv, cleanup: () => {} }),
}));

import { prepareSandboxedLaunch } from './stdio';

const scratch = mkdtempSync(join(tmpdir(), 'eg-req-'));
afterEach(() => { mode = 'required'; });

const launch = () => prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin' },
  { root: '/pkg', allowNetwork: true, egress: { label: 'demo-pkg', hosts: ['api.example.com'], runDir: join(scratch, 'plugin-run') } });

test('required: a package with hosts and no runner is refused', async () => {
  await expect(launch()).rejects.toThrow(/required: the network of plugin package "demo-pkg" cannot be enforced/);
});

test('auto: the same package launches with the advisory proxy, not enforced', async () => {
  mode = 'auto';
  const result = await launch();
  try {
    expect(result.networkEnforced).toBe(false);
    expect(result.env.HTTPS_PROXY).toBe(result.proxy?.url);
  } finally {
    result.cleanup();
    await result.proxy?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('own Node binary: listed under $HOME or /opt, not for a system install', async () => {
  const { ownNodeBinary } = await import('./stdio');
  expect(ownNodeBinary('/home/u/.nvm/versions/node/v24.1.0/bin/node')).toEqual(['/home/u/.nvm/versions/node/v24.1.0/bin/node']);
  expect(ownNodeBinary('/opt/hostedtoolcache/node/24.1.0/x64/bin/node')).toEqual(['/opt/hostedtoolcache/node/24.1.0/x64/bin/node']);
  expect(ownNodeBinary('/usr/bin/node')).toEqual([]);
  expect(ownNodeBinary('/usr/local/bin/node')).toEqual([]);
  expect(ownNodeBinary('/bin/node')).toEqual([]);
  expect(ownNodeBinary('/lib64/node')).toEqual([]);
});
