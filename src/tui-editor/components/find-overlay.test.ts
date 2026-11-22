import { describe, expect, test } from 'vitest';
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

  test('starts from the cursor, not the top of the file (docs/plans/tui-modernization.md §5.2)', () => {
    const buffers = new BufferStore();
    const rec = buffers.openFile('/tmp/file.ts', 'foo one\nfoo two\nfoo three');
    rec.buffer.setCursor({ line: 1, col: 3 });
    const overlay = new FindOverlay({ buffers, onClose: () => {} });
    for (const c of 'foo') overlay.handleInput(c);
    expect(overlay.getIndex()).toBe(2);
    expect(rec.buffer.getCursor()).toEqual({ line: 2, col: 0 });
  });

  test('Esc puts the cursor back where it was; Alt+Enter keeps it on the match', () => {
    const buffers = new BufferStore();
    const rec = buffers.openFile('/tmp/file.ts', 'alpha\nbeta\ngamma');
    rec.buffer.setCursor({ line: 0, col: 2 });
    const first = new FindOverlay({ buffers, onClose: () => {} });
    for (const c of 'gam') first.handleInput(c);
    expect(rec.buffer.getCursor()).toEqual({ line: 2, col: 0 });
    first.handleInput('\x1b');
    expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 2 });
    const second = new FindOverlay({ buffers, onClose: () => {} });
    for (const c of 'gam') second.handleInput(c);
    second.handleInput('\x1b\r');
    expect(rec.buffer.getCursor()).toEqual({ line: 2, col: 0 });
  });

  test('hands its matches and the current one to the buffer view, and clears them on close', () => {
    const buffers = new BufferStore();
    const rec = buffers.openFile('/tmp/file.ts', 'ab ab ab');
    const calls: Array<[string | null, number, number | null]> = [];
    const overlay = new FindOverlay({ buffers, onClose: () => {}, onMatches: (id, matches, current) => calls.push([id, matches.length, current?.col ?? null]) });
    overlay.handleInput('a'); overlay.handleInput('b');
    overlay.handleInput('\r');
    expect(calls.at(-1)).toEqual([rec.id, 3, 3]);
    overlay.handleInput('\x1b');
    expect(calls.at(-1)).toEqual([null, 0, null]);
  });

  test('the query takes a paste and an emoji, and an invalid regex is shown, not taken for no matches', () => {
    const { overlay } = setup('smile 😀 here');
    overlay.handleInput('\x1b[200~😀\x1b[201~');
    expect(overlay.getQuery()).toBe('😀');
    expect(overlay.getMatches()).toEqual([{ line: 0, col: 6, length: 2 }]);
    const ctx = setup('x');
    ctx.overlay.handleInput('\x1br');
    ctx.overlay.handleInput('(');
    expect(ctx.overlay.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')).toContain('Invalid regex');
  });

  test('renders a bordered box bounded by viewport width', () => {
    const ctx = setup('hello');
    const lines = ctx.overlay.render(50).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
  });
});
