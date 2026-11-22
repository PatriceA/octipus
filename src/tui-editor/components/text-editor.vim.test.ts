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

  test('Escape sent as kitty ESC[27u returns to NORMAL (docs/plans/tui-modernization.md §5.2)', () => {
    const { editor, rec } = setup('');
    editor.handleInput('i');
    editor.handleInput('\x1b[27u');
    expect(editor.getVimState().mode).toBe('NORMAL');
    editor.handleInput('x');
    expect(rec.buffer.text()).toBe(''); // NORMAL: x deletes, it does not type
  });

  test('Ctrl+S saves in NORMAL mode', () => {
    const layout = new LayoutStore();
    layout.setEditorMode('vim');
    const buffers = new BufferStore();
    buffers.openFile('/tmp/v.ts', 'x');
    let saved = 0;
    const editor = new TextEditor(buffers, { height: 5, layout, onSave: () => { saved++; } });
    editor.handleInput('\x13');
    expect(saved).toBe(1);
    expect(editor.getVimState().mode).toBe('NORMAL');
  });

  test(':w, :q and :wq reach the app; the command line is shown while typed', () => {
    const layout = new LayoutStore();
    layout.setEditorMode('vim');
    const buffers = new BufferStore();
    buffers.openFile('/tmp/v.ts', 'x');
    const commands: string[] = [];
    const editor = new TextEditor(buffers, { height: 5, layout, onVimCommand: (c) => commands.push(c) });
    for (const keys of [':w\r', ':q\r', ':wq\r', ':qa!\r']) for (const k of keys) editor.handleInput(k);
    expect(commands).toEqual(['write', 'quit', 'write-quit', 'quit-all!']);
    // Keys typed faster than they are read arrive as one chunk.
    editor.handleInput(':w'); editor.handleInput('\r');
    expect(commands.at(-1)).toBe('write');
    editor.handleInput(':'); editor.handleInput('w');
    expect(editor.getVimState().commandLine).toBe('w');
    editor.handleInput('\x1b');
    expect(editor.getVimState().commandLine).toBeNull();
    expect(buffers.active()?.buffer.text()).toBe('x');
  });

  test('an unknown : command is reported', () => {
    const layout = new LayoutStore();
    layout.setEditorMode('vim');
    const buffers = new BufferStore();
    buffers.openFile('/tmp/v.ts', 'x');
    const notices: string[] = [];
    const editor = new TextEditor(buffers, { height: 5, layout, onNotice: (t) => notices.push(t) });
    for (const k of ':nope\r') editor.handleInput(k);
    expect(notices[0]).toContain(':nope');
  });

  test('VISUAL mode draws its selection', async () => {
    const { getPalette } = await import('@/tui-pi/theme/defaults');
    const { editor } = setup('hello');
    editor.handleInput('v'); editor.handleInput('l'); editor.handleInput('l');
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(getPalette().selection.slice(i, i + 2), 16));
    expect(editor.render(20)[0]).toContain(`\x1b[48;2;${r};${g};${b}m`);
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
