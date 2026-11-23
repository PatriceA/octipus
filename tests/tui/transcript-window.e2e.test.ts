/** The rendered window of the transcript in a real terminal. */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const SESSION = 'cccccccc-0000-4000-8000-000000000000';
const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, n)).toISOString();

describe.skipIf(process.platform === 'win32')('the rendered window in a real terminal', () => {
  test('scrolling up with nothing else happening brings in the messages above the rendered window', async () => {
    // 250 replayed messages without ids (nothing to page from the server): the newest 200 are rendered, 50 wait above them.
    const rows = Array.from({ length: 250 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `Turn number ${n}`, at: at(n) }));
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, ['--session', SESSION], { commandResults: { history: { result: '…', data: rows } } });
    await tui.waitFor('Turn number 249');
    for (let n = 0; n < 10 && !/Turn number 0\s*\n/.test(await tui.text()); n++) {
      tui.send('\x1b[1;5H'); // Ctrl+Home: the top of what is rendered
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    expect(await tui.text()).toMatch(/Turn number 0\s*\n/);
    expect(await tui.text()).not.toContain('earlier messages above');
  });
});
