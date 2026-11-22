/** The plan summary follows the gateway's session.plan_updated instead of a 4 s poll. */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

describe.skipIf(process.platform === 'win32')('plan status in a real terminal', () => {
  test('fetched on connect and when the plan changes, not on a timer', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('1/3 steps done');
    const fetches = () => tui!.commands.filter(command => command.type === 'command' && command.name === 'work-plan-status').length;
    const before = fetches();
    await new Promise(resolve => setTimeout(resolve, 4500));
    expect(fetches()).toBe(before);
    tui.event('session.plan_updated', { revision: 2 });
    const start = Date.now();
    while (fetches() === before && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetches()).toBe(before + 1);
  }, 20_000);
});
