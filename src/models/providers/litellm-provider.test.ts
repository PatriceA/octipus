import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';

// bun's mock.module is process-global. Spread real exports + restore in
// afterAll so this file does not pollute unrelated suites.

process.env.LOG_LEVEL ??= 'error';
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/octipus_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
const PROXY_URL = 'http://litellm.test:4000';
process.env.LITELLM_URL = PROXY_URL;
process.env.LITELLM_API_KEY ??= 'sk-test';

const realLitellmClient = await import('../litellm-client');

const fakeCompleteResult: CompletionResult = {
  content: 'hi',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: 'gpt-4',
  latencyMs: 5,
};

let completeViaProxyCalls: CompletionOptions[] = [];
let streamViaProxyCalls: CompletionOptions[] = [];
let streamChunks: StreamChunk[] = [];

mock.module('../litellm-client', () => ({
  ...realLitellmClient,
  getLiteLLMClient: () => ({
    completeViaProxy: async (opts: CompletionOptions) => {
      completeViaProxyCalls.push(opts);
      return fakeCompleteResult;
    },
    streamViaProxy: async function* (opts: CompletionOptions) {
      streamViaProxyCalls.push(opts);
      for (const c of streamChunks) yield c;
    },
  }),
}));

const { LiteLLMProvider } = await import('./litellm-provider');

const baseOptions = (): CompletionOptions => ({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'hi', timestamp: new Date() }],
});

describe('LiteLLMProvider', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    completeViaProxyCalls = [];
    streamViaProxyCalls = [];
    streamChunks = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module('../litellm-client', () => realLitellmClient);
  });

  test('identity fields', () => {
    const p = new LiteLLMProvider();
    expect(p.name).toBe('litellm');
    expect(p.type).toBe('litellm');
  });

  test('supportsModel returns true for any string', () => {
    const p = new LiteLLMProvider();
    expect(p.supportsModel('gpt-4')).toBe(true);
    expect(p.supportsModel('claude-3-opus')).toBe(true);
    expect(p.supportsModel('')).toBe(true);
  });

  test('complete delegates to client.completeViaProxy', async () => {
    const p = new LiteLLMProvider();
    const opts = baseOptions();
    const res = await p.complete(opts);
    expect(res).toEqual(fakeCompleteResult);
    expect(completeViaProxyCalls).toHaveLength(1);
    expect(completeViaProxyCalls[0]).toBe(opts);
  });

  test('stream delegates to client.streamViaProxy and forwards every chunk', async () => {
    streamChunks = [
      { content: 'hel' },
      { content: 'lo' },
      { finishReason: 'stop' },
    ];
    const p = new LiteLLMProvider();
    const opts = baseOptions();
    const out: StreamChunk[] = [];
    for await (const c of p.stream(opts)) out.push(c);
    expect(out).toEqual(streamChunks);
    expect(streamViaProxyCalls).toHaveLength(1);
    expect(streamViaProxyCalls[0]).toBe(opts);
  });

  test('checkHealth returns healthy on 200', async () => {
    globalThis.fetch = (async (input: RequestInfo) => {
      expect(String(input)).toBe(`${PROXY_URL}/health`);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const p = new LiteLLMProvider();
    const res = await p.checkHealth();
    expect(res.healthy).toBe(true);
    expect(res.error).toBeUndefined();
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  test('checkHealth returns unhealthy with HTTP status on non-2xx', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 503 })) as unknown as typeof fetch;

    const p = new LiteLLMProvider();
    const res = await p.checkHealth();
    expect(res.healthy).toBe(false);
    expect(res.error).toBe('HTTP 503');
  });

  test('checkHealth returns unhealthy with error message when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const p = new LiteLLMProvider();
    const res = await p.checkHealth();
    expect(res.healthy).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
  });

  test('checkHealth uses 5s timeout signal', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo, init?: RequestInit) => {
      capturedInit = init;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const p = new LiteLLMProvider();
    await p.checkHealth();
    expect(capturedInit?.signal).toBeDefined();
    expect(capturedInit!.signal).toBeInstanceOf(AbortSignal);
  });
});
