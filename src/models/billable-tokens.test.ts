import { describe, expect, it } from 'vitest';
import { billableTokens } from './billable-tokens';

describe('billableTokens', () => {
  it('excludes cache reads from the billable figure', () => {
    // 35 input of which 20 were cache reads and 5 cache creation -> 10 fresh.
    expect(billableTokens({ inputTokens: 35, outputTokens: 3, totalTokens: 38, cacheReadTokens: 20, cacheCreationTokens: 5 })).toBe(13);
  });

  it('equals input + output when nothing was cached', () => {
    expect(billableTokens({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })).toBe(120);
  });

  it('never goes negative on inconsistent provider numbers', () => {
    expect(billableTokens({ inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 999 })).toBe(1);
  });
});
