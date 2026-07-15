import { describe, expect, test } from 'bun:test';
import { extractCachedTokens } from './usage';

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
