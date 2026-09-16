import { beforeEach, describe, expect, it, test, vi } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  __resetMissedCacheSplitLogs,
  applyAnthropicCacheControl,
  isAnthropicFamily,
  logMissedCacheSplit,
  splitVolatileSystem,
} from './prompt-cache';
import { modelLogger } from '@/utils/logger';

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

  test('marks short prefixes because eligibility includes tool tokens', () => {
    expect(splitVolatileSystem('short' + VOLATILE)?.staticPart).toBe('short');
  });

  test('caches an entirely stable system without a volatile marker', () => {
    expect(splitVolatileSystem('S'.repeat(5000))).toEqual({ staticPart: 'S'.repeat(5000), volatilePart: '' });
  });
});

describe('applyAnthropicCacheControl', () => {
  test('rewrites a splittable system message into cached content blocks', () => {
    const staticPart = 'S'.repeat(5000);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: staticPart + VOLATILE },
      { role: 'user', content: 'hi' },
    ];
    expect(applyAnthropicCacheControl(messages).system).toBe(true);

    const blocks = messages[0].content as unknown as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toBeUndefined();
    // Static prefix cached, volatile suffix not — reassembling is lossless.
    expect(blocks[0].text + blocks[1].text).toBe(staticPart + VOLATILE);
    // One-shot (no `conversation`): nothing later will read a write of the
    // newest turn back, so it stays a plain string and pays no write premium.
    expect(messages[1].content).toBe('hi');
  });

  test('leaves an empty prompt unchanged', () => {
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: '' }];
    expect(applyAnthropicCacheControl(messages).system).toBe(false);
    expect(messages[0].content).toBe('');
  });

  test('marks only the FIRST splittable system message (stays under the 4-breakpoint cap)', () => {
    const big = 'S'.repeat(5000) + VOLATILE;
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: big },
      { role: 'system', content: big },
    ];
    expect(applyAnthropicCacheControl(messages).system).toBe(true);
    expect(Array.isArray(messages[0].content)).toBe(true); // first rewritten
    expect(messages[1].content).toBe(big); // second left as-is → single breakpoint
  });
});

describe('every prompt-assembly site is splittable', () => {
  test('splits the direct-response system prompt', async () => {
    const { buildDirectResponseSystem } = await import('@/core/agent/direct-response');
    const system = buildDirectResponseSystem({
      persona: 'x'.repeat(5000),      // over the 4000-char floor
      dateContext: 'CURRENT DATE/TIME: 2026-09-15T10:00:00Z',
    });
    expect(splitVolatileSystem(system)).not.toBeNull();
  });
});

describe('applyAnthropicCacheControl — settled history', () => {
  it('marks the settled history as well as the system prefix', () => {
    const messages = [
      { role: 'system', content: `${'x'.repeat(5000)}\n\nCURRENT DATE/TIME: now` },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ] as any[];
    expect(applyAnthropicCacheControl(messages, 'claude-sonnet-4-5', { conversation: true })).toEqual({ system: true, history: true });
    const marked = messages.filter(m => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control));
    expect(marked).toHaveLength(2);                      // system + settled history
    expect(messages[messages.length - 1].content).toEqual([{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]); // newest turn untouched
  });
});

describe('applyAnthropicCacheControl — breakpoint outcomes', () => {
  it('M1 — places the history breakpoint past an assistant turn that is only tool_calls', () => {
    // The agent tool loop's shape: the second-to-last message is an assistant
    // turn with `tool_calls` and `content: null`. The walk used to `break` on a
    // non-string content, so no history breakpoint was placed in exactly the
    // case it was built for. (The native path never had this bug.)
    const messages = [
      { role: 'system', content: `${'x'.repeat(5000)}

CURRENT DATE/TIME: now` },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'a big tool result' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't2', content: 'the newest tool result' },
    ] as any[];

    expect(applyAnthropicCacheControl(messages, 'claude-sonnet-4-5', { conversation: true })).toEqual({ system: true, history: true });
    // Marked the last markable message before the newest turn — the tool
    // result at index 3, not nothing at all.
    expect(messages[3].content).toBe('a big tool result');
    expect(messages[5].content).toEqual([{ type: 'text', text: 'the newest tool result', cache_control: { type: 'ephemeral' } }]); // newest untouched
  });

  it('M4 — reports the two breakpoints separately so a system miss is visible', () => {
    // A short system prompt (below the cache floor) with a normal history: the
    // history breakpoint lands, the system one does not. A combined flag made
    // this read as "cached" and masked the miss anyone actually wants logged.
    const messages = [
      { role: 'system', content: `short

CURRENT DATE/TIME: now` },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ] as any[];
    expect(applyAnthropicCacheControl(messages, 'claude-sonnet-4-5', { conversation: true })).toEqual({ system: true, history: true });
  });
});

describe('logMissedCacheSplit', () => {
  beforeEach(() => __resetMissedCacheSplitLogs());

  it('logs at debug level once per model, not once per call', () => {
    const debugSpy = vi.spyOn(modelLogger, 'debug').mockImplementation(() => modelLogger as never);
    logMissedCacheSplit('claude-sonnet-4-5');
    logMissedCacheSplit('claude-sonnet-4-5');
    logMissedCacheSplit('claude-opus-4-1');
    expect(debugSpy).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });

  it('never logs at warn level — a missed split is not necessarily a defect', () => {
    const warnSpy = vi.spyOn(modelLogger, 'warn').mockImplementation(() => modelLogger as never);
    logMissedCacheSplit('claude-sonnet-4-5');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
