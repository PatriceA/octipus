import { describe, expect, test } from 'vitest';
import { BufferStore } from '../stores/buffer-store';
import { LayoutStore } from '../stores/layout-store';
import { TextEditor } from './text-editor';

function setup(initial: string) {
  const layout = new LayoutStore();
  layout.setEditorMode('vim');
  const buffers = new BufferStore();
  const rec = buffers.openFile('/tmp/v.ts', initial);
  const editor = new TextEditor(buffers, { height: 5, layout });
  editor.focused = true;
  return { layout, buffers, rec, editor };
}

describe('TextEditor — vim mode', () => {
  test('starts in NORMAL mode', () => {
    const { editor } = setup('hello');
    expect(editor.getVimState().mode).toBe('NORMAL');
  });

  test('h moves cursor left in NORMAL mode (no insertion)', () => {
    const { editor, rec } = setup('hello');
    rec.buffer.moveLineEnd();
    editor.handleInput('h');
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 4 });
    expect(rec.buffer.text()).toBe('hello'); // not inserted
  });

  test('i enters INSERT mode and subsequent typing inserts characters', () => {
    const { editor, rec } = setup('');
    editor.handleInput('i');
    expect(editor.getVimState().mode).toBe('INSERT');
    editor.handleInput('a');
    editor.handleInput('b');
    expect(rec.buffer.text()).toBe('ab');
  });

  test('Escape returns to NORMAL', () => {
    const { editor } = setup('hello');
    editor.handleInput('i');
    editor.handleInput('\x1b');
    expect(editor.getVimState().mode).toBe('NORMAL');
  });

  test('x deletes the character under the cursor', () => {
    const { editor, rec, buffers } = setup('hello');
    editor.handleInput('x');
    expect(rec.buffer.text()).toBe('ello');
    expect(buffers.get().buffers[0].dirty).toBe(true);
  });

  test('motion-only keys do NOT mark buffer dirty', () => {
    const { editor, rec, buffers } = setup('hello');
    rec.buffer.moveLineEnd();
    editor.handleInput('h'); editor.handleInput('h');
    expect(buffers.get().buffers[0].dirty).toBe(false);
  });

  test('dd deletes the current line', () => {
    const { editor, rec } = setup('alpha\nbeta\ngamma');
    rec.buffer.setCursor({ line: 1, col: 0 });
    editor.handleInput('d');
    editor.handleInput('d');
    expect(rec.buffer.text()).toBe('alpha\ngamma');
  });

  test('switching back to modeless via the layout disables vim routing', () => {
    const { editor, rec, layout } = setup('');
    editor.handleInput('a');         // enters INSERT in vim
    editor.handleInput('x');         // typed in INSERT mode
    expect(rec.buffer.text()).toBe('x');
    layout.setEditorMode('modeless');
    editor.handleInput('y');         // plain modeless typing
    expect(rec.buffer.text()).toBe('xy');
  });
});
