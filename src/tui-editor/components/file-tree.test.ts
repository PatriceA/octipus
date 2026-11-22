import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { FileTree } from './file-tree';

let root: string;
let opened: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-tree-'));
  for (const dir of ['src/lib', 'node_modules/pkg']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['README.md', 'src/app.ts', 'src/lib/util.ts', 'node_modules/pkg/index.js']) writeFileSync(join(root, file), '');
  opened = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
function tree() {
  const t = new FileTree({ root, onOpen: (p) => opened.push(p) });
  t.focused = true;
  t.setHeight(10);
  return t;
}
const rows = (t: FileTree) => t.render(40).map(strip).filter(Boolean);

test('shows the root expanded and its entries collapsed, skipping node_modules', () => {
  const lines = rows(tree());
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain('README.md');
  expect(lines[2]).toMatch(/▸ .*src/);
  expect(lines.join('\n')).not.toContain('node_modules');
});

test('Right expands a folder, Left collapses it, Enter toggles it', () => {
  const t = tree();
  t.handleInput('\x1b[B'); t.handleInput('\x1b[B'); // to src
  t.handleInput('\x1b[C');
  expect(rows(t).some((l) => l.includes('app.ts'))).toBe(true);
  t.handleInput('\x1b[D');
  expect(rows(t).some((l) => l.includes('app.ts'))).toBe(false);
  t.handleInput('\r');
  expect(rows(t).some((l) => l.includes('lib'))).toBe(true);
});

test('Enter on a file opens it; Left on a child jumps to its folder', () => {
  const t = tree();
  t.handleInput('\x1b[B'); t.handleInput('\x1b[B'); t.handleInput('\x1b[C'); // expand src
  t.handleInput('\x1b[B'); // src/app.ts (files and folders sort by name)
  t.handleInput('\r');
  expect(opened).toEqual([join(root, 'src', 'app.ts')]);
  t.handleInput('\x1b[D');
  t.handleInput('\r'); // collapses src: the selection moved to it
  expect(rows(t).some((l) => l.includes('app.ts'))).toBe(false);
});

test('scrolls to keep the selection in view and pads to its height', () => {
  for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), '');
  const t = tree();
  t.setHeight(5);
  t.handleInput('\x1b[F'); // End
  const lines = t.render(40).map(strip);
  expect(lines).toHaveLength(5);
  expect(lines.at(-1)).toContain('src');
});

test('a file name with control characters cannot move the terminal cursor', () => {
  writeFileSync(join(root, 'bad\x1b[2Jname'), '');
  for (const line of tree().render(60)) expect(line.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x1f]/);
});
