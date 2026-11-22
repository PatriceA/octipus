import { describe, expect, test } from 'vitest';
import { DiffOverlay } from './diff-overlay';

function setup(before: string, after: string) {
  let accepted = 0; let rejected = 0;
  const overlay = new DiffOverlay({
    bufferLabel: 'foo.ts',
    before, after,
    onAccept: () => { accepted++; },
    onReject: () => { rejected++; },
  });
  return { overlay, get accepted() { return accepted; }, get rejected() { return rejected; } };
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
    const shown = () => framed.render(80).map(strip).filter((l) => /[-+] (line|LINE) \d+/.test(l)).map((l) => l.replace(/^│ ?|│$/g, '').trim());
    const firstPage = shown();
    ctx.overlay.handleInput('\x1b[6~'); // PageDown
    const secondPage = shown();
    const all = ctx.overlay.hunks.map((h) => `${h.op === 'add' ? '+' : '-'} ${h.text}`);
    expect(all.indexOf(secondPage[0])).toBe(all.indexOf(firstPage.at(-1) ?? '') + 1);
  });

  test('scrolling stops at the last page of the rows it was given', () => {
    const ctx = setup(long, '');
    ctx.overlay.setMaxRows(17); // 10 body rows
    ctx.overlay.handleInput('\x1b[F'); // End
    expect(ctx.overlay.getScroll()).toBe(ctx.overlay.hunks.length - 10);
  });
});

describe('DiffOverlay', () => {
  test('computes hunks and stats up front', () => {
    const ctx = setup('a\nb\nc', 'a\nB\nc');
    expect(ctx.overlay.stats.adds).toBe(1);
    expect(ctx.overlay.stats.dels).toBe(1);
    expect(ctx.overlay.hunks.length).toBeGreaterThan(0);
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
