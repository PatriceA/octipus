import { describe, expect, test } from 'bun:test';
import { BufferStore } from '../stores/buffer-store';
import { FindOverlay } from './find-overlay';

function setup(initial: string) {
  const buffers = new BufferStore();
  buffers.openFile('/tmp/file.ts', initial);
  let closed = false;
  const overlay = new FindOverlay({ buffers, onClose: () => { closed = true; } });
  return { buffers, overlay, get closed() { return closed; } };
}

describe('FindOverlay', () => {
  test('typing builds the query and computes matches', () => {
    const { overlay } = setup('foo bar foo baz foo');
    for (const c of 'foo') overlay.handleInput(c);
    expect(overlay.getQuery()).toBe('foo');
    expect(overlay.getMatches().length).toBe(3);
    expect(overlay.getIndex()).toBe(0);
  });

  test('Enter cycles to the next match and updates the buffer cursor', () => {
    const { overlay, buffers } = setup('foo bar foo baz foo');
    for (const c of 'foo') overlay.handleInput(c);
    overlay.handleInput('\r');
    expect(overlay.getIndex()).toBe(1);
    expect(buffers.active()?.buffer.getCursor()).toEqual({ line: 0, col: 8 });
  });

  test('Escape closes', () => {
    const ctx = setup('hello');
    ctx.overlay.handleInput('\x1b');
    expect(ctx.closed).toBe(true);
  });

  test('Backspace on empty query closes', () => {
    const ctx = setup('hello');
    ctx.overlay.handleInput('\x7f');
    expect(ctx.closed).toBe(true);
  });

  test('Alt+C toggles case sensitivity and recomputes', () => {
    const { overlay } = setup('FOO foo Foo');
    for (const c of 'FOO') overlay.handleInput(c);
    expect(overlay.getMatches().length).toBe(3); // case-insensitive
    overlay.handleInput('\x1bc');
    expect(overlay.getFlags().caseSensitive).toBe(true);
    expect(overlay.getMatches().length).toBe(1); // only the all-caps FOO
  });

  test('renders a bordered box bounded by viewport width', () => {
    const ctx = setup('hello');
    const lines = ctx.overlay.render(50).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
  });
});
