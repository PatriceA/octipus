import { describe, expect, test } from 'bun:test';
import { BufferStore } from '../stores/buffer-store';
import { ReplaceOverlay } from './replace-overlay';

function setup(initial: string) {
  const buffers = new BufferStore();
  buffers.openFile('/tmp/file.ts', initial);
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

  test('Alt+R toggles regex flag', () => {
    const ctx = setup('foo');
    expect(ctx.overlay.getFlags().regex).toBe(false);
    ctx.overlay.handleInput('\x1br');
    expect(ctx.overlay.getFlags().regex).toBe(true);
  });
});
