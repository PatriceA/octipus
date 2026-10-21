import { beforeEach, expect, test, vi } from 'vitest';
import { decide } from '@/models/decision';
import { filterRelevance } from './relevance';
vi.mock('@/models/decision', () => ({ decide: vi.fn() }));
const hits = [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }, { id: 'c', content: 'c' }];
beforeEach(() => vi.mocked(decide).mockReset());
test('drops confidently irrelevant hits and preserves uncertain ones in original order', async () => {
  vi.mocked(decide).mockResolvedValue({
    p1: { type: 'noul', p: 0.1, confidence: 0.9 },
    p2: { type: 'noul', p: 0.5, confidence: 0.5 },
    p3: { type: 'noul', p: 0.95, confidence: 0.95 },
  });
  expect(await filterRelevance('query', hits)).toEqual(hits.slice(1));
});
test('preserves all hits on unavailable decisions, and does not probe a single hit', async () => {
  vi.mocked(decide).mockResolvedValue(null);
  expect(await filterRelevance('query', hits)).toBe(hits);
  vi.mocked(decide).mockClear();
  expect(await filterRelevance('query', [hits[0]])).toEqual([hits[0]]);
  expect(decide).not.toHaveBeenCalled();
});
test('a confident rejection of every passage produces an empty result', async () => {
  vi.mocked(decide).mockResolvedValue(Object.fromEntries(hits.map((_, i) => [`p${i + 1}`, { type: 'noul' as const, p: 0.01, confidence: 0.99 }])));
  expect(await filterRelevance('query', hits)).toEqual([]);
});
