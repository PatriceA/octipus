/**
 * A very long line (a minified bundle, a log line of JSON) must not make
 * the editor unusable. With soft wrap on, the line's rows were recomputed
 * (every grapheme measured) for each visible row and each scroll step; with
 * it off, the whole line was tokenised and styled on every frame to show one
 * screen of it.
 *
 * The checks are structural where they can be: how many times the line is
 * broken into rows, and how much text the highlighter is handed. The time
 * bound is generous, a backstop for what the counts do not see.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sliceByColumn } from '@/tui-kit';
import { displayText } from '../editor/columns';
import { BufferStore } from '../stores/buffer-store';
import { TextEditor } from './text-editor';

const calls = vi.hoisted(() => ({ segments: 0, highlighted: 0, longest: 0 }));
vi.mock('../editor/view', async (original) => {
  const actual = await original<typeof import('../editor/view')>();
  return { ...actual, lineSegments: (line: string, width: number, wrap: boolean) => { if (wrap && line.length > 10_000) calls.segments++; return actual.lineSegments(line, width, wrap); } };
});
vi.mock('../editor/highlight', async (original) => {
  const actual = await original<typeof import('../editor/highlight')>();
  return { ...actual, highlight: (line: string, language: Parameters<typeof actual.highlight>[1]) => { calls.highlighted += line.length; calls.longest = Math.max(calls.longest, line.length); return actual.highlight(line, language); } };
});
afterEach(() => { calls.segments = 0; calls.highlighted = 0; calls.longest = 0; });

const LONG = Array.from({ length: 12_000 }, (_, i) => `{"k${i}":"v"},`).join('').slice(0, 200_000);
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '');

function setup(wrap: boolean) {
  const store = new BufferStore();
  const rec = store.openFile('/tmp/bundle.js', `before\n${LONG}\nafter`);
  const editor = new TextEditor(store, { height: 20 });
  editor.focused = true;
  editor.setWrap(wrap);
  rec.buffer.setCursor({ line: 1, col: 0 });
  return { rec, editor };
}

describe('a 200 KB line', () => {
  test('soft wrap: the line is broken into rows once per text, not per row or per step; render and keys stay fast', () => {
    const { rec, editor } = setup(true);
    const started = performance.now();
    const first = editor.render(100);
    for (let i = 0; i < 20; i++) editor.handleInput('\x1b[B'); // down a row of the wrapped line
    editor.handleInput('\x1b[6~'); // a page
    editor.render(100);
    expect(calls.segments).toBeLessThanOrEqual(2);
    rec.buffer.setCursor({ line: 1, col: 5_000 });
    editor.handleInput('x'); // an edit changes the text: one more
    editor.render(100);
    const elapsed = performance.now() - started;
    expect(calls.segments).toBeLessThanOrEqual(4);
    expect(strip(first[1])).toContain('{"k0":"v"}');
    expect(rec.buffer.getLine(1)).toContain('x');
    expect(elapsed).toBeLessThan(3000);
  });

  test('no wrap: only the visible part of the line is highlighted and styled', () => {
    const { rec, editor } = setup(false);
    const started = performance.now();
    editor.render(100);
    rec.buffer.setCursor({ line: 1, col: 150_000 });
    const rows = editor.render(100);
    for (let i = 0; i < 20; i++) editor.handleInput('\x1b[C');
    editor.handleInput('y');
    editor.render(100);
    const elapsed = performance.now() - started;
    expect(calls.longest).toBeLessThan(5_000);
    const shown = strip(rows[1]);
    expect(shown).toContain(LONG.slice(150_000 - 40, 150_000 - 10));
    expect(elapsed).toBeLessThan(3000);
  });

  test('the visible window of a long line with tabs and wide characters is drawn as the whole line would be', () => {
    const store = new BufferStore();
    const line = Array.from({ length: 3_000 }, (_, i) => `\t世界${i}`).join('');
    const rec = store.openFile('/tmp/wide.txt', line);
    const editor = new TextEditor(store, { height: 3 });
    for (const col of [0, 7_777, 20_001, line.length]) {
      rec.buffer.setCursor({ line: 0, col });
      const row = strip(editor.render(60)[0]);
      const scrollLeft = (editor as unknown as { scrollLeft: number }).scrollLeft;
      const inner = 60 - (String(1).length + 1);
      expect(row.slice(2)).toBe(sliceByColumn(displayText(line), scrollLeft, inner, true).padEnd(0));
    }
  });
});

