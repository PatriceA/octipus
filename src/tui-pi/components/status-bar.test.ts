import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@mariozechner/pi-tui';
import { StatusBar } from './status-bar';

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('StatusBar', () => {
  test('shows app name + status by default', () => {
    const bar = new StatusBar();
    const [text] = bar.render(80);
    expect(strip(text)).toContain('Octipus');
    expect(strip(text)).toContain('disconnected');
  });

  test('renders project label when set', () => {
    const bar = new StatusBar();
    bar.setProject('octipus');
    expect(strip(bar.render(80)[0])).toContain('octipus');
  });

  test('renders expert when set', () => {
    const bar = new StatusBar();
    bar.setExpert('security');
    expect(strip(bar.render(80)[0])).toContain('⟨security⟩');
  });

  test('renders run-mode segment when set, hidden otherwise', () => {
    const bar = new StatusBar();
    expect(strip(bar.render(80)[0])).not.toContain('[Full]');
    bar.setMode('Full');
    expect(strip(bar.render(80)[0])).toContain('[Full]');
    bar.setMode(null);
    expect(strip(bar.render(80)[0])).not.toContain('[Full]');
  });

  test('renders cumulative stats when non-zero', () => {
    const bar = new StatusBar();
    bar.setStats({ tokens: 1234, cost: 0.05, turns: 3 });
    const text = strip(bar.render(120)[0]);
    expect(text).toContain('1.2k tok');
    expect(text).toContain('3 turns');
    expect(text).toContain('$0.0500');
  });

  test('formats million-token counts', () => {
    const bar = new StatusBar();
    bar.setStats({ tokens: 2_500_000, cost: 0, turns: 50 });
    expect(strip(bar.render(120)[0])).toContain('2.5M tok');
  });

  test('truncates output to viewport width', () => {
    const bar = new StatusBar();
    bar.setProject('a-very-long-project-name-that-should-be-trimmed');
    bar.setExpert('long-expert-name');
    bar.setStats({ tokens: 999_999, cost: 12.34, turns: 100 });
    const [text] = bar.render(40);
    expect(visibleWidth(text)).toBeLessThanOrEqual(40);
  });

  test('context fill: percentage when the window is known, raw size when it is not', () => {
    const bar = new StatusBar();
    expect(strip(bar.render(120)[0])).not.toContain('ctx');
    bar.setContext({ used: 41_000, window: 100_000 });
    expect(strip(bar.render(120)[0])).toContain('ctx 41% (41.0k tok)');
    bar.setContext({ used: 41_000 });
    const noWindow = strip(bar.render(120)[0]);
    expect(noWindow).toContain('ctx 41.0k tok');
    expect(noWindow).not.toContain('%');
    bar.setContext(null);
    expect(strip(bar.render(120)[0])).not.toContain('ctx');
  });
});
