import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const lastIndex = (text: string, needle: string) => text.lastIndexOf(needle);

describe.skipIf(process.platform === 'win32')('the terminal is restored on every way out', () => {
  test.each([
    ['an uncaught exception', 'throw', 1, 'fixture exception'],
    ['an unhandled rejection', 'reject', 1, 'fixture rejection'],
    ['process.exit', 'exit', 3, undefined],
    ['SIGHUP', 'hangup', 129, undefined],
  ])('%s', async (_label, path, code, message) => {
    tui = await TuiHarness.start('tests/tui/fixtures/exit-paths.ts', 80, 20, [path]);
    await tui.waitFor('exit-path fixture ready');
    expect(tui.screen.modes.mouseTrackingMode).toBe('vt200');
    expect(await tui.exited).toBe(code);
    await tui.text();
    const raw = tui.rawOutput();
    expect(tui.screen.modes.mouseTrackingMode).toBe('none');
    expect(tui.screen.modes.bracketedPasteMode).toBe(false);
    // The cursor was hidden while running and is shown again last.
    expect(lastIndex(raw, '\x1b[?25l')).toBeGreaterThan(-1);
    expect(lastIndex(raw, '\x1b[?25h')).toBeGreaterThan(lastIndex(raw, '\x1b[?25l'));
    expect(raw).toContain('raw-after-exit:false');
    if (message) {
      // Printed once the screen is back, not inside the frame.
      expect(raw.indexOf(message)).toBeGreaterThan(lastIndex(raw, '\x1b[?1000l'));
      expect(await tui.text()).toContain(message);
    }
  });
});
