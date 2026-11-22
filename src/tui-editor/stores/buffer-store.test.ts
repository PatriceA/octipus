import { describe, expect, test } from 'vitest';
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

  test('dirty compares the text with what was saved: undoing back to it is clean (docs/plans/tui-modernization.md §5.2)', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', 'saved');
    expect(a.dirty).toBe(false);
    a.buffer.moveLineEnd();
    a.buffer.type('!');
    expect(s.active()?.dirty).toBe(true);
    a.buffer.undo();
    expect(s.active()?.dirty).toBe(false);
  });

  test('an edit that changes nothing does not dirty the buffer', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', 'text');
    a.buffer.deleteBackward(); // at 0,0
    a.buffer.setText('text');
    expect(s.active()?.dirty).toBe(false);
  });

  test('markSaved moves the baseline; revert goes back to it', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', 'one');
    a.buffer.setText('two');
    s.markSaved(a.id, 'two', null);
    expect(s.active()?.dirty).toBe(false);
    a.buffer.setText('three');
    s.revert(a.id);
    expect(a.buffer.text()).toBe('two');
    expect(s.active()?.dirty).toBe(false);
  });

  test('rebind gives a scratch buffer a file and keeps its id', () => {
    const s = new BufferStore();
    const a = s.openScratch();
    a.buffer.insert('notes');
    expect(s.active()?.dirty).toBe(true);
    s.rebind(a.id, '/p/notes.md', 'notes', { mtimeMs: 1, size: 5, eol: '\n', bom: false, mode: 0o644 });
    const r = s.active();
    expect(r?.id).toBe(a.id);
    expect(r?.path).toBe('/p/notes.md');
    expect(r?.label).toBe('notes.md');
    expect(r?.language).toBe('markdown');
    expect(r?.dirty).toBe(false);
  });

  test('the Tab indent follows the file', () => {
    const s = new BufferStore();
    expect(s.openFile('/t.go', 'func f() {\n\treturn\n}').indent).toBe('\t');
    expect(s.openFile('/f.py', 'def f():\n    if x:\n        pass').indent).toBe('    ');
    expect(s.openFile('/n.txt', 'no indentation').indent).toBe('  ');
  });

  test('a closed buffer stops notifying', () => {
    const s = new BufferStore();
    const a = s.openFile('/a', '');
    s.close(a.id);
    let fires = 0;
    s.subscribe(() => { fires++; });
    a.buffer.insert('late');
    expect(fires).toBe(0);
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

  test('setAgentLocked takes and releases the lock without touching the text', () => {
    const s = new BufferStore();
    const a = s.openFile('/a.ts', 'before');
    s.setAgentLocked(a.id, true);
    expect(s.active()?.agentLocked).toBe(true);
    expect(a.buffer.text()).toBe('before');
    s.setAgentLocked(a.id, false);
    expect(s.active()?.agentLocked).toBe(false);
  });
});
