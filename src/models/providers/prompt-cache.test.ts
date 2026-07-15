import { describe, expect, test } from 'bun:test';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { applyAnthropicCacheControl, isAnthropicFamily, splitVolatileSystem } from './prompt-cache';

const VOLATILE = '\n\nCURRENT DATE & TIME: 2026-07-15';

describe('isAnthropicFamily', () => {
  test('matches Anthropic slugs and claude ids, rejects others', () => {
    expect(isAnthropicFamily('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicFamily('claude-3-5-sonnet')).toBe(true);
    expect(isAnthropicFamily('openai/gpt-4o')).toBe(false);
    expect(isAnthropicFamily('gemini-2.0-flash')).toBe(false);
    // Not fooled by "anthropic" as a non-prefix substring of a foreign backend.
    expect(isAnthropicFamily('anthropic-gateway/llama-70b')).toBe(false);
  });
});

describe('splitVolatileSystem', () => {
  test('splits at the marker when the static prefix is large enough', () => {
    const staticPart = 'S'.repeat(5000);
    const split = splitVolatileSystem(staticPart + VOLATILE);
    expect(split).not.toBeNull();
    expect(split!.staticPart).toBe(staticPart);
    expect(split!.volatilePart.startsWith('\n\nCURRENT DATE')).toBe(true);
  });

  test('returns null when the static prefix is below the cache minimum', () => {
    expect(splitVolatileSystem('short' + VOLATILE)).toBeNull();
  });

  test('returns null when there is no volatile marker', () => {
    expect(splitVolatileSystem('S'.repeat(5000))).toBeNull();
  });
});

describe('applyAnthropicCacheControl', () => {
  test('rewrites a splittable system message into cached content blocks', () => {
    const staticPart = 'S'.repeat(5000);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: staticPart + VOLATILE },
      { role: 'user', content: 'hi' },
    ];
    expect(applyAnthropicCacheControl(messages)).toBe(true);

    const blocks = messages[0].content as unknown as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toBeUndefined();
    // Static prefix cached, volatile suffix not — reassembling is lossless.
    expect(blocks[0].text + blocks[1].text).toBe(staticPart + VOLATILE);
    // Non-system messages untouched.
    expect(messages[1].content).toBe('hi');
  });

  test('no-op (leaves plain string) when nothing is cacheable', () => {
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: 'short' + VOLATILE }];
    expect(applyAnthropicCacheControl(messages)).toBe(false);
    expect(messages[0].content).toBe('short' + VOLATILE);
  });

  test('marks only the FIRST splittable system message (stays under the 4-breakpoint cap)', () => {
    const big = 'S'.repeat(5000) + VOLATILE;
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: big },
      { role: 'system', content: big },
    ];
    expect(applyAnthropicCacheControl(messages)).toBe(true);
    expect(Array.isArray(messages[0].content)).toBe(true); // first rewritten
    expect(messages[1].content).toBe(big); // second left as-is → single breakpoint
  });
});
