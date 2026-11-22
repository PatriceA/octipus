import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@/tui-kit';
import { applyToolEvent, newToolGroup, renderThinking, renderToolGroup, toolGroupSummary, toolGroupText } from './tool-group';

const strip = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));

describe('tool groups', () => {
  test('results pair with their calls by id, not by name, even out of order', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'Bash', toolName: 'Bash', callId: 'a', args: { command: 'sleep 5' } }, 0);
    applyToolEvent(group, { state: 'pending', name: 'Bash', toolName: 'Bash', callId: 'b', args: { command: 'ls' } }, 10);
    applyToolEvent(group, { state: 'completed', name: 'Bash', toolName: 'Bash', callId: 'b', output: 'file.ts' }, 110);
    expect(group.calls.map(call => [call.callId, call.state, call.output])).toEqual([['a', 'running', undefined], ['b', 'completed', 'file.ts']]);
    expect(group.calls[1]?.durationMs).toBe(100);
    applyToolEvent(group, { state: 'error', name: 'Bash', toolName: 'Bash', callId: 'a', output: 'killed' }, 5000);
    expect(group.calls[0]).toMatchObject({ state: 'error', output: 'killed', durationMs: 5000 });
  });

  test('a native call announced without an id takes the result of the same tool; the server title replaces the name', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'read_file', toolName: 'read_file' }, 0);
    applyToolEvent(group, { state: 'pending', name: 'shell', toolName: 'shell' }, 0);
    applyToolEvent(group, { state: 'completed', name: 'Ran ls', toolName: 'shell', title: 'Ran ls', callId: 't2', durationMs: 30, input: 'ls' }, 50);
    expect(group.calls).toHaveLength(2);
    expect(group.calls[1]).toMatchObject({ label: 'Ran ls', state: 'completed', durationMs: 30, input: 'ls' });
    expect(group.calls[0]?.state).toBe('running');
  });

  test('a result with no call still shows up', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'completed', name: 'websearch', toolName: 'websearch', output: 'hits' });
    expect(group.calls).toMatchObject([{ tool: 'websearch', state: 'completed', output: 'hits' }]);
  });

  test('collapsed: one row with count, running and failed state, durations', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'shell', toolName: 'shell', callId: '1' }, 0);
    applyToolEvent(group, { state: 'completed', name: 'shell', toolName: 'shell', callId: '1', durationMs: 1200 }, 0);
    applyToolEvent(group, { state: 'pending', name: 'read_file', toolName: 'read_file', callId: '2' }, 0);
    applyToolEvent(group, { state: 'pending', name: 'write_file', toolName: 'write_file', callId: '3' }, 0);
    applyToolEvent(group, { state: 'error', name: 'write_file', toolName: 'write_file', callId: '3', durationMs: 300, output: 'denied' }, 0);
    expect(toolGroupSummary(group)).toBe('▸ 3 tool calls · 1 running · 1 failed · 1.5s — shell, read_file, write_file');
    const rows = strip(renderToolGroup(group, 80));
    expect(rows).toEqual(['! ▸ 3 tool calls · 1 running · 1 failed · 1.5s — shell, read_file, write_file']);
  });

  test('expanded: each call with its arguments and full output; an edit as a diff', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'shell', toolName: 'shell', callId: '1', args: { command: 'printf "a\\nb"' } }, 0);
    applyToolEvent(group, { state: 'completed', name: 'shell', toolName: 'shell', callId: '1', output: 'line 1\nline 2\nline 3', durationMs: 20 }, 0);
    applyToolEvent(group, { state: 'pending', name: 'str_replace_editor', toolName: 'str_replace_editor', callId: '2', args: { command: 'str_replace', path: 'a.ts', old_str: 'const a = 1;', new_str: 'const a = 2;' } }, 0);
    group.expanded = true;
    const text = strip(renderToolGroup(group, 80)).join('\n');
    expect(text).toContain('▾ 2 tool calls');
    expect(text).toContain('✓ shell · 20ms');
    expect(text).toContain('$ printf "a\\nb"');
    expect(text).toContain('line 1\n·     line 2\n·     line 3');
    expect(text).toContain('… str_replace_editor · running');
    expect(text).toContain('-const a = 1;');
    expect(text).toContain('+const a = 2;');
  });

  test('outside text cannot reach the terminal and no row is wider than asked', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'sh\x1b[2J', toolName: 'sh', callId: '1', args: { command: 'x'.repeat(300) } }, 0);
    applyToolEvent(group, { state: 'completed', name: 'sh', toolName: 'sh', callId: '1', output: '\x1b]8;;http://evil\x07click\x1b]8;;\x07\r\n世界'.repeat(20) }, 0);
    group.expanded = true;
    for (const width of [10, 40, 120]) {
      const rows = renderToolGroup(group, width);
      expect(rows.join('')).not.toMatch(/\x1b\]|\x1b\[2J|\r/);
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    }
  });

  test('exported as one line per call', () => {
    const group = newToolGroup();
    applyToolEvent(group, { state: 'pending', name: 'shell', toolName: 'shell', callId: '1', args: { command: 'ls' } }, 0);
    applyToolEvent(group, { state: 'completed', name: 'shell', toolName: 'shell', callId: '1', durationMs: 5 }, 0);
    expect(toolGroupText(group)).toBe('✓ shell → $ ls (5ms)');
  });
});

describe('thinking', () => {
  test('folded to one dim row with its first line; unfolded shows all of it', () => {
    const item = { kind: 'thinking' as const, text: 'I will read the file first.\nThen run the tests.', expanded: false };
    expect(strip(renderThinking(item, 80))).toEqual(['· ▸ Thinking · 2 lines — I will read the file first.']);
    item.expanded = true;
    expect(strip(renderThinking(item, 80))).toEqual(['· ▾ Thinking · 2 lines', '·   I will read the file first.', '·   Then run the tests.']);
  });
});
