/** A resumed session's older turns load from the server as the reader scrolls up (REST paging, the web's route). */
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const SESSION = 'cccccccc-0000-4000-8000-000000000000';
const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, n)).toISOString();
const turn = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, role: n % 2 ? 'assistant' : 'user', content: `Turn number ${n}` });
/** The replay: turns 100–149, each with its id. */
const REPLAY = Array.from({ length: 50 }, (_, i) => ({ ...turn(100 + i), at: at(100 + i) }));

describe.skipIf(process.platform === 'win32')('older turns in a real terminal', () => {
  test('PageUp to the top loads the turns before the replay, page by page, and stops when there are none', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, ['--session', SESSION], {
      commandResults: { history: { result: '…', data: REPLAY } },
      http: (path) => {
        const url = new URL(`http://x${path}`);
        if (url.pathname !== `/sessions/${SESSION}/messages`) return undefined;
        const before = url.searchParams.get('before');
        const pageOf = (from: number, to: number, hasMore: boolean) => ({
          body: { messages: Array.from({ length: to - from }, (_, i) => ({ ...turn(from + i), createdAt: at(from + i) })), hasMore, nextCursor: hasMore ? turn(from).id : null },
        });
        if (before === turn(100).id) return pageOf(40, 100, true);
        if (before === turn(40).id) return pageOf(0, 40, false);
        return { status: 400, body: { error: `unexpected cursor ${before}` } };
      },
    });
    await tui.waitFor('Turn number 149');
    expect(tui.requests).toEqual([]); // reading the latest: nothing asked yet
    for (let n = 0; n < 40 && !(await tui.text()).includes('Turn number 100'); n++) tui.send(KEY.PageUp);
    await tui.waitFor('Turn number 99');
    expect(tui.requests[0]?.path).toBe(`/api/sessions/${SESSION}/messages?page=true&limit=100&before=${turn(100).id}&roles=user%2Cassistant&aggregate=false`);
    expect(tui.requests[0]?.authorization).toBe('Bearer test-session-token');
    // The reading position held: the page went in above it.
    expect(await tui.text()).toContain('Turn number 100');
    tui.send('\x1b[1;5H'); // Ctrl+Home: the top, which asks for the next page
    await tui.waitFor('Turn number 39');
    expect(tui.requests).toHaveLength(2);
    tui.send('\x1b[1;5H'); // the page went in above the reading position: the top again shows it
    await tui.waitFor('Turn number 0\n');
    expect(await tui.text()).not.toContain('Older messages are on the server');
    tui.send('\x1b[1;5H');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(tui.requests).toHaveLength(2); // nothing more on the server: nothing more asked
    await tui.saveScreen('older-turns');
  });

  test('a failed load is said at the top of the transcript', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, ['--session', SESSION], {
      commandResults: { history: { result: '…', data: REPLAY.slice(-3) } },
      http: () => ({ status: 502, body: { error: 'Upstream unavailable' } }),
    });
    // Three turns fit on the screen: the top is in view and the transcript asks at once.
    await tui.waitFor('Older messages could not be loaded: Upstream unavailable');
    expect(await tui.text()).toContain('Turn number 149');
  });
});
