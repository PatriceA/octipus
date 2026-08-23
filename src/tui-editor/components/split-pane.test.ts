import { describe, expect, test } from 'vitest';
import { type Component, visibleWidth } from '@mariozechner/pi-tui';
import { LayoutStore } from '../stores/layout-store';
import { SplitPane } from './split-pane';

class FixedComponent implements Component {
  constructor(private readonly lines: string[], public readonly handled: string[] = []) {}
  render(_width: number): string[] { return this.lines.slice(); }
  handleInput(data: string): void { this.handled.push(data); }
  invalidate(): void {}
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('SplitPane', () => {
  test('renders all three panes when both side panes visible', () => {
    const layout = new LayoutStore();
    const tree   = new FixedComponent(['T1', 'T2']);
    const editor = new FixedComponent(['E1']);
    const chat   = new FixedComponent(['C1', 'C2', 'C3']);
    const pane = new SplitPane({ layout, tree, editor, chat });
    const lines = pane.render(120).map(strip);
    expect(lines.length).toBe(3); // tallest pane drives row count
    expect(lines[0]).toContain('T1');
    expect(lines[0]).toContain('E1');
    expect(lines[0]).toContain('C1');
  });

  test('hides tree pane when treeVisible toggled off', () => {
    const layout = new LayoutStore();
    layout.toggleTree(); // false
    const tree   = new FixedComponent(['SHOULD-NOT-APPEAR']);
    const editor = new FixedComponent(['EDITOR']);
    const chat   = new FixedComponent(['CHAT']);
    const pane = new SplitPane({ layout, tree, editor, chat });
    const text = pane.render(120).map(strip).join('\n');
    expect(text).not.toContain('SHOULD-NOT-APPEAR');
    expect(text).toContain('EDITOR');
    expect(text).toContain('CHAT');
  });

  test('routes input to the focused pane only', () => {
    const layout = new LayoutStore();
    const tree   = new FixedComponent(['t']);
    const editor = new FixedComponent(['e']);
    const chat   = new FixedComponent(['c']);
    const pane = new SplitPane({ layout, tree, editor, chat });

    layout.focus('tree');
    pane.handleInput('a');
    layout.focus('chat');
    pane.handleInput('b');
    layout.focus('editor');
    pane.handleInput('c');

    expect(tree.handled).toEqual(['a']);
    expect(chat.handled).toEqual(['b']);
    expect(editor.handled).toEqual(['c']);
  });

  test('emits resize callbacks with allocated widths', () => {
    const layout = new LayoutStore();
    let observed: { tree: number; editor: number; chat: number; rows: number } | null = null;
    const pane = new SplitPane({
      layout,
      tree: new FixedComponent(['t']),
      editor: new FixedComponent(['e']),
      chat: new FixedComponent(['c']),
      onResize: (sizes) => { observed = sizes; },
    });
    pane.render(120);
    expect(observed).not.toBeNull();
    if (observed) {
      const o = observed as { tree: number; editor: number; chat: number; rows: number };
      expect(o.tree).toBeGreaterThan(0);
      expect(o.chat).toBeGreaterThan(0);
      expect(o.editor).toBeGreaterThan(0);
      expect(o.tree + o.editor + o.chat + 2).toBeLessThanOrEqual(120); // +2 for dividers
    }
  });

  test('output respects viewport width', () => {
    const layout = new LayoutStore();
    const pane = new SplitPane({
      layout,
      tree:   new FixedComponent([]),
      editor: new FixedComponent(['x'.repeat(200)]),
      chat:   new FixedComponent([]),
    });
    const lines = pane.render(80).map(strip);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });
});
