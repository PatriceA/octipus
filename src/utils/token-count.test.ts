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

  test('result INCLUDING the marker never exceeds the budget', () => {
    const big = 'word '.repeat(2000); // ~2000 tokens
    const out = truncateToTokens(big, 100);
    expect(out).toContain('…[truncated]');
    expect(estimateTokens(out)).toBeLessThanOrEqual(100); // hard cap, marker included
    expect(out.length).toBeLessThan(big.length);
  });

  test('cuts on token boundaries — no lone surrogate at the edge', () => {
    // Astral-plane chars (emoji) must not be split into a replacement char.
    const emoji = '😀'.repeat(500);
    const out = truncateToTokens(emoji, 50);
    expect(estimateTokens(out)).toBeLessThanOrEqual(50);
    expect(out).not.toContain('�'); // no replacement char
  });

  test('budget <= 0 yields empty', () => {
    expect(truncateToTokens('anything', 0)).toBe('');
  });
});
