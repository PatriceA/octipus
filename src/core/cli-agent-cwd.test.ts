import { describe, expect, test } from 'vitest';
import { isBorrowedProjectDir } from './cli-agent-worker';

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
