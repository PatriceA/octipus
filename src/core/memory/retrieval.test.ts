import { describe, expect, test } from 'bun:test';
import type { Memory } from '@/db/schema/memories';
import { renderMemoriesBlock } from './retrieval';

const mem = (content: string, factType = 'preference', confidence = 1): Memory =>
  ({ content, factType, confidence } as Memory);

describe('renderMemoriesBlock — token budget', () => {
  test('empty rows → empty string', () => {
    expect(renderMemoriesBlock([])).toBe('');
  });

  test('renders rows that fit and tags low-confidence facts', () => {
    const block = renderMemoriesBlock([mem('likes dark mode'), mem('guessed timezone', 'inferred', 0.6)]);
    expect(block).toContain('likes dark mode');
    expect(block).toContain('p≈0.60');
  });

  test('drops rows once the token budget is exhausted', () => {
    const rows = Array.from({ length: 50 }, (_, i) => mem(`fact number ${i} with some words`));
    const full = renderMemoriesBlock(rows, 10_000);
    const tight = renderMemoriesBlock(rows, 40);
    expect(tight.length).toBeGreaterThan(0);
    expect(tight.length).toBeLessThan(full.length);
    // Highest-value (first-ranked) rows survive the tight budget.
    expect(tight).toContain('fact number 0');
    expect(tight).not.toContain('fact number 49');
  });

  test('value-per-token: an oversized row is skipped but a cheaper later row still fits', () => {
    const rows = [mem('x'.repeat(4000)), mem('short high-value fact')];
    const block = renderMemoriesBlock(rows, 60);
    expect(block).toContain('short high-value fact');
    expect(block).not.toContain('x'.repeat(4000));
  });

  test('returns empty string when nothing fits the budget', () => {
    expect(renderMemoriesBlock([mem('y'.repeat(2000))], 20)).toBe('');
  });
});
