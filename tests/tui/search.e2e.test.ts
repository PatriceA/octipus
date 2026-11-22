/** Transcript search (Ctrl+F): count, next, highlight, Escape back to the reading position; Ctrl+R over input history. */
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const CTRL_F = '\x06';
const CTRL_R = '\x12';
const rowsOf = async (h: TuiHarness) => (await h.text()).split('\n');
const historyRows = (rows: string[]) => rows.flatMap(row => row.match(/History line \d+( needle)?/) ?? []);

describe.skipIf(process.platform === 'win32')('search in a real terminal', () => {
  test('Ctrl+F finds and counts matches, Enter moves to the next, Escape returns to where reading was', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 100 }, (_, n) => `History line ${n}${n % 30 === 5 ? ' needle' : ''}`).join('\n') });
    await tui.waitFor('History line 99');
    tui.send(KEY.PageUp); tui.send(KEY.PageUp);
    await tui.waitFor('End: latest');
    const reading = historyRows(await rowsOf(tui));
    tui.send(CTRL_F);
    tui.send('needle');
    await tui.waitFor('/4');
    // The current match is highlighted (bold reverse) and on screen.
    const buffer = tui.screen.buffer.active;
    const highlighted = Array.from({ length: tui.screen.rows }, (_, row) => buffer.getLine(buffer.viewportY + row))
      .some(line => line && Array.from({ length: tui!.screen.cols }, (_, col) => line.getCell(col)).some(cell => cell?.isInverse() && cell.getChars() === 'n'));
    expect(highlighted).toBe(true);
    const first = (await tui.text()).match(/(\d)\/4/)?.[1];
    tui.send(KEY.Enter);
    await tui.waitFor(`${(Number(first) % 4) + 1}/4`);
    expect(historyRows(await rowsOf(tui))).not.toEqual(reading);
    tui.send(KEY.Esc);
    await tui.waitFor('/4', true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(historyRows(await rowsOf(tui))).toEqual(reading);
  });

  test('the search finds and counts messages outside the rendered window too', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    // More messages than the transcript renders at once (a window of 200, up to 400 while following).
    for (let n = 0; n < 450; n++) tui.event('chat.response', { response: `Message ${n}${n < 3 ? ' haystack-needle' : ''}` });
    await tui.waitFor('Message 449');
    tui.send(CTRL_F);
    tui.send('haystack-needle');
    await tui.waitFor('/3');
    tui.send(KEY.Enter);
    await tui.waitFor('haystack-needle');
    expect((await tui.text())).toMatch(/Message [012] haystack-needle/);
  });

  test('/search opens the same search; at the latest, Escape comes back to the latest', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 100 }, (_, n) => `History line ${n}${n === 3 ? ' needle' : ''}`).join('\n') });
    await tui.waitFor('History line 99');
    tui.send('/search\r');
    tui.send('needle');
    await tui.waitFor('1/1');
    await tui.waitFor('History line 3 needle');
    tui.send(KEY.Esc);
    await tui.waitFor('History line 99');
    await tui.waitFor('End: latest', true);
  });

  test('Ctrl+R finds an earlier message and puts it back in the composer', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.send('explain the parser bug\r');
    await tui.waitFor('A streaming reply');
    tui.event('chat.response', { response: 'It splits on commas.' });
    await tui.waitFor('It splits on commas.');
    tui.send('/status\r');
    tui.send(CTRL_R);
    await tui.waitFor('Input history 2/2');
    tui.send('parser');
    await tui.waitFor('Input history 1/2');
    tui.send(KEY.Enter);
    await tui.waitFor('Input history', true);
    const rows = await rowsOf(tui);
    // In the composer (no rail), not as a sent message.
    expect(rows.some(row => row.includes('explain the parser bug') && !row.includes('│'))).toBe(true);
    expect(tui.commands.filter(command => command.type === 'chat.send')).toHaveLength(1);
  });
});
