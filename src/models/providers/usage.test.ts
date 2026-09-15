import { describe, expect, test, it } from 'vitest';
import { cacheAffinityKey, extractCachedTokens, foldCacheCounters, normalizeUsage } from './usage';

describe('cacheAffinityKey', () => {
  test('undefined session ⇒ undefined (no key sent)', () => {
    expect(cacheAffinityKey(undefined)).toBeUndefined();
    expect(cacheAffinityKey('')).toBeUndefined();
  });
  test('stable and opaque — same id maps to same key, not the raw id', () => {
    const id = '3f9a1c22-0000-4b8e-aaaa-000000000000';
    const k = cacheAffinityKey(id);
    expect(k).toBe(cacheAffinityKey(id));
    expect(k).not.toContain(id);
    expect(k?.startsWith('octi-')).toBe(true);
  });
  test('different ids map to different keys', () => {
    expect(cacheAffinityKey('session-a')).not.toBe(cacheAffinityKey('session-b'));
  });
  test('same session but different users never share a key (user-salted)', () => {
    expect(cacheAffinityKey('s1', 'userA')).not.toBe(cacheAffinityKey('s1', 'userB'));
  });
});

describe('extractCachedTokens', () => {
  test('reads OpenAI-style prompt_tokens_details.cached_tokens', () => {
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 512 } })).toEqual({
      cacheReadTokens: 512,
    });
  });

  test('reads DeepSeek prompt_cache_hit_tokens', () => {
    expect(extractCachedTokens({ prompt_cache_hit_tokens: 128 })).toEqual({ cacheReadTokens: 128 });
  });

  test('omits the field when zero or absent (spread adds nothing)', () => {
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toEqual({});
    expect(extractCachedTokens(undefined)).toEqual({});
    expect(extractCachedTokens({ prompt_tokens: 100 })).toEqual({});
  });
});

describe('foldCacheCounters', () => {
  it('folds Anthropic-native exclusive counters into inputTokens', () => {
    // Native /v1/messages: input_tokens excludes both cache counters.
    expect(foldCacheCounters({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }))
      .toEqual({ inputTokens: 35, cacheReadTokens: 20, cacheCreationTokens: 5 });
  });

  it('leaves OpenAI-compat inclusive counters alone', () => {
    // prompt_tokens already includes cached_tokens.
    expect(foldCacheCounters({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }))
      .toEqual({ inputTokens: 100, cacheReadTokens: 60, cacheCreationTokens: 0 });
  });

  it('reads cache creation under the Anthropic name on a compat body', () => {
    // Both fields are Anthropic names, so both are exclusive; true input is 100 + 50 + 40 = 190.
    expect(foldCacheCounters({ prompt_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 50 }))
      .toEqual({ inputTokens: 190, cacheReadTokens: 50, cacheCreationTokens: 40 });
  });

  it('handles hybrid: OpenAI-shaped read + Anthropic-named write', () => {
    // prompt_tokens_details.cached_tokens is already in 100; cache_creation_input_tokens is exclusive.
    expect(foldCacheCounters({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 }, cache_creation_input_tokens: 10 }))
      .toEqual({ inputTokens: 110, cacheReadTokens: 50, cacheCreationTokens: 10 });
  });

  it('handles write-only Anthropic exclusivity', () => {
    // No cache read; only cache write is exclusive.
    expect(foldCacheCounters({ input_tokens: 10, cache_creation_input_tokens: 5 }))
      .toEqual({ inputTokens: 15, cacheCreationTokens: 5 });
  });

  it('clamps if cache counters exceed the calculated input total', () => {
    // OpenAI-shaped cache counters (already included) sum to 100, but reported is only 50.
    const result = foldCacheCounters({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 } });
    expect(result).toEqual({ inputTokens: 100, cacheReadTokens: 60, cacheCreationTokens: 40 });
    // Invariant: read + write <= inputTokens
    expect(result.cacheReadTokens! + result.cacheCreationTokens).toBeLessThanOrEqual(result.inputTokens);
  });

  it('when both encodings present, OpenAI-shaped fields take precedence', () => {
    // prompt_tokens_details.cached_tokens (OpenAI-shaped, 30, already in 100) wins over
    // cache_read_input_tokens (Anthropic, 70, exclusive). Only OpenAI value is used.
    expect(foldCacheCounters({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, cache_read_input_tokens: 70 }))
      .toEqual({ inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 0 });
  });

  it('reports no counters when the provider sends none', () => {
    expect(foldCacheCounters({ prompt_tokens: 7 })).toEqual({ inputTokens: 7, cacheCreationTokens: 0 });
  });
});

describe('normalizeUsage cache fields', () => {
  it('surfaces Anthropic cache creation through the shared fold', () => {
    const u = normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 });
    expect(u.inputTokens).toBe(35);
    expect(u.cacheReadTokens).toBe(20);
    expect(u.cacheCreationTokens).toBe(5);
    // pricing.ts refuses to cost a row where read + write > input.
    expect((u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0)).toBeLessThanOrEqual(u.inputTokens);
  });
});

test('normalizes reported cost, cache writes and reasoning details', () => {
  expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, cost: 0,
    prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 8 } })).toMatchObject({
    inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50,
    cacheCreationTokens: 10, reasoningTokens: 8, reportedCost: 0, available: true,
  });
});
test('missing usage is not a free request; invalid charges are ignored', () => {
  expect(normalizeUsage(undefined).available).toBe(false);
  expect(normalizeUsage({ cost: -1 })).not.toHaveProperty('reportedCost');
});
