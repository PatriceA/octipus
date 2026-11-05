import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getConfig, resetConfig } from '@/config';
import type { AgentContext } from '@/core/types';
import { detectRunner } from '@/security/shell-sandbox';
import { WorkspaceFS } from '@/security/workspace-fs';
import { resolveShellCwd } from '@/security/shell-cwd';
import { LocalShellOperations } from './local-operations';
import { shellRunOptions } from './index';

let dir: string;
let context: AgentContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'octipus-mount-parity-'));
  getConfig().workspace.rootPath = join(dir, 'data');
  getConfig().workspace.additionalPaths = [join(dir, 'repos')];
  mkdirSync(join(dir, 'repos'));
  context = { userId: 'aaaaaaaa-0000-4000-8000-00000000a11c', metadata: {}, space: null } as AgentContext;
});
afterEach(() => { resetConfig(); rmSync(dir, { recursive: true, force: true }); });

test('mounts only approved directories, with segment boundaries shared by filesystem tools', () => {
  const project = join(dir, 'project');
  mkdirSync(project);
  context.metadata.projectPath = project;
  const fs = WorkspaceFS.forAgent(context);
  const options = shellRunOptions(context, undefined, null);
  expect(options.extraReadWrite).toEqual(expect.arrayContaining([fs.root, join(dir, 'repos'), project]));
  expect(fs.resolve(join(project, 'new.txt'))).toBe(join(project, 'new.txt'));
  expect(() => fs.resolve(join(dir, 'repos-evil', 'file'))).toThrow(/outside workspace/);
  expect(options.extraReadWrite).not.toContain(dir);
  expect(options.extraReadWrite).not.toContain(tmpdir());
  expect(options.extraReadOnly).not.toContain(fs.root);
});

test('space mounts do not inherit personal directories or project metadata', () => {
  context.space = { workspaceId: 'bbbbbbbb-0000-4000-8000-0000000000b0', scope: null } as NonNullable<AgentContext['space']>;
  context.metadata.projectPath = join(dir, 'repos');
  const fs = WorkspaceFS.forAgent(context);
  expect(shellRunOptions(context, undefined, null).extraReadWrite).toEqual([fs.root]);
  expect(resolveShellCwd(undefined, context)).toBe(fs.root);
  expect(() => fs.resolve(join(dir, 'repos'))).toThrow();
});

test('a leading cd cannot add an unapproved writable host mount', async () => {
  const fs = WorkspaceFS.forAgent(context);
  const options = shellRunOptions(context, undefined, null);
  const ops = new LocalShellOperations();
  await expect(ops.exec(`cd ${dir} && pwd`, fs.root, options)).rejects.toThrow(/outside approved/);
  await expect(ops.spawnBackground('true', dir, options)).rejects.toThrow(/outside approved/);
  const valid = await ops.exec(`cd ${join(dir, 'repos')} && pwd`, fs.root, options);
  expect(valid.exitCode, valid.stderr).toBe(0);
  expect(valid.stdout.trim()).toBe(join(dir, 'repos'));
});

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

test.skipIf(detectRunner()?.runner !== 'bwrap')('a Git worktree survives separate sandbox calls and filesystem edits', async () => {
  getConfig().security.shellSandbox = 'required';
  const repo = join(dir, 'repos', 'source');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'package.json'), '{"version":"1"}\n');
  execFileSync('git', ['-C', repo, 'add', 'package.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const fs = WorkspaceFS.forAgent(context);
  const options = { ...shellRunOptions(context, undefined, null), timeout: 5000 };
  const target = join(fs.root, 'tagging', 'library');
  const ops = new LocalShellOperations();
  const add = await ops.exec(`git worktree add -b tagging ${quote(target)} HEAD`, repo, options);
  expect(add.exitCode, add.stderr).toBe(0);
  expect(readFileSync(fs.resolve(join(target, 'package.json')), 'utf8')).toContain('"1"');
  writeFileSync(fs.resolve(join(target, 'package.json')), '{"version":"2"}\n');
  const diff = await ops.exec('git diff -- package.json', target, shellRunOptions(context, undefined, null));
  expect(diff.exitCode, diff.stderr).toBe(0);
  expect(diff.stdout).toContain('+{"version":"2"}');
  // Inverse direction: start in the workspace and write to another approved repo.
  const write = await ops.exec(`touch ${quote(join(repo, 'from-workspace'))}`, fs.root, options);
  expect(write.exitCode, write.stderr).toBe(0);
  expect(existsSync(fs.resolve(join(repo, 'from-workspace')))).toBe(true);
  // The same options support detached commands, too.
  await ops.spawnBackground(`touch ${quote(join(fs.root, 'background'))}`, repo, options);
  for (let i = 0; i < 100 && !existsSync(join(fs.root, 'background')); i++) await new Promise(r => setTimeout(r, 20));
  expect(existsSync(fs.resolve('background'))).toBe(true);
});

test.skipIf(detectRunner()?.runner !== 'bwrap')('unmounted parent directories reject writes instead of losing them on exit', async () => {
  getConfig().security.shellSandbox = 'required';
  const fs = WorkspaceFS.forAgent(context);
  const options = shellRunOptions(context, undefined, null);
  const target = `/home/octipus-unmounted-${process.pid}`;
  const result = await new LocalShellOperations().exec(`mkdir ${quote(target)}`, fs.root, options);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/read-only|permission denied/i);
  expect(existsSync(target)).toBe(false);
});
