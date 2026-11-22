import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness, KEY } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

describe.skipIf(process.platform === 'win32')('editor in a real POSIX terminal', () => {
  test('opens, edits, protects unsaved close, saves, and renders the focused pane after resize', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file');
    tui.send('example.ts'); tui.send(KEY.Enter); await tui.waitFor('const greeting');
    await tui.saveScreen('editor');
    tui.send('X'); await tui.waitFor('Xconst');
    tui.send(KEY.CtrlW); await tui.waitFor('Unsaved changes');
    tui.send(KEY.Esc); await tui.waitFor('Unsaved changes', true); await tui.waitFor('Xconst');
    tui.send('\x13'); await tui.waitFor('Saved');
    expect(readFileSync(join(tui.project, 'example.ts'), 'utf8')).toMatch(/^Xconst/);
    tui.resize(50, 16); await tui.waitFor('switch pane');
    tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat');
    expect(await tui.text()).toContain('Chat');
    tui.send('hello from editor\r'); await tui.waitFor('A streaming reply');
    await tui.saveScreen('editor-narrow');
    tui.event('agent.approval_required', { requestId: 'edit-q', question: 'Keep this change?', options: ['Keep', 'Revise'] });
    await tui.waitFor('Keep this change?'); tui.send('2'); await tui.waitFor('Keep this change?', true);
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'approval.respond', requestId: 'edit-q', response: 'Revise' }));
  });

  test('dirty quit defaults to cancel and only exits after explicit discard', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts'); await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file'); tui.send('example.ts\r'); await tui.waitFor('const greeting');
    tui.send('UNSAVED'); tui.send(KEY.CtrlQ); await tui.waitFor('Unsaved changes');
    tui.send(KEY.Enter); await tui.waitFor('Unsaved changes', true);
    expect(tui.proc.exitCode).toBeNull();
    tui.send(KEY.CtrlQ); await tui.waitFor('Unsaved changes'); tui.send('d');
    expect(await tui.exited).toBe(0);
    expect(readFileSync(join(tui.project, 'example.ts'), 'utf8')).not.toContain('UNSAVED');
  });

  // docs/plans/tui-modernization.md §5.2, "Present but unreachable or invisible" and "Wrong today".
  async function openExample(h: TuiHarness): Promise<void> {
    await h.waitFor('focus:editor');
    h.send(KEY.CtrlO); await h.waitFor('Open file');
    h.send('example.ts'); h.send(KEY.Enter); await h.waitFor('const greeting');
  }

  test('vim mode is switched on with Alt+M, shown in the mode bar; VISUAL draws its selection; :w saves', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await openExample(tui);
    tui.send('\x1bm'); await tui.waitFor('Vim mode on');
    tui.send('v'); await tui.waitFor('VIM VISUAL');
    tui.send('l'); tui.send('l'); tui.send('l');
    await tui.waitFor('L1:4');
    const row = await rowOf(tui, 'const greeting');
    expect(await cellsWithBackground(tui, row, SELECTION)).toBe('con'); // the fourth is under the cursor
    tui.send(KEY.Esc); await tui.waitFor('VIM NORMAL');
    tui.send('x'); await tui.waitFor('cont greeting');
    tui.send(':w'); await tui.waitFor(':w');
    tui.send(KEY.Enter); await tui.waitFor('Saved example.ts');
    expect(readFileSync(join(tui.project, 'example.ts'), 'utf8')).toMatch(/^cont greeting/);
  });

  test('find highlights the matches in the buffer and Esc puts the cursor back', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await openExample(tui);
    tui.send('\x06'); await tui.waitFor('Find');
    tui.send('greeting'); await tui.waitFor('1 / 1');
    const row = await rowOf(tui, 'const greeting');
    expect(await cellsWithBackground(tui, row, WARN)).toBe('greeting');
    tui.send(KEY.Esc); await tui.waitFor('1 / 1', true);
    expect(await cellsWithBackground(tui, row, WARN)).toBe('');
    await tui.waitFor('L1:1');
  });

  test('a scratch buffer is saved with Save As', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat');
    tui.send('/new\r'); await tui.waitFor('Scratch 1');
    await tui.waitFor('focus:editor');
    tui.send('notes from the terminal');
    await tui.waitFor('notes from the terminal');
    tui.send('\x13'); await tui.waitFor('Save Scratch 1 as');
    tui.send('notes.md'); tui.send(KEY.Enter); await tui.waitFor('Saved as notes.md');
    expect(readFileSync(join(tui.project, 'notes.md'), 'utf8')).toBe('notes from the terminal');
    await tui.waitFor(' notes.md ');
  });

  test('saving over a file changed on disk asks first, and reload takes the disk version', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await openExample(tui);
    const path = join(tui.project, 'example.ts');
    writeFileSync(path, 'const changedElsewhere = 1;\n');
    tui.send('MINE '); await tui.waitFor('MINE const greeting');
    tui.send('\x13'); await tui.waitFor('File changed on disk');
    expect(readFileSync(path, 'utf8')).toBe('const changedElsewhere = 1;\n');
    tui.send('r'); await tui.waitFor('const changedElsewhere');
    await tui.waitFor('MINE', true);
    tui.send('\x13'); await tui.waitFor('Saved example.ts');
    expect(readFileSync(path, 'utf8')).toBe('const changedElsewhere = 1;\n');
  });

  test('a CRLF file stays CRLF and Backspace after an emoji leaves no half character', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    const path = join(tui.project, 'win.txt');
    writeFileSync(path, 'first\r\nsecond😀\r\n');
    await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file'); tui.send('win.txt'); tui.send(KEY.Enter);
    await tui.waitFor('second😀');
    expect(await tui.text()).not.toContain('␍'); // no ␍ drawn: the buffer holds no \r
    tui.send('\x1b[B'); tui.send(KEY.End); tui.send('\x7f'); await tui.waitFor('😀', true);
    expect(await tui.text()).not.toContain('�');
    tui.send('\x13'); await tui.waitFor('Saved win.txt');
    expect(readFileSync(path, 'utf8')).toBe('first\r\nsecond\r\n');
  });
});

const SELECTION = 0x163b44;
const WARN = 0xe8c46a;

async function rowOf(h: TuiHarness, needle: string): Promise<number> {
  const row = (await h.text()).split('\n').findIndex((line) => line.includes(needle));
  if (row < 0) throw new Error(`no row shows ${needle}`);
  return row;
}

/** The characters on screen row `row` drawn with background colour `rgb`. */
async function cellsWithBackground(h: TuiHarness, row: number, rgb: number): Promise<string> {
  await h.text();
  const buffer = h.screen.buffer.active;
  const line = buffer.getLine(buffer.viewportY + row);
  let out = '';
  for (let col = 0; line && col < h.screen.cols; col++) {
    const cell = line.getCell(col);
    if (cell?.isBgRGB() && cell.getBgColor() === rgb) out += cell.getChars();
  }
  return out;
}
