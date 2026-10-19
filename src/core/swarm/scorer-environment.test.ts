import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getConfig } from '@/config';
import * as sandbox from '@/security/shell-sandbox';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import { tokenizeSafe } from '@/tools/shell/policy';
import { runScorers, scorerEnvironmentError, type Scorer } from './scorers';

const gate = (command: string): Scorer => ({ kind: 'command_exit_zero', command });
const result = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', killed: false, timedOut: false, aborted: false, signal: null });
afterEach(() => vi.restoreAllMocks());

describe('MOCO #35: scorer directory visibility', () => {
  beforeEach(() => vi.spyOn(sandbox, 'getSandboxMode').mockReturnValue('required'));
  it('rejects a host repo hidden from the sandbox before dispatch', async () => {
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result(1));
    const error = await scorerEnvironmentError([gate('pnpm -C "/home/patrice/Github Rep/moco-rebuild" test')], '/workspace', { beforeSpawn: true });
    expect(error).toContain('Scorer environment');
    expect(error).toContain('/home/patrice/Github Rep/moco-rebuild');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(tokenizeSafe(exec.mock.calls[0][0])).toEqual(['test', '-d', '/home/patrice/Github Rep/moco-rebuild']);
    expect(exec.mock.calls[0][1]).toBe('/workspace');
    expect(exec.mock.calls[0][2]).not.toHaveProperty('extraReadWrite');
  });

  it.each(['pnpm --dir=', 'pnpm -C', 'npm --prefix=', 'yarn --cwd=', 'git -C ', 'make --directory='])(
    'checks directory switches with spaces and quotes: %s', async prefix => {
      const exec = vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result(0));
      expect(await scorerEnvironmentError([gate(`${prefix}"/repo's path" test`)], '/workspace', { beforeSpawn: true })).toBeNull();
      expect(tokenizeSafe(exec.mock.calls[0][0])).toEqual(['test', '-d', "/repo's path"]);
    },
  );

  it('resolves successive git directory switches against each other', async () => {
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result(0));
    expect(await scorerEnvironmentError([gate('git -C /repo -C sub status')], '/workspace')).toBeNull();
    expect(exec.mock.calls.map(call => tokenizeSafe(call[0]))).toEqual([
      ['test', '-d', '/repo'], ['test', '-d', '/repo/sub'],
    ]);
  });

  it('allows the child to create a subproject and does not mistake test inputs for cwd', async () => {
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec');
    expect(await scorerEnvironmentError([gate('pnpm -C new-package test'), gate('pytest /repo/new_test.py')], '/repo', { beforeSpawn: true })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('keeps a viable any_of alternative, but rejects when all are inaccessible', async () => {
    vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result(1));
    expect(await scorerEnvironmentError([{ kind: 'any_of', scorers: [gate('pnpm -C /hidden test'), gate('npm test')] }], '/repo', { beforeSpawn: true })).toBeNull();
    expect(await scorerEnvironmentError([{ kind: 'any_of', scorers: [gate('pnpm -C /hidden test'), gate('npm --prefix /hidden test')] }], '/repo', { beforeSpawn: true })).toContain('Scorer environment');
  });

  it('marks a missing scorer cwd non-retryable without running the gate', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'scorer-env-'));
    const permissions = await import('@/security/permissions');
    vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({ check: async () => ({ allowed: true, level: 'ALLOW', requiresApproval: false }) } as never);
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result(1));
    try {
      const outcome = await runScorers([gate('pnpm -C /hidden/repo test')], { output: 'done' }, { canRunCommands: true, role: 'coding', userId: 'system', projectPath: cwd });
      expect(outcome.failures[0]).toMatchObject({ retryable: false, reason: expect.stringContaining('Scorer environment') });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][0]).toMatch(/^test -d /);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('checks the host filesystem without a Unix probe when sandboxing is off', async () => {
    vi.spyOn(sandbox, 'getSandboxMode').mockReturnValue('off');
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec');
    expect(await scorerEnvironmentError([gate(`pnpm -C "${tmpdir()}" test`)], '/workspace')).toBeNull();
    expect(await scorerEnvironmentError([gate('pnpm -C /missing/scorer-repo test')], '/workspace')).toContain('Scorer environment');
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not silently score another tree when the declared project disappeared', async () => {
    const permissions = await import('@/security/permissions');
    vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({ check: async () => ({ allowed: true, level: 'ALLOW', requiresApproval: false }) } as never);
    const outcome = await runScorers([gate('true')], { output: 'done' }, { canRunCommands: true, role: 'coding', userId: 'system', projectPath: '/missing/scorer-project', workspaceRoot: tmpdir() });
    expect(outcome.failures[0]).toMatchObject({ retryable: false, reason: expect.stringContaining('/missing/scorer-project') });
  });
});

// Exercise the actual mount boundary when Linux user namespaces are available.
const bwrapAvailable = process.platform === 'linux' &&
  spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--', 'true']).status === 0;
it.skipIf(!bwrapAvailable)('real sandbox: hides the host sibling repo, mounts the declared project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Github Rep scorer-'));
  const workspace = join(root, 'workspace');
  const project = join(root, 'moco');
  mkdirSync(workspace);
  mkdirSync(project);
  const config = getConfig();
  const previous = config.security.shellSandbox;
  config.security.shellSandbox = 'required';
  try {
    const scorer = gate(`pnpm -C "${project}" test`);
    expect(await scorerEnvironmentError([scorer], workspace, { beforeSpawn: true })).toContain('Scorer environment');
    expect(await scorerEnvironmentError([scorer], project)).toBeNull();
  } finally {
    config.security.shellSandbox = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
