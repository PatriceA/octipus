/** Esc stops the running turn; messages typed during it queue above the composer and go out when it ends. */
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const chats = (h: TuiHarness) => h.commands.filter(command => command.type === 'chat.send');

describe.skipIf(process.platform === 'win32')('turn control in a real terminal', () => {
  test('typing during a turn queues visibly; the turn ending sends it as its own turn', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    tui.send('first question'); tui.send(KEY.Enter);
    await tui.waitFor('A streaming reply');
    tui.send('second question'); tui.send(KEY.Enter);
    await tui.waitFor('⧗ queued 1 · second question');
    const rows = (await tui.text()).split('\n');
    // Above the composer, below the transcript.
    const queued = rows.findIndex(row => row.includes('⧗ queued 1'));
    expect(rows.findIndex(row => row.includes('sent when the turn ends'))).toBe(queued + 1);
    expect(chats(tui)).toHaveLength(1);
    tui.event('chat.response', { response: 'First answer.' });
    await tui.waitFor('⧗ queued', true);
    await tui.waitFor('│ second question');
    expect(chats(tui).at(-1)).toMatchObject({ content: 'second question', mode: 'queue' });
  });

  test('Esc stops the turn by its root agent, returns the queued message, and a second Esc clears the draft', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    tui.send('long task'); tui.send(KEY.Enter);
    await tui.waitFor('A streaming reply');
    tui.event('agent.spawned', { agentId: 'root-1', role: 'general', model: 'fixture-model' });
    tui.send('follow-up'); tui.send(KEY.Enter);
    await tui.waitFor('⧗ queued 1 · follow-up');
    tui.send(KEY.Esc);
    await tui.waitFor('Stopping the turn (Esc)');
    expect(tui.commands).toContainEqual({ type: 'agent.stop', agentId: 'root-1' });
    await tui.waitFor('back in the composer');
    await tui.waitFor('⧗ queued', true);
    tui.event('agent.stopped', { agentId: 'root-1' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(chats(tui)).toHaveLength(1);
    expect((await tui.text()).split('\n').some(row => row.includes('follow-up') && !row.includes('│'))).toBe(true);
    tui.send(KEY.Esc);
    await tui.waitFor('follow-up', true);
  });

  test('a queued message clicked goes back into the composer and is not sent', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    tui.send('first'); tui.send(KEY.Enter);
    await tui.waitFor('A streaming reply');
    tui.send('second with a tpyo'); tui.send(KEY.Enter);
    await tui.waitFor('⧗ queued 1');
    const row = (await tui.text()).split('\n').findIndex(line => line.includes('⧗ queued 1')) + 1;
    tui.send(`\x1b[<0;5;${row}M\x1b[<0;5;${row}m`);
    await tui.waitFor('⧗ queued', true);
    tui.event('chat.response', { response: 'Done.' });
    await tui.waitFor('Done.');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(chats(tui)).toHaveLength(1);
    expect(await tui.text()).toContain('second with a tpyo');
  });
});
