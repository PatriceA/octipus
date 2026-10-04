/**
 * WorkspaceFS — path resolution + cross-tenant isolation.
 *
 * These tests exercise the safety properties of the resolver:
 *   - traversal (`..`) escapes are rejected
 *   - absolute paths outside the root are rejected
 *   - symlink escapes are rejected
 *   - alice's and bob's resolved paths live in disjoint trees
 *
 * The fixture seeds two principals and an ephemeral data root in
 * `tmpdir`. No DB, no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import pathMod, { join } from 'node:path';
import { ANONYMOUS_PRINCIPAL, principalFromUser } from './principal';
import type { AgentContext } from '@/core/types';
import { isInside, noteWorkspaceRows, swapDefaultWorkspaceFiles, WorkspaceFS, WorkspaceFsError } from './workspace-fs';

let dataRoot: string;
let aliceFs: WorkspaceFS;
let bobFs: WorkspaceFS;

const aliceP = principalFromUser({ id: 'alice-uuid', username: 'alice', isAdmin: false });
const bobP = principalFromUser({ id: 'bob-uuid', username: 'bob', isAdmin: false });
const ALICE_DEFAULT_WS = '11111111-0000-4000-8000-000000000001';
const ALICE_OTHER_WS = '11111111-0000-4000-8000-000000000002';

function agentCtx(userId: string, workspaceId: string | null = null): AgentContext {
  const now = new Date();
  return {
    id: 'agent-1', sessionId: 'session-1', userId, workspaceId, topic: 'general', model: '', role: 'general',
    status: 'running', createdAt: now, updatedAt: now, metadata: {},
  };
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'octipus-wfs-'));

  aliceFs = WorkspaceFS.forPrincipal(aliceP, { dataRoot });
  bobFs = WorkspaceFS.forPrincipal(bobP, { dataRoot });
  await aliceFs.ensureRoot();
  await bobFs.ensureRoot();
});

afterAll(() => { /* dataRoot is in tmpdir; OS reaps */ });

describe('WorkspaceFS construction', () => {
  test('throws for anonymous principal', () => {
    expect(() => WorkspaceFS.forPrincipal(ANONYMOUS_PRINCIPAL, { dataRoot }))
      .toThrow(WorkspaceFsError);
  });

  test('roots are deterministic and disjoint per user', () => {
    expect(aliceFs.root).not.toBe(bobFs.root);
    expect(aliceFs.root).toContain('alice-uuid');
    expect(bobFs.root).toContain('bob-uuid');
  });

  test("a non-default workspace gets its id as the segment; the default keeps 'default'", () => {
    noteWorkspaceRows([
      { id: ALICE_DEFAULT_WS, userId: 'alice-uuid', isDefault: true },
      { id: ALICE_OTHER_WS, userId: 'alice-uuid', isDefault: false },
    ]);
    const other = WorkspaceFS.forPrincipal({ ...aliceP, workspaceId: ALICE_OTHER_WS }, { dataRoot });
    expect(other.root).toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', ALICE_OTHER_WS, 'files'));
    const def = WorkspaceFS.forPrincipal({ ...aliceP, workspaceId: ALICE_DEFAULT_WS }, { dataRoot });
    expect(def.root).toBe(aliceFs.root);
    expect(aliceFs.root).toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', 'default', 'files'));
  });

  test("an unknown workspace, or another user's, throws instead of guessing", () => {
    expect(() => WorkspaceFS.forPrincipal({ ...aliceP, workspaceId: '99999999-0000-4000-8000-000000000000' }, { dataRoot }))
      .toThrow(WorkspaceFsError);
    expect(() => WorkspaceFS.forPrincipal({ ...bobP, workspaceId: ALICE_OTHER_WS }, { dataRoot }))
      .toThrow(WorkspaceFsError);
  });
});

describe('WorkspaceFS.resolve — relative paths', () => {
  test('relative path lands inside the root', () => {
    const out = aliceFs.resolve('foo/bar.txt');
    expect(out.startsWith(aliceFs.root)).toBe(true);
  });

  test('empty / "." resolves to the root itself', () => {
    expect(aliceFs.resolve('')).toBe(aliceFs.root);
    expect(aliceFs.resolve('.')).toBe(aliceFs.root);
  });

  test('nested ".." inside the workspace is OK as long as the result stays under root', () => {
    // foo/../bar normalizes to bar
    const out = aliceFs.resolve('foo/../bar');
    expect(out).toBe(join(aliceFs.root, 'bar'));
  });
});

describe('WorkspaceFS.resolve — escape attempts', () => {
  test('parent traversal is rejected', () => {
    expect(() => aliceFs.resolve('../../../etc/passwd')).toThrow(WorkspaceFsError);
  });

  test('absolute paths outside the root are rejected', () => {
    expect(() => aliceFs.resolve('/etc/passwd')).toThrow(WorkspaceFsError);
    expect(() => aliceFs.resolve('/tmp/random')).toThrow(WorkspaceFsError);
  });

  test('absolute path inside the root is allowed', () => {
    const inside = join(aliceFs.root, 'inside.txt');
    expect(aliceFs.resolve(inside)).toBe(inside);
  });

  test('null byte is rejected', () => {
    expect(() => aliceFs.resolve('foo\0.txt')).toThrow(WorkspaceFsError);
  });

  test('non-string input is rejected', () => {
    // @ts-expect-error — runtime guard
    expect(() => aliceFs.resolve(null)).toThrow(WorkspaceFsError);
    // @ts-expect-error — runtime guard
    expect(() => aliceFs.resolve(undefined)).toThrow(WorkspaceFsError);
  });
});

describe('WorkspaceFS.resolve — symlink escape', () => {
  test('symlink pointing outside the root is rejected', () => {
    // Pick an out-of-root anchor that actually exists on the host so the
    // symlink resolves on every platform. The previous version hard-coded
    // `/etc`, which doesn't exist on Windows — the symlink got created
    // anyway (Node defaults to a file-typed link) but failed to follow on
    // resolve, so the test passed through without exercising the escape
    // path it was meant to check. tmpdir() is always present and is
    // guaranteed to live outside aliceFs.root.
    const outsideTarget = tmpdir();
    const linkPath = join(aliceFs.root, 'escape');
    try {
      symlinkSync(outsideTarget, linkPath, 'dir');
    } catch (err) {
      // Some sandboxes (and Windows without Developer Mode + admin) disallow
      // symlink creation; skip in that case.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }

    expect(() => aliceFs.resolve('escape/anything')).toThrow(WorkspaceFsError);
  });

  test('symlink within the workspace is allowed', () => {
    mkdirSync(join(aliceFs.root, 'real'), { recursive: true });
    writeFileSync(join(aliceFs.root, 'real', 'data.txt'), 'hi');
    const linkPath = join(aliceFs.root, 'lnk');
    try { symlinkSync(join(aliceFs.root, 'real'), linkPath, 'dir'); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }

    const out = aliceFs.resolve('lnk/data.txt');
    // Compare via `join` so the assertion works on both Windows
    // (`real\data.txt`) and POSIX (`real/data.txt`).
    expect(out).toContain(join('real', 'data.txt'));
  });
});

describe('WorkspaceFS — cross-tenant disjoint paths', () => {
  test('alice and bob resolve "foo" to different absolute paths', () => {
    expect(aliceFs.resolve('foo')).not.toBe(bobFs.resolve('foo'));
  });

  test('alice cannot reach into bob’s root by traversal', () => {
    // bobFs.root is something like .../users/bob-uuid/workspaces/default/files
    // The relative path from alice.root to bob.root is many `..` ups.
    const traversal = '../../../../bob-uuid/workspaces/default/files/secret';
    expect(() => aliceFs.resolve(traversal)).toThrow(WorkspaceFsError);
  });
});

describe('WorkspaceFS.resolveOptional', () => {
  test('returns null on traversal instead of throwing', () => {
    expect(aliceFs.resolveOptional('../../etc/passwd')).toBeNull();
  });

  test('returns the resolved path on success', () => {
    const out = aliceFs.resolveOptional('hello.txt');
    expect(out).toBe(join(aliceFs.root, 'hello.txt'));
  });
});

describe('WorkspaceFS.extraAllowedPrefixes', () => {
  test('paths under an extra-allowed prefix are accepted', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'octipus-extra-'));
    const fs = WorkspaceFS.forPrincipal(aliceP, {
      dataRoot,
      extraAllowedPrefixes: [tmp],
    });
    const inside = join(tmp, 'transient.txt');
    expect(fs.resolve(inside)).toBe(inside);
  });

  test('paths outside the extra-allowed prefix still fail', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'octipus-extra-2-'));
    const fs = WorkspaceFS.forPrincipal(aliceP, {
      dataRoot,
      extraAllowedPrefixes: [tmp],
    });
    expect(() => fs.resolve('/etc/passwd')).toThrow(WorkspaceFsError);
  });

  test('legacy "/tmp/assistant-" string-prefix is accepted (filesystem-tool back-compat)', () => {
    // The pre-Phase-1b validatePath did `realPath.startsWith('/tmp/assistant-')`
    // — a literal string prefix, not a directory match. Operators rely on
    // this for transient session artifacts whose path encodes the session
    // id directly (`/tmp/assistant-abc123/...`). WorkspaceFS preserves that
    // semantics via the dual match in `isInExtraAllowed`.
    const fs = WorkspaceFS.withRoot(dataRoot, {
      extraAllowedPrefixes: ['/tmp/assistant-'],
    });
    expect(fs.resolveOptional('/tmp/assistant-foo/transient')).not.toBeNull();
    // …but a plain `/tmp/foo` is still rejected.
    expect(fs.resolveOptional('/tmp/foo')).toBeNull();
  });
});

describe('WorkspaceFS.withRoot — flat single-user mode', () => {
  test('flat root accepts relative + absolute paths under it', () => {
    const fs = WorkspaceFS.withRoot(dataRoot);
    expect(fs.resolve('a/b.txt')).toBe(join(dataRoot, 'a/b.txt'));
    expect(fs.resolve(join(dataRoot, 'inside.txt'))).toBe(join(dataRoot, 'inside.txt'));
  });

  test('flat root rejects escapes', () => {
    const fs = WorkspaceFS.withRoot(dataRoot);
    expect(() => fs.resolve('../../etc/passwd')).toThrow(WorkspaceFsError);
    expect(() => fs.resolve('/etc/passwd')).toThrow(WorkspaceFsError);
  });
});

describe('WorkspaceFS.forAgent — user workspaces and system jobs', () => {
  test('a user path never gets the flat root: sentinel or missing users throw', () => {
    for (const userId of ['system', 'local', '']) {
      expect(() => WorkspaceFS.forAgent(agentCtx(userId), { dataRoot })).toThrow(WorkspaceFsError);
    }
  });

  test('a system job gets exactly the root it names, and must name one', () => {
    expect(WorkspaceFS.forAgent({ system: true, root: dataRoot }).root).toBe(dataRoot);
    expect(() => WorkspaceFS.forAgent({ system: true, root: '' })).toThrow(WorkspaceFsError);
  });

  test("an agent without a workspace gets the user's default root", () => {
    expect(WorkspaceFS.forAgent(agentCtx('alice-uuid'), { dataRoot }).root)
      .toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', 'default', 'files'));
  });

  test("an agent in a non-default workspace gets that workspace's root", () => {
    noteWorkspaceRows([{ id: ALICE_OTHER_WS, userId: 'alice-uuid', isDefault: false }]);
    expect(WorkspaceFS.forAgent(agentCtx('alice-uuid', ALICE_OTHER_WS), { dataRoot }).root)
      .toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', ALICE_OTHER_WS, 'files'));
  });
});

describe('swapDefaultWorkspaceFiles — files follow their workspace when the default moves', () => {
  test("the old default's files move to its id, the new default's to 'default'", () => {
    const root = mkdtempSync(join(tmpdir(), 'octipus-wfs-swap-'));
    const base = join(root, 'users', 'carol', 'workspaces');
    mkdirSync(join(base, 'default', 'files'), { recursive: true });
    writeFileSync(join(base, 'default', 'files', 'old.txt'), 'old default');
    mkdirSync(join(base, ALICE_OTHER_WS, 'files'), { recursive: true });
    writeFileSync(join(base, ALICE_OTHER_WS, 'files', 'new.txt'), 'new default');

    swapDefaultWorkspaceFiles('carol', ALICE_DEFAULT_WS, ALICE_OTHER_WS, root);

    expect(readFileSync(join(base, ALICE_DEFAULT_WS, 'files', 'old.txt'), 'utf8')).toBe('old default');
    expect(readFileSync(join(base, 'default', 'files', 'new.txt'), 'utf8')).toBe('new default');
    expect(existsSync(join(base, ALICE_OTHER_WS))).toBe(false);
  });
});

describe('WorkspaceFS.forSession — read-back root matches the agent cwd (P1.8)', () => {
  test("a session in a non-default workspace reads back that workspace's root", () => {
    noteWorkspaceRows([{ id: ALICE_OTHER_WS, userId: 'alice-uuid', isDefault: false }]);
    const fs = WorkspaceFS.forSession({ userId: 'alice-uuid', workspaceId: ALICE_OTHER_WS, context: {} }, { dataRoot });
    expect(fs.root).toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', ALICE_OTHER_WS, 'files'));
  });

  test('dev-mode session with projectPath roots at the project dir', () => {
    const fs = WorkspaceFS.forSession({
      userId: 'alice-uuid',
      context: { devMode: true, projectPath: dataRoot },
    });
    expect(fs.root).toBe(dataRoot);
  });

  test('devMode without projectPath falls back to the user workspace', () => {
    const fs = WorkspaceFS.forSession(
      { userId: 'alice-uuid', context: { devMode: true } },
      { dataRoot },
    );
    expect(fs.root)
      .toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', 'default', 'files'));
  });

  test('projectPath without devMode is ignored (mirrors cli-agent-worker)', () => {
    const fs = WorkspaceFS.forSession(
      { userId: 'alice-uuid', context: { projectPath: '/somewhere/else' } },
      { dataRoot },
    );
    expect(fs.root)
      .toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', 'default', 'files'));
  });

  test('non-dev session gets the per-user nested root', () => {
    const fs = WorkspaceFS.forSession(
      { userId: 'alice-uuid', context: {} },
      { dataRoot },
    );
    expect(fs.root)
      .toBe(join(dataRoot, 'users', 'alice-uuid', 'workspaces', 'default', 'files'));
  });
});

describe('isInside', () => {
  test('win32: case-insensitive, segment-bounded, cross-drive', () => {
    const w = pathMod.win32;
    expect(isInside('C:\\Users\\Me\\ws', 'c:\\users\\me\\ws\\a.txt', w)).toBe(true);
    expect(isInside('C:\\ws', 'C:\\ws', w)).toBe(true);
    expect(isInside('C:\\ws', 'C:\\ws2\\a.txt', w)).toBe(false);
    expect(isInside('C:\\ws', 'C:\\ws\\..\\x', w)).toBe(false);
    expect(isInside('C:\\ws', 'D:\\ws\\a.txt', w)).toBe(false);
  });

  test('a child dir literally named "..foo" is inside', () => {
    expect(isInside('/a', '/a/..foo/b', pathMod.posix)).toBe(true);
    expect(isInside('/a', '/b', pathMod.posix)).toBe(false);
  });
});

describe('WorkspaceFS with a linked root', () => {
  test('junction/symlinked root still resolves files inside it', () => {
    const base = mkdtempSync(join(tmpdir(), 'octipus-wfs-link-'));
    const target = join(base, 'real');
    mkdirSync(target);
    writeFileSync(join(target, 'a.txt'), 'x');
    const link = join(base, 'link');
    symlinkSync(target, link, 'junction'); // type ignored off Windows
    const fs = WorkspaceFS.withRoot(link);
    expect(fs.resolve('a.txt')).toBe(realpathSync(join(target, 'a.txt')));
    expect(() => fs.resolve('new/b.txt')).not.toThrow();
    // Paths returned by read/write tools must work as input to the next tool.
    for (const input of ['a.txt', 'new/b.txt', '.']) {
      const canonical = fs.resolve(input);
      expect(fs.resolve(canonical)).toBe(canonical);
    }

    const outside = join(base, 'real-sibling');
    mkdirSync(outside);
    symlinkSync(outside, join(target, 'escape'), 'junction');
    expect(() => fs.resolve(join(outside, 'a.txt'))).toThrow(/outside workspace/);
    expect(() => fs.resolve('escape/a.txt')).toThrow(/outside workspace via symlink/);
    expect(() => fs.resolve(join(realpathSync(target), 'escape/a.txt'))).toThrow(/outside workspace via symlink/);
  });
});

describe('every forAgent caller passes the agent context', () => {
  // Building it from a bare user id dropped the agent's workspace and filed its files
  // in the default one. Pass the AgentContext (or `{ system: true, root }`);
  // a surface without an agent uses `forPrincipal` / `forRequest` /
  // `forSession`. Built from parts so this file does not match itself.
  test('no source file builds a WorkspaceFS from a bare user id', () => {
    const pattern = new RegExp(['forAgent', '\\(\\s*\\{\\s*userId'].join(''));
    const srcRoot = pathMod.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && pattern.test(readFileSync(full, 'utf8'))) {
          offenders.push(pathMod.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
