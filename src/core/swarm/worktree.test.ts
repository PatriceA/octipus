import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorktree,
  finishWorktree,
  isValidWorktreeId,
  isWorktreeLive,
  reapStaleWorktrees,
  releaseWorktree,
  removeWorktree,
} from './worktree';

/**
 * Real git, real temp repos: the whole point of this module is what git does
 * with the arguments we give it, which a mocked `execFile` cannot tell us.
 */

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function commitAll(cwd: string, msg: string): void {
  git(cwd, 'add', '-A');
  git(cwd, ...ID, 'commit', '-q', '-m', msg);
}

let base: string;
let repo: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'octipus-wt-')));
  repo = join(base, 'repo');
  root = join(base, 'worktrees');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), 'line one\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  commitAll(repo, 'init');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').trim();
const branchExists = (name: string) => git(repo, 'branch', '--list', name).trim().length > 0;

describe('createWorktree', () => {
  it('creates a worktree on octipus/<id> at HEAD, outside the repo', async () => {
    const h = await createWorktree(repo, 'agent_1', { root });
    expect(h.path).toBe(join(root, 'agent_1'));
    expect(h.branch).toBe('octipus/agent_1');
    expect(h.baseSha).toBe(head(repo));
    expect(git(h.path, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('octipus/agent_1');
    expect(isWorktreeLive('agent_1')).toBe(true);
    await removeWorktree(h, { merged: true });
    expect(isWorktreeLive('agent_1')).toBe(false);
  });

  it('rejects an id that could name a path or a ref', async () => {
    for (const bad of ['', '../x', 'a/b', 'a b', 'x;rm', '-f', '.hidden', 'a'.repeat(65)]) {
      expect(isValidWorktreeId(bad), bad).toBe(false);
    }
    expect(isValidWorktreeId('c0a1b2_x-y')).toBe(true);
    await expect(createWorktree(repo, '../escape', { root })).rejects.toThrow(/invalid worktree id/);
    await expect(createWorktree(repo, 'a/b', { root })).rejects.toThrow(/invalid worktree id/);
    expect(existsSync(join(base, 'escape'))).toBe(false);
  });

  it('fails (so the caller falls back) when the directory is not a git repository root', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    await expect(createWorktree(plain, 'a1', { root })).rejects.toThrow(/not a git repository root/);
    // A sub-directory of a repo does not qualify either.
    mkdirSync(join(repo, 'sub'));
    await expect(createWorktree(join(repo, 'sub'), 'a2', { root })).rejects.toThrow(/not a git repository root/);
    expect(isWorktreeLive('a1')).toBe(false);
  });

  it('fails when the worktree path is already taken, leaving it alone', async () => {
    mkdirSync(join(root, 'taken'), { recursive: true });
    writeFileSync(join(root, 'taken', 'keep.txt'), 'x');
    await expect(createWorktree(repo, 'taken', { root })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(root, 'taken', 'keep.txt'), 'utf-8')).toBe('x');
    expect(branchExists('octipus/taken')).toBe(false);
  });

  const excludeLines = () =>
    readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')
      .split('\n')
      .filter((l) => l === '/node_modules');

  it('links node_modules as ONE symlink to the repo’s, kept out of git status', async () => {
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    const h = await createWorktree(repo, 'nm', { root });
    const link = join(h.path, 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(repo, 'node_modules'));
    expect(readFileSync(join(link, 'left-pad', 'index.js'), 'utf-8')).toContain('module.exports');
    // `node_modules/` (directories only) does not match a symlink, so the
    // exclude line is what keeps it out — in the worktree and the main tree.
    expect(git(h.path, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(excludeLines()).toHaveLength(1);
    // A second worktree does not add the line again.
    const h2 = await createWorktree(repo, 'nm2', { root });
    expect(excludeLines()).toHaveLength(1);

    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('no_changes');
    expect((await removeWorktree(h, { merged: true })).removed).toBe(true);
    await removeWorktree(h2, { merged: true });
    // The link was removed, never its target.
    expect(existsSync(join(repo, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('links node_modules in a repo that does not ignore it at all', async () => {
    writeFileSync(join(repo, '.gitignore'), '');
    commitAll(repo, 'no ignore');
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    const h = await createWorktree(repo, 'nm3', { root });
    expect(lstatSync(join(h.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(git(h.path, 'status', '--porcelain').trim()).toBe('');
    writeFileSync(join(h.path, 'src.ts'), 'x\n');
    const report = await finishWorktree(h, { merge: false });
    // Only the child's file was committed, never the symlink.
    expect(report.filesChanged).toBe(1);
    expect(git(repo, 'ls-tree', '-r', '--name-only', h.branch)).not.toContain('node_modules');
    await removeWorktree(h, { merged: false });
  });

  it('does not link node_modules when turned off, or when the repo tracks it', async () => {
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    const off = await createWorktree(repo, 'nmoff', { root, linkNodeModules: false });
    expect(existsSync(join(off.path, 'node_modules'))).toBe(false);
    expect(existsSync(join(repo, '.git', 'info', 'exclude')) ? excludeLines() : []).toHaveLength(0);
    await removeWorktree(off, { merged: true });

    // Vendored dependencies: the checkout already has a real node_modules.
    writeFileSync(join(repo, '.gitignore'), '');
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'v\n');
    commitAll(repo, 'vendor');
    const tracked = await createWorktree(repo, 'nmtracked', { root });
    expect(lstatSync(join(tracked.path, 'node_modules')).isDirectory()).toBe(true);
    expect(readFileSync(join(tracked.path, 'node_modules', 'dep', 'index.js'), 'utf-8')).toBe('v\n');
    await removeWorktree(tracked, { merged: true });
  });
});

describe('finishWorktree', () => {
  it('commits the child’s edits, merges them into the current branch and reports the branch', async () => {
    const h = await createWorktree(repo, 'ok1', { root });
    writeFileSync(join(h.path, 'feature.ts'), 'export const x = 1;\n');

    const report = await finishWorktree(h, { merge: true, label: 'swarm node n1' });

    expect(report.branch).toBe('octipus/ok1');
    expect(report.merge).toBe('merged');
    expect(report.filesChanged).toBe(1);
    expect(report.diffStat).toMatch(/1 file changed/);
    expect(report.headSha).not.toBe(h.baseSha);
    expect(readFileSync(join(repo, 'feature.ts'), 'utf-8')).toContain('x = 1');
    // A real merge commit (--no-ff) whose second parent is the child's head.
    expect(git(repo, 'rev-parse', 'HEAD^2').trim()).toBe(report.headSha);
    expect(git(repo, 'log', '-1', '--format=%an', report.headSha).trim()).toBe('Test');
    expect(git(repo, 'log', '-1', '--format=%ae|%ce').trim()).toBe('test@example.com|test@example.com');

    const cleaned = await removeWorktree(h, { merged: true });
    expect(cleaned).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(h.path)).toBe(false);
    expect(branchExists('octipus/ok1')).toBe(false);
  });

  it('uses a fallback identity only when no identity is configured', async () => {
    git(repo, 'config', 'user.name', ''); git(repo, 'config', 'user.email', '');
    const h = await createWorktree(repo, 'fallback', { root });
    writeFileSync(join(h.path, 'new.txt'), 'new');
    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('merged');
    expect(git(repo, 'log', '-1', '--format=%ae|%ce').trim()).toBe('octipus-agent@localhost|octipus-agent@localhost');
  });

  it('keeps commits the child made itself', async () => {
    const h = await createWorktree(repo, 'ok2', { root });
    writeFileSync(join(h.path, 'a.txt'), 'a\n');
    commitAll(h.path, 'child commit');
    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('merged');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
    await removeWorktree(h, { merged: true });
  });

  it('aborts a conflicting merge, keeps the branch and leaves the parent tree untouched', async () => {
    const h = await createWorktree(repo, 'cf', { root });
    writeFileSync(join(h.path, 'README.md'), 'child version\n');
    writeFileSync(join(repo, 'README.md'), 'parent version\n');
    commitAll(repo, 'parent moved on');
    const parentHead = head(repo);

    const report = await finishWorktree(h, { merge: true });

    expect(report.merge).toBe('conflict');
    expect(head(repo)).toBe(parentHead);
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('parent version\n');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(() => git(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();

    const cleaned = await removeWorktree(h, { merged: false });
    expect(cleaned.removed).toBe(true);
    expect(cleaned.branchDeleted).toBe(false);
    expect(branchExists('octipus/cf')).toBe(true);
    expect(git(repo, 'show', 'octipus/cf:README.md')).toBe('child version\n');
  });

  it('does not attempt a merge when the parent tree is dirty', async () => {
    const h = await createWorktree(repo, 'dirty', { root });
    writeFileSync(join(h.path, 'new.txt'), 'n\n');
    writeFileSync(join(repo, 'README.md'), 'uncommitted user edit\n');
    const parentHead = head(repo);

    const report = await finishWorktree(h, { merge: true });

    expect(report.merge).toBe('skipped_dirty');
    expect(head(repo)).toBe(parentHead);
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('uncommitted user edit\n');
    await removeWorktree(h, { merged: false });
    expect(branchExists('octipus/dirty')).toBe(true);
  });

  it('does not merge when asked not to (a child that did not finish ok)', async () => {
    const h = await createWorktree(repo, 'nomerge', { root });
    writeFileSync(join(h.path, 'half.txt'), 'h\n');
    const report = await finishWorktree(h, { merge: false });
    expect(report.merge).toBe('skipped_status');
    expect(report.filesChanged).toBe(1);
    expect(existsSync(join(repo, 'half.txt'))).toBe(false);
    await removeWorktree(h, { merged: false });
    expect(branchExists('octipus/nomerge')).toBe(true);
  });

  it('reports no_changes for a child that changed nothing', async () => {
    const h = await createWorktree(repo, 'idle', { root });
    const report = await finishWorktree(h, { merge: true });
    expect(report).toMatchObject({ merge: 'no_changes', filesChanged: 0, headSha: h.baseSha });
    await removeWorktree(h, { merged: true });
    expect(branchExists('octipus/idle')).toBe(false);
  });

  it('never deletes an unmerged branch, even when told it was merged', async () => {
    const h = await createWorktree(repo, 'liar', { root });
    writeFileSync(join(h.path, 'x.txt'), 'x\n');
    await finishWorktree(h, { merge: false });
    const cleaned = await removeWorktree(h, { merged: true });
    // `branch -d` refuses unmerged work — the guard is git's, not ours alone.
    expect(cleaned.branchDeleted).toBe(false);
    expect(branchExists('octipus/liar')).toBe(true);
  });
});

describe('detached work survives clean-up', () => {
  it('fast-forwards octipus/<id> onto a detached HEAD before removing the worktree', async () => {
    const h = await createWorktree(repo, 'det1', { root });
    git(h.path, 'checkout', '-q', '--detach');
    writeFileSync(join(h.path, 'lost.txt'), 'would be lost\n');
    commitAll(h.path, 'detached commit');
    const detachedSha = head(h.path);

    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('failed');
    expect(report.headSha).toBe(detachedSha);

    const cleaned = await removeWorktree(h, { merged: false });
    expect(cleaned.removed).toBe(true);
    expect(cleaned.keptRef).toBe('octipus/det1');
    expect(git(repo, 'rev-parse', 'octipus/det1').trim()).toBe(detachedSha);
    expect(git(repo, 'show', 'octipus/det1:lost.txt')).toBe('would be lost\n');
  });

  it('pins a detached HEAD that is not a fast-forward with a -detached keep-ref', async () => {
    const h = await createWorktree(repo, 'det2', { root });
    writeFileSync(join(h.path, 'on-branch.txt'), 'b\n');
    commitAll(h.path, 'branch commit');
    git(h.path, 'checkout', '-q', '--detach', h.baseSha);
    writeFileSync(join(h.path, 'side.txt'), 's\n');
    commitAll(h.path, 'side commit');
    const sideSha = head(h.path);

    const cleaned = await removeWorktree(h, { merged: true });
    expect(cleaned.removed).toBe(true);
    expect(cleaned.keptRef).toBe('octipus/det2-detached');
    expect(git(repo, 'rev-parse', 'octipus/det2-detached').trim()).toBe(sideSha);
    // The branch's own unmerged commit is kept too (`-d` refused it).
    expect(git(repo, 'show', 'octipus/det2:on-branch.txt')).toBe('b\n');
  });

  it('never removes a worktree with uncommitted changes', async () => {
    const h = await createWorktree(repo, 'wip', { root });
    git(h.path, 'checkout', '-q', '--detach');
    writeFileSync(join(h.path, 'README.md'), 'edited, not committed\n');
    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('failed');
    const cleaned = await removeWorktree(h, { merged: false });
    expect(cleaned.removed).toBe(false);
    expect(readFileSync(join(h.path, 'README.md'), 'utf-8')).toBe('edited, not committed\n');
    releaseWorktree('wip');
  });
});

describe('merge safety', () => {
  it('skips the merge when the project no longer contains the base (skipped_moved)', async () => {
    writeFileSync(join(repo, 'second.txt'), '2\n');
    commitAll(repo, 'second');
    const h = await createWorktree(repo, 'moved', { root });
    writeFileSync(join(h.path, 'child.txt'), 'c\n');
    // The user rewinds their branch past the commit the child started from.
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    const before = head(repo);

    const report = await finishWorktree(h, { merge: true });

    expect(report.merge).toBe('skipped_moved');
    expect(head(repo)).toBe(before);
    expect(existsSync(join(repo, 'child.txt'))).toBe(false);
    await removeWorktree(h, { merged: false });
    expect(git(repo, 'show', 'octipus/moved:child.txt')).toBe('c\n');
  });

  it('runs no repository hook for any server-side git call', async () => {
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const name of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'post-merge', 'pre-merge-commit']) {
      writeFileSync(join(hooks, name), `#!/bin/sh\necho ran >> "${join(base, `hook-${name}`)}"\n`, { mode: 0o755 });
    }

    const h = await createWorktree(repo, 'hooks', { root });
    writeFileSync(join(h.path, 'f.txt'), 'f\n');
    const report = await finishWorktree(h, { merge: true });
    expect(report.merge).toBe('merged');
    await removeWorktree(h, { merged: true });

    for (const name of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'post-merge', 'pre-merge-commit']) {
      expect(existsSync(join(base, `hook-${name}`)), name).toBe(false);
    }
    // Control: the hooks are live for an ordinary git call, so the test proves something.
    git(repo, 'checkout', '-q', '-b', 'control');
    expect(existsSync(join(base, 'hook-post-checkout'))).toBe(true);
  });
});

describe('reapStaleWorktrees', () => {
  it('prunes a merged, abandoned worktree and reports an unmerged one', async () => {
    const merged = await createWorktree(repo, 'gone1', { root });
    const unmerged = await createWorktree(repo, 'gone2', { root });
    writeFileSync(join(unmerged.path, 'wip.txt'), 'w\n');
    commitAll(unmerged.path, 'wip');
    const live = await createWorktree(repo, 'alive', { root });
    // The first two children are gone; the third is still running.
    releaseWorktree('gone1');
    releaseWorktree('gone2');

    const out = await reapStaleWorktrees({ root, minAgeMs: 0 });

    expect(out.pruned).toEqual(['gone1']);
    expect(out.reported.map((r) => r.id)).toEqual(['gone2']);
    expect(out.reported[0]?.reason).toMatch(/not merged/);
    expect(existsSync(merged.path)).toBe(false);
    expect(branchExists('octipus/gone1')).toBe(false);
    expect(existsSync(unmerged.path)).toBe(true);
    expect(branchExists('octipus/gone2')).toBe(true);
    expect(existsSync(live.path)).toBe(true);
    await removeWorktree(live, { merged: true });
  });

  it('leaves a worktree whose owner process is alive, however old', async () => {
    const h = await createWorktree(repo, 'otherproc', { root });
    releaseWorktree('otherproc');
    // Another server process (here: our parent, which is certainly alive) owns it.
    writeFileSync(join(root, 'otherproc.pid'), String(process.ppid));
    const out = await reapStaleWorktrees({ root, minAgeMs: 0 });
    expect(out.pruned).toEqual([]);
    expect(existsSync(h.path)).toBe(true);
  });

  it('reports, never removes, an abandoned worktree with uncommitted or detached work', async () => {
    const dirty = await createWorktree(repo, 'dirtyleft', { root });
    writeFileSync(join(dirty.path, 'README.md'), 'uncommitted\n');
    const det = await createWorktree(repo, 'detleft', { root });
    git(det.path, 'checkout', '-q', '--detach');
    writeFileSync(join(det.path, 'd.txt'), 'd\n');
    commitAll(det.path, 'detached');
    releaseWorktree('dirtyleft');
    releaseWorktree('detleft');

    const out = await reapStaleWorktrees({ root, minAgeMs: 0 });

    expect(out.pruned).toEqual([]);
    expect(out.reported.map((r) => r.id).sort()).toEqual(['detleft', 'dirtyleft']);
    expect(existsSync(dirty.path) && existsSync(det.path)).toBe(true);
  });

  it('leaves a young worktree alone (another process may own it)', async () => {
    await createWorktree(repo, 'young', { root });
    releaseWorktree('young');
    const out = await reapStaleWorktrees({ root });
    expect(out.pruned).toEqual([]);
    expect(existsSync(join(root, 'young'))).toBe(true);
  });
});
