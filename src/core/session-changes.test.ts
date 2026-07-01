import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getWorkspaceChangeDiff, getWorkspaceChanges } from './session-changes';

/**
 * Integration tests against a REAL git repo in a temp dir — the git logic is
 * the whole point of the module, so mocking git would test nothing. Each test
 * gets a fresh workspace.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@octipus.dev');
  git(root, 'config', 'user.name', 'Octipus Test');
  git(root, 'config', 'commit.gpgsign', 'false');
}

describe('session-changes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octi-changes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('non-git workspace → isGitRepo false, empty changes', async () => {
    const res = await getWorkspaceChanges(dir);
    expect(res.isGitRepo).toBe(false);
    expect(res.changes).toEqual([]);
  });

  test('clean repo → isGitRepo true, no changes', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');

    const res = await getWorkspaceChanges(dir);
    expect(res.isGitRepo).toBe(true);
    expect(res.changes).toEqual([]);
  });

  test('modified + untracked files are listed with correct status', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');

    // Modify tracked file + add an untracked one.
    writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n');
    writeFileSync(join(dir, 'b.txt'), 'brand new\n');

    const res = await getWorkspaceChanges(dir);
    expect(res.isGitRepo).toBe(true);
    const byPath = Object.fromEntries(res.changes.map((c) => [c.path, c.status]));
    expect(byPath['a.txt']).toBe('modified');
    expect(byPath['b.txt']).toBe('untracked');
  });

  test('deleted tracked file reported as deleted', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'gone.txt'), 'bye\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    rmSync(join(dir, 'gone.txt'));

    const res = await getWorkspaceChanges(dir);
    expect(res.changes.find((c) => c.path === 'gone.txt')?.status).toBe('deleted');
  });

  test('reports the current branch name', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'checkout', '-q', '-b', 'feature/foo');

    const res = await getWorkspaceChanges(dir);
    expect(res.branch).toBe('feature/foo');
  });

  test('nested repo is NOT reported through a parent workspace root (containment)', async () => {
    // The workspace root itself is not a repo; a subdir is. We must refuse to
    // surface the child repo's changes, and never a parent repo's.
    const sub = join(dir, 'project');
    mkdirSync(sub);
    initRepo(sub);
    writeFileSync(join(sub, 'a.txt'), 'x\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'init');
    writeFileSync(join(sub, 'a.txt'), 'y\n');

    const res = await getWorkspaceChanges(dir);
    expect(res.isGitRepo).toBe(false);
  });

  test('paths with spaces are listed unquoted (porcelain -z)', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'my report.txt'), 'spaced\n');

    const res = await getWorkspaceChanges(dir);
    const paths = res.changes.map((c) => c.path);
    // Must be the exact name, not the C-quoted `"my report.txt"`.
    expect(paths).toContain('my report.txt');
  });

  test('empty tracked file edited to have content is "modified", not "added"', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'placeholder'), '');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'placeholder'), 'now has content\n');

    const diff = await getWorkspaceChangeDiff(dir, join(dir, 'placeholder'));
    // Status comes from git tracked-ness, not string emptiness.
    expect(diff.status).toBe('modified');
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('now has content\n');
  });

  test('tracked file cleared to empty is "modified", not "deleted"', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'cfg.txt'), 'value\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'cfg.txt'), '');

    const diff = await getWorkspaceChangeDiff(dir, join(dir, 'cfg.txt'));
    expect(diff.status).toBe('modified');
    expect(diff.modified).toBe('');
  });

  test('diff returns before/after for a modified file', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');

    const diff = await getWorkspaceChangeDiff(dir, join(dir, 'a.txt'));
    expect(diff.path).toBe('a.txt');
    expect(diff.status).toBe('modified');
    expect(diff.original).toBe('one\ntwo\n');
    expect(diff.modified).toBe('one\ntwo\nthree\n');
    expect(diff.truncated).toBe(false);
  });

  test('diff of an untracked (added) file has empty original', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'new.txt'), 'fresh\n');

    const diff = await getWorkspaceChangeDiff(dir, join(dir, 'new.txt'));
    expect(diff.status).toBe('added');
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('fresh\n');
  });

  test('diff of a deleted file has empty modified', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'gone.txt'), 'content\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    rmSync(join(dir, 'gone.txt'));

    const diff = await getWorkspaceChangeDiff(dir, join(dir, 'gone.txt'));
    expect(diff.status).toBe('deleted');
    expect(diff.original).toBe('content\n');
    expect(diff.modified).toBe('');
  });
});
