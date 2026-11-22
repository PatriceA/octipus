/** New file, rename, delete, revert and the watcher, on real files (docs/plans/tui-modernization.md §7, Phase 5 item 5). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Component, OverlayHandle, TUI } from '@/tui-kit';
import { installEditorKeybindings } from '../keybindings';
import { BufferStore } from '../stores/buffer-store';
import { LayoutStore } from '../stores/layout-store';
import type { EditorContext } from './context';
import { AgentReview } from './agent-review';
import { FileCommands } from './file-commands';
import { FileOps } from './file-ops';
import { FileWatcher } from './file-watcher';
import { PendingPrompts } from './pending-prompts';
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
  installEditorKeybindings({});
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
    tui, buffers: new BufferStore(), layout: new LayoutStore(), overlays, pending: new PendingPrompts(), projectPath: root,
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

test('the watcher reloads a clean buffer changed on disk; about a dirty one it waits for the resolve key, without taking focus or the tab', () => {
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
  // The user is typing in another tab: a prompt must not take the keyboard or the tab.
  writeFileSync(join(root, 'src', 'b.ts'), 'bravo\n');
  files.openFile(join(root, 'src', 'b.ts'));
  const typing = ctx.buffers.active();
  writeFileSync(path, 'changed again\n');
  watcher.check();
  expect(modals).toHaveLength(0);
  expect(ctx.buffers.active()).toBe(typing);
  expect(ctx.pending.summary()).toContain('a.ts changed on disk — press alt+y to resolve');
  ctx.pending.openNext();
  expect(modalText()).toContain('File changed on disk');
  modals.at(-1)?.handleInput?.('\x1b'); // keep editing
  expect(ctx.pending.summary()).toBeNull();
  watcher.check();
  expect(modals).toHaveLength(0); // not asked again for the same version
  expect(ctx.pending.summary()).toBeNull();
  expect(rec?.buffer.text()).toBe('my edit changed elsewhere\n');
  writeFileSync(path, 'a third version\n');
  watcher.check();
  expect(modals).toHaveLength(0);
  // Saving that buffer is the other way the question opens.
  if (rec) files.saveBuffer(rec.id);
  expect(modalText()).toContain('File changed on disk');
  modals.at(-1)?.handleInput?.('r');
  expect(rec?.buffer.text()).toBe('a third version\n');
  expect(ctx.pending.summary()).toBeNull();
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

// agent.write arrives before the tool writes the file: the review is done against the old file, and the
// watcher then saw a clean buffer change on disk and reloaded the agent's text, undoing the rejection.
test('rejecting an agent edit is not undone when the agent writes the file afterwards: the rejected text becomes the baseline, the user keeps theirs', () => {
  const path = join(root, 'src', 'a.ts');
  files.openFile(path);
  const id = ctx.buffers.active()?.id ?? '';
  const review = new AgentReview(ctx, files);
  const watcher = new FileWatcher(ctx, files, review);
  review.handleWrite(path, 'agent version\n');
  ctx.pending.openNext();
  modals.at(-1)?.handleInput?.('r'); // reject every hunk
  expect(ctx.buffers.byId(id)?.buffer.text()).toBe('alpha\n');
  expect(ctx.buffers.byId(id)?.dirty).toBe(false);
  writeFileSync(path, 'agent version\n'); // the tool's write lands now
  watcher.check();
  const rec = ctx.buffers.byId(id);
  expect(rec?.buffer.text()).toBe('alpha\n');
  expect(rec?.dirty).toBe(true);
  expect(rec?.savedText).toBe('agent version\n');
  expect(notices.at(-1)).toContain('which you rejected');
  // Only that text: a later change on disk reloads the (still clean-against-it) buffer as usual.
  if (rec) files.saveBuffer(rec.id);
  expect(readFileSync(path, 'utf8')).toBe('alpha\n');
  writeFileSync(path, 'agent version\n');
  watcher.check();
  expect(ctx.buffers.byId(id)?.buffer.text()).toBe('agent version\n');
});
