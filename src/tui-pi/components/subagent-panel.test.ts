/**
 * A fan-out used to interleave every child's tool calls with the root agent's
 * in the transcript. These pin the fold: one line while collapsed, one row per
 * child when expanded, and finished children dropping off on their own.
 */
import { describe, expect, test } from 'vitest';
import { SubagentPanel } from './subagent-panel';

const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

function panelAt(clock: { now: number }) {
  return new SubagentPanel(() => clock.now);
}

describe('SubagentPanel', () => {
  test('renders nothing with no subagents', () => {
    expect(new SubagentPanel().render(80)).toEqual([]);
  });

  test('collapsed: one line naming the running children and their iterations', () => {
    const panel = new SubagentPanel();
    panel.start('a1', 'research');
    panel.start('a2', 'coding');
    panel.iteration('a1', 3);

    const [line, ...rest] = strip(panel.render(120));
    expect(rest).toEqual([]);
    expect(line).toContain('2 subagents');
    expect(line).toContain('research iter 3');
    expect(line).toContain('coding iter 0');
    expect(line).toContain('alt+s');
  });

  test('expanded: a row per child with its current tool', () => {
    const panel = new SubagentPanel();
    panel.start('a1', 'research');
    panel.iteration('a1', 2);
    panel.tool('a1', { state: 'pending', name: 'websearch', preview: 'mcp reconnect' });
    panel.toggle();

    const lines = strip(panel.render(120));
    expect(lines[0]).toContain('subagents (1)');
    expect(lines[1]).toContain('research');
    expect(lines[1]).toContain('iter 2');
    expect(lines[1]).toContain('1 tool');
    expect(lines[1]).toContain('websearch → mcp reconnect');
  });

  test('a pending/completed pair counts as one tool call', () => {
    const panel = new SubagentPanel();
    panel.start('a1', 'research');
    panel.tool('a1', { state: 'pending', name: 'websearch' });
    panel.tool('a1', { state: 'completed', name: 'websearch', preview: '3 results' });
    panel.toggle();

    expect(strip(panel.render(120))[1]).toContain('1 tool');
  });

  test('events for an unknown agent are ignored, not invented', () => {
    const panel = new SubagentPanel();
    panel.iteration('ghost', 4);
    panel.tool('ghost', { state: 'pending', name: 'shell' });
    panel.end('ghost');
    expect(panel.render(80)).toEqual([]);
    expect(panel.has('ghost')).toBe(false);
  });

  test('a finished child is marked done, then drops off on its own', () => {
    const clock = { now: 1_000_000 };
    const panel = panelAt(clock);
    panel.start('a1', 'coding');
    clock.now += 5_000;
    panel.end('a1');
    panel.toggle();

    expect(strip(panel.render(120))[1]).toContain('✓ coding');
    expect(strip(panel.render(120))[1]).toContain('5s');

    clock.now += 9_000;
    expect(panel.render(120)).toEqual([]);
    expect(panel.size).toBe(0);
  });

  test('a failed child is marked as failed', () => {
    const panel = new SubagentPanel();
    panel.start('a1', 'coding');
    panel.end('a1', { failed: true });
    panel.toggle();
    expect(strip(panel.render(120))[1]).toContain('✗ coding');
  });

  test('toggle flips both ways and reset forgets everything', () => {
    const panel = new SubagentPanel();
    panel.start('a1', 'research');
    expect(panel.toggle()).toBe(true);
    expect(panel.toggle()).toBe(false);
    panel.reset();
    expect(panel.render(80)).toEqual([]);
  });

  test('a running child whose backend vanished is dropped, not counted up forever', () => {
    const clock = { now: 1_000_000 };
    const panel = panelAt(clock);
    panel.start('a1', 'research');
    panel.iteration('a1', 1);

    clock.now += 14 * 60 * 1000;
    expect(panel.size).toBe(1); // still plausibly alive

    clock.now += 2 * 60 * 1000; // past the stale window with no events at all
    expect(panel.render(120)).toEqual([]);
    expect(panel.size).toBe(0);
  });

  test('activity keeps a slow child alive past the stale window', () => {
    const clock = { now: 1_000_000 };
    const panel = panelAt(clock);
    panel.start('a1', 'research');
    clock.now += 14 * 60 * 1000;
    panel.iteration('a1', 9); // still talking
    clock.now += 14 * 60 * 1000;
    expect(panel.size).toBe(1);
  });
});
