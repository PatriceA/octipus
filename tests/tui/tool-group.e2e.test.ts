/** A turn's tool calls as one collapsed row that a click or Ctrl+O expands; reasoning before them folded. */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

function turn(h: TuiHarness): void {
  h.event('agent.spawned', { agentId: 'root', role: 'general', root: true, model: 'fixture-model' });
  h.event('chat.delta', { delta: 'I will look at the file, then fix it.', iteration: 1 });
  h.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_use', id: 'c1', toolName: 'Bash', args: { command: 'cat app.ts' } } });
  h.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_use', id: 'c2', toolName: 'str_replace_editor', args: { command: 'str_replace', path: 'app.ts', old_str: 'const port = 80;', new_str: 'const port = 8080;' } } });
  h.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_result', id: 'c1', toolName: 'Bash', output: 'const port = 80;\nexport default port;' } });
  h.event('chat.delta', { delta: 'Fixed.', iteration: 2 });
}

describe.skipIf(process.platform === 'win32')('tool groups in a real terminal', () => {
  test('one collapsed row per turn; a click shows each call with arguments, full output and the edit as a diff', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 30);
    await tui.waitFor('connected');
    turn(tui);
    // The client times a result that came without a duration: "· 1ms" may follow "running".
    await tui.waitFor('▸ 2 tool calls · 1 running');
    await tui.waitFor('— Bash, str_replace_editor');
    // The whole turn is on screen before rows are counted: the second iteration folds the first's text.
    await tui.waitFor('Fixed.');
    await tui.waitFor('▸ Thinking');
    const screen = await tui.text();
    expect(screen).toContain('▸ Thinking · 1 line — I will look at the file, then fix it.');
    expect(screen).not.toContain('cat app.ts');
    await tui.saveScreen('tool-group-collapsed');
    const row = screen.split('\n').findIndex(line => line.includes('▸ 2 tool calls')) + 1;
    tui.send(`\x1b[<0;6;${row}M\x1b[<0;6;${row}m`);
    await tui.waitFor('▾ 2 tool calls');
    const open = await tui.text();
    expect(open).toContain('$ cat app.ts');
    expect(open).toContain('export default port;');
    expect(open).toContain('-const port = 80;');
    expect(open).toContain('+const port = 8080;');
    await tui.saveScreen('tool-group-expanded');
    // Thinking folds and unfolds the same way.
    const thinking = open.split('\n').findIndex(line => line.includes('▸ Thinking')) + 1;
    tui.send(`\x1b[<0;6;${thinking}M\x1b[<0;6;${thinking}m`);
    await tui.waitFor('▾ Thinking');
  });

  test('Ctrl+O expands and collapses every group; a failed call marks the row', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 30);
    await tui.waitFor('connected');
    turn(tui);
    tui.event('agent.action', { agentId: 'root', data: { type: 'tool_call_complete', toolCallId: 'c2', name: 'str_replace_editor', status: 'error', error: 'old_str not found', durationMs: 15 } });
    await tui.waitFor('▸ 2 tool calls · 1 failed');
    tui.send('\x0f');
    await tui.waitFor('✗ str_replace_editor · 15ms');
    expect((await tui.text()).split('\n').filter(line => line.includes('old_str not found'))).toHaveLength(2);
    tui.send('\x0f');
    await tui.waitFor('✗ str_replace_editor · 15ms', true);
    expect((await tui.text()).split('\n').find(line => line.includes('tool calls'))).toMatch(/^! /);
  });
});
