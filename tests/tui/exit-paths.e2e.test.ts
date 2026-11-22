import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const lastIndex = (text: string, needle: string) => text.lastIndexOf(needle);

const PATHS = [
  ['an uncaught exception', 'throw', 1, 'fixture exception'],
  ['an unhandled rejection', 'reject', 1, 'fixture rejection'],
  ['process.exit', 'exit', 3, undefined],
  ['SIGHUP', 'hangup', 129, undefined],
] as const;

describe.skipIf(process.platform === 'win32')('the terminal is restored on every way out', () => {
  describe.each([
    ['alternate screen', [] as string[], 'any', '\x1b[?1006l'],
    ['inline', ['--inline'], 'vt200', '\x1b[?1000l'],
  ])('%s', (_screen, flags, tracking, mouseOff) => {
    test.each(PATHS)('%s', async (_label, path, code, message) => {
      tui = await TuiHarness.start('tests/tui/fixtures/exit-paths.ts', 80, 20, [...flags, path], { preamble: 'shell history before launch\n' });
      await tui.waitFor('exit-path fixture ready');
      expect(tui.screen.modes.mouseTrackingMode).toBe(tracking);
      expect(await tui.bufferType()).toBe(flags.length ? 'normal' : 'alternate');
      expect(await tui.exited).toBe(code);
      await tui.text();
      const raw = tui.rawOutput();
      expect(await tui.bufferType()).toBe('normal');
      expect(await tui.normalBuffer()).toContain('shell history before launch');
      expect(tui.screen.modes.mouseTrackingMode).toBe('none');
      expect(tui.screen.modes.bracketedPasteMode).toBe(false);
      // The cursor was hidden while running and is shown again last.
      expect(lastIndex(raw, '\x1b[?25l')).toBeGreaterThan(-1);
      expect(lastIndex(raw, '\x1b[?25h')).toBeGreaterThan(lastIndex(raw, '\x1b[?25l'));
      expect(raw).toContain('raw-after-exit:false');
      // The user's window title is saved before the app sets its own, and put back on the way out.
      expect(raw.indexOf('\x1b[22;0t')).toBeGreaterThan(-1);
      expect(raw.indexOf('\x1b[22;0t')).toBeLessThan(raw.indexOf('\x1b]0;exit paths'));
      expect(lastIndex(raw, '\x1b[23;0t')).toBeGreaterThan(lastIndex(raw, '\x1b]0;'));
      if (message) {
        // Printed once the screen is back, not inside the frame.
        expect(raw.indexOf(message)).toBeGreaterThan(lastIndex(raw, mouseOff));
        if (!flags.length) expect(raw.indexOf(message)).toBeGreaterThan(lastIndex(raw, '\x1b[?1049l'));
        expect(await tui.text()).toContain(message);
      }
    });
  });
});
