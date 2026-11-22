/** Pickers in a real terminal: sessions, skills and commands, from the one fuzzy list. */
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const SESSIONS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'Fix the parser', updatedAt: '2026-11-20T10:00:00.000Z', messages: 12, channel: 'tui' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000000', title: 'Plan the release', updatedAt: '2026-11-21T09:30:00.000Z', messages: 4, channel: 'web' },
];
const SKILLS = 'Skills: /skills [list] | /skills <id or name> always|session|auto\n\nresearch-notes — Research notes [automatic]\ntech-writing — Technical Writing [always]';

describe.skipIf(process.platform === 'win32')('pickers in a real terminal', () => {
  test('/sessions opens a filtered list with a preview; Enter resumes the session', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { commandResults: {
      sessions: { result: ' 1  aaaaaaaa …', data: SESSIONS },
      history: { result: '…', data: [{ role: 'user', content: 'when do we ship?', at: '2026-11-21T09:30:00.000Z' }] },
    } });
    await tui.waitFor('connected');
    tui.send('/sessions\r');
    await tui.waitFor('Sessions 2/2');
    expect(await tui.text()).toContain('Updated 2026-11-20 10:00 · 12 messages · from tui');
    tui.send('release');
    await tui.waitFor('Sessions 1/2');
    await tui.saveScreen('picker-sessions');
    tui.send(KEY.Enter);
    await tui.waitFor('when do we ship?');
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'command', name: 'history', sessionId: SESSIONS[1]?.id }));
  });

  test('/skills: a skill, then how to use it, sent as the textual command', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { commandResults: { skills: { result: SKILLS } } });
    await tui.waitFor('connected');
    tui.send('/skills\r');
    await tui.waitFor('Skills 2/2');
    tui.send('research'); tui.send(KEY.Enter);
    await tui.waitFor('How to use: Research notes');
    tui.send('always'); tui.send(KEY.Enter);
    await tui.waitFor('How to use', true);
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'command', name: 'skills', args: { value: 'research-notes always' } }));
  });

  test('the command palette is the same list: fuzzy filter, preview, a click chooses', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.waitFor('connected');
    tui.send(KEY.CtrlP);
    await tui.waitFor('Commands');
    tui.send('hotk');
    await tui.waitFor('Show the chat shell keybindings');
    const row = (await tui.text()).split('\n').findIndex(line => line.includes('› /hotkeys')) + 1;
    tui.send(`\x1b[<0;20;${row}M\x1b[<0;20;${row}m`);
    // The list is longer than the screen: its rows, not its heading, are what shows.
    await tui.waitFor('Show hotkeys');
  });
});
