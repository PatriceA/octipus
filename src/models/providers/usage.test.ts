import { describe, expect, test } from 'vitest';
import { cacheAffinityKey, extractCachedTokens } from './usage';

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

import { normalizeUsage } from './usage';
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
