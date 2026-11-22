/**
 * Saving when the atomic rename cannot be used, on real files with the
 * refusal injected: the temporary file cannot be given the original's owner
 * (EPERM: not root, not the owner), or cannot be created in the folder
 * (EACCES: a writable file in a read-only folder). Both write the file in
 * place, where it keeps its owner, instead of failing or changing it.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const inject = vi.hoisted(() => ({ chown: null as string | null, createTemp: null as string | null, owner: null as { uid: number; gid: number } | null }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const fail = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
  return {
    ...actual,
    fchownSync: (fd: number, uid: number, gid: number) => { if (inject.chown) throw fail(inject.chown); return actual.fchownSync(fd, uid, gid); },
    // The file's owner as the save sees it: someone else.
    statSync: ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stat = actual.statSync(path, options) as fs.Stats;
      return inject.owner && String(path).endsWith('f.txt') ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, inject.owner) : stat;
    }) as typeof fs.statSync,
    openSync: ((path: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (inject.createTemp && String(path).endsWith('.octipus-save')) throw fail(inject.createTemp);
      return actual.openSync(path, flags, mode);
    }) as typeof fs.openSync,
  };
});

const { readFileForBuffer, writeFileForBuffer } = await import('./workspace-fs-bridge');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'fs-bridge-fallback-')); inject.chown = null; inject.createTemp = null; inject.owner = null; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function setup(): { path: string; disk: Parameters<typeof writeFileForBuffer>[2]; ino: number } {
  const path = join(dir, 'f.txt');
  fs.writeFileSync(path, 'one');
  fs.chmodSync(path, 0o640);
  const r = readFileForBuffer(path);
  if (!r.ok) throw new Error(r.error);
  return { path, disk: r.disk, ino: fs.lstatSync(path).ino };
}

test('the owner cannot be kept (EPERM): written in place, the same file, no temporary left', () => {
  const { path, disk, ino } = setup();
  inject.owner = { uid: 4321, gid: 4322 };
  inject.chown = 'EPERM';
  expect(writeFileForBuffer(path, 'two', disk).ok).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe('two');
  expect(fs.lstatSync(path).ino).toBe(ino); // not replaced by a rename
  expect(fs.lstatSync(path).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(dir)).toEqual(['f.txt']);
});

test('the temporary file cannot be created (EACCES): written in place', () => {
  const { path, disk, ino } = setup();
  inject.createTemp = 'EACCES';
  expect(writeFileForBuffer(path, 'two', disk).ok).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe('two');
  expect(fs.lstatSync(path).ino).toBe(ino);
});

test('a new file in a folder that refuses it is still an error, not a silent success', () => {
  inject.createTemp = 'EACCES';
  const result = writeFileForBuffer(join(dir, 'new.txt'), 'x', null);
  expect(result).toEqual({ ok: false, error: `Cannot save ${join(dir, 'new.txt')}: permission denied.` });
});

test('the same owner: renamed into place atomically, as before', () => {
  const { path, disk, ino } = setup();
  expect(writeFileForBuffer(path, 'two', disk).ok).toBe(true);
  expect(fs.lstatSync(path).ino).not.toBe(ino);
  expect(fs.lstatSync(path).mode & 0o777).toBe(0o640);
});
