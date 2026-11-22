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
    // The rows read, not the scrollbar beside them: its thumb moves as the reply grows.
    const harness = tui;
    const reading = async () => (await harness.text()).split('\n').flatMap(l => l.match(/Answer row \d+/) ?? []);
    const before = await reading();
    tui.event('chat.delta', { delta: 'Fresh streaming content', iteration: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await reading()).toEqual(before);
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

  test('the wheel and resize reach old history while composer and status stay fixed', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 100 }, (_, n) => `History line ${n}`).join('\n') });
    await tui.waitFor('History line 99');
    expect(tui.screen.modes.mouseTrackingMode).toBe('any');
    tui.send('unsent composer text');
    await tui.waitFor('unsent composer text');
    const footer = (await tui.text()).split('\n').slice(-6);
    tui.send('\x1b[<64;10;5M');
    await tui.waitFor('End: latest');
    expect((await tui.text()).split('\n').slice(-6)).toEqual(footer);
    tui.send('\x1b[1;5H'); // Ctrl+Home
    await tui.waitFor('History line 0');
    tui.resize(50, 16);
    await tui.waitFor('History line 0');
    await tui.waitFor('unsent composer text');
    tui.send('\x1b[1;5F'); // Ctrl+End
    await tui.waitFor('History line 99');
    expect((await tui.text()).split('\n').at(-1)).toContain('Octipus');
    await tui.waitFor('connected');
    expect(tui.screen.modes.mouseTrackingMode).toBe('any');
    expect(await tui.text()).toContain('unsent composer text');
    expect(tui.commands.some(command => command.type === 'chat.send')).toBe(false);
  });
});
