/**
 * The LiteLLM client at its wire boundary: the real OpenAI SDK and the real
 * client against the scripted provider (src/models/testing/scripted-provider.ts)
 * on a local socket. What is asserted is what crossed the wire — the request
 * the proxy received, the typed result or ClassifiedError the client returned,
 * how many attempts reached the proxy and when.
 *
 * litellm-client.test.ts mocks the SDK and covers the client's own branching;
 * this suite covers what that mock cannot see.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const usageLog = vi.hoisted(() => [] as Array<{ model: string; input: number; output: number; metadata: Record<string, unknown> }>);
vi.mock('./cost-tracker', () => ({
  getCostTracker: () => ({
    logUsageWithCost: async (_user: string, model: string, input: number, output: number, opts: { metadata: Record<string, unknown> }) => {
      usageLog.push({ model, input, output, metadata: opts.metadata });
      return {};
    },
  }),
}));
// Not under test here: the install-model gate (install-access.isolation.test.ts).
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
  assertInstallModelAccess: async () => {},
}));
vi.mock('@/models/model-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/model-registry')>()),
  getModelRegistry: (await import('@/models/testing/model-doubles')).registryDouble.registry,
}));
vi.mock('@/security/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/security/vault')>()),
  getVault: (await import('@/models/testing/model-doubles')).vaultDouble.vault,
}));

import { ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { modelRow, registryDouble, vaultDouble } from '@/models/testing/model-doubles';
import {
  chatChunk, chatCompletion, embeddings, hang, json, openAIError, reset, sse, startScriptedProvider, text,
} from '@/models/testing/scripted-provider';

process.env.LOG_LEVEL = 'fatal';
process.env.NODE_ENV ??= 'test';
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const proxy = await startScriptedProvider();
process.env.LITELLM_URL = proxy.url;
process.env.LITELLM_API_KEY = 'sk-boundary';

const { resetConfig } = await import('@/config');
const { LiteLLMClient, resetLiteLLMClient } = await import('./litellm-client');
const { collectStream } = await import('./stream-collect');

/** A client built from config with these SDK settings (the client reads them at construction). */
function clientWith(opts: { maxRetries?: number; timeoutMs?: number } = {}) {
  process.env.LITELLM_MAX_RETRIES = String(opts.maxRetries ?? 0);
  process.env.LITELLM_TIMEOUT = String(opts.timeoutMs ?? 10_000);
  resetConfig();
  resetLiteLLMClient();
  return new LiteLLMClient();
}

const at = new Date(0);
const user = (content: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: 'user', content, timestamp: at, ...extra });
const hi = [user('hi')];

async function rejection(p: Promise<unknown>): Promise<ClassifiedError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ClassifiedError);
  return err as ClassifiedError;
}

/**
 * Move the fake clock forward in small steps, letting real socket I/O run
 * between steps, until `done()` or `limitMs` of fake time has passed. A retry
 * cannot leave before the client's timer fires, so the fake-time gap between
 * two requests the double records is at least the wait the client chose.
 */
async function advanceUntil(done: () => boolean, limitMs: number): Promise<void> {
  for (let elapsed = 0; !done() && elapsed < limitMs; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

async function drain<T>(it: AsyncIterable<T>): Promise<{ chunks: T[]; error?: unknown }> {
  const chunks: T[] = [];
  try {
    for await (const c of it) chunks.push(c);
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

beforeEach(() => {
  proxy.reset();
  registryDouble.clear();
  vaultDouble.clear();
  usageLog.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  await proxy.close();
  resetConfig();
});

describe('completion over the wire', () => {
  test('sends the shaped conversation to /chat/completions with the proxy key', async () => {
    proxy.enqueue(json(chatCompletion({ content: 'done' })));
    await clientWith().completeViaProxy({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief', timestamp: at },
        user('what is this', { media: [{ kind: 'image', path: '/tmp/x.png', mimeType: 'image/png', source: 'user', data: 'AAAA' }] }),
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }], timestamp: at },
        { role: 'tool', content: 'found', toolCallId: 'call_1', timestamp: at },
      ],
      temperature: 0.3,
      maxTokens: 200,
    });

    const [req] = proxy.requests;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-boundary');
    expect(req.body).toMatchObject({ model: 'gpt-4o', temperature: 0.3, max_tokens: 200, stream: false });
    expect(req.body?.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, reasoning_content: ' ', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', content: 'found', tool_call_id: 'call_1' },
    ]);
  });

  test('returns content, usage with cache counts, request id and the served model', async () => {
    proxy.enqueue(json(chatCompletion({
      id: 'chatcmpl-42', model: 'gpt-4o-2026', content: 'hello',
      usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 100 } },
    })));
    const res = await clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi });
    expect(res).toMatchObject({ content: 'hello', finishReason: 'stop', requestId: 'chatcmpl-42', model: 'gpt-4o-2026' });
    expect(res.usage).toMatchObject({ inputTokens: 120, outputTokens: 8, totalTokens: 128, cacheReadTokens: 100 });
    expect(usageLog).toEqual([expect.objectContaining({ model: 'gpt-4o', input: 120, output: 8, metadata: expect.objectContaining({ provider: 'litellm', requestId: 'chatcmpl-42', incomplete: false }) })]);
  });

  test('parses wire tool calls and keeps reasoning_content for the next turn', async () => {
    proxy.enqueue(json(chatCompletion({
      toolCalls: [{ id: 'call_a', name: 'add', arguments: '{"a":5,"b":3}' }, { id: 'call_b', name: 'noop', arguments: '' }],
      message: { reasoning_content: 'I should add.' },
    })));
    const res = await clientWith().completeViaProxy({ model: 'deepseek-reasoner', messages: hi });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'call_a', name: 'add', arguments: { a: 5, b: 3 } }, { id: 'call_b', name: 'noop', arguments: {} }]);
    expect(res.reasoningContent).toBe('I should add.');
  });

  test('sends tools with tool_choice, and a DeepSeek reasoner gets auto where required was asked', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'add', parameters: { type: 'object' } } }];
    proxy.enqueue(json(chatCompletion({ content: 'ok' })), json(chatCompletion({ content: 'ok' })));
    const client = clientWith();
    await client.completeViaProxy({ model: 'gpt-4o', messages: hi, tools, toolChoice: 'required', extraBody: { seed: 7 } });
    await client.completeViaProxy({ model: 'deepseek-reasoner', messages: hi, tools, toolChoice: 'required' });
    expect(proxy.requests[0].body).toMatchObject({ tools, tool_choice: 'required', seed: 7 });
    expect(proxy.requests[1].body).toMatchObject({ tools, tool_choice: 'auto' });
  });

  test('recovers DeepSeek tool-call markup leaked into content as structured tool calls', async () => {
    const leak = '<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.txt</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    proxy.enqueue(json(chatCompletion({ content: leak })));
    const res = await clientWith().completeViaProxy({ model: 'deepseek-v4-pro', messages: hi });
    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([expect.objectContaining({ name: 'read_file', arguments: { path: 'a.txt' } })]);
  });

  test('leaked DeepSeek markup that cannot be parsed is a retry-now tool-call failure', async () => {
    proxy.enqueue(json(chatCompletion({ content: '<｜tool▁calls▁begin｜>garbage' })));
    const err = await rejection(clientWith().completeViaProxy({ model: 'deepseek-v4-pro', messages: hi }));
    expect(err.reason).toBe(FailoverReason.TOOL_CALL_INVALID);
    expect(err.recovery).toBe(RecoveryAction.RETRY_NOW);
  });

  test('complete() on a row bound to litellm reaches the proxy with the row model id', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'proxy-model' }));
    proxy.enqueue(json(chatCompletion({ content: 'via proxy' })));
    const res = await clientWith().complete({ model: 'proxy-model', messages: hi });
    expect(res.content).toBe('via proxy');
    expect(proxy.requests.map(r => r.body?.model)).toEqual(['proxy-model']);
  });

  test('a reasoning model that spends the budget thinking is asked again with headroom', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'wire-thinker' }));
    proxy.enqueue(
      json(chatCompletion({ content: '', finishReason: 'length', usage: { prompt_tokens: 5, completion_tokens: 50, total_tokens: 55, completion_tokens_details: { reasoning_tokens: 50 } } })),
      json(chatCompletion({ content: 'answer' })),
    );
    const res = await clientWith().complete({ model: 'wire-thinker', messages: hi, maxTokens: 50 });
    expect(res.content).toBe('answer');
    expect(proxy.requests.map(r => r.body?.max_tokens)).toEqual([50, 8_050]);
  });
});

describe('failure classification over the wire', () => {
  test.each([
    ['401', openAIError(401, 'Invalid proxy server token', { type: 'auth_error' }), FailoverReason.AUTH_FAILED, RecoveryAction.ROTATE_CREDENTIAL],
    ['403', openAIError(403, 'Key not allowed to access model'), FailoverReason.AUTH_FAILED, RecoveryAction.ROTATE_CREDENTIAL],
    ['400 context_length_exceeded', openAIError(400, "This model's maximum context length is 8192 tokens", { code: 'context_length_exceeded' }), FailoverReason.CONTEXT_TOO_BIG, RecoveryAction.COMPRESS_CONTEXT],
    ['402', openAIError(402, 'Payment required'), FailoverReason.QUOTA_EXHAUSTED, RecoveryAction.FALLBACK_PROVIDER],
    ['429 insufficient_quota', openAIError(429, 'You exceeded your current quota', { code: 'insufficient_quota' }), FailoverReason.RATE_LIMIT, RecoveryAction.RETRY_BACKOFF],
    ['500', openAIError(500, 'boom', { type: 'server_error' }), FailoverReason.PROVIDER_DOWN, RecoveryAction.FALLBACK_PROVIDER],
    ['503', openAIError(503, 'no healthy deployments'), FailoverReason.PROVIDER_DOWN, RecoveryAction.FALLBACK_PROVIDER],
    ['400 other', openAIError(400, 'messages: field required'), FailoverReason.ABORT_FATAL, RecoveryAction.ABORT],
  ])('HTTP %s is classified', async (_label, reply, reason, recovery) => {
    proxy.enqueue(reply);
    const err = await rejection(clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(err.reason).toBe(reason);
    expect(err.recovery).toBe(recovery);
    expect(err.providerHint).toBe('litellm');
  });

  test('a 429 carries the Retry-After the proxy sent', async () => {
    proxy.enqueue(openAIError(429, 'Rate limit reached for requests', { headers: { 'retry-after': '7' } }));
    const err = await rejection(clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
    expect(err.retryAfterMs).toBe(7_000);
  });

  test('a truncated JSON body is an invalid response', async () => {
    proxy.enqueue(text('{"id":"x","choices":[{"message":', { contentType: 'application/json' }));
    const err = await rejection(clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(err.reason).toBe(FailoverReason.INVALID_RESPONSE);
    expect(err.recovery).toBe(RecoveryAction.RETRY_NOW);
  });

  test('a body with no choices is an invalid response', async () => {
    proxy.enqueue(json({ id: 'x', object: 'chat.completion', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }));
    const err = await rejection(clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(err.reason).toBe(FailoverReason.INVALID_RESPONSE);
  });

  test('a proxy that never answers times out at the configured limit as a network failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    proxy.enqueue(hang());
    const pending = rejection(clientWith({ timeoutMs: 3_000 }).completeViaProxy({ model: 'gpt-4o', messages: hi }));
    await proxy.waitForRequests(1);
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await pending;
    expect(err.reason).toBe(FailoverReason.NETWORK_TIMEOUT);
    await proxy.requests[0].closed;
    expect(proxy.requests[0].clientClosed).toBe(true);
  });

  test('an abort from the caller cancels the request on the wire and is a cancellation', async () => {
    proxy.enqueue(hang());
    const ctrl = new AbortController();
    const pending = rejection(clientWith().completeViaProxy({ model: 'gpt-4o', messages: hi, signal: ctrl.signal }));
    await proxy.waitForRequests(1);
    ctrl.abort();
    const err = await pending;
    expect(err.reason).toBe(FailoverReason.CASCADED_CANCELLATION);
    expect(err.recovery).toBe(RecoveryAction.ABORT);
    await proxy.requests[0].closed;
  });
});

describe('SDK retries against the proxy', () => {
  test('retries a 5xx up to maxRetries, then succeeds on the same request', async () => {
    const noWait = { headers: { 'retry-after-ms': '0' } };
    proxy.enqueue(openAIError(503, 'down', noWait), openAIError(502, 'bad gateway', noWait), json(chatCompletion({ content: 'third time' })));
    const res = await clientWith({ maxRetries: 2 }).completeViaProxy({ model: 'gpt-4o', messages: hi });
    expect(res.content).toBe('third time');
    expect(proxy.requests).toHaveLength(3);
    expect(proxy.requests.map(r => r.rawBody)).toEqual(Array(3).fill(proxy.requests[0].rawBody));
  });

  test('gives up after maxRetries and classifies the last answer', async () => {
    const noWait = { headers: { 'retry-after-ms': '0' } };
    proxy.enqueue(openAIError(500, 'a', noWait), openAIError(500, 'b', noWait), openAIError(500, 'c', noWait));
    const err = await rejection(clientWith({ maxRetries: 2 }).completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
    expect(err.message).toContain('c');
    expect(proxy.requests).toHaveLength(3);
  });

  test('never retries a client error', async () => {
    proxy.enqueue(openAIError(401, 'bad key'), json(chatCompletion({ content: 'unreachable' })));
    await rejection(clientWith({ maxRetries: 3 }).completeViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(proxy.requests).toHaveLength(1);
  });

  test('waits the Retry-After of a 429 before the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    proxy.enqueue(openAIError(429, 'slow down', { headers: { 'retry-after': '4' } }), json(chatCompletion({ content: 'after wait' })));
    const pending = clientWith({ maxRetries: 1 }).completeViaProxy({ model: 'gpt-4o', messages: hi });
    await proxy.waitForRequests(1);
    await advanceUntil(() => proxy.requests.length === 2, 30_000);
    expect((await pending).content).toBe('after wait');
    expect(proxy.requests[1].receivedAt - proxy.requests[0].receivedAt).toBeGreaterThanOrEqual(4_000);
  });
});

describe('embeddings over the wire', () => {
  test('sends one batched request and returns a vector per input in input order', async () => {
    proxy.enqueue(json(embeddings([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]])));
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'embed-small' }));
    const vectors = await clientWith().embed(['a', 'b', 'c'], 'embed-small');
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0].path).toBe('/embeddings');
    expect(proxy.requests[0].body).toEqual({ model: 'embed-small', input: ['a', 'b', 'c'], encoding_format: 'float' });
    expect(vectors).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]]);
    expect(usageLog).toEqual([expect.objectContaining({ model: 'embed-small' })]);
  });

  test('a single string is sent as a one-element batch', async () => {
    proxy.enqueue(json(embeddings([[0.5, 0.5]])));
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'embed-small' }));
    expect(await clientWith().embed('one', 'embed-small')).toEqual([[0.5, 0.5]]);
    expect(proxy.requests[0].body?.input).toEqual(['one']);
  });

  test('uses the model bound to the embedding topic when none is named', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'topic-embed', topicRoles: { embedding: 'primary' } }));
    proxy.enqueue(json(embeddings([[1, 2]])));
    await clientWith().embed('x');
    expect(proxy.requests[0].body?.model).toBe('topic-embed');
  });

  test.each([
    ['401', openAIError(401, 'invalid api key'), FailoverReason.AUTH_FAILED],
    ['400 too long', openAIError(400, 'This model\'s maximum context length is 8191 tokens', { code: 'context_length_exceeded' }), FailoverReason.CONTEXT_TOO_BIG],
    ['503', openAIError(503, 'down'), FailoverReason.PROVIDER_DOWN],
  ])('an embedding answer of HTTP %s is classified', async (_label, reply, reason) => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'embed-small' }));
    proxy.enqueue(reply);
    const err = await rejection(clientWith().embed('x', 'embed-small'));
    expect(err.reason).toBe(reason);
  });
});

describe('streaming over the wire', () => {
  test('streams text and usage, and asks the proxy to include usage', async () => {
    proxy.enqueue(sse([
      chatChunk({ content: 'Hel' }),
      chatChunk({ content: 'lo' }),
      chatChunk({ finishReason: 'stop' }),
      chatChunk({ noChoices: true, usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
    ]));
    const { chunks, error } = await drain(clientWith().streamViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(error).toBeUndefined();
    expect(proxy.requests[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(chunks.filter(c => c.content).map(c => c.content).join('')).toBe('Hello');
    expect(chunks).toContainEqual({ finishReason: 'stop' });
    expect(chunks).toContainEqual(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 9, outputTokens: 2 }) }));
    expect(usageLog).toEqual([expect.objectContaining({ input: 9, output: 2, metadata: expect.objectContaining({ incomplete: false }) })]);
  });

  test('tool-call deltas for two parallel calls assemble into two calls', async () => {
    proxy.enqueue(sse([
      chatChunk({ toolCalls: [{ index: 0, id: 'call_a', name: 'add', arguments: '' }] }),
      chatChunk({ toolCalls: [{ index: 1, id: 'call_b', name: 'mul', arguments: '{"a":' }] }),
      chatChunk({ toolCalls: [{ index: 0, arguments: '{"a":1,' }] }),
      chatChunk({ toolCalls: [{ index: 0, arguments: '"b":2}' }, { index: 1, arguments: '3}' }] }),
      chatChunk({ finishReason: 'tool_calls' }),
    ]));
    const options = { model: 'gpt-4o', messages: hi };
    const result = await collectStream(clientWith().streamViaProxy(options), options, 'litellm');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'add', arguments: { a: 1, b: 2 } },
      { id: 'call_b', name: 'mul', arguments: { a: 3 } },
    ]);
  });

  test('a <think> block split across SSE frames never reaches the caller', async () => {
    proxy.enqueue(sse([chatChunk({ content: 'Sure<thi' }), chatChunk({ content: 'nk>secret</th' }), chatChunk({ content: 'ink>, done.' }), chatChunk({ finishReason: 'stop' })]));
    const { chunks } = await drain(clientWith().streamViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(chunks.map(c => c.content ?? '').join('')).toBe('Sure, done.');
  });

  test('an error status before the stream starts is classified', async () => {
    proxy.enqueue(openAIError(429, 'rate limit', { headers: { 'retry-after': '3' } }));
    const { chunks, error } = await drain(clientWith().streamViaProxy({ model: 'gpt-4o', messages: hi }));
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(ClassifiedError);
    expect((error as ClassifiedError).reason).toBe(FailoverReason.RATE_LIMIT);
    expect((error as ClassifiedError).retryAfterMs).toBe(3_000);
  });

  test('stream() on a direct provider that fails before its first chunk is sent to the proxy under the same model id', async () => {
    registryDouble.add(modelRow({
      provider: 'custom-openai', modelId: 'gateway-only', endpoint: proxy.url, apiKeyRef: 'env:BOUNDARY_GATEWAY_KEY',
      metadata: { customProvider: { auth: { type: 'bearer' } } },
    }));
    process.env.BOUNDARY_GATEWAY_KEY = 'gateway-key';
    proxy.enqueue(openAIError(401, 'bad gateway key'), sse([chatChunk({ content: 'from the proxy' }), chatChunk({ finishReason: 'stop' })]));
    const { chunks } = await drain(clientWith().stream({ model: 'gateway-only', messages: hi }));
    delete process.env.BOUNDARY_GATEWAY_KEY;
    expect(proxy.requests.map(r => [r.path, r.body?.model, r.headers.authorization])).toEqual([
      ['/v1/chat/completions', 'gateway-only', 'Bearer gateway-key'],
      ['/chat/completions', 'gateway-only', 'Bearer sk-boundary'],
    ]);
    expect(chunks).toContainEqual({ content: 'from the proxy' });
  });

  test('stream() for a row bound to litellm goes straight to the proxy', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'proxy-stream' }));
    proxy.enqueue(sse([chatChunk({ content: 'ok' }), chatChunk({ finishReason: 'stop' })]));
    const { chunks } = await drain(clientWith().stream({ model: 'proxy-stream', messages: hi }));
    expect(chunks).toEqual([{ content: 'ok' }, { finishReason: 'stop' }]);
    expect(proxy.requests.map(r => r.body?.model)).toEqual(['proxy-stream']);
  });
});

describe('vision on a direct provider row', () => {
  const visionRow = (over: Partial<import('@/db/schema/models').ModelConfigEntry> = {}) =>
    modelRow({ provider: 'openai', modelId: 'gpt-4o', endpoint: proxy.url, supportsVision: true, ...over });
  const ask = () => clientWith().completeVision({ model: 'gpt-4o', prompt: 'what colour', imageBase64: 'QUJD', mimeType: 'image/jpeg' });

  test('posts the image to the row endpoint with the key the row names', async () => {
    registryDouble.add(visionRow({ apiKeyRef: 'vision_key' }));
    vaultDouble.set('system', 'vision_key', 'row-key');
    vaultDouble.set('system', 'openai_api_key', 'provider-key');
    proxy.enqueue(json(chatCompletion({ content: 'red' })));
    const res = await ask();
    expect(res).toMatchObject({ content: 'red', provider: 'openai' });
    const [req] = proxy.requests;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer row-key');
    expect(req.body?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'what colour' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }]);
  });

  test('without a row key, the provider vault key, then the provider env key', async () => {
    registryDouble.add(visionRow());
    vaultDouble.set('system', 'openai_api_key', 'provider-key');
    process.env.OPENAI_API_KEY = 'env-key';
    proxy.enqueue(json(chatCompletion({ content: 'a' })), json(chatCompletion({ content: 'b' })));
    await ask();
    vaultDouble.clear();
    await ask();
    expect(proxy.requests.map(r => r.headers.authorization)).toEqual(['Bearer provider-key', 'Bearer env-key']);
  });

  test('with no key anywhere it fails before any request', async () => {
    registryDouble.add(visionRow());
    await rejection(ask());
    expect(proxy.requests).toHaveLength(0);
  });
});
