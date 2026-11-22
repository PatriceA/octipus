/** The watcher's reads of a changed file, on real files. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TUI } from '@/tui-kit';
import { BufferStore } from '../stores/buffer-store';
import { LayoutStore } from '../stores/layout-store';
import type { EditorContext } from './context';
import { FileOps } from './file-ops';
import { FileWatcher } from './file-watcher';
import { OverlaySlots } from './overlay-slots';
import { PendingPrompts } from './pending-prompts';
import type { OverlayController } from '@/tui-pi/overlays/registry';

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../workspace-fs-bridge', async (original) => {
  const actual = await original<typeof import('../workspace-fs-bridge')>();
  return { ...actual, readFileForBuffer: (path: string) => { reads.count++; return actual.readFileForBuffer(path); } };
});

let root: string;
let ctx: EditorContext;
let files: FileOps;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-watcher-'));
  const tui = { requestRender() {}, hasOverlay: () => false } as unknown as TUI;
  const overlays = new OverlaySlots({} as OverlayController, tui, () => {});
  ctx = {
    tui, buffers: new BufferStore(), layout: new LayoutStore(), overlays, pending: new PendingPrompts(), projectPath: root,
    notice() {}, pushMessage() {}, log() {}, refocus() {}, exiting: () => false,
  };
  files = new FileOps(ctx, () => {});
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// A clean log appended to every second was read three times per check (compare, catch-up, reload).
test('a clean file that changed is read once per check, and that read is the reload', () => {
  const path = join(root, 'app.log');
  writeFileSync(path, 'one\n');
  files.openFile(path);
  const watcher = new FileWatcher(ctx, files);
  writeFileSync(path, 'one\ntwo\n');
  reads.count = 0;
  watcher.check();
  expect(reads.count).toBe(1);
  expect(ctx.buffers.active()?.buffer.text()).toBe('one\ntwo\n');
  reads.count = 0;
  watcher.check();
  expect(reads.count).toBe(0);
});
