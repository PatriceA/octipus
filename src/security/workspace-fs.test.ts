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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_PRINCIPAL, principalFromUser } from './principal';
import { WorkspaceFS, WorkspaceFsError } from './workspace-fs';

let dataRoot: string;
let aliceFs: WorkspaceFS;
let bobFs: WorkspaceFS;

const aliceP = principalFromUser({ id: 'alice-uuid', username: 'alice', isAdmin: false });
const bobP = principalFromUser({ id: 'bob-uuid', username: 'bob', isAdmin: false });

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

  test('roots respect the workspaceId option', () => {
    const f1 = WorkspaceFS.forPrincipal(aliceP, { dataRoot, workspaceId: 'project-x' });
    expect(f1.root).toContain('project-x');
    expect(f1.root).not.toBe(aliceFs.root);
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
    // Create alice/files/escape -> /etc
    const linkPath = join(aliceFs.root, 'escape');
    try {
      symlinkSync('/etc', linkPath);
    } catch (err) {
      // Some sandboxes disallow symlink creation; skip.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    expect(() => aliceFs.resolve('escape/passwd')).toThrow(WorkspaceFsError);
  });

  test('symlink within the workspace is allowed', () => {
    mkdirSync(join(aliceFs.root, 'real'), { recursive: true });
    writeFileSync(join(aliceFs.root, 'real', 'data.txt'), 'hi');
    const linkPath = join(aliceFs.root, 'lnk');
    try { symlinkSync(join(aliceFs.root, 'real'), linkPath); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    const out = aliceFs.resolve('lnk/data.txt');
    expect(out).toContain('real/data.txt');
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
});
