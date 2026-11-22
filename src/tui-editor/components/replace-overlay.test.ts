import { describe, expect, test } from 'vitest';
import { BufferStore } from '../stores/buffer-store';
import { ReplaceOverlay } from './replace-overlay';

function setup(initial: string, cursor?: { line: number; col: number }) {
  const buffers = new BufferStore();
  const rec = buffers.openFile('/tmp/file.ts', initial);
  if (cursor) rec.buffer.setCursor(cursor);
  let committed: number | null = null;
  let closed = false;
  const overlay = new ReplaceOverlay({
    buffers,
    onCommit: (count) => { committed = count; },
    onClose:  ()      => { closed    = true; },
  });
  return { buffers, overlay, get committed() { return committed; }, get closed() { return closed; } };
}

describe('ReplaceOverlay', () => {
  test('Tab cycles between find and replace fields', () => {
    const ctx = setup('hello');
    expect(ctx.overlay.getActiveField()).toBe('find');
    ctx.overlay.handleInput('\t');
    expect(ctx.overlay.getActiveField()).toBe('replace');
    ctx.overlay.handleInput('\t');
    expect(ctx.overlay.getActiveField()).toBe('find');
  });

  test('typing fills the active field', () => {
    const ctx = setup('hello');
    for (const c of 'foo') ctx.overlay.handleInput(c);
    expect(ctx.overlay.getFind()).toBe('foo');
    expect(ctx.overlay.getReplace()).toBe('');
    ctx.overlay.handleInput('\t');
    for (const c of 'bar') ctx.overlay.handleInput(c);
    expect(ctx.overlay.getReplace()).toBe('bar');
  });

  test('Enter commits replaceAll and reports the count', () => {
    const ctx = setup('foo bar foo baz foo');
    for (const c of 'foo') ctx.overlay.handleInput(c);
    ctx.overlay.handleInput('\t');
    for (const c of 'qux') ctx.overlay.handleInput(c);
    ctx.overlay.handleInput('\r');
    expect(ctx.committed).toBe(3);
    expect(ctx.buffers.active()?.buffer.text()).toBe('qux bar qux baz qux');
  });

  test('Escape closes without committing', () => {
    const ctx = setup('foo');
    ctx.overlay.handleInput('\x1b');
    expect(ctx.closed).toBe(true);
    expect(ctx.committed).toBeNull();
  });

  test('Backspace on empty find field closes', () => {
    const ctx = setup('foo');
    ctx.overlay.handleInput('\x7f');
    expect(ctx.closed).toBe(true);
  });

  test('Backspace on the replace field shrinks instead of closing', () => {
    const ctx = setup('foo');
    ctx.overlay.handleInput('\t');
    for (const c of 'abc') ctx.overlay.handleInput(c);
    ctx.overlay.handleInput('\x7f');
    expect(ctx.overlay.getReplace()).toBe('ab');
    expect(ctx.closed).toBe(false);
  });

  test('regex replace with $1, through the overlay, and one Ctrl+Z undoes it all', () => {
    const ctx = setup('a=1 b=2 c=3');
    ctx.overlay.handleInput('\x1br');
    ctx.overlay.handleInput('\x1b[200~(\\w)=(\\d)\x1b[201~');
    ctx.overlay.handleInput('\t');
    ctx.overlay.handleInput('\x1b[200~$2=$1\x1b[201~');
    ctx.overlay.handleInput('\r');
    expect(ctx.committed).toBe(3);
    const buffer = ctx.buffers.active()?.buffer;
    expect(buffer?.text()).toBe('1=a 2=b 3=c');
    buffer?.undo();
    expect(buffer?.text()).toBe('a=1 b=2 c=3');
  });

  test('fields take emoji and pasted text', () => {
    const ctx = setup('hi');
    ctx.overlay.handleInput('👋');
    ctx.overlay.handleInput('\x1b[200~ there\x1b[201~');
    expect(ctx.overlay.getFind()).toBe('👋 there');
  });

  test('Alt+Enter replaces the current match only, one undo step each, and moves on; Esc reports the count', () => {
    const ctx = setup('foo bar foo baz foo');
    for (const c of 'foo') ctx.overlay.handleInput(c);
    ctx.overlay.handleInput('\t');
    for (const c of 'food') ctx.overlay.handleInput(c);
    expect(ctx.overlay.getIndex()).toBe(0);
    ctx.overlay.handleInput('\x1b\r');
    const buffer = ctx.buffers.active()?.buffer;
    expect(buffer?.text()).toBe('food bar foo baz foo');
    // The next match is after the replacement: "food" itself is not matched again.
    expect(ctx.overlay.getMatches()[ctx.overlay.getIndex()]).toEqual({ line: 0, col: 9, length: 3 });
    ctx.overlay.handleInput('\x1b[B'); // skip the second
    ctx.overlay.handleInput('\x1b\r');
    expect(buffer?.text()).toBe('food bar foo baz food');
    buffer?.undo();
    expect(buffer?.text()).toBe('food bar foo baz foo');
    ctx.overlay.handleInput('\x1b');
    expect(ctx.committed).toBe(2);
  });

  test('the box previews what the current match becomes, regex groups expanded', () => {
    const ctx = setup('let a=1;\nlet b=2;', { line: 1, col: 0 });
    ctx.overlay.handleInput('\x1br');
    ctx.overlay.handleInput('\x1b[200~(\\w)=(\\d)\x1b[201~');
    ctx.overlay.handleInput('\t');
    ctx.overlay.handleInput('\x1b[200~$2=$1\x1b[201~');
    const text = ctx.overlay.render(64).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '')).join('\n');
    expect(text).toContain('Replace 2 / 2'); // starts from the cursor
    expect(text).toContain('L2 let b=2→2=b;');
  });

  test('Alt+R toggles regex flag', () => {
    const ctx = setup('foo');
    expect(ctx.overlay.getFlags().regex).toBe(false);
    ctx.overlay.handleInput('\x1br');
    expect(ctx.overlay.getFlags().regex).toBe(true);
  });
});
