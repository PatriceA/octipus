/**
 * The chat inside tmux (plan §4.4 criterion 4, the part this harness can run):
 * the outer screen is xterm, tmux is the real multiplexer in between. Real
 * terminal emulators (VTE, Kitty, iTerm2, Windows Terminal) are not covered
 * here.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

describe.skipIf(process.platform === 'win32' || !hasTmux)('the chat inside tmux', () => {
  test('keeps the composer and status pinned through resizes, copies to the tmux buffer, and quits cleanly', async () => {
    const socket = `octi-tui-test-${process.pid}`;
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], {
      wrap: ['tmux', '-L', socket, '-f', '/dev/null', 'new-session', '--'],
    });
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 60 }, (_, n) => `Tmux line ${n}`).join('\n') });
    await tui.waitFor('Tmux line 59');
    tui.send('draft in tmux'); await tui.waitFor('draft in tmux');
    for (const [cols, rows] of [[70, 20], [120, 40], [100, 28]]) { tui.resize(cols, rows); await settle(); }
    await tui.waitFor('draft in tmux');
    const screen = (await tui.text()).split('\n');
    // tmux draws its own status line on the last row; ours is directly above it.
    expect(screen.at(-2)).toContain('● Octipus');
    expect(screen.findIndex(row => row.includes('draft in tmux'))).toBeGreaterThan(screen.findIndex(row => row.includes('Tmux line 59')));
    tui.send('\x15'); // Ctrl+U clears the draft
    tui.send('/copy last\r'); await tui.waitFor('tmux buffer');
    const buffer = execFileSync('tmux', ['-L', socket, 'show-buffer'], { encoding: 'utf8' });
    expect(buffer).toBe(Array.from({ length: 60 }, (_, n) => `Tmux line ${n}`).join('\n'));
    tui.send('/quit\r');
    expect(await tui.exited).toBe(0);
  });
});
