import { createHash } from 'node:crypto';
import { snapshotWorkspace, workspaceSnapshotConfig } from '@/core/agent/workspace-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionEnvironmentSchema } from '@/shared/execution-environment';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import * as sandbox from './shell-sandbox';
import { REMOTE_COMMAND_PROGRAM, SshShellOperations, quoteRuntimeArg } from './environment-runtime';
import { REMOTE_FILESYSTEM_PROGRAM } from '@/tools/filesystem/environment-operations';
import { buildHostChildEnv } from './child-env';
const root = mkdtempSync(join(tmpdir(), 'environment-runtime-'));
afterEach(() => vi.restoreAllMocks());
const result = { exitCode: 0, stdout: '', stderr: '', killed: false, timedOut: false, aborted: false, signal: null };
const remote = executionEnvironmentSchema.parse({ id: 'remote', userId: '11111111-1111-4111-8111-111111111111', name: 'Server', backend: 'ssh', roots: [root], ssh: { host: 'server.example', user: 'deploy' } });
function fs(operation: string, args: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify({ operation, args, cwd: root, roots: [root] })).toString('base64');
  const run = spawnSync(process.execPath, ['-e', REMOTE_FILESYSTEM_PROGRAM], { input: payload, encoding: 'utf8' });
  expect(run.stderr).toBe('');
  return JSON.parse(run.stdout);
}
describe('actual remote transport programs', () => {
  it('passes commands, env and nested stdin as data rather than shell syntax', () => {
    const command = `${quoteRuntimeArg(process.execPath)} -e ${quoteRuntimeArg('process.stdout.write(process.env.CLI_TOKEN + require("fs").readFileSync(0,"utf8"))')}`;
    const run = spawnSync(process.execPath, ['-e', REMOTE_COMMAND_PROGRAM], { encoding: 'utf8', input: JSON.stringify({ command, cwd: root, env: { CLI_TOKEN: 'a\n$()`;' }, input: 'nested input' }) });
    expect(run.status).toBe(0); expect(run.stdout).toBe('a\n$()`;nested input');
  });
  it('does not put command input or connected credentials in SSH argv', async () => {
    const exec = vi.spyOn(LocalShellOperations.prototype, 'exec').mockResolvedValue(result);
    await new SshShellOperations(remote).exec('printf hello', root, { env: { GH_TOKEN: 'synthetic-token' }, input: 'large-private-body' });
    const [command, , options] = exec.mock.calls[0];
    expect(command).toContain('StrictHostKeyChecking=yes');
    expect(command).not.toContain('synthetic-token'); expect(command).not.toContain('large-private-body');
    expect(JSON.parse(options!.input!)).toMatchObject({ env: { GH_TOKEN: 'synthetic-token' }, input: 'large-private-body' });
    expect(options).toMatchObject({ sandboxMode: 'off', allowNetwork: true });
  });
  it('round trips file writes, edits and versioned session saves', () => {
    expect(fs('write_file', { path: 'a.txt', content: 'one' })).toMatchObject({ success: true });
    expect(fs('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' })).toMatchObject({ replacements: 1 });
    const read = fs('read_session_file', { path: 'a.txt' }); expect(read).toMatchObject({ type: 'text', content: 'two' });
    expect(fs('write_session_file', { path: './a.txt', content: 'three', baseVersion: read.version })).toHaveProperty('version');
    expect(fs('write_session_file', { path: 'a.txt', content: 'lost', baseVersion: read.version })).toMatchObject({ __error: true, status: 409 });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('three');
  });
  it('rejects traversal and symlinks outside approved remote roots', () => {
    expect(fs('read_file', { path: '../outside' })).toMatchObject({ __error: true });
    symlinkSync(tmpdir(), join(root, 'escape'));
    expect(fs('write_file', { path: 'escape/should-never-exist', content: 'x' })).toMatchObject({ __error: true });
  });
  it('preserves search result shape and explicit limits', () => {
    writeFileSync(join(root, 'match-one.log'), ''); writeFileSync(join(root, 'match-two.log'), '');
    expect(fs('search_files', { pattern: 'match*.log', _validatedPattern: '^match.*\\.log$', maxResults: 1 })).toMatchObject({ pattern: 'match*.log', results: [expect.stringMatching(/match-.*\.log/)], truncated: true });
  });
  it('remote snapshots match local snapshot semantics, including generated-file pruning', async () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true }); writeFileSync(join(root, 'node_modules', 'generated'), 'ignored');
    const remote = fs('snapshot', { path: '.', config: workspaceSnapshotConfig() });
    const local = await snapshotWorkspace(root);
    expect(new Map(remote.files)).toEqual(local!.files); expect(remote.truncated).toBe(local!.truncated);
    expect(fs('snapshot', { path: '.', config: workspaceSnapshotConfig(1) }).truncated).toBe(true);
  });
  it('remote Git Changes and diff use the actual target tree', () => {
    for (const args of [['init', '--quiet'], ['add', 'a.txt'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']]) {
      const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); expect(git.status, git.stderr).toBe(0);
    }
    writeFileSync(join(root, 'a.txt'), 'new-content');
    expect(fs('changes', {})).toMatchObject({ isGitRepo: true, changes: expect.arrayContaining([{ path: 'a.txt', status: 'modified' }]) });
    expect(fs('change_diff', { path: 'a.txt' })).toMatchObject({ path: 'a.txt', original: 'three', modified: 'new-content', status: 'modified', truncated: false });
    expect(fs('git_head', {})).toMatch(/uncommitted changes/);
  });
  it('symlink aliases use the same remote write lock as their real target', () => {
    symlinkSync(join(root, 'a.txt'), join(root, 'alias.txt'));
    const lock = join(root, '.octipus-file-lock-' + createHash('sha256').update(join(root, 'a.txt')).digest('hex'));
    mkdirSync(lock);
    try { expect(fs('write_session_file', { path: 'alias.txt', content: 'must-not-write' })).toMatchObject({ __error: true, status: 409, notExecuted: true }); }
    finally { rmSync(lock, { recursive: true }); }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new-content');
  });
});
it.each(['required', 'off'] as const)('forwards per-environment mode %s for foreground and background', async mode => {
  const wrap = vi.spyOn(sandbox, 'wrapCommand').mockImplementation(argv => ({ wrapped: false, runner: null, argv, cleanup() {} }));
  const ops = new LocalShellOperations();
  await ops.exec(`${quoteRuntimeArg(process.execPath)} -e 'process.exit(0)'`, root, { sandboxMode: mode });
  await new Promise<void>(async (resolve, reject) => { try { await ops.spawnBackground(`${quoteRuntimeArg(process.execPath)} -e 'process.exit(0)'`, root, { sandboxMode: mode, onExit: () => resolve() }); } catch (error) { reject(error); } });
  expect(wrap.mock.calls).toHaveLength(2);
  for (const [, options] of wrap.mock.calls) expect(options?.mode).toBe(mode);
});
it('host identity keeps user CLI authentication but withholds server root secrets', () => {
  const before = { ...process.env };
  Object.assign(process.env, { GH_TOKEN: 'host-cli', MASTER_KEY: 'server-key', OPENAI_API_KEY: 'provider-key' });
  try { const env = buildHostChildEnv(); expect(env.GH_TOKEN).toBe('host-cli'); expect(env.MASTER_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined(); }
  finally { process.env = before; }
});
// One process owns the scratch tree; no real account, daemon or remote service is touched.
import { afterAll } from 'vitest';
afterAll(() => rmSync(root, { recursive: true, force: true }));
