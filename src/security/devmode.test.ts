/**
 * devMode authorization policy.
 *
 * devMode/projectPath let the caller point the agent's filesystem tools at an
 * arbitrary host path — a sandbox escape for a non-admin. Octipus is always
 * multi-user, so it is an admin-only capability regardless of config.
 *
 * Admin-ness is necessary but not sufficient: the path must also be a real
 * directory that isn't a system directory.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkProjectPath, devModeAllowed } from './devmode';

describe('devModeAllowed', () => {
  test('allowed only for admins', () => {
    expect(devModeAllowed(true)).toBe(true);
    expect(devModeAllowed(false)).toBe(false);
  });

  test('a valid path does not rescue a non-admin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmode-'));
    try {
      expect(devModeAllowed(false, dir)).toBe(false);
      expect(devModeAllowed(true, dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('admin-ness does not rescue a bad path', () => {
    // The exact scenario devmode.ts names as its threat model.
    expect(devModeAllowed(true, '/etc')).toBe(false);
  });
});

describe('checkProjectPath', () => {
  test('accepts a real directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmode-'));
    try {
      expect(checkProjectPath(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects system directories and their descendants', () => {
    for (const p of ['/etc', '/etc/ssh', '/proc', '/sys/kernel', '/root', '/usr/bin', '/var/lib']) {
      expect(checkProjectPath(p).ok).toBe(false);
    }
  });

  test('rejects traversal that resolves into a system directory', () => {
    expect(checkProjectPath('/home/../etc').ok).toBe(false);
  });

  test('rejects a symlink pointing into a system directory', () => {
    // path.resolve() is lexical and does NOT follow links, so a denylist
    // checked against it alone is trivially bypassed by `ln -s /etc project`.
    const dir = mkdtempSync(join(tmpdir(), 'devmode-'));
    const link = join(dir, 'innocent-looking-project');
    symlinkSync('/etc', link);
    try {
      const res = checkProjectPath(link);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('system directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects the filesystem root', () => {
    expect(checkProjectPath('/').ok).toBe(false);
  });

  test('rejects a non-existent path', () => {
    expect(checkProjectPath('/home/definitely-not-a-real-project-xyz').ok).toBe(false);
  });

  test('rejects a file — existsSync alone would pass this', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmode-'));
    const file = join(dir, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    try {
      const res = checkProjectPath(file);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('not a directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects relative and empty paths', () => {
    expect(checkProjectPath('relative/path').ok).toBe(false);
    expect(checkProjectPath('   ').ok).toBe(false);
  });
});
