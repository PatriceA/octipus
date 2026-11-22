/**
 * The chat on the alternate screen, against the symptoms users reported:
 * history before launch lost on resize, a dead frame left on exit, the
 * composer leaving the window. And the ways the conversation leaves the app:
 * the exit summary, `/export`, the scrollback dump. `--inline` keeps the
 * normal buffer and must not erase scrollback either.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const PREAMBLE = Array.from({ length: 40 }, (_, n) => `before launch ${n}`).join('\n') + '\n';
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

describe.skipIf(process.platform === 'win32')('the chat screen', () => {
  test.each([
    ['alternate screen', [] as string[]],
    ['--inline', ['--inline']],
  ])('%s: resizing never erases the scrollback the user had before launch', async (_label, flags) => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, flags, { preamble: PREAMBLE });
    await tui.waitFor('connected');
    expect(await tui.bufferType()).toBe(flags.length ? 'normal' : 'alternate');
    for (const [cols, rows] of [[60, 18], [120, 40], [80, 24], [40, 12], [90, 24]]) { tui.resize(cols, rows); await settle(); }
    await tui.waitFor('connected');
    expect(tui.rawOutput()).not.toContain('\x1b[3J');
    const normal = await tui.normalBuffer();
    expect(normal).toContain('before launch 0');
    expect(normal).toContain('before launch 39');
  });

  test.each([[80, 24], [200, 60]])('at %ix%i the composer and status stay pinned through 50 random resizes', async (cols, rows) => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', cols, rows);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 200 }, (_, n) => `History line ${n}`).join('\n') });
    tui.send('pinned draft'); await tui.waitFor('pinned draft');
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let n = 0; n < 50; n++) tui.resize(30 + Math.floor(next() * 171), 8 + Math.floor(next() * 53));
    tui.resize(cols, rows); await settle(); await tui.waitFor('pinned draft');
    const screen = (await tui.text()).split('\n');
    expect(screen.at(-1)).toContain('● Octipus');
    const draft = screen.findIndex(row => row.includes('pinned draft'));
    expect(draft).toBeGreaterThan(screen.findIndex(row => row.includes('History line 199')));
    expect(tui.screen.buffer.active.cursorY).toBe(draft);
  });

  test('quitting restores the screen and prints the last exchange and the resume command', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, [], { preamble: PREAMBLE });
    await tui.waitFor('connected');
    tui.send('what is the answer?\r'); await tui.waitFor('A streaming reply');
    tui.event('chat.response', { response: 'The answer is 42.\x1b[2J' });
    await tui.waitFor('The answer is 42');
    const sessionId = tui.commands.find(command => command.type === 'chat.send')?.sessionId as string;
    tui.send('/quit\r');
    expect(await tui.exited).toBe(0);
    expect(await tui.bufferType()).toBe('normal');
    const normal = await tui.normalBuffer();
    expect(normal).toContain('before launch 39');
    expect(normal).toContain('You:\nwhat is the answer?');
    expect(normal).toContain('Octipus:\nThe answer is 42.');
    expect(normal).toContain(`Resume this conversation: octi tui --session ${sessionId}`);
    // The frame itself is not left behind in the normal buffer.
    expect(normal).not.toContain('● Octipus');
  });

  test('/export writes the transcript as Markdown and will not overwrite a file', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    tui.send('first question\r'); await tui.waitFor('A streaming reply');
    tui.event('chat.response', { response: '**Bold** answer' }); await tui.waitFor('Bold answer');
    tui.send('/export notes.md\r'); await tui.waitFor('Exported');
    const file = join(tui.project, 'notes.md');
    expect(existsSync(file)).toBe(true);
    const markdown = readFileSync(file, 'utf8');
    expect(markdown).toMatch(/^# Octipus session [0-9a-f-]{36}/);
    expect(markdown).toContain('## You · ');
    expect(markdown).toContain('first question');
    expect(markdown).toContain('**Bold** answer');
    tui.send('/export notes.md\r'); await tui.waitFor('already exists');
  });

  test('/scrollback shows the transcript in the normal buffer and any key returns to the app', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 60 }, (_, n) => `Dumped line ${n}`).join('\n') });
    tui.send('kept draft'); await tui.waitFor('kept draft');
    tui.send('\x1b[1;5F'); // Ctrl+End
    tui.send('\x1bo'); // Alt+O
    await tui.waitFor('Press any key to return');
    expect(await tui.bufferType()).toBe('normal');
    expect(tui.screen.modes.mouseTrackingMode).toBe('none');
    expect(await tui.normalBuffer()).toContain('Dumped line 0');
    tui.send('x');
    await tui.waitFor('kept draft');
    expect(await tui.bufferType()).toBe('alternate');
    expect(tui.screen.modes.mouseTrackingMode).toBe('any');
    expect(await tui.text()).not.toContain('kept draftx');
  });
});
