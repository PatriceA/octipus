/**
 * Errors the editor used to swallow (`catch {}`): an unreadable folder in
 * the tree and the file index, an unreadable file in the fallback project
 * search and its preview. Each is either an expected code handled on
 * purpose (a file removed since it was listed, a dangling symlink) or said.
 *
 * Root reads anything, so the refusals are injected into real files.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const denied = vi.hoisted(() => ({ paths: new Set<string>() }));
const refuse = (path: unknown) => {
  if (denied.paths.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: 'EACCES' });
};
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((path: fs.PathLike, options?: never) => { refuse(path); return actual.readdirSync(path, options); }) as typeof fs.readdirSync,
    readFileSync: ((path: fs.PathOrFileDescriptor, options?: never) => { refuse(path); return actual.readFileSync(path, options); }) as typeof fs.readFileSync,
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (path: fs.PathLike, options?: never) => { refuse(path); return actual.readdir(path, options); }) as typeof fsp.readdir,
    readFile: (async (path: fs.PathLike, options?: never) => { refuse(path); return actual.readFile(path, options); }) as typeof fsp.readFile,
  };
});

const { indexProjectFiles, listFolder } = await import('./project-files');
const { searchProject } = await import('./project-search');
const { FileTree } = await import('./components/file-tree');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'reported-errors-'));
  fs.mkdirSync(join(root, 'locked'));
  fs.writeFileSync(join(root, 'locked', 'inside.ts'), 'needle');
  fs.writeFileSync(join(root, 'secret.ts'), 'needle');
  fs.writeFileSync(join(root, 'open.ts'), 'needle');
  fs.symlinkSync(join(root, 'nowhere'), join(root, 'dangling.ts'));
  denied.paths.clear();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('a folder that cannot be read says so in the tree; a dangling symlink and a vanished folder are left out quietly', () => {
  denied.paths.add(join(root, 'locked'));
  expect(listFolder(join(root, 'locked'))).toEqual({ entries: [], error: 'cannot read this folder: permission denied' });
  expect(listFolder(join(root, 'gone'))).toEqual({ entries: [], error: null });
  expect(listFolder(root).entries.map((e) => e.name)).toEqual(['locked', 'open.ts', 'secret.ts']);
  const tree = new FileTree({ root, onOpen: () => {} });
  tree.handleInput('\x1b[B'); // to "locked"
  tree.handleInput('\r'); // expand it
  expect(tree.render(60).join('\n').replace(/\x1b\[[0-9;]*m/g, '')).toContain('⚠ cannot read this folder: permission denied');
});

test('the walk reports the folders it could not read; the fallback search counts the files it could not read', async () => {
  denied.paths.add(join(root, 'locked'));
  denied.paths.add(join(root, 'secret.ts'));
  const index = await indexProjectFiles(root);
  expect(index.source).toBe('walk');
  expect(index.unreadable).toEqual([join(root, 'locked')]);
  const hits: string[] = [];
  const done = await searchProject(root, 'needle', { rg: null }, (batch) => hits.push(...batch.map((h) => h.path))).done;
  expect(hits).toEqual([join(root, 'open.ts')]);
  expect(done.unreadable).toBe(2); // the folder and the file
});
