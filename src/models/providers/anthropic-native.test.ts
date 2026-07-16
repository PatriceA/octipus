import { describe, expect, test } from 'bun:test';
import type { CompletionOptions } from '../litellm-client';
import { AnthropicProvider } from './anthropic-provider';

// Reach the private native request builder (pure — no network).
const buildBody = (o: CompletionOptions, stream: boolean) =>
  (new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, s: boolean): Record<string, unknown> })
    .buildNativeBody(o, stream);

describe('AnthropicProvider native /v1/messages body (Phase A2)', () => {
  const bigStatic = 'You are a helpful assistant. '.repeat(200); // > 4000 chars
  const system = `${bigStatic}\n\nCURRENT DATE & TIME: 2026-07-16`;

  const opts: CompletionOptions = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'hi' },
    ] as CompletionOptions['messages'],
    maxTokens: 1000,
    tools: [{ type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } }],
  };

  test('assembles a native body with model, max_tokens, messages, tools', () => {
    const body = buildBody(opts, false);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true); // converted to Anthropic tool shape
  });

  test('caches the static system prefix as cache_control content blocks', () => {
    const body = buildBody(opts, false);
    const sys = body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(sys)).toBe(true); // split at the volatile marker, not a plain string
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1].cache_control).toBeUndefined(); // volatile part uncached
  });

  test('stream flag flows through', () => {
    expect(buildBody(opts, true).stream).toBe(true);
  });
});
