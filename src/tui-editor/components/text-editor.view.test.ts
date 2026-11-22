/** Navigation, selection and the mouse in the editor pane (docs/plans/tui-modernization.md §7, Phase 5 items 1 and 4). */
import { describe, expect, test } from 'vitest';
import { CURSOR_MARKER, type TuiMouseEvent } from '@/tui-kit';
import { BufferStore } from '../stores/buffer-store';
import { type EditorClipboard, TextEditor } from './text-editor';

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, ''); }

function setup(initial = '', height = 5, clipboard?: EditorClipboard) {
  const store = new BufferStore();
  const rec = store.openFile('/tmp/example.ts', initial);
  const editor = new TextEditor(store, { height, clipboard });
  editor.focused = true;
  return { store, rec, editor };
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const mouse = (type: TuiMouseEvent['type'], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent =>
  ({ type, button: type === 'wheel' ? 'none' : 'left', x, y, screenX: x, screenY: y, width: 40, height: 5, shift: false, alt: false, ctrl: false, ...extra });
const selected = (rec: ReturnType<typeof setup>['rec']) => {
  const range = rec.buffer.selectionRange();
  return range ? rec.buffer.textInRange(range[0], range[1]) : '';
};

describe('keyboard navigation', () => {
  test('PageDown and PageUp move the cursor and the view by a page; Ctrl+End and Ctrl+Home go to the ends', () => {
    const { editor, rec } = setup(numbered(40));
    editor.render(40);
    editor.handleInput('\x1b[6~');
    expect(editor.getScrollTop()).toBe(4);
    expect(rec.buffer.getCursor().line).toBe(6); // kept two rows (of five) from the top edge
    editor.handleInput('\x1b[6~');
    expect(editor.getScrollTop()).toBe(8);
    expect(rec.buffer.getCursor().line).toBe(10);
    editor.handleInput('\x1b[5~');
    expect(editor.getScrollTop()).toBe(4);
    expect(rec.buffer.getCursor().line).toBe(6);
    editor.handleInput('\x1b[5~');
    expect(editor.getScrollTop()).toBe(0);
    expect(rec.buffer.getCursor().line).toBe(2);
    editor.handleInput('\x1b[1;5F');
    expect(rec.buffer.getCursor()).toEqual({ line: 39, col: 7 });
    expect(strip(editor.render(40).at(-1) ?? '')).toContain('line 39');
    editor.handleInput('\x1b[1;5H');
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test('the view keeps three rows between the cursor and its edge while the cursor moves', () => {
    const { editor, rec } = setup(numbered(40), 10);
    editor.render(40);
    for (let i = 0; i < 7; i++) editor.handleInput('\x1b[B');
    expect(rec.buffer.getCursor().line).toBe(7);
    expect(editor.getScrollTop()).toBe(1);
    for (let i = 0; i < 5; i++) editor.handleInput('\x1b[A');
    expect(editor.getScrollTop()).toBe(0);
  });

  test('Shift+arrows, Shift+End and Ctrl+Shift+Right select; Ctrl+X cuts to the clipboard and Ctrl+V pastes it', async () => {
    const copied: string[] = [];
    const { editor, rec } = setup('hello world', 5, { copy: (t) => copied.push(t), paste: async () => copied.at(-1) ?? null });
    editor.handleInput('\x1b[1;2C'); editor.handleInput('\x1b[1;2C');
    expect(selected(rec)).toBe('he');
    editor.handleInput('\x1b[1;2F');
    expect(editor.copySelection()).toBe(true);
    expect(copied.at(-1)).toBe('hello world');
    rec.buffer.setCursor({ line: 0, col: 0 });
    editor.handleInput('\x1b[1;6C');
    editor.handleInput('\x18');
    expect(copied.at(-1)).toBe('hello ');
    expect(rec.buffer.text()).toBe('world');
    rec.buffer.moveLineEnd();
    editor.handleInput('\x16');
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.buffer.text()).toBe('worldhello ');
    expect(editor.copySelection()).toBe(false);
  });

  test('Enter keeps the indentation, one step deeper after an opening bracket, with the closer on its own line', () => {
    const { editor, rec } = setup('  if (x) {}');
    rec.buffer.setCursor({ line: 0, col: 10 });
    editor.handleInput('\r');
    expect(rec.buffer.text()).toBe('  if (x) {\n    \n  }');
    expect(rec.buffer.getCursor()).toEqual({ line: 1, col: 4 });
    editor.handleInput('y'); editor.handleInput('\r');
    expect(rec.buffer.getLine(2)).toBe('    ');
    rec.buffer.undo();
    expect(rec.buffer.getLine(1)).toBe('    y');
  });

  test('the bracket matching the one at the cursor is drawn', () => {
    const { editor, rec } = setup('f(a, b)');
    rec.buffer.setCursor({ line: 0, col: 1 });
    editor.focused = false;
    const line = editor.render(40)[0];
    expect(line.match(/\x1b\[1m\x1b\[4m[()]/g)).toHaveLength(2);
  });

  test('soft wrap breaks long lines into rows and draws the cursor on the row it is on', () => {
    const { editor, rec } = setup(`${'a'.repeat(50)}END\nnext`);
    editor.setWrap(true);
    rec.buffer.moveLineEnd();
    const raw = editor.render(22);
    const lines = raw.map(strip);
    expect(lines[0]).toMatch(/^1 a{19}$/);
    expect(lines[1]).toMatch(/^ {2}a{19}$/); // a continuation row has no line number
    const end = lines.findIndex((l) => l.includes('END'));
    expect(end).toBe(2);
    expect(raw[end]).toContain(CURSOR_MARKER);
    expect(lines[3]).toMatch(/^2 next/);
  });
});

describe('the mouse', () => {
  test('a scrollbar is drawn when the buffer is longer than the pane; a click on it scrolls there', () => {
    const { editor } = setup(numbered(100));
    const lines = editor.render(40).map(strip);
    expect(lines.every((l) => /[│┃]$/.test(l))).toBe(true);
    expect(lines[0].endsWith('┃')).toBe(true);
    editor.handleMouse(mouse('press', 39, 4));
    editor.handleMouse(mouse('release', 39, 4));
    expect(editor.getScrollTop()).toBe(95);
    expect(strip(editor.render(40)[4]).endsWith('┃')).toBe(true);
  });

  test('a click places the cursor in buffer coordinates, past the line numbers and through tabs and wide text', () => {
    const { editor, rec } = setup('ab\t界x\nsecond');
    editor.render(40);
    editor.handleMouse(mouse('press', 2 + 6, 0)); // gutter 2; ab, the tab to cell 4, 界 at 4-5, x at 6
    editor.handleMouse(mouse('release', 2 + 6, 0));
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 4 });
    editor.handleMouse(mouse('press', 30, 1));
    expect(rec.buffer.getCursor()).toEqual({ line: 1, col: 6 }); // past the end of a line: its end
    editor.handleMouse(mouse('press', 5, 4));
    expect(rec.buffer.getCursor()).toEqual({ line: 1, col: 6 }); // below the last line: the end of the buffer
  });

  test('a drag selects in buffer coordinates and copies the file text, without line numbers', () => {
    const copied: string[] = [];
    const { editor, rec } = setup('first line\nsecond line\nthird', 5, { copy: (t) => copied.push(t), paste: async () => null });
    editor.render(40);
    editor.handleMouse(mouse('press', 2 + 6, 0));
    editor.handleMouse(mouse('drag', 2 + 6, 1));
    editor.handleMouse(mouse('release', 2 + 6, 1));
    expect(copied).toEqual(['line\nsecond']);
    expect(rec.buffer.selectionRange()).toEqual([{ line: 0, col: 6 }, { line: 1, col: 6 }]);
  });

  test('a drag below the pane scrolls and keeps selecting', () => {
    const { editor, rec } = setup(numbered(40));
    editor.render(40);
    editor.handleMouse(mouse('press', 2, 0));
    for (let i = 0; i < 6; i++) editor.handleMouse(mouse('drag', 4, 7));
    expect(editor.getScrollTop()).toBe(6);
    expect(rec.buffer.selectionRange()?.[1].line).toBe(10);
  });

  test('a double click selects a word, a triple click the line; Shift+click extends', () => {
    const { editor, rec } = setup('const greeting = 1;\nnext');
    editor.render(40);
    editor.handleMouse(mouse('press', 2 + 8, 0));
    editor.handleMouse(mouse('click', 2 + 8, 0, { clickCount: 2 }));
    expect(selected(rec)).toBe('greeting');
    editor.handleMouse(mouse('click', 2 + 8, 0, { clickCount: 3 }));
    expect(rec.buffer.selectionRange()).toEqual([{ line: 0, col: 0 }, { line: 1, col: 0 }]);
    rec.buffer.setCursor({ line: 0, col: 0 });
    editor.handleMouse(mouse('press', 2 + 5, 0, { shift: true }));
    expect(selected(rec)).toBe('const');
  });

  test('the wheel scrolls the view without moving the cursor, and the next render does not jump back', () => {
    const { editor, rec } = setup(numbered(40));
    editor.render(40);
    editor.handleMouse(mouse('wheel', 5, 2, { wheelDelta: 6 }));
    expect(editor.getScrollTop()).toBe(6);
    expect(rec.buffer.getCursor().line).toBe(0);
    expect(strip(editor.render(40)[0])).toContain('line 6');
    editor.handleInput('\x1b[B'); // moving the cursor brings it back into view
    expect(strip(editor.render(40)[0])).toContain('line 0');
  });
});
