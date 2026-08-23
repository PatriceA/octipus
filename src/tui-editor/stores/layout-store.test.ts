import { describe, expect, test } from 'vitest';
import { LayoutStore } from './layout-store';

describe('LayoutStore', () => {
  test('initial state', () => {
    const s = new LayoutStore();
    expect(s.get().treeVisible).toBe(true);
    expect(s.get().chatVisible).toBe(true);
    expect(s.get().focused).toBe('editor');
    expect(s.get().overlay).toBeNull();
  });

  test('toggleTree / toggleChat', () => {
    const s = new LayoutStore();
    s.toggleTree();
    expect(s.get().treeVisible).toBe(false);
    s.toggleChat();
    expect(s.get().chatVisible).toBe(false);
  });

  test('cycleFocus skips hidden panes', () => {
    const s = new LayoutStore();
    s.toggleTree(); // hide tree
    s.cycleFocus(1);
    expect(s.get().focused).toBe('chat');
    s.cycleFocus(1);
    expect(s.get().focused).toBe('editor'); // wrap; tree was skipped
    s.cycleFocus(-1);
    expect(s.get().focused).toBe('chat');
  });

  test('cycleFocus across all three when both side panes visible', () => {
    const s = new LayoutStore();
    expect(s.get().focused).toBe('editor');
    s.cycleFocus(1); expect(s.get().focused).toBe('chat');
    s.cycleFocus(1); expect(s.get().focused).toBe('tree');
    s.cycleFocus(1); expect(s.get().focused).toBe('editor');
  });

  test('overlay open / close', () => {
    const s = new LayoutStore();
    s.openOverlay({ kind: 'palette' });
    expect(s.get().overlay).toEqual({ kind: 'palette' });
    s.closeOverlay();
    expect(s.get().overlay).toBeNull();
  });

  test('subscribe fires on change', () => {
    const s = new LayoutStore();
    let count = 0;
    const off = s.subscribe(() => { count++; });
    s.toggleTree();
    s.toggleChat();
    off();
    s.toggleTree();
    expect(count).toBe(2);
  });
});
