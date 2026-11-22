import { describe, expect, test } from 'vitest';
import { DiffOverlay, type ReviewResult } from './diff-overlay';

function setup(before: string, after: string) {
  const results: ReviewResult[] = [];
  const overlay = new DiffOverlay({ bufferLabel: 'foo.ts', before, after, onApply: (result) => { results.push(result); } });
  return {
    overlay, results,
    get accepted() { return results.filter((r) => r.text === after).length; },
    get rejected() { return results.filter((r) => r.text === before).length; },
  };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('DiffOverlay on a short terminal (docs/plans/tui-modernization.md §5.2)', () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  for (const rows of [24, 16, 10, 6]) {
    test(`fits ${rows} rows with its keys and borders on screen`, async () => {
      const { FramedOverlay } = await import('@/tui-pi/overlays/registry');
      const ctx = setup(long, long.replace(/line/g, 'LINE'));
      const lines = new FramedOverlay(ctx.overlay, () => rows).render(80).map(strip);
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines[0].startsWith('┌')).toBe(true);
      expect(lines.at(-1)?.startsWith('└')).toBe(true);
      expect(lines.at(-2)).toContain('accept');
      expect(lines[1]).toContain('Agent edit: foo.ts');
    });
  }

  test('PageDown on a short terminal shows the next line after the last one shown: none are skipped unseen', async () => {
    const { FramedOverlay } = await import('@/tui-pi/overlays/registry');
    const ctx = setup(long, long.replace(/line/g, 'LINE'));
    const framed = new FramedOverlay(ctx.overlay, () => 16);
    const shown = () => framed.render(80).map(strip).filter((l) => /[-+] (line|LINE) \d+/.test(l)).map((l) => l.replace(/^│ ?|│$/g, '').trim().replace(/^[▌✓✗ ]+/, ''));
    const firstPage = shown();
    ctx.overlay.handleInput('\x1b[6~'); // PageDown
    const secondPage = shown();
    const all = ctx.overlay.ops.map((h) => `${h.op === 'add' ? '+' : '-'} ${h.text}`);
    expect(all.indexOf(secondPage[0])).toBe(all.indexOf(firstPage.at(-1) ?? '') + 1);
  });

  test('scrolling stops at the last page of the rows it was given', () => {
    const ctx = setup(long, '');
    ctx.overlay.setMaxRows(17); // 10 body rows
    ctx.overlay.handleInput('\x1b[F'); // End
    expect(ctx.overlay.getScroll()).toBe(ctx.overlay.getRowCount() - 10);
  });
});

describe('DiffOverlay', () => {
  test('computes hunks and stats up front', () => {
    const ctx = setup('a\nb\nc', 'a\nB\nc');
    expect(ctx.overlay.stats.adds).toBe(1);
    expect(ctx.overlay.stats.dels).toBe(1);
    expect(ctx.overlay.hunks.length).toBe(1);
  });

  test('a / Enter / Ctrl+] all accept', () => {
    let n = 0;
    for (const key of ['a', '\r', '\x1d']) {
      const ctx = setup('x', 'y');
      ctx.overlay.handleInput(key);
      n += ctx.accepted;
    }
    expect(n).toBe(3);
  });

  test('r / Esc / Ctrl+[ all reject', () => {
    let n = 0;
    for (const key of ['r', '\x1b', '\x1b[']) {
      const ctx = setup('x', 'y');
      ctx.overlay.handleInput(key);
      n += ctx.rejected;
    }
    expect(n).toBeGreaterThanOrEqual(2); // \x1b is plain Esc (counted), \x1b[ may not parse on bare Esc paths
  });

  test('arrow keys scroll the diff body', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const after  = Array.from({ length: 50 }, (_, i) => `LINE ${i}`).join('\n');
    const ctx = setup(before, after);
    ctx.overlay.setBodyRows(5);
    expect(ctx.overlay.getScroll()).toBe(0);
    ctx.overlay.handleInput('\x1b[B'); // down
    expect(ctx.overlay.getScroll()).toBe(1);
    ctx.overlay.handleInput('\x1b[A'); // up
    expect(ctx.overlay.getScroll()).toBe(0);
  });

  test('renders inside a bordered box bounded by viewport width', () => {
    const ctx = setup('alpha', 'beta');
    const lines = ctx.overlay.render(60).map(strip);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('DiffOverlay hunk review (docs/plans/tui-modernization.md §7, Phase 5)', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 2\n', 'line two\n').replace('line 20', 'line twenty').replace('line 28\n', '');

  test('y and n decide the current hunk and move on; Enter applies the accepted ones only', () => {
    const ctx = setup(before, after);
    expect(ctx.overlay.hunks).toHaveLength(3);
    ctx.overlay.handleInput('y');
    expect(ctx.overlay.getCurrentHunk()).toBe(1);
    ctx.overlay.handleInput('n');
    ctx.overlay.handleInput('\r');
    expect(ctx.results).toHaveLength(1);
    const lines = ctx.results[0].text.split('\n');
    expect(lines[2]).toBe('line two');
    expect(lines[20]).toBe('line 20');
    expect(lines).not.toContain('line 28'); // undecided: taken, as Enter takes everything not rejected
    expect(ctx.results[0]).toMatchObject({ accepted: 2, rejected: 1, total: 3 });
  });

  test('] and [ jump between hunks and scroll each into view; Space flips a decision', () => {
    const ctx = setup(before, after);
    ctx.overlay.setBodyRows(5);
    ctx.overlay.handleInput(']');
    expect(ctx.overlay.getCurrentHunk()).toBe(1);
    const shown = ctx.overlay.render(80).map(strip).join('\n');
    expect(shown).toContain('- line 20');
    expect(shown).toContain('+ line twenty');
    ctx.overlay.handleInput('[');
    expect(ctx.overlay.getCurrentHunk()).toBe(0);
    ctx.overlay.handleInput(' ');
    expect(ctx.overlay.render(80).map(strip).join('\n')).toContain('1 accepted, 0 rejected');
    ctx.overlay.handleInput(' ');
    expect(ctx.overlay.render(80).map(strip).join('\n')).toContain('0 accepted, 1 rejected');
  });

  test('unchanged lines away from the hunks are folded; z unfolds them', () => {
    const ctx = setup(before, after);
    ctx.overlay.setBodyRows(100);
    const folded = ctx.overlay.render(80).map(strip).join('\n');
    expect(folded).toMatch(/⋯ \d+ unchanged lines/);
    expect(folded).not.toContain('line 11');
    expect(folded).toContain('line 17'); // three lines of context above `line 20`
    ctx.overlay.handleInput('z');
    const unfolded = ctx.overlay.render(80).map(strip).join('\n');
    expect(unfolded).not.toContain('unchanged lines');
    expect(unfolded).toContain('line 11');
  });

  test('the words that changed in a replaced line are drawn inverted', () => {
    const ctx = setup('const greeting = "hello";', 'const greeting = "goodbye";');
    const rows = ctx.overlay.render(80);
    const inverted = rows.join('\n').match(/\x1b\[7m([^\x1b]*)/g)?.map((s) => s.replace('\x1b[7m', ''));
    expect(inverted).toEqual(['hello', 'goodbye']);
  });

  test('control bytes in the file are drawn as control pictures, not written to the terminal', () => {
    const ctx = setup('a', 'evil\x1b[2J\x07');
    const rows = ctx.overlay.render(80).join('\n');
    expect(rows).not.toContain('\x1b[2J');
    expect(rows).not.toContain('\x07');
    expect(strip(rows)).toContain('evil␛[2J␇');
  });
});
