import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness, KEY } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

describe.skipIf(process.platform === 'win32')('chat in a real POSIX terminal', () => {
  test('renders distinct turns, streams replies, and keeps a visible plan with feedback', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts');
    await tui.waitFor('connected');
    tui.send('Please check rendering 世界 🐙'); tui.send(KEY.Enter);
    await tui.waitFor('A streaming reply');
    const screen = await tui.text();
    expect(screen).toContain('You'); expect(screen).toContain('│ Please check rendering'); expect(screen).toContain('Octipus');
    tui.send('/work-plan\r'); await tui.waitFor('/plan-hide');
    await tui.saveScreen('chat');
    tui.send('/plan-feedback Keep the layout simple\r'); await tui.waitFor('Feedback saved as pending.');
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'command', name: 'plan-feedback', args: { value: 'Keep the layout simple' } }));
    tui.resize(50, 16); await tui.waitFor('Plan');
    expect(tui.screen.buffer.active.cursorY).toBeLessThan(16);
    tui.send('/plan-hide\r'); await tui.waitFor('/plan-hide ·', true);
  });

  test('scrolls one long answer and answers queued decisions without losing either', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 50 }, (_, n) => `Answer row ${n}`).join('\n') });
    await tui.waitFor('Answer row 49');
    tui.send(KEY.PageUp); await tui.waitFor('End: latest');
    const before = (await tui.text()).split('\n').filter(l => l.includes('Answer row'));
    tui.event('chat.delta', { delta: 'Fresh streaming content', iteration: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await tui.text()).split('\n').filter(l => l.includes('Answer row'))).toEqual(before);
    tui.send(KEY.End); await tui.waitFor('Fresh streaming content');
    for (const [requestId, question] of [['a', 'First decision?'], ['b', 'Second decision?']]) {
      tui.event('agent.approval_required', { requestId, question, options: ['Continue', 'Revise'] });
    }
    await tui.waitFor('First decision?'); tui.send('2');
    await tui.waitFor('Second decision?'); tui.send(KEY.Esc);
    await tui.waitFor('Second decision?', true);
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'approval.respond', requestId: 'a', response: 'Revise' }));
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'approval.respond', requestId: 'b', approved: false }));
  });
});
