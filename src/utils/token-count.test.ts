import { describe, expect, test } from 'bun:test';
import { estimateTokens, truncateToTokens } from './token-count';

describe('estimateTokens', () => {
  test('empty is zero, counts BPE tokens', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' hello world')).toBe(2);
  });
});

describe('truncateToTokens', () => {
  test('returns text unchanged when within budget', () => {
    const t = 'a short guide';
    expect(truncateToTokens(t, 1000)).toBe(t);
  });

  test('trims to approximately the budget and marks truncation', () => {
    const big = 'word '.repeat(2000); // ~2000 tokens
    const out = truncateToTokens(big, 100);
    expect(out).toContain('…[truncated to ~100 tokens]');
    expect(estimateTokens(out)).toBeLessThan(200); // near budget, not the full 2000
    expect(out.length).toBeLessThan(big.length);
  });

  test('budget <= 0 yields empty', () => {
    expect(truncateToTokens('anything', 0)).toBe('');
  });
});
