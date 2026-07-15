import { describe, expect, test } from 'bun:test';
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
