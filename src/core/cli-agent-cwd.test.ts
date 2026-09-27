import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isBorrowedProjectDir } from './cli-agent-worker';
import { worktreeCwdOverride } from './swarm/worktree';

// Swarm worktree isolation: the spawner hands a coding CLI child its own git
// worktree through `metadata.worktreePath`, and the worker must run there. The
// override is honoured only for an existing directory directly under the
// worktrees root — metadata is an open bag, and a cwd override must never be a
// way to point a write-enabled agent at an arbitrary directory.
describe('worktreeCwdOverride', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'octipus-wtroot-')));
    mkdirSync(join(root, 'c123'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('an existing worktree under the root overrides the cwd', () => {
    expect(worktreeCwdOverride({ worktreePath: join(root, 'c123') }, root)).toBe(join(root, 'c123'));
  });

  test('no worktreePath means no override: the shared tree is used', () => {
    expect(worktreeCwdOverride({}, root)).toBeUndefined();
    expect(worktreeCwdOverride(undefined, root)).toBeUndefined();
  });

  test('a path outside the worktrees root, relative, nested or missing is ignored', () => {
    expect(worktreeCwdOverride({ worktreePath: '/etc' }, root)).toBeUndefined();
    expect(worktreeCwdOverride({ worktreePath: 'c123' }, root)).toBeUndefined();
    expect(worktreeCwdOverride({ worktreePath: join(root, 'c123', '..', '..') }, root)).toBeUndefined();
    expect(worktreeCwdOverride({ worktreePath: join(root, 'missing') }, root)).toBeUndefined();
    mkdirSync(join(root, 'c123', 'deeper'));
    expect(worktreeCwdOverride({ worktreePath: join(root, 'c123', 'deeper') }, root)).toBeUndefined();
    expect(worktreeCwdOverride({ worktreePath: 42 }, root)).toBeUndefined();
  });
});

// A missing cwd means two different things, and the CLI worker must not
// conflate them. Its per-user workspace is materialised lazily, so absent is
// routine — but a dev-mode `projectPath` belongs to someone else and is checked
// only once, when the session is created. If it has since been deleted, renamed
// or unmounted, creating it would spawn a write-enabled agent into an EMPTY
// tree and let it report success against no code at all, with nothing saying
// the project had gone.
describe('isBorrowedProjectDir', () => {
  test('a dev-mode session pinned to a project path is borrowed', () => {
    expect(isBorrowedProjectDir({ devMode: true, projectPath: '/home/user/repo' })).toBe(true);
  });

  test('an ordinary session owns its workspace', () => {
    expect(isBorrowedProjectDir({})).toBe(false);
    expect(isBorrowedProjectDir(undefined)).toBe(false);
    expect(isBorrowedProjectDir(null)).toBe(false);
  });

  test('both halves are required — either alone is still our own workspace', () => {
    // `WorkspaceFS.forSession` only honours `projectPath` together with
    // `devMode`, so anything else resolves to the per-user root and must stay
    // lazily creatable.
    expect(isBorrowedProjectDir({ devMode: true })).toBe(false);
    expect(isBorrowedProjectDir({ projectPath: '/home/user/repo' })).toBe(false);
    expect(isBorrowedProjectDir({ devMode: false, projectPath: '/home/user/repo' })).toBe(false);
  });
});
