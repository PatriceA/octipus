import { describe, expect, test } from 'vitest';
import { type CacheProbe, classifyCacheBreak, prefixSignature } from './cache-break';

const tools = [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }];
const base = prefixSignature('claude-sonnet-5-5', tools, ['system prompt']);
const probe = (over: Partial<CacheProbe> = {}): CacheProbe => ({ ...base, at: 1_000, inputTokens: 20_000, ...over });
const now = (over = {}) => ({ ...base, at: 61_000, ...over });

describe('prefixSignature', () => {
  test('is order-sensitive: a reordered tool list is a different prefix', () => {
    expect(prefixSignature('m', [...tools].reverse(), ['s']).tools).not.toBe(prefixSignature('m', tools, ['s']).tools);
    expect(prefixSignature('m', tools, ['s'])).toEqual(prefixSignature('m', tools, ['s']));
  });
});

describe('classifyCacheBreak', () => {
  test('names the changed part of the prefix, model first', () => {
    expect(classifyCacheBreak(probe(), now({ model: 'other' }), {}, 'anthropic')).toBe('model_changed');
    expect(classifyCacheBreak(probe(), now({ tools: 'x' }), {}, 'anthropic')).toBe('tools_changed');
    expect(classifyCacheBreak(probe(), now({ system: 'x' }), {}, 'anthropic')).toBe('system_changed');
  });

  test('an unchanged prefix that reads back under half of the previous prompt is an unexplained miss', () => {
    expect(classifyCacheBreak(probe(), now(), { cacheReadTokens: 19_000 }, 'anthropic')).toBeUndefined();
    expect(classifyCacheBreak(probe(), now(), { cacheReadTokens: 3_000 }, 'anthropic')).toBe('unexplained_miss');
    // An absent read count is zero on a provider that always reports reads.
    expect(classifyCacheBreak(probe(), now(), {}, 'openai')).toBe('unexplained_miss');
  });

  test('no verdict without a previous request, past the shortest lifetime, under the minimum, or where reads are not reported', () => {
    expect(classifyCacheBreak(undefined, now(), {}, 'anthropic')).toBeUndefined();
    expect(classifyCacheBreak(probe({ at: 0 }), now({ at: 6 * 60_000 }), {}, 'anthropic')).toBeUndefined();
    expect(classifyCacheBreak(probe({ inputTokens: 1_000 }), now(), {}, 'anthropic')).toBeUndefined();
    expect(classifyCacheBreak(probe(), now(), {}, 'ollama')).toBeUndefined();
    expect(classifyCacheBreak(probe(), now(), {}, 'litellm')).toBeUndefined();
  });
});
