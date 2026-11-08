/**
 * The egress launch under sandbox-exec (macOS): no Unix socket and no bridge
 * — the profile allows only the proxy's loopback port, and the server is
 * pointed at that port directly. The runner is faked; nothing is executed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

const wrapCommand = vi.fn();
vi.mock('@/security/shell-sandbox', async (original) => ({
  ...(await original<typeof import('@/security/shell-sandbox')>()),
  wrapCommand: (...args: unknown[]) => wrapCommand(...args),
  // Only a caller that allows Seatbelt (the package launch) sees it.
  activeSandboxRunner: (o?: { allowSeatbelt?: boolean }) => (o?.allowSeatbelt ? 'sandbox-exec' : null),
}));

import { prepareSandboxedLaunch } from './stdio';

beforeEach(() => { wrapCommand.mockReset(); });

test('declared hosts: wrapped with network off but the proxy port, proxy variables set, no socket', async () => {
  wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: true, runner: 'sandbox-exec', argv: ['/usr/bin/sandbox-exec', '-p', '(version 1)', ...argv], cleanup: () => {} }));
  const scratch = mkdtempSync(join(tmpdir(), 'eg-mac-'));
  const dataDir = join(scratch, 'plugin-data', 'demo-pkg');
  const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin', NO_PROXY: '*' },
    { root: '/pkg', readOnlyRoot: true, writable: [dataDir], allowNetwork: true, egress: { label: 'demo-pkg', hosts: ['api.example.com'], runDir: join(scratch, 'plugin-run') } });
  try {
    expect(launch.networkEnforced).toBe(true);
    expect(launch.proxy?.socketPath).toBeNull();
    const opts = wrapCommand.mock.calls[0][1];
    expect(opts).toMatchObject({ workspaceRoot: '/pkg', allowSeatbelt: true, workspaceReadOnly: true, extraReadWrite: [dataDir], allowNetwork: false, loopbackPorts: [launch.proxy?.port] });
    expect(opts.extraReadOnly).toEqual([process.execPath]);
    // The command itself, no launcher in between.
    expect(launch.argv).toEqual(['/usr/bin/sandbox-exec', '-p', '(version 1)', 'node', 'server.mjs']);
    expect(launch.env.HTTPS_PROXY).toBe(launch.proxy?.url);
    expect(launch.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${launch.proxy?.port}`);
    expect(launch.env.NO_PROXY).toBe('');
    expect(launch.env.PATH).toBe('/usr/bin');
  } finally {
    launch.cleanup();
    await launch.proxy?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('no hosts: wrapped with no network and no proxy', async () => {
  wrapCommand.mockImplementation((argv: string[]) => ({ wrapped: true, runner: 'sandbox-exec', argv: ['/usr/bin/sandbox-exec', '-p', '(version 1)', ...argv], cleanup: () => {} }));
  const env = { PATH: '/usr/bin' };
  const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], env, { root: '/pkg', readOnlyRoot: true, allowNetwork: false });
  expect(launch.proxy).toBeNull();
  expect(launch.networkEnforced).toBe(true);
  expect(launch.env).toBe(env);
  expect(wrapCommand.mock.calls[0][1]).toEqual({ workspaceRoot: '/pkg', allowSeatbelt: true, workspaceReadOnly: true, allowNetwork: false, path: '/usr/bin', extraReadOnly: [process.execPath] });
});
