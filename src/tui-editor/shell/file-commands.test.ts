/** New file, rename, delete, revert and the watcher, on real files (docs/plans/tui-modernization.md §7, Phase 5 item 5). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Component, OverlayHandle, TUI } from '@/tui-kit';
import { BufferStore } from '../stores/buffer-store';
import { LayoutStore } from '../stores/layout-store';
import type { EditorContext } from './context';
import { FileCommands } from './file-commands';
import { FileOps } from './file-ops';
import { FileWatcher } from './file-watcher';
import { OverlaySlots } from './overlay-slots';
import type { OverlayController } from '@/tui-pi/overlays/registry';

let root: string;
let modals: Component[];
let notices: string[];
let messages: string[];
let ctx: EditorContext;
let files: FileOps;
let commands: FileCommands;
let treeChanges: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-commands-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'alpha\n');
  modals = []; notices = []; messages = []; treeChanges = 0;
  const show = (component: Component): OverlayHandle => {
    modals.push(component);
    return { hide: () => { modals = modals.filter((m) => m !== component); }, focus() {}, setHidden() {}, isHidden: () => false, unfocus() {}, isFocused: () => true } as unknown as OverlayHandle;
  };
  const controller = { showModal: show, showCommandPalette: () => show({ render: () => [], invalidate() {} }) } as unknown as OverlayController;
  const tui = { requestRender() {}, hasOverlay: () => modals.length > 0 } as unknown as TUI;
  const overlays = new OverlaySlots(controller, tui, () => {});
  ctx = {
    tui, buffers: new BufferStore(), layout: new LayoutStore(), overlays, projectPath: root,
    notice: (text) => notices.push(text), pushMessage: (_role, text) => messages.push(text), log: (text) => messages.push(text),
    refocus() {}, exiting: () => false,
  };
  files = new FileOps(ctx, () => {});
  commands = new FileCommands(ctx, files, () => { treeChanges++; }, () => {});
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const answer = (text: string) => {
  const modal = modals.at(-1);
  modal?.handleInput?.(`\x1b[200~${text}\x1b[201~`);
  modal?.handleInput?.('\r');
};
const modalText = () => (modals.at(-1)?.render(80) ?? []).join('\n').replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b_pi:\/?fc\x07/g, '');

test('a new file is created empty and opened; an existing path or a missing folder is refused in the prompt', () => {
  files.openFile(join(root, 'src', 'a.ts'));
  commands.newFile('');
  expect(modalText()).toContain(`path: src/`); // prefilled with the active file's folder
  modals.at(-1)?.handleInput?.('\x15'); // clear the field
  answer('src/a.ts');
  expect(modalText()).toContain('src/a.ts already exists.');
  modals.at(-1)?.handleInput?.('\x15');
  answer('nope/b.ts');
  expect(modalText()).toContain('The folder nope does not exist.');
  modals.at(-1)?.handleInput?.('\x15');
  answer('src/b.ts');
  expect(modals).toHaveLength(0);
  expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('');
  expect(ctx.buffers.active()?.path).toBe(join(root, 'src', 'b.ts'));
  expect(treeChanges).toBe(1);
});

test('a rename moves the file and takes its open buffer, unsaved edits included; a taken name is refused', () => {
  files.openFile(join(root, 'src', 'a.ts'));
  const rec = ctx.buffers.active();
  rec?.buffer.insert('edit ');
  writeFileSync(join(root, 'taken.ts'), '');
  commands.rename('taken.ts');
  expect(messages.at(-1)).toContain('taken.ts already exists.');
  commands.rename('src/renamed.ts');
  expect(existsSync(join(root, 'src', 'a.ts'))).toBe(false);
  expect(readFileSync(join(root, 'src', 'renamed.ts'), 'utf8')).toBe('alpha\n');
  expect(ctx.buffers.active()?.path).toBe(join(root, 'src', 'renamed.ts'));
  expect(ctx.buffers.active()?.label).toBe('renamed.ts');
  expect(ctx.buffers.active()?.buffer.text()).toBe('edit alpha\n');
  expect(ctx.buffers.active()?.dirty).toBe(true);
  // A renamed folder takes the buffers under it.
  commands.rename('lib', join(root, 'src'));
  expect(ctx.buffers.active()?.path).toBe(join(root, 'lib', 'renamed.ts'));
});

test('a delete asks first, says when the buffer has unsaved changes, and closes the tab; folders are refused', () => {
  files.openFile(join(root, 'src', 'a.ts'));
  ctx.buffers.active()?.buffer.insert('x');
  commands.delete();
  expect(modalText()).toContain('Delete src/a.ts?');
  expect(modalText()).toContain('unsaved changes');
  modals.at(-1)?.handleInput?.('\r'); // Enter cancels
  expect(existsSync(join(root, 'src', 'a.ts'))).toBe(true);
  commands.delete();
  modals.at(-1)?.handleInput?.('y');
  expect(existsSync(join(root, 'src', 'a.ts'))).toBe(false);
  expect(ctx.buffers.active()).toBeNull();
  commands.delete(join(root, 'src'));
  expect(messages.at(-1)).toContain('is a folder');
  expect(existsSync(join(root, 'src'))).toBe(true);
});

test('/revert takes the file on disk back, as one undo step', () => {
  files.openFile(join(root, 'src', 'a.ts'));
  const rec = ctx.buffers.active();
  rec?.buffer.insert('mine ');
  commands.revert();
  expect(rec?.buffer.text()).toBe('alpha\n');
  rec?.buffer.undo();
  expect(rec?.buffer.text()).toBe('mine alpha\n');
});

test('the watcher reloads a clean buffer changed on disk, and asks once about a dirty one', () => {
  const path = join(root, 'src', 'a.ts');
  files.openFile(path);
  const rec = ctx.buffers.active();
  const watcher = new FileWatcher(ctx, files);
  watcher.check();
  expect(rec?.buffer.text()).toBe('alpha\n');
  // A touch with the same content is not a change.
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  watcher.check();
  expect(notices).toEqual([]);
  writeFileSync(path, 'changed elsewhere\n');
  watcher.check();
  expect(rec?.buffer.text()).toBe('changed elsewhere\n');
  expect(rec?.dirty).toBe(false);
  expect(notices.at(-1)).toContain('changed on disk and was reloaded');
  rec?.buffer.insert('my edit ');
  writeFileSync(path, 'changed again\n');
  watcher.check();
  expect(modalText()).toContain('File changed on disk');
  modals.at(-1)?.handleInput?.('\x1b'); // keep editing
  watcher.check();
  expect(modals).toHaveLength(0); // not asked again for the same version
  expect(rec?.buffer.text()).toBe('my edit changed elsewhere\n');
  writeFileSync(path, 'a third version\n');
  watcher.check();
  modals.at(-1)?.handleInput?.('r');
  expect(rec?.buffer.text()).toBe('a third version\n');
});

test('the watcher leaves a buffer under agent review alone and reports a deleted file once', () => {
  const path = join(root, 'src', 'a.ts');
  files.openFile(path);
  const rec = ctx.buffers.active();
  if (!rec) throw new Error('not opened');
  const watcher = new FileWatcher(ctx, files);
  ctx.buffers.setAgentLocked(rec.id, true);
  writeFileSync(path, 'agent text\n');
  watcher.check();
  expect(rec.buffer.text()).toBe('alpha\n');
  ctx.buffers.setAgentLocked(rec.id, false);
  rmSync(path);
  watcher.check(); watcher.check();
  expect(notices.filter((n) => n.includes('was deleted on disk'))).toHaveLength(1);
});
