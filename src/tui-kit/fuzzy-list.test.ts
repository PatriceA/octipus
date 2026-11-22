import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FuzzyList, type FuzzyListItem } from './fuzzy-list';

const plain = { border: (t: string) => t, title: (t: string) => t, selected: (t: string) => t, dim: (t: string) => t };
const ITEMS: FuzzyListItem<string>[] = [
  { value: 'a', label: 'header.ts', description: 'src/ui' },
  { value: 'b', label: 'parser.ts', description: 'src/core' },
  { value: 'c', label: 'readme.md', description: 'docs' },
];

function make(items = ITEMS, extra: Partial<ConstructorParameters<typeof FuzzyList<string>>[0]> = {}) {
  const chosen: string[] = [];
  let cancelled = 0;
  const list = new FuzzyList<string>({ title: 'Files', items, theme: plain, onSelect: item => chosen.push(item.value), onCancel: () => { cancelled++; }, preview: item => `Preview of ${item.label}\nsecond line`, ...extra });
  return { list, chosen, cancelled: () => cancelled, text: (width = 60) => list.render(width).join('\n') };
}

const key = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', backspace: '\x7f' };

describe('FuzzyList', () => {
  test('typing filters by letters in order, best match first; the count says how many', () => {
    const t = make();
    for (const c of 'hdr') t.list.handleInput(c);
    expect(t.list.visibleItems().map(item => item.label)).toEqual(['header.ts']);
    expect(t.text()).toContain('Files 1/3');
    t.list.handleInput(key.enter);
    expect(t.chosen).toEqual(['a']);
  });

  test('space-separated words all have to match, and match the description too', () => {
    const t = make();
    for (const c of 'ts core') t.list.handleInput(c);
    expect(t.list.visibleItems().map(item => item.value)).toEqual(['b']);
  });

  test('arrows move the highlight and the preview follows it', () => {
    const t = make();
    expect(t.text()).toContain('› header.ts');
    expect(t.text()).toContain('Preview of header.ts');
    t.list.handleInput(key.down);
    expect(t.text()).toContain('› parser.ts');
    expect(t.text()).toContain('Preview of parser.ts');
    t.list.handleInput(key.up); t.list.handleInput(key.up);
    expect(t.list.highlighted()?.value).toBe('a');
  });

  test('Escape closes; Backspace shrinks the filter, then closes on an empty one; control bytes are not text', () => {
    const t = make();
    t.list.handleInput('x'); t.list.handleInput('\x07');
    expect(t.list.getFilter()).toBe('x');
    t.list.handleInput(key.backspace);
    expect(t.list.getFilter()).toBe('');
    expect(t.cancelled()).toBe(0);
    t.list.handleInput(key.backspace);
    expect(t.cancelled()).toBe(1);
    t.list.handleInput(key.esc);
    expect(t.cancelled()).toBe(2);
  });

  test('a pasted query keeps its text without the paste markers', () => {
    const t = make();
    t.list.handleInput('\x1b[200~read\x1b[201~');
    expect(t.list.getFilter()).toBe('read');
  });

  test('no row is wider than given, none taller than allowed, outside text cannot draw', () => {
    const items = Array.from({ length: 50 }, (_, n) => ({ value: String(n), label: `item ${n} \x1b[2J 世界`.repeat(3), description: 'd\r\n' }));
    for (const rows of [3, 6, 12, 40]) for (const width of [8, 30, 120]) {
      const t = make(items);
      t.list.setMaxRows(rows);
      const lines = t.list.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.max(rows, 5));
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join('')).not.toMatch(/\x1b\[2J|\r|\n/);
    }
  });

  test('the highlight scrolls the list window with it', () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ value: String(n), label: `row ${n}` }));
    const t = make(items, { maxVisible: 5 });
    for (let n = 0; n < 12; n++) t.list.handleInput(key.down);
    expect(t.text()).toContain('› row 12');
    expect(t.text()).not.toContain('row 0');
  });

  test('a click on a row chooses it; items can arrive after it opened', () => {
    const t = make([], { emptyText: 'Loading…' });
    expect(t.text()).toContain('Loading…');
    t.list.setItems(ITEMS);
    const lines = t.list.render(60);
    const row = lines.findIndex(line => line.includes('readme.md'));
    const event = { button: 'left' as const, x: 4, y: row, screenX: 4, screenY: row, width: 60, height: lines.length, shift: false, alt: false, ctrl: false };
    expect(t.list.handleMouse({ ...event, type: 'press' })).toEqual({ handled: true });
    t.list.handleMouse({ ...event, type: 'click' });
    expect(t.chosen).toEqual(['c']);
  });
});
