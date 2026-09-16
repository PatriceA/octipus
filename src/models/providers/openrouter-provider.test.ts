import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentMessage } from '@/core/types';

process.env.OPENROUTER_API_KEY ??= 'test-key';

// OpenAI SDK mock — mirrors the pattern in litellm-client.test.ts so
// client.chat.completions.create can be inspected without a real network call.
let captured: any;
let clientOptions: any;
let responseMessage: any = { content: 'ok' };
let chunks: any[] = [];
/** Which upstream endpoint OpenRouter says served the call (drives pinning). */
let servedBy: string | undefined = 'CheapCo';
beforeEach(() => { chunks = []; responseMessage = { content: 'ok' }; servedBy = 'CheapCo'; });
vi.mock('openai', async () => {
  const actual = await vi.importActual<typeof import('openai')>('openai');
  class FakeOpenAI {
    chat: any;
    constructor(options: any) {
      clientOptions = options;
      this.chat = {
        completions: {
          create: (params: any) => {
            captured = params;
            if (params.stream) return Promise.resolve((async function* () { for (const chunk of chunks) yield chunk; })());
            return Promise.resolve({
              id: 'req1',
              model: params.model,
              provider: servedBy,
              choices: [{ message: responseMessage, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          },
        },
      };
    }
  }
  return { ...actual, default: FakeOpenAI };
});

const { OpenRouterProvider } = await import('./openrouter-provider');

const ts = () => new Date(0);
const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts() });

describe('OpenRouterProvider — cachePolicy off disables cache_control', () => {
  test('sends plain string content, no cache_control blocks, for an Anthropic model', async () => {
    const provider = new OpenRouterProvider();
    await provider.complete({
      model: 'anthropic/claude-sonnet-4-6',
      cachePolicy: 'off',
      messages: [
        { role: 'system', content: `${'x'.repeat(5000)}\n\nCURRENT DATE/TIME: now`, timestamp: ts() },
        userMsg('first'),
        { role: 'assistant', content: 'answer', timestamp: ts() },
        userMsg('second'),
      ],
    } as any);

    for (const m of captured.messages) expect(typeof m.content).toBe('string');
  });
});

describe('OpenRouter session and parameter routing', () => {
  const options = () => ({ model: 'anthropic/claude-sonnet-4-6', messages: [userMsg('question')],
    sessionId: 'session-secret', userId: 'user-secret', cacheScope: 'root:g1',
    tools: [{ type: 'function' as const, function: { name: 'read', parameters: { type: 'object' } } }],
    responseFormat: { type: 'json_object' as const }, topP: 0.8, stopSequences: ['STOP'],
    extraBody: { reasoning: { effort: 'low' }, provider: { allow_fallbacks: false } },
  });
  test('stream and complete carry identical settings and opaque sticky routing', async () => {
    const provider = new OpenRouterProvider();
    await provider.complete(options()); const complete = captured;
    for await (const _ of provider.stream(options())) { /* drain */ }
    expect({ ...captured, stream: false }).toEqual(complete);
    expect(captured.user).not.toContain('secret');
    expect(captured.user.length).toBeLessThanOrEqual(256);
    expect(captured.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
    expect(captured.reasoning).toEqual({ effort: 'low' });
    expect(captured.stream_options).toBeUndefined();
    await provider.complete({ ...options(), cacheScope: 'child:1' });
    expect(captured.user).not.toBe(complete.user);
    await provider.complete({ ...options(), cacheScope: 'root:g2' });
    expect(captured.user).not.toBe(complete.user);
  });
  test('preserves explicit routing policy and per-model credentials', async () => {
    await new OpenRouterProvider().complete({ ...options(), apiKey: 'model-specific-key',
      extraBody: { user: 'explicit', provider: { require_parameters: false, order: ['Anthropic'] } } });
    expect(captured.user).toBe('explicit');
    expect(captured.provider).toEqual({ require_parameters: false, order: ['Anthropic'] });
    expect(clientOptions.apiKey).toBe('model-specific-key');
  });
  test('retains signed reasoning through a tool loop, excluding a different model', async () => {
    const provider = new OpenRouterProvider();
    const details = [{ type: 'reasoning.text', text: 'reasoning', signature: 'signature', index: 0 }];
    responseMessage = { content: '', reasoning_details: details,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] };
    const response = await provider.complete(options());
    const messages: AgentMessage[] = [userMsg('question'), { role: 'assistant', content: '', timestamp: ts(),
      toolCalls: response.toolCalls, providerRaw: response.providerRaw },
      { role: 'tool', content: 'result', toolCallId: 't1', timestamp: ts() }];
    await provider.complete({ ...options(), messages });
    expect(captured.messages[1].reasoning_details).toEqual(details);
    await provider.complete({ ...options(), model: 'other/model', messages });
    expect(captured.messages[1].reasoning_details).toBeUndefined();
  });
  test('reassembles streaming reasoning and preserves final cost/cache accounting', async () => {
    chunks = [
      { model: 'anthropic/claude-sonnet-4-6', choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'part ' }] } }] },
      { model: 'anthropic/claude-sonnet-4-6', choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'two', signature: 'sig' }] } }] },
      { id: 'request', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 }, cost: 0.003 } },
    ];
    const output = []; for await (const chunk of new OpenRouterProvider().stream(options())) output.push(chunk);
    expect(output[1].providerRaw?.reasoning_details).toEqual([{ type: 'reasoning.text', index: 0, text: 'part two', signature: 'sig' }]);
    expect(output.at(-1)?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheCreationTokens: 30, reportedCost: 0.003 });
  });
  test('rejects an error inside an otherwise successful SSE connection', async () => {
    chunks = [{ error: { code: 429, message: 'upstream overloaded' } }];
    await expect((async () => { for await (const _ of new OpenRouterProvider().stream(options())) { /* drain */ } })()).rejects.toThrow();
  });
});

describe('OpenRouter endpoint stickiness', () => {
  const conversation = (overrides: Record<string, unknown> = {}) => ({
    model: 'z-ai/glm-4.6', messages: [userMsg('hi')],
    sessionId: 's1', userId: 'u1', cacheScope: `root:${Math.random()}`, ...overrides,
  }) as any;

  test('asks for the cheapest endpoint, then pins the conversation to whoever served it', async () => {
    const provider = new OpenRouterProvider();
    const options = conversation();

    await provider.complete(options);
    // Turn 1: no pin yet — cheapest-first, no order.
    expect(captured.provider).toEqual({ sort: 'price' });

    servedBy = 'SomeoneElse'; // must NOT change the pin mid-conversation
    await provider.complete(options);
    // Turn 2: pinned to turn 1's endpoint. Fallbacks stay on — an endpoint
    // going down costs a cache miss, not a failed turn.
    expect(captured.provider).toEqual({ sort: 'price', order: ['CheapCo'], allow_fallbacks: true });

    // ...and the reply re-pins, so a real move is followed rather than fought.
    await provider.complete(options);
    expect(captured.provider.order).toEqual(['SomeoneElse']);
  });

  test('a different conversation on the same model is pinned separately', async () => {
    const provider = new OpenRouterProvider();
    await provider.complete(conversation());
    servedBy = 'OtherCo';
    await provider.complete(conversation());
    expect(captured.provider.order).toBeUndefined(); // fresh conversation, no inherited pin
  });

  test('an explicit operator routing policy wins outright', async () => {
    const provider = new OpenRouterProvider();
    const options = conversation({ extraBody: { provider: { order: ['Pinned'], allow_fallbacks: false } } });
    await provider.complete(options);
    await provider.complete(options);
    // No sort, no sticky order bolted on: the operator owns routing entirely.
    expect(captured.provider).toEqual({ order: ['Pinned'], allow_fallbacks: false });
  });

  test('keeps require_parameters when tools are in play', async () => {
    await new OpenRouterProvider().complete(conversation({
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    }));
    expect(captured.provider.require_parameters).toBe(true);
    expect(captured.provider.sort).toBe('price');
  });
});
