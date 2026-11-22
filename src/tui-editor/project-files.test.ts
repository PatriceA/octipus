import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { indexProjectFiles, listFolder } from './project-files';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'project-files-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function files(paths: Record<string, string>): void {
  for (const [rel, text] of Object.entries(paths)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const rel = (abs: string[]) => abs.map((p) => p.slice(root.length + 1)).sort();

describe('indexProjectFiles', () => {
  test('in a git work tree: tracked and untracked files, not what .gitignore excludes', async () => {
    files({ '.gitignore': 'out/\n*.log\n', 'src/a.ts': '', 'untracked.md': '', 'out/build.js': '', 'debug.log': '' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q'); git('add', '.gitignore', 'src/a.ts');
    const index = await indexProjectFiles(root);
    expect(index.source).toBe('git');
    expect(rel(index.files)).toEqual(['.gitignore', 'src/a.ts', 'untracked.md']);
  });

  test('a tracked file deleted from the work tree is not listed', async () => {
    files({ 'keep.ts': '', 'gone.ts': '' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q'); git('add', '.');
    rmSync(join(root, 'gone.ts'));
    expect(rel((await indexProjectFiles(root)).files)).toEqual(['keep.ts']);
  });

  test('outside git: a walk that skips the same folders as the tree, with no depth or count cliff at 1,000', async () => {
    const many: Record<string, string> = { 'node_modules/x/index.js': '', '.git-not/real.txt': '' };
    for (let i = 0; i < 1200; i++) many[`gen/${String(i).padStart(4, '0')}.txt`] = '';
    many['a/b/c/d/e/f/g/h/deep.ts'] = '';
    files(many);
    const index = await indexProjectFiles(root);
    expect(index.source).toBe('walk');
    expect(index.truncated).toBe(false);
    const names = rel(index.files);
    expect(names).toHaveLength(1202);
    expect(names).toContain('a/b/c/d/e/f/g/h/deep.ts');
    expect(names.some((n) => n.startsWith('node_modules/'))).toBe(false);
  });
});

describe('listFolder', () => {
  test('one folder, sorted, skipped folders left out, folders marked', () => {
    files({ 'b.txt': '', 'a/x.ts': '', 'dist/out.js': '' });
    expect(listFolder(root).entries.map((e) => [e.name, e.isDir])).toEqual([['a', true], ['b.txt', false]]);
  });
});
