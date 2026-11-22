import { describe, expect, test } from 'vitest';
import { BufferStore } from '../stores/buffer-store';
import { TextEditor } from './text-editor';

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

function setup(initial = '') {
  const store = new BufferStore();
  const rec = store.openFile('/tmp/example.ts', initial);
  const editor = new TextEditor(store, { height: 5 });
  editor.focused = true;
  return { store, rec, editor };
}

describe('TextEditor', () => {
  test('renders empty-state hint when no buffer is open', () => {
    const editor = new TextEditor(new BufferStore(), { height: 3 });
    const lines = editor.render(40).map(strip);
    expect(lines[0]).toContain('No buffer');
  });

  test('renders the current buffer with line numbers', () => {
    const { editor } = setup('alpha\nbeta\ngamma');
    const lines = editor.render(40).map(strip);
    expect(lines[0]).toContain('alpha');
    expect(lines[1]).toContain('beta');
    expect(lines[2]).toContain('gamma');
    expect(lines[0]).toMatch(/^\s*1 /);
  });

  test('printable characters insert into the buffer', () => {
    const { editor, rec } = setup('');
    for (const c of 'hi') editor.handleInput(c);
    expect(rec.buffer.text()).toBe('hi');
  });

  test('Enter inserts a newline and Backspace removes the previous char', () => {
    const { editor, rec } = setup('');
    editor.handleInput('a');
    editor.handleInput('\r');
    editor.handleInput('b');
    expect(rec.buffer.text()).toBe('a\nb');
    editor.handleInput('\x7f');
    expect(rec.buffer.text()).toBe('a\n');
  });

  test('arrow keys move the cursor', () => {
    const { editor, rec } = setup('hello');
    rec.buffer.moveLineEnd();
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 5 });
    editor.handleInput('\x1b[D'); // left
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 4 });
  });

  test('Ctrl+S triggers onSave callback', () => {
    const store = new BufferStore();
    const rec = store.openFile('/tmp/x.ts', 'data');
    let saved = false;
    const editor = new TextEditor(store, { height: 5, onSave: (b) => { if (b.id === rec.id) saved = true; } });
    editor.handleInput('\x13');
    expect(saved).toBe(true);
  });

  test('respects viewport height with empty-line padding', () => {
    const { editor } = setup('only one line');
    const lines = editor.render(40);
    expect(lines.length).toBe(5);
  });

  test('marks dirty when typing', () => {
    const { editor, store, rec } = setup('');
    editor.handleInput('x');
    expect(store.get().buffers.find((b) => b.id === rec.id)?.dirty).toBe(true);
  });
});

test('long lines scroll horizontally and keep the cursor marker in bounds', async () => {
  const { CURSOR_MARKER, visibleWidth } = await import('@mariozechner/pi-tui');
  const { editor, rec } = setup('a'.repeat(80) + 'END');
  rec.buffer.moveLineEnd();
  const line = editor.render(20)[0];
  expect(line).toContain(CURSOR_MARKER); expect(strip(line)).toContain('END');
  expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  rec.buffer.moveLineStart(); expect(strip(editor.render(20)[0])).toContain('aaaa');
});

test('cursor after tab and wide glyph uses terminal cells', async () => {
  const { CURSOR_MARKER, visibleWidth } = await import('@mariozechner/pi-tui');
  const { editor, rec } = setup('\t界x');
  rec.buffer.setCursor({ line: 0, col: 2 });
  const line = editor.render(40)[0];
  expect(visibleWidth(line.split(CURSOR_MARKER)[0])).toBe(8); // gutter 2 + tab 4 + CJK 2
});

test('bracketed multiline paste inserts content without escape sequences', () => {
  const { editor, rec } = setup('');
  editor.handleInput('\x1b[200~hello\r\n'); editor.handleInput('world\x1b[201~');
  expect(rec.buffer.text()).toBe('hello\nworld');
});

test('control bytes in a file are shown, never sent to the terminal', () => {
  const { editor, rec } = setup('crlf line\r\nclear \x1b[2J screen\nbell \x07 del \x7f end');
  const raw = editor.render(40);
  // Only the editor's own colour codes may carry an escape byte.
  for (const line of raw) expect(line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '')).not.toMatch(/[\x00-\x1f\x7f]/);
  const lines = raw.map(strip);
  expect(lines[0]).toContain('crlf line\u240d');
  expect(lines[1]).toContain('clear \u241b[2J screen');
  expect(lines[2]).toContain('bell \u2407 del \u2421 end');
  expect(rec.buffer.text()).toContain('\x1b[2J'); // the file itself is untouched
});
