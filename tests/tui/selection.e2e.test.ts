import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness, KEY } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const press = (col: number, row: number) => `\x1b[<0;${col};${row}M`;
const drag = (col: number, row: number) => `\x1b[<32;${col};${row}M`;
const release = (col: number, row: number) => `\x1b[<0;${col};${row}m`;
const decoded = (request: string | undefined) => Buffer.from((request ?? '').slice(2), 'base64').toString();
const response = Array.from({ length: 80 }, (_, n) => `Copy line ${n}`).join('\n');

describe.skipIf(process.platform === 'win32')('mouse and selection on the alternate screen', () => {
  test('the wheel scrolls and a drag selects transcript text, with no modifier, and copies it without the rail', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.waitFor('connected');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    // Any-motion SGR reporting: what terminals override with Shift (Option in iTerm2) for their own selection.
    expect(tui.screen.modes.mouseTrackingMode).toBe('any');
    tui.send('\x1b[<64;10;5M'); await tui.waitFor('End: latest');

    const rows = (await tui.text()).split('\n');
    const first = rows.findIndex(row => /^ {2}Copy line \d+/.test(row));
    const expected = rows.slice(first, first + 3).map(row => row.replace(/[│┃]\s*$/, '').trim());
    tui.send(press(1, first + 1)); tui.send(drag(40, first + 3)); tui.send(release(40, first + 3));
    await tui.waitFor('OSC 52');
    expect(decoded(tui.clipboardRequests.at(-1))).toBe(expected.join('\n'));
    // Nothing of the gesture reached the composer or the gateway.
    expect(tui.commands.some(command => command.type === 'chat.send')).toBe(false);
  });

  test('/copy uses the same chain: a native tool when one is local, and says so', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'tui-clipboard-'));
    const sink = join(bin, 'copied.txt');
    writeFileSync(join(bin, 'xclip'), `#!/bin/sh\ncat > "${sink}"\n`); chmodSync(join(bin, 'xclip'), 0o755);
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { env: { DISPLAY: ':99', PATH: `${bin}:${process.env.PATH}` } });
    await tui.waitFor('connected');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    tui.send('/copy last\r'); await tui.waitFor('Copied with xclip');
    expect(readFileSync(sink, 'utf8')).toBe(response);
    expect(tui.clipboardRequests).toEqual([]);
    rmSync(bin, { recursive: true, force: true });
  });

  test('/copy falls back to OSC 52 and says the terminal may refuse it', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.waitFor('connected');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    tui.send('/copy last\r'); await tui.waitFor('OSC 52');
    expect(await tui.text()).toContain('refused');
    expect(decoded(tui.clipboardRequests.at(-1))).toBe(response);
  });

  test('tui.mouse native: no mouse reporting, alternate scroll, Up on an empty composer scrolls', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, ['--mouse', 'native']);
    await tui.waitFor('connected');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    expect(tui.screen.modes.mouseTrackingMode).toBe('none');
    expect(tui.rawOutput()).toContain('\x1b[?1007h');
    tui.send('\x1b[A'); await tui.waitFor('End: latest');
    await tui.stop();
    expect(tui.rawOutput().lastIndexOf('\x1b[?1007l')).toBeGreaterThan(tui.rawOutput().lastIndexOf('\x1b[?1007h'));
  });

  test('tui.mouse off, from ~/.octipus/tui.json: no mouse reporting and no alternate scroll', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { files: { '.octipus/tui.json': '{ "mouse": "off" }' } });
    await tui.waitFor('connected');
    expect(tui.screen.modes.mouseTrackingMode).toBe('none');
    expect(tui.rawOutput()).not.toContain('\x1b[?1007h');
    expect(await tui.bufferType()).toBe('alternate');
  });

  test('a bad --mouse value stops before the screen is taken, naming the choices', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, ['--mouse', 'sometimes']);
    expect(await tui.exited).toBe(2);
    await tui.text();
    expect(tui.rawOutput()).not.toContain('\x1b[?1049h');
    expect(await tui.text()).toContain('--mouse takes one of app, native, off');
  });
});

describe.skipIf(process.platform === 'win32')('the editor on the alternate screen', () => {
  test('keeps wheel scrolling, its own PageUp/Ctrl+Home and /copy in the chat pane', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 100, 28);
    await tui.waitFor('connected');
    tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    expect(await tui.bufferType()).toBe('alternate');
    tui.send('\x1b[<64;80;10M'); await tui.waitFor('End: latest');
    tui.send('\x1b[1;5F'); // Ctrl+End before the clipboard request.
    tui.send('/copy last\r'); await tui.waitFor('OSC 52');
    expect(decoded(tui.clipboardRequests.at(-1))).toBe(response);
    tui.send('unsent selection draft'); await tui.waitFor('unsent selection draft');
    tui.send('\x1b[1;5H'); await tui.waitFor('Copy line 0');
    tui.resize(85, 24); await tui.waitFor('Copy line 0');
    await tui.waitFor('unsent selection draft');
    expect(tui.commands.some(command => command.type === 'chat.send')).toBe(false);
  });
});
