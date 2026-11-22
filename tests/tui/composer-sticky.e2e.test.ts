import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const settle = () => new Promise(resolve => setTimeout(resolve, 400));

describe.skipIf(process.platform === 'win32')('composer stays on screen during a turn', () => {
  test.each([
    ['a multi-line shell command', 'for f in *.ts; do\n  wc -l "$f"\ndone'],
    ['a carriage return', 'printf "a\rb"'],
    ['a tab and an escape sequence', 'echo\t\x1b[2Jdone'],
  ])('tool preview with %s does not push the composer off screen', async (_label, command) => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: Array.from({ length: 60 }, (_, n) => `History line ${n}`).join('\n') });
    await tui.waitFor('History line 59');
    tui.send('draft stays visible');
    await tui.waitFor('draft stays visible');
    tui.event('agent.started', { agentId: 'root', role: 'general', model: 'test-model' });
    tui.event('agent.action', { agentId: 'root', data: { type: 'tool_call', toolName: 'shell', args: { command } } });
    await settle();
    const rows = (await tui.text()).split('\n');
    // Composer, then the status rows, with the transcript still above them.
    const draft = rows.findIndex(row => row.includes('draft stays visible'));
    expect(draft).toBeGreaterThan(rows.findIndex(row => row.includes('History line 59')));
    expect(rows.at(-1)).toContain('● Octipus');
    expect(rows.filter(row => row.includes('● Octipus'))).toHaveLength(1);
    expect(rows.join('\n')).toContain('shell');
    // The activity row is one row: nothing of the command spilled below it.
    expect(rows.slice(draft).join('\n')).not.toContain("wc -l");
  });
});

describe.skipIf(process.platform === 'win32')('decision prompts with multi-line text', () => {
  test('an agent question spanning lines keeps its box and the frame intact', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    await tui.waitFor('connected');
    tui.send('draft stays visible');
    await tui.waitFor('draft stays visible');
    tui.event('agent.approval_required', { requestId: 'q', question: 'Run this?\nfor f in *; do\n  rm "$f"\ndone', options: ['Yes', 'No'] });
    await tui.waitFor('Run this?');
    await settle();
    const rows = (await tui.text()).split('\n');
    expect(rows.at(-1)).toContain('● Octipus');
    expect(rows.join('\n')).toContain('rm "$f"');
    // Each line of the question is its own closed row of the box.
    const screen = rows.join('\n');
    for (const line of [/│ Run this\? +│/, /│ for f in \*; do +│/, /│ {3}rm "\$f" +│/, /│ done +│/]) expect(screen).toMatch(line);
  });

  test('a question taller than the screen scrolls in its box and leaves the status line and choices visible', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 16);
    await tui.waitFor('connected');
    const question = Array.from({ length: 40 }, (_, n) => `question line ${n}`).join('\n');
    tui.event('agent.approval_required', { requestId: 'tall', question, options: ['Keep', 'Revise'] });
    await tui.waitFor('1. Keep');
    await settle();
    const rows = (await tui.text()).split('\n');
    expect(rows.at(-1)).toContain('● Octipus');
    expect(rows.join('\n')).toContain('Esc decline');
    expect(rows.join('\n')).toContain('question line 0');
    tui.send('\x1b[B'); await tui.waitFor('question line 0', true);
    tui.send('2'); await tui.waitFor('1. Keep', true);
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'approval.respond', requestId: 'tall', response: 'Revise' }));
  });
});
