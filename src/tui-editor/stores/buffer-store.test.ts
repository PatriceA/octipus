import { describe, expect, test } from 'bun:test';
import { BufferStore } from './buffer-store';

describe('BufferStore', () => {
  test('openFile creates a buffer and sets it active', () => {
    const s = new BufferStore();
    const b = s.openFile('/abs/foo.ts', 'const x = 1');
    expect(b.label).toBe('foo.ts');
    expect(b.language).toBe('typescript');
    expect(s.get().activeId).toBe(b.id);
  });

  test('openFile dedupes by path', () => {
    const s = new BufferStore();
    const a = s.openFile('/abs/foo.ts', 'a');
    const b = s.openFile('/abs/foo.ts', 'b'); // initial text ignored on dedupe
    expect(a.id).toBe(b.id);
    expect(s.get().buffers.length).toBe(1);
  });

  test('openScratch creates an unbacked buffer', () => {
    const s = new BufferStore();
    const a = s.openScratch();
    const b = s.openScratch();
    expect(a.label).toBe('Scratch 1');
    expect(b.label).toBe('Scratch 2');
    expect(a.path).toBeNull();
  });

  test('close removes the buffer and picks a neighbor', () => {
    const s = new BufferStore();
    const a = s.openFile('/abs/a.ts', '');
    const b = s.openFile('/abs/b.ts', '');
    const c = s.openFile('/abs/c.ts', '');
    s.setActive(b.id);
    s.close(b.id);
    expect(s.get().buffers.map((x) => x.id)).toEqual([a.id, c.id]);
    expect(s.get().activeId).toBe(c.id);
  });

  test('cycle wraps both directions', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', '');
    const b = s.openFile('/b', '');
    const c = s.openFile('/c', '');
    s.setActive(a.id);
    s.cycle(1); expect(s.get().activeId).toBe(b.id);
    s.cycle(1); expect(s.get().activeId).toBe(c.id);
    s.cycle(1); expect(s.get().activeId).toBe(a.id);
    s.cycle(-1); expect(s.get().activeId).toBe(c.id);
  });

  test('markDirty updates flag', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', '');
    expect(a.dirty).toBe(false);
    s.markDirty(a.id, true);
    expect(s.active()?.dirty).toBe(true);
  });

  test('subscribe fires on change', () => {
    const s = new BufferStore();
    let fires = 0;
    const off = s.subscribe(() => { fires++; });
    s.openFile('/a', '');
    s.openFile('/b', '');
    off();
    s.openFile('/c', '');
    expect(fires).toBe(2);
  });

  test('reset clears state', () => {
    const s = new BufferStore();
    s.openFile('/a', '');
    s.openFile('/b', '');
    s.reset();
    expect(s.get().buffers.length).toBe(0);
    expect(s.get().activeId).toBeNull();
  });

  test('lockMode defaults to "lock"', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'foo');
    expect(a.lockMode).toBe('lock');
  });

  test('setLockMode toggles', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'foo');
    s.setLockMode(a.id, 'merge');
    expect(s.active()?.lockMode).toBe('merge');
  });

  test('applyAgentEdit in lock mode takes lock and does not modify text', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'before');
    const applied = s.applyAgentEdit(a.id, 'after');
    expect(applied).toBe(false);
    expect(s.active()?.agentLocked).toBe(true);
    expect(a.buffer.text()).toBe('before');
  });

  test('applyAgentEdit in merge mode rewrites text + marks dirty', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'before');
    s.setLockMode(a.id, 'merge');
    const applied = s.applyAgentEdit(a.id, 'after');
    expect(applied).toBe(true);
    expect(a.buffer.text()).toBe('after');
    expect(s.active()?.dirty).toBe(true);
  });

  test('merge-mode edit pushes onto undo stack so user can rollback', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'before');
    s.setLockMode(a.id, 'merge');
    s.applyAgentEdit(a.id, 'after');
    expect(a.buffer.text()).toBe('after');
    a.buffer.undo();
    expect(a.buffer.text()).toBe('before');
  });
});
