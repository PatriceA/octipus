/**
 * Terminal compatibility (plan §7, Phase 6 item 2): what this harness can
 * express of tmux, SSH, the Linux console, dumb terminals and very small
 * windows. The outer screen is always xterm's model (`@xterm/headless`); tmux
 * is the real multiplexer in between. docs/guides/tui.md, "Terminal
 * compatibility", lists what is not covered.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await tui?.stop(); tui = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
// SGR coordinates are 1-based; screen rows and columns below are 0-based.
const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`;
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`;
const wheelUp = (col: number, row: number) => `\x1b[<64;${col + 1};${row + 1}M`;
const decoded = (request: string | undefined) => Buffer.from((request ?? '').replace(/^[^;]*;/, ''), 'base64').toString();

async function find(h: TuiHarness, needle: string): Promise<{ row: number; col: number }> {
  const rows = (await h.text()).split('\n');
  const row = rows.findIndex(line => line.includes(needle));
  if (row < 0) throw new Error(`no row shows ${needle}:\n${rows.join('\n')}`);
  return { row, col: rows[row].indexOf(needle) };
}

/** No row of the visible screen wrapped into the next: everything drawn fits the width. */
async function expectNoWrappedRow(h: TuiHarness): Promise<void> {
  await h.text();
  const b = h.screen.buffer.active;
  const wrapped = Array.from({ length: h.screen.rows }, (_, row) => row).filter(row => b.getLine(b.viewportY + row)?.isWrapped);
  expect(wrapped, await h.text()).toEqual([]);
}

/** A tmux on its own socket with `conf`, killed after the test whatever happened. */
function tmux(conf: string): { socket: string; wrap: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'tui-tmux-'));
  const file = join(dir, 'tmux.conf');
  writeFileSync(file, conf);
  const socket = `octi-tui-compat-${process.pid}-${cleanups.length}`;
  cleanups.push(() => {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* the server already exited with its last pane */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return { socket, wrap: ['tmux', '-L', socket, '-f', file, 'new-session', '--'] };
}

/** The settings docs/guides/tui.md recommends. */
const RECOMMENDED = 'set -g mouse on\nset -g set-clipboard on\nset -g allow-passthrough on\nset -g status on\n';

describe.skipIf(process.platform === 'win32' || !hasTmux)('inside tmux', () => {
  // tmux 3.4's defaults (`mouse off`, `set-clipboard external`) behave the same for Octipus: a pane that asks
  // for the mouse gets it, and `load-buffer -w` reaches the outer terminal. Both are run so a tmux that changes that is noticed.
  test.each([['the recommended settings', RECOMMENDED], ['tmux defaults', '']])('the editor with %s: frame above tmux\'s status, mouse through tmux, a drag-copy lands in the tmux buffer and reaches the outer terminal as OSC 52', async (_name, conf) => {
    const { socket, wrap } = tmux(conf);
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 30, [], { wrap });
    await tui.waitFor('focus:editor'); await tui.ready();
    let screen = (await tui.text()).split('\n');
    // tmux's status line is the last row; the editor's mode bar is directly above it.
    expect(screen.at(-2)).toContain('focus:editor');
    // The app asked tmux for mouse reports; tmux forwards the outer terminal's clicks.
    const tree = await find(tui, 'example.ts');
    tui.send(press(tree.col, tree.row) + release(tree.col, tree.row));
    await tui.waitFor('const greeting');
    const word = await find(tui, 'greeting');
    tui.send(press(word.col, word.row)); tui.send(drag(word.col + 8, word.row)); tui.send(release(word.col + 8, word.row));
    await tui.waitFor('tmux buffer');
    expect(execFileSync('tmux', ['-L', socket, 'show-buffer'], { encoding: 'utf8' })).toBe('greeting');
    // set-clipboard on: tmux hands the buffer on to the terminal it runs in.
    for (let i = 0; i < 100 && !tui.clipboardRequests.length; i++) await settle(30);
    expect(decoded(tui.clipboardRequests.at(-1))).toBe('greeting');
    for (const [cols, rows] of [[80, 20], [140, 40]]) { tui.resize(cols, rows); await settle(); }
    await tui.waitFor('const greeting');
    screen = (await tui.text()).split('\n');
    // The mode bar row: the copy notice stays there until the next action.
    expect(screen.at(-2)).toMatch(/focus:editor|Copied to the tmux buffer/);
    expect(screen.at(-1)).toContain('Octipus Editor');
    await expectNoWrappedRow(tui);
    tui.send(KEY.CtrlQ);
    expect(await tui.exited).toBe(0);
  });

  test('the chat: the wheel scrolls the transcript through tmux, and /copy reaches the outer terminal', async () => {
    const { wrap } = tmux(RECOMMENDED);
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { wrap });
    await tui.ready();
    tui.event('chat.response', { response: Array.from({ length: 80 }, (_, n) => `Wheel line ${n}`).join('\n') });
    await tui.waitFor('Wheel line 79');
    const line = await find(tui, 'Wheel line 70');
    for (let i = 0; i < 5; i++) tui.send(wheelUp(line.col, line.row));
    await tui.waitFor('End: latest');
    await tui.waitFor('Wheel line 79', true);
    tui.send(KEY.End); await tui.waitFor('Wheel line 79');
    tui.send('/copy last\r'); await tui.waitFor('tmux buffer');
    for (let i = 0; i < 100 && !tui.clipboardRequests.length; i++) await settle(30);
    expect(decoded(tui.clipboardRequests.at(-1))).toContain('Wheel line 79');
    tui.send('/quit\r');
    expect(await tui.exited).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('other terminals', () => {
  test('over SSH, a copy goes to the local terminal as OSC 52, not to a clipboard tool on the remote host', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], {
      env: { SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22', SSH_TTY: '/dev/pts/9', DISPLAY: ':0' },
    });
    await tui.waitFor('connected');
    tui.event('chat.response', { response: 'Copied over SSH' });
    await tui.waitFor('Copied over SSH');
    tui.send('/copy last\r'); await tui.waitFor('OSC 52');
    expect(decoded(tui.clipboardRequests.at(-1))).toBe('Copied over SSH');
  });

  test('TERM=linux (the Linux console): both surfaces draw, keep their last row, and quit cleanly', async () => {
    const env = { TERM: 'linux', COLORTERM: undefined };
    tui = await TuiHarness.start('src/tui-pi/index.ts', 80, 25, [], { env });
    await tui.waitFor('connected');
    expect((await tui.text()).split('\n').at(-1)).toContain('● Octipus');
    await expectNoWrappedRow(tui);
    tui.send('/quit\r');
    expect(await tui.exited).toBe(0);
    await tui.stop();
    tui = await TuiHarness.start('src/tui-editor/index.ts', 80, 25, [], { env });
    await tui.waitFor('focus:editor');
    expect((await tui.text()).split('\n').at(-1)).toContain('focus:editor');
    await expectNoWrappedRow(tui);
    tui.send(KEY.CtrlQ);
    expect(await tui.exited).toBe(0);
  });

  for (const [entry, command] of [['src/tui-pi/index.ts', 'octi tui'], ['src/tui-editor/index.ts', 'octi edit']] as const) {
    test(`TERM=dumb: ${command} refuses with a reason and writes no screen`, async () => {
      tui = await TuiHarness.start(entry, 100, 10, [], { env: { TERM: 'dumb' } });
      expect(await tui.exited).toBe(2);
      expect((await tui.text()).replace(/\s+/g, ' ')).toContain(`${command} needs a terminal that can move the cursor`);
      expect(tui.rawOutput()).not.toContain('\x1b[?1049h');
      expect(tui.rawOutput()).not.toContain('\x1b[?1000h');
    });
  }

  test('20x5: the chat keeps its status on the last row and the composer above it, with no wrapped row', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 20, 5);
    await tui.waitFor('connec');
    tui.send('hi there');
    await tui.waitFor('hi there');
    const screen = (await tui.text()).split('\n');
    expect(screen.at(-1)).toContain('● Octipus');
    expect(screen.findIndex(row => row.includes('hi there'))).toBeLessThan(4);
    expect(tui.screen.buffer.active.cursorY).toBeLessThan(4);
    await expectNoWrappedRow(tui);
    tui.resize(100, 28); await tui.waitFor('connected');
    tui.resize(20, 5); await settle();
    await expectNoWrappedRow(tui);
    tui.send('\x15/quit\r');
    expect(await tui.exited).toBe(0);
  });

  test('20x5: the editor keeps its mode bar on the last row with no wrapped row, opens a file, and quits', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 20, 5);
    await tui.waitFor('focus:editor');
    expect((await tui.text()).split('\n').at(-1)).toContain('focus:editor');
    await expectNoWrappedRow(tui);
    tui.send(KEY.CtrlO); await settle();
    tui.send('example.ts\r'); await settle(500);
    tui.send(KEY.Esc); await settle();
    tui.resize(30, 6); await settle();
    expect((await tui.text()).split('\n').at(-1)).toContain('EDIT');
    await expectNoWrappedRow(tui);
    tui.send(KEY.CtrlQ);
    expect(await tui.exited).toBe(0);
  });
});
