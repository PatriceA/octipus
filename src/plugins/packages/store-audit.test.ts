/**
 * The store's aggregated audit (./store-audit.ts): no request goes uncounted.
 * The first of a kind writes its row, the ones after it within the window
 * are written by the flush (a timer, and shutdown), and too many kinds are
 * written before the map is cleared, never dropped.
 */
import { describe, expect, test } from 'vitest';
import { flushStoreAudits, storeAuditAggregator } from './store-audit';

const WINDOW = 60_000;

function recorder() {
  const rows: Array<{ kind: string; count: number }> = [];
  return { rows, write: (kind: string) => async (count: number) => { rows.push({ kind, count }); }, total: () => rows.reduce((n, r) => n + r.count, 0) };
}

describe('the store audit aggregator', () => {
  test('requests counted within a window are written by the flush, and none twice', async () => {
    const a = storeAuditAggregator(WINDOW);
    const r = recorder();
    for (let i = 0; i < 5; i++) await a.count('k', r.write('k'), 1000 + i);
    expect(r.rows).toEqual([{ kind: 'k', count: 1 }]);
    // Before the window ends a due-only flush (the timer's) writes nothing.
    await a.flush({ now: 2000, onlyDue: true });
    expect(r.total()).toBe(1);
    await a.flush({ now: 1000 + WINDOW, onlyDue: true });
    expect(r.rows).toEqual([{ kind: 'k', count: 1 }, { kind: 'k', count: 4 }]);
    // Nothing pending: nothing more.
    await a.flush({ now: 1000 + 3 * WINDOW });
    expect(r.total()).toBe(5);
  });

  test('shutdown writes what is pending in every aggregator', async () => {
    const a = storeAuditAggregator(WINDOW);
    const b = storeAuditAggregator(WINDOW);
    const r = recorder();
    await a.count('a', r.write('a'), 10);
    await a.count('a', r.write('a'), 11);
    await b.count('b', r.write('b'), 10);
    await b.count('b', r.write('b'), 12);
    await b.count('b', r.write('b'), 13);
    await flushStoreAudits();
    expect(r.rows.filter((x) => x.kind === 'a').reduce((n, x) => n + x.count, 0)).toBe(2);
    expect(r.rows.filter((x) => x.kind === 'b').reduce((n, x) => n + x.count, 0)).toBe(3);
  });

  test('when too many kinds are held, their counts are written before the map is cleared', async () => {
    const a = storeAuditAggregator(WINDOW);
    const r = recorder();
    // 5000 kinds, each with one request written and one pending.
    for (let i = 0; i < 5000; i++) {
      await a.count(`k${i}`, r.write(`k${i}`), 100);
      await a.count(`k${i}`, r.write(`k${i}`), 101);
    }
    expect(r.total()).toBe(5000);
    // One kind more: the 5000 pending are written first.
    await a.count('one-more', r.write('one-more'), 102);
    expect(r.total()).toBe(10_001);
  });
});
