/** The mouse across the editor's panes (docs/plans/tui-modernization.md §7, Phase 5 item 1). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from '@/tui-kit';
import { LayoutStore } from '../stores/layout-store';
import { ChatPane } from './chat-pane';
import { FileTree } from './file-tree';
import { SplitPane } from './split-pane';

const event = (type: TuiMouseEvent['type'], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent =>
  ({ type, button: type === 'wheel' ? 'none' : 'left', x, y, screenX: x, screenY: y, width: 120, height: 20, shift: false, alt: false, ctrl: false, ...extra });

class Recorder implements Component {
  readonly events: TuiMouseEvent[] = [];
  constructor(private readonly result: TuiMouseEventResult = { handled: true }) {}
  render(): string[] { return Array(10).fill('x'); }
  invalidate(): void {}
  handleMouse(e: TuiMouseEvent): TuiMouseEventResult { this.events.push(e); return this.result; }
}

function split() {
  const layout = new LayoutStore();
  const tree = new Recorder(); const editor = new Recorder(); const chat = new Recorder();
  const pane = new SplitPane({ layout, tree, editor, chat });
  pane.render(120); // tree 0-29, divider 30, editor 31-80, divider 81, chat 82-119
  return { layout, tree, editor, chat, pane };
}

test('each event goes to the pane under the pointer, in that pane\'s coordinates, whatever has the focus', () => {
  const { tree, editor, chat, pane, layout } = split();
  expect(layout.get().focused).toBe('editor');
  pane.handleMouse(event('wheel', 5, 4, { wheelDelta: -3 }));
  pane.handleMouse(event('wheel', 100, 4, { wheelDelta: 3 }));
  pane.handleMouse(event('wheel', 40, 4, { wheelDelta: 3 }));
  expect(tree.events.map((e) => [e.x, e.y])).toEqual([[5, 3]]);
  expect(chat.events.map((e) => [e.x, e.y])).toEqual([[18, 3]]);
  expect(editor.events.map((e) => [e.x, e.y])).toEqual([[9, 3]]);
});

test('a pane that takes a press gets the drag and release, even outside it', () => {
  const { editor, pane, chat } = split();
  expect(pane.handleMouse(event('press', 40, 5))).toMatchObject({ capture: true });
  pane.handleMouse(event('drag', 100, 25));
  pane.handleMouse(event('release', 100, 25));
  expect(editor.events.map((e) => [e.type, e.x, e.y])).toEqual([['press', 9, 4], ['drag', 69, 24], ['release', 69, 24]]);
  expect(chat.events).toEqual([]);
});

test('a click on a pane title focuses it; dragging a divider resizes the side pane', () => {
  const { pane, layout } = split();
  pane.handleMouse(event('press', 100, 0));
  expect(layout.get().focused).toBe('chat');
  pane.handleMouse(event('press', 30, 6));
  pane.handleMouse(event('drag', 22, 6));
  pane.handleMouse(event('release', 22, 6));
  expect(layout.get().treeWidth).toBe(22);
  pane.render(120);
  pane.handleMouse(event('press', 81 - 8, 6)); // the editor shrank by 8: the chat divider moved left
  pane.handleMouse(event('press', 81, 6));
  pane.handleMouse(event('drag', 70, 6));
  expect(layout.get().chatWidth).toBe(120 - 70 - 1);
  expect(pane.render(120)[1].length).toBeGreaterThan(0);
});

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test('a click on a tree row opens a file or expands a folder; the wheel scrolls the tree', () => {
  root = mkdtempSync(join(tmpdir(), 'pane-mouse-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), '');
  for (let i = 0; i < 30; i++) writeFileSync(join(root, `z${String(i).padStart(2, '0')}.txt`), '');
  const opened: string[] = [];
  let focused = 0;
  const tree = new FileTree({ root, onOpen: (p) => opened.push(p), onFocus: () => { focused++; } });
  tree.setHeight(10);
  const rows = () => tree.render(40).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const srcRow = rows().findIndex((l) => l.includes('src'));
  tree.handleMouse(event('press', 3, srcRow));
  tree.handleMouse(event('click', 3, srcRow, { clickCount: 1 }));
  expect(focused).toBe(1);
  expect(tree.isExpanded(join(root, 'src'))).toBe(true);
  const appRow = rows().findIndex((l) => l.includes('app.ts'));
  tree.handleMouse(event('click', 5, appRow, { clickCount: 1 }));
  expect(opened).toEqual([join(root, 'src', 'app.ts')]);
  tree.handleMouse(event('wheel', 5, 2, { wheelDelta: 5 }));
  expect(rows()[0]).toContain('z02.txt'); // five rows down: root, src, app.ts, z00, z01 scrolled off
});

test('a drag in the chat pane selects only inside it and copies without the rail; the wheel scrolls the transcript', () => {
  const copied: string[] = [];
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
  const chat = new ChatPane({ tui, basePath: '/tmp', onSubmit: () => {}, onCopy: (t) => copied.push(t) });
  chat.setHeight(16);
  chat.messages.push({ role: 'user', content: 'first question here', timestamp: new Date() });
  for (let i = 0; i < 30; i++) chat.messages.push({ role: 'assistant', content: `answer line ${i}`, timestamp: new Date() });
  const lines = () => chat.render(40).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, ''));
  const before = lines();
  chat.handleMouse(event('wheel', 5, 3, { wheelDelta: -6 }));
  expect(lines()).not.toEqual(before);
  const shown = lines();
  const row = shown.findIndex((l) => /answer line \d+/.test(l));
  expect(chat.handleMouse(event('press', 0, row))).toMatchObject({ capture: true });
  chat.handleMouse(event('drag', 39, row + 1));
  chat.handleMouse(event('release', 39, row + 1));
  expect(copied).toHaveLength(1);
  expect(copied[0].split('\n')).toEqual([shown[row], shown[row + 1]].map((l) => l.replace(/^(?:│ |· |! | {2})/, '').trimEnd()));
  expect(chat.render(40)[row]).toContain('\x1b[7m'); // drawn selected
});
