/** Notifications while the terminal is out of focus, and the state in the window title. */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const FOCUS_OUT = '\x1b[O';
const FOCUS_IN = '\x1b[I';
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const notifications = (h: TuiHarness) => h.rawOutput().match(/\x1b\]777;notify;[^\x07]*\x07/g) ?? [];

describe.skipIf(process.platform === 'win32')('attention in a real terminal', () => {
  test('a turn ending or a decision waiting while unfocused notifies; the title says what the chat does', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, [], { files: { '.octipus/tui.json': '{ "notify": "osc777" }' } });
    await tui.waitFor('connected');
    expect(tui.rawOutput()).toContain('\x1b[?1004h');
    expect(tui.rawOutput()).toContain('\x1b]0;Octipus — project\x07');
    tui.send('a long question\r');
    await tui.waitFor('A streaming reply');
    await settle();
    expect(tui.rawOutput()).toContain('\x1b]0;Octipus — project · working…\x07');
    // Focused: the reply ends the turn without a notification.
    tui.event('chat.response', { response: 'First answer.' });
    await tui.waitFor('First answer.');
    expect(notifications(tui)).toEqual([]);
    tui.send(FOCUS_OUT);
    tui.send('another\r');
    await tui.waitFor('│ another');
    tui.event('chat.response', { response: 'Second answer.' });
    await tui.waitFor('Second answer.');
    await settle();
    expect(notifications(tui)).toEqual(['\x1b]777;notify;Octipus;The reply is ready\x07']);
    tui.event('agent.approval_required', { requestId: 'q1', question: 'Deploy now?', options: ['Yes', 'No'] });
    await tui.waitFor('Deploy now?');
    await settle();
    expect(notifications(tui).at(-1)).toBe('\x1b]777;notify;Octipus;A decision is waiting for you\x07');
    expect(tui.rawOutput()).toContain('\x1b]0;Octipus — project · waiting for you\x07');
    tui.send(FOCUS_IN);
    tui.send('1');
    await tui.waitFor('Deploy now?', true);
    await settle();
    // Answered: the title is back to idle.
    expect(tui.rawOutput().lastIndexOf('\x1b]0;Octipus — project\x07')).toBeGreaterThan(tui.rawOutput().lastIndexOf('waiting for you'));
    expect(notifications(tui)).toHaveLength(2);
  });

  test('inline, focus reports are turned on and off by the app and never reach the composer', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, ['--inline']);
    await tui.waitFor('connected');
    expect(tui.rawOutput()).toContain('\x1b[?1004h');
    tui.send('draft');
    tui.send(FOCUS_OUT); tui.send(FOCUS_IN);
    await tui.waitFor('draft');
    await settle();
    const screen = await tui.text();
    expect(screen).not.toContain('[O');
    expect(screen).not.toContain('[I');
    tui.send('\x1b'); await tui.waitFor('Esc again to clear the draft');
    tui.send('\x1b'); await tui.waitFor('draft', true);
    tui.send('/quit\r');
    await tui.exited;
    expect(tui.rawOutput()).toContain('\x1b[?1004l');
  });
});
