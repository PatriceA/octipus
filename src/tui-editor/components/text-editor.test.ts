import { describe, expect, test } from 'bun:test';
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
