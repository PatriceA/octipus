import { describe, expect, test } from 'vitest';
import { estimateTokens, truncateLinesToTokens, truncateToTokens } from './token-count';

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

describe('truncateLinesToTokens', () => {
  test('keeps all lines when within budget', () => {
    const lines = ['- a (expertId: 1)', '- b (expertId: 2)'];
    expect(truncateLinesToTokens(lines, 1000)).toEqual({ lines, truncated: false });
  });

  test('always keeps the first line even if it alone exceeds budget', () => {
    const huge = `- expert (expertId: x) — ${'lorem '.repeat(2000)}`;
    const { lines, truncated } = truncateLinesToTokens([huge, '- b (expertId: 2)'], 50);
    expect(lines).toEqual([huge]); // never returns an empty list
    expect(truncated).toBe(true);
  });

  test('drops trailing lines and never cuts mid-line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `  - repo-${i} [service] /abs/path/to/repo-${i}`);
    const { lines: kept, truncated } = truncateLinesToTokens(lines, 40);
    expect(truncated).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(lines.length);
    // Every kept line is whole (highest-value first survive) — no severed path.
    expect(kept).toEqual(lines.slice(0, kept.length));
    kept.forEach((l) => expect(l.endsWith(`repo-${lines.indexOf(l)}`)).toBe(true));
  });
});
