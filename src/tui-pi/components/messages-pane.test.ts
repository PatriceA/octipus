import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@mariozechner/pi-tui';
import { MessagesPane } from './messages-pane';

function strip(line: string): string {
  // Remove ANSI escape codes for length-based assertions.
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('MessagesPane', () => {
  test('renders nothing for empty history', () => {
    const pane = new MessagesPane();
    expect(pane.render(80)).toEqual([]);
  });

  test('prefixes user/system/assistant messages distinctly', () => {
    const pane = new MessagesPane();
    pane.push({ role: 'user', content: 'hello', timestamp: new Date() });
    pane.push({ role: 'assistant', content: 'hi there', timestamp: new Date() });
    pane.push({ role: 'system', content: 'ok', timestamp: new Date() });
    const lines = pane.render(80).map(strip);
    expect(lines[0].startsWith('❯ ')).toBe(true);
    // Spacer between messages
    expect(lines[1]).toBe('');
    expect(lines[2].startsWith('  ')).toBe(true);
    expect(lines[3]).toBe('');
    expect(lines[4].startsWith('· ')).toBe(true);
  });

  test('respects maxVisible and drops older messages from rendered output', () => {
    const pane = new MessagesPane({ maxVisible: 2 });
    pane.push({ role: 'system', content: 'first', timestamp: new Date() });
    pane.push({ role: 'system', content: 'second', timestamp: new Date() });
    pane.push({ role: 'system', content: 'third', timestamp: new Date() });
    const text = pane.render(80).map(strip).join('\n');
    expect(text).not.toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('third');
  });

  test('wraps lines wider than the viewport', () => {
    const pane = new MessagesPane();
    pane.push({ role: 'assistant', content: 'aaaa bbbb cccc dddd eeee', timestamp: new Date() });
    const lines = pane.render(12).map(strip);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  test('caches rendered output until invalidated or width changes', () => {
    const pane = new MessagesPane();
    pane.push({ role: 'system', content: 'cached', timestamp: new Date() });
    const first = pane.render(40);
    const second = pane.render(40);
    expect(second).toBe(first); // same array reference when cached
    pane.push({ role: 'system', content: 'new', timestamp: new Date() });
    const third = pane.render(40);
    expect(third).not.toBe(first);
  });

  test('reset() clears history', () => {
    const pane = new MessagesPane();
    pane.push({ role: 'user', content: 'hi', timestamp: new Date() });
    pane.reset();
    expect(pane.render(80)).toEqual([]);
  });

  test('scrollUp reveals older messages, scrollDown returns to live tail', () => {
    const pane = new MessagesPane({ maxVisible: 2 });
    pane.push({ role: 'system', content: 'first', timestamp: new Date() });
    pane.push({ role: 'system', content: 'second', timestamp: new Date() });
    pane.push({ role: 'system', content: 'third', timestamp: new Date() });

    // At bottom: see second/third
    const atBottom = pane.render(80).map(strip).join('\n');
    expect(atBottom).toContain('second');
    expect(atBottom).toContain('third');
    expect(atBottom).not.toContain('first');

    // Scroll up: see first/second
    expect(pane.scrollUp(2)).toBe(true);
    const scrolled = pane.render(80).map(strip).join('\n');
    expect(scrolled).toContain('first');
    expect(scrolled).toContain('second');
    expect(scrolled).toContain('newer message');
    expect(pane.getScrollOffset()).toBeGreaterThan(0);

    // Scroll back to bottom
    expect(pane.scrollDown(2)).toBe(true);
    expect(pane.getScrollOffset()).toBe(0);
  });

  test('scrollUp clamps at the top of history', () => {
    const pane = new MessagesPane({ maxVisible: 2 });
    pane.push({ role: 'system', content: 'a', timestamp: new Date() });
    pane.push({ role: 'system', content: 'b', timestamp: new Date() });
    pane.push({ role: 'system', content: 'c', timestamp: new Date() });

    expect(pane.scrollUp(10)).toBe(true);
    const max = pane.getScrollOffset();
    // Already at top — second call cannot move further.
    expect(pane.scrollUp(10)).toBe(false);
    expect(pane.getScrollOffset()).toBe(max);
  });

  test('scrollToBottom is a no-op when already pinned', () => {
    const pane = new MessagesPane();
    pane.push({ role: 'system', content: 'a', timestamp: new Date() });
    expect(pane.getScrollOffset()).toBe(0);
    pane.scrollToBottom();
    expect(pane.getScrollOffset()).toBe(0);
  });
});
