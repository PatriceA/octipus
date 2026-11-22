import { QuotaExceededError } from '@/security/quota-error';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';
/**
 * OpenAI-compatible API (WS6) — route-level contract tests.
 *
 * Mounts the route under an injecting `.derive()` (standing in for the server's
 * app-level auth derive). No DB, no live providers.
 *
 * Dependencies: `getProviderRouter` / `getModelRegistry` are module mocks
 * (spreading the real module so other exports survive) driven by mutable
 * per-test impls. They are scoped to this file — the runner isolates each test
 * file in its own process. `getAgentService` is spied normally.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import type { CompletionOptions, StreamChunk } from '@/models/litellm-client';
import { ANONYMOUS_PRINCIPAL, type Principal, principalFromUser } from '@/security/principal';

// ── Mutable per-test behavior the pinned stubs delegate to ──────────────────
let completeImpl: (opts: unknown) => Promise<unknown>;
let streamImpl: (opts: CompletionOptions) => AsyncGenerator<StreamChunk>;
let getAllModelsImpl: () => Promise<unknown[]>;
let completeCalls: unknown[];
let streamCalls: CompletionOptions[];
let streamingSetting: boolean | undefined;
let stallSetting: number | undefined;
/** What the router resolves the model to: only `streamIsComplete` is read. */
let resolvedProvider: { name: string; streamIsComplete?: boolean };

vi.mock('@/models/providers', async () => ({
  ...(await vi.importActual<typeof import('@/models/providers')>('@/models/providers')),
  getProviderRouter: () => ({
    complete: (opts: unknown) => {
      completeCalls.push(opts);
      return completeImpl(opts);
    },
    stream: (opts: CompletionOptions) => {
      streamCalls.push(opts);
      return streamImpl(opts);
    },
    resolveProvider: async () => resolvedProvider,
  }),
}));
vi.mock('@/config', async () => {
  const actual = await vi.importActual<typeof import('@/config')>('@/config');
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        agent: { ...config.agent, ...(streamingSetting === undefined ? {} : { streaming: streamingSetting }) },
        api: { ...config.api, ...(stallSetting === undefined ? {} : { streamStallTimeoutMs: stallSetting }) },
      };
    },
  };
});
vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  // The caller's models (`getModelsForUser`); explicit names resolve to nothing
  // registered, so passthrough model ids go straight to the provider router.
  getModelRegistry: () => ({
    getModelsForUser: () => getAllModelsImpl(),
    getModelVisibleTo: async () => null,
    getModelByModelIdVisibleTo: async () => null,
    isRegistered: async () => false,
  }),
}));

const { getAgentService } = await import('@/core/agent');
const { openaiCompatRoutes } = await import('./openai-compat');

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

function appFor(principal: Principal | null): ElysiaLike {
  return new Elysia()
    .derive({ as: 'scoped' }, () => ({
      user: principal && principal.kind !== 'anonymous'
        ? { id: principal.userId, username: principal.username, isAdmin: principal.isAdmin }
        : null,
      session: null,
      principal: principal ?? ANONYMOUS_PRINCIPAL,
    }))
    .group('/v1', (a) => a.use(openaiCompatRoutes)) as unknown as ElysiaLike;
}

const fullUser = principalFromUser({ id: 'u1', username: 'alice', isAdmin: false });
const scopedNoChat: Principal = { ...fullUser, scopes: ['api:read'] };
const scopedWithChat: Principal = { ...fullUser, scopes: ['api:chat'] };

function post(app: ElysiaLike, body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  completeCalls = [];
  streamCalls = [];
  streamingSetting = undefined;
  stallSetting = undefined;
  resolvedProvider = { name: 'cli' };
  completeImpl = async () => {
    throw new Error('completeImpl not set for this test');
  };
  // A provider that does not really stream (the CLI providers): its whole
  // completion as one chunk. Not `streamIsComplete`, so never called unless a
  // test resolves to one that is.
  streamImpl = async function* (opts) {
    const result = await completeImpl(opts) as { content: string; finishReason: string };
    yield { content: result.content };
    yield { finishReason: result.finishReason };
  };
  getAllModelsImpl = async () => [];
});

afterEach(() => {
  vi.restoreAllMocks(); // revert getAgentService spies
});

describe('GET /v1/models', () => {
  test('401 without auth (OpenAI error envelope)', async () => {
    const res = await appFor(null).handle(new Request('http://localhost/v1/models'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });

  test('lists the rootAgent model + registry models', async () => {
    getAllModelsImpl = async () => [
      { name: 'gpt-4o', provider: 'openai', isEnabled: true },
      { name: 'llama3.2', provider: 'ollama', isEnabled: true },
    ];
    const res = await appFor(fullUser).handle(new Request('http://localhost/v1/models'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('octipus/agent');
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('llama3.2');
    expect(body.data.every((m: { object: string }) => m.object === 'model')).toBe(true);
  });
});

describe('POST /v1/chat/completions — auth + scope', () => {
  test('401 without auth', async () => {
    const res = await post(appFor(null), { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  test('403 when a scoped token lacks api:chat', async () => {
    const res = await post(appFor(scopedNoChat), { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('insufficient_scope');
  });

  test('a token WITH api:chat is allowed through to passthrough', async () => {
    completeImpl = async () => ({
      content: 'ok', model: 'gpt-4o', finishReason: 'stop', latencyMs: 1,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });
    const res = await post(appFor(scopedWithChat), {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/chat/completions — passthrough mode', () => {
  test('maps a provider completion to a chat.completion object with real usage', async () => {
    completeImpl = async () => ({
      content: 'The answer is 42.', model: 'gpt-4o', finishReason: 'stop', latencyMs: 5,
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
    });

    const res = await post(appFor(fullUser), {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'what is the answer?' },
      ],
      temperature: 0.2,
      max_tokens: 100,
      stop: ['\n\n'],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('gpt-4o');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'The answer is 42.' });
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 });

    // Passthrough forwards the OpenAI params to the router (stop normalized to array).
    const opts = completeCalls[0] as Record<string, unknown>;
    expect(opts.model).toBe('gpt-4o');
    expect(opts.temperature).toBe(0.2);
    expect(opts.maxTokens).toBe(100);
    expect(opts.stopSequences).toEqual(['\n\n']);
    expect((opts.messages as unknown[]).length).toBe(2);
  });

  test('stream:true returns SSE frames terminated by [DONE]', async () => {
    completeImpl = async () => ({
      content: 'hello world', model: 'gpt-4o', finishReason: 'stop', latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    const res = await post(appFor(fullUser), {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('hello world'.slice(0, 10)); // content chunk present
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('unknown provider model → 400 model_not_found', async () => {
    completeImpl = async () => {
      throw new Error('No provider for model bogus');
    };
    const res = await post(appFor(fullUser), {
      model: 'bogus',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('model_not_found');
  });
});

describe('POST /v1/chat/completions — agent mode', () => {
  test('octipus/agent routes the last user message and maps the response', async () => {
    const spy = vi.spyOn(getAgentService(), 'handleMessage').mockResolvedValue({
      response: 'orchestrated reply', sessionId: 's1',
      classification: { type: 'task', confidence: 1 }, metadata: { tokens: 42 },
    } as never);

    const res = await post(appFor(fullUser), {
      model: 'octipus/agent',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'the real question' },
      ],
      user: 'sticky-session-id',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('octipus/agent');
    expect(body.choices[0].message.content).toBe('orchestrated reply');
    expect(body.usage.total_tokens).toBe(42);

    // Last user message + sticky session + api channel.
    const [sessionId, userId, message, channel] = spy.mock.calls[0];
    expect(sessionId).toBe('sticky-session-id');
    expect(userId).toBe('u1');
    expect(message).toBe('the real question');
    expect(channel).toBe('api');
  });

  test('defaults to the agent model when no model is given', async () => {
    vi.spyOn(getAgentService(), 'handleMessage').mockResolvedValue({
      response: 'default routed', classification: { type: 'casual', confidence: 1 },
    } as never);
    const res = await post(appFor(fullUser), { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('octipus/agent');
    expect(body.usage.total_tokens).toBe(0); // metadata absent → 0
  });

  test('the retired `octipus/orchestrator` id still routes, for clients configured with it', async () => {
    vi.spyOn(getAgentService(), 'handleMessage').mockResolvedValue({
      response: 'still works', classification: { type: 'casual', confidence: 1 },
    } as never);
    const res = await post(appFor(fullUser), {
      model: 'octipus/orchestrator',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('still works');
  });

  test('malformed body (empty messages) → 400 invalid_request_error envelope', async () => {
    const res = await post(appFor(fullUser), { model: 'gpt-4o', messages: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
  });

  test('octipus/<role> (unwired) → 400 model_not_found', async () => {
    const res = await post(appFor(fullUser), {
      model: 'octipus/research',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('model_not_found');
  });
});


describe('platform budget refusals retain actionable guidance', () => {
  test.each([
    new QuotaExceededError({ kind: 'tokensPerDay', current: 10_000_001, max: 10_000_000, userId: 'u1' }),
    new SpendBudgetExceededError({ budgetId: 'b', userId: 'u1', scopeKind: 'user', scopeRef: null, period: 'day', spentUsd: 5, limitUsd: 5 }),
  ])('$code is HTTP 429, not an internal/provider error', async error => {
    completeImpl = async () => { throw error; };
    const response = await post(appFor(fullUser), { model: 'custom-model', messages: [{ role: 'user', content: 'hello' }] });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: error.code, type: 'rate_limit_exceeded', message: error.message });
    expect(body.error.message).toContain('/admin/quotas');
  });
});

// ── Token-true streaming ─────────────────────────────────────────────────────

const { OpenAIProvider } = await import('@/models/providers/openai-provider');

/** A promise with its resolver, to hold a scripted provider mid-reply. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Script {
  pieces: string[];
  toolCall?: { id: string; name: string; arguments: string };
  /** Awaited before piece `i` is sent (streaming only). */
  holdBefore?: Map<number, Promise<void>>;
  /** Awaited after the finish chunk, before the usage chunk (streaming only). */
  holdBeforeUsage?: Promise<void>;
  /** Fails the stream after the pieces. */
  failAfterPieces?: Error;
}

/**
 * The real OpenAI-compatible provider over a scripted client: `stream: true`
 * yields SDK chunks piece by piece (each may be held), a plain request returns
 * the same script as one message. Records what the stream saw.
 */
function scriptedProvider(script: Script) {
  const seen = { finished: false, released: false, usageRead: false, signal: undefined as AbortSignal | undefined };
  const abortable = (p: Promise<void>, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    p.then(resolve);
  });
  const base = { id: 'cmpl-scripted', object: 'chat.completion.chunk', created: 1, model: 'scripted-model' };
  async function* sdkStream(signal?: AbortSignal) {
    seen.signal = signal;
    try {
      for (const [i, piece] of script.pieces.entries()) {
        const hold = script.holdBefore?.get(i);
        if (hold) await abortable(hold, signal);
        yield { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
      }
      if (script.toolCall) {
        const { id, name, arguments: args } = script.toolCall;
        yield { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] };
      }
      if (script.failAfterPieces) throw script.failAfterPieces;
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: script.toolCall ? 'tool_calls' : 'stop' }] };
      if (script.holdBeforeUsage) await abortable(script.holdBeforeUsage, signal);
      seen.usageRead = true;
      yield { ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: script.pieces.length, total_tokens: 4 + script.pieces.length } };
      seen.finished = true;
    } finally {
      seen.released = true;
    }
  }
  const create = async (params: { stream?: boolean }, request?: { signal?: AbortSignal }) => params.stream
    ? sdkStream(request?.signal)
    : {
      id: 'cmpl-scripted', model: 'scripted-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: script.pieces.join(''),
          ...(script.toolCall ? { tool_calls: [{ id: script.toolCall.id, type: 'function', function: { name: script.toolCall.name, arguments: script.toolCall.arguments } }] } : {}),
        },
        finish_reason: script.toolCall ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 4, completion_tokens: script.pieces.length, total_tokens: 4 + script.pieces.length },
    };
  const provider = new OpenAIProvider();
  (provider as unknown as { createClient: () => unknown }).createClient = async () => ({ chat: { completions: { create } } });
  return { provider, seen };
}

function useProvider(provider: InstanceType<typeof OpenAIProvider>) {
  completeImpl = (opts) => provider.complete(opts as CompletionOptions);
  streamImpl = (opts) => provider.stream(opts);
  resolvedProvider = provider;
}

type Frame = { id?: string; choices?: Array<{ delta: { role?: string; content?: string; tool_calls?: unknown }; finish_reason: string | null }>; error?: { message: string } } | '[DONE]';

/** Reads SSE frames off a response body as they arrive. */
function frameReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    reader,
    async next(): Promise<Frame | undefined> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const raw = buffer.slice(0, end).replace(/^data: /, '');
          buffer = buffer.slice(end + 2);
          return raw === '[DONE]' ? '[DONE]' : JSON.parse(raw);
        }
        const { value, done } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async rest(): Promise<Frame[]> {
      const out: Frame[] = [];
      for (let f = await this.next(); f !== undefined; f = await this.next()) out.push(f);
      return out;
    },
  };
}

const contentOf = (frames: Frame[]) => frames.map((f) => (f === '[DONE]' ? '' : f.choices?.[0]?.delta.content ?? '')).join('');
const idsOf = (frames: Frame[]) => new Set(frames.filter((f) => f !== '[DONE]').map((f) => (f as { id: string }).id));

function postStream(body: Record<string, unknown>, signal?: AbortSignal) {
  return appFor(fullUser).handle(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'scripted-model', messages: [{ role: 'user', content: 'arms?' }], stream: true, ...body }),
    ...(signal ? { signal } : {}),
  }));
}

describe('POST /v1/chat/completions — token-true passthrough streaming', () => {
  /** The non-streamed answer for a script, then the streamed text for the same script. */
  async function bothWays(script: Script) {
    useProvider(scriptedProvider(script).provider);
    const plain = await (await post(appFor(fullUser), { model: 'scripted-model', messages: [{ role: 'user', content: 'q' }] })).json();
    useProvider(scriptedProvider(script).provider);
    const frames = await frameReader(await postStream({})).rest();
    return { plain: plain.choices[0].message.content as string, frames };
  }

  test('deltas reach the client while the provider is still writing, in protocol order', async () => {
    const last = deferred();
    const { provider, seen } = scriptedProvider({ pieces: ['Octo', 'puses ', 'have ', 'eight ', 'arms.'], holdBefore: new Map([[4, last.promise]]) });
    useProvider(provider);

    const res = await postStream({});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = frameReader(res);
    const role = (await frames.next())!;
    expect(role).toMatchObject({ object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] });
    const early: Frame[] = [];
    for (let i = 0; i < 4; i++) early.push((await frames.next())!);
    // Four deltas are out and the provider has not finished its reply.
    expect(early.map((f) => f !== '[DONE]' && f.choices?.[0]?.delta.content)).toEqual(['Octo', 'puses ', 'have ', 'eight ']);
    expect(seen.finished).toBe(false);

    last.resolve();
    const rest = await frames.rest();
    expect(contentOf(rest)).toBe('arms.');
    expect(rest.at(-2)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(rest.at(-1)).toBe('[DONE]');
    const ids = idsOf([role, ...early, ...rest]);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^chatcmpl-/);
    expect(completeCalls).toHaveLength(0);
  });

  // The OpenAI-shaped providers (`streamIsComplete`) alter the text on neither
  // path, so each case that some other path would normalise streams verbatim
  // and matches the non-streamed answer byte for byte.
  test.each([
    ['plain text', ['The', ' answer', ' is', ' 42', '.']],
    ['leading and trailing whitespace', ['\n ', ' The answer', '.\n', '  ']],
    ['a <think> block', ['<think>', 'count them', '</think>', 'Eight.']],
    ['a <thinking> block', ['<thinking>plan', '</thinking>Answer']],
    ['a <reasoning> block', ['<reasoning>x', '</reasoning> Eight.']],
    ['a leaked JSON thinking wrapper', ['{"thought": "count ', 'the arms"}', ' Eight.']],
    ['whitespace only', [' ', '\n']],
  ])('%s: the concatenated deltas are exactly the non-streamed answer', async (_case, pieces) => {
    const { plain, frames } = await bothWays({ pieces });
    expect(plain).toBe(pieces.join(''));
    expect(contentOf(frames)).toBe(plain);
    expect(streamCalls).toHaveLength(1);
  });

  test('tool-call deltas are not answer text: only the text the reply carries is streamed', async () => {
    const { plain, frames } = await bothWays({ pieces: ['Checking ', 'the docs.'], toolCall: { id: 'call_1', name: 'search', arguments: '{"q":"arms"}' } });
    expect(frames.some((f) => f !== '[DONE]' && f.choices?.[0]?.delta.tool_calls !== undefined)).toBe(false);
    expect(contentOf(frames)).toBe('Checking the docs.');
    expect(contentOf(frames)).toBe(plain);
  });

  test('a provider whose stream is not its completion is completed and chunked, never streamed', async () => {
    // As the LiteLLM proxy: its completion strips <thinking> and trims, its
    // stream strips only <think>. Streaming it would show text the
    // non-streamed answer filters.
    resolvedProvider = { name: 'litellm' };
    completeImpl = async () => ({ content: 'Answer', model: 'm', finishReason: 'stop', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    streamImpl = async function* () { yield { content: '<thinking>plan</thinking>Answer\n' }; };
    const frames = await frameReader(await postStream({})).rest();
    expect(contentOf(frames)).toBe('Answer');
    expect(streamCalls).toHaveLength(0);
    expect(completeCalls).toHaveLength(1);
    expect(frames.at(-1)).toBe('[DONE]');
  });

  test('two concurrent streams keep their own text and ids', async () => {
    const holdA = deferred();
    const holdB = deferred();
    const provA = scriptedProvider({ pieces: ['alpha-1 ', 'alpha-2 ', 'alpha-3'], holdBefore: new Map([[1, holdA.promise]]) });
    const provB = scriptedProvider({ pieces: ['beta-1 ', 'beta-2 ', 'beta-3'], holdBefore: new Map([[1, holdB.promise]]) });
    resolvedProvider = provA.provider;
    streamImpl = (opts) => (opts.messages.at(-1)?.content === 'a' ? provA : provB).provider.stream(opts);

    const ra = frameReader(await postStream({ messages: [{ role: 'user', content: 'a' }] }));
    const rb = frameReader(await postStream({ messages: [{ role: 'user', content: 'b' }] }));
    const fa = [(await ra.next())!, (await ra.next())!];
    const fb = [(await rb.next())!, (await rb.next())!];
    holdB.resolve();
    fb.push(...(await rb.rest()));
    holdA.resolve();
    fa.push(...(await ra.rest()));

    expect(contentOf(fa)).toBe('alpha-1 alpha-2 alpha-3');
    expect(contentOf(fb)).toBe('beta-1 beta-2 beta-3');
    expect(idsOf(fa).size).toBe(1);
    expect(idsOf(fb).size).toBe(1);
    expect([...idsOf(fa)][0]).not.toBe([...idsOf(fb)][0]);
  });

  test('a client that goes away mid-reply aborts the provider call and releases the stream', async () => {
    const never = deferred();
    const { provider, seen } = scriptedProvider({ pieces: ['first ', 'never sent'], holdBefore: new Map([[1, never.promise]]) });
    useProvider(provider);
    const client = new AbortController();
    const frames = frameReader(await postStream({}, client.signal));
    await frames.next(); // role
    expect(contentOf([(await frames.next())!])).toBe('first ');

    client.abort();
    await frames.reader.cancel();
    await vi.waitFor(() => expect(seen.released).toBe(true));
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.usageRead).toBe(false);
    expect(streamCalls[0].signal?.aborted).toBe(true);
  });

  test('a client that leaves once the text is complete still lets the usage chunk be read', async () => {
    const usage = deferred();
    const { provider, seen } = scriptedProvider({ pieces: ['all ', 'here'], holdBeforeUsage: usage.promise });
    useProvider(provider);
    const client = new AbortController();
    const frames = frameReader(await postStream({}, client.signal));
    await frames.next(); // role
    await frames.next();
    await frames.next(); // both pieces: the provider now holds its usage chunk, after the finish reason
    await new Promise((r) => setTimeout(r, 10));

    client.abort();
    void frames.reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.signal?.aborted).toBe(false); // not cut off: within the drain bound
    usage.resolve();
    await vi.waitFor(() => expect(seen.released).toBe(true));
    expect(seen.usageRead).toBe(true);
    expect(seen.finished).toBe(true);
  });

  test('a client that stops reading is dropped after the stall timeout', async () => {
    stallSetting = 50;
    const { provider, seen } = scriptedProvider({ pieces: ['one ', 'two ', 'three'] });
    useProvider(provider);
    const frames = frameReader(await postStream({}));
    await frames.next(); // role — then the client reads nothing more
    await vi.waitFor(() => expect(seen.released).toBe(true), { timeout: 2_000 });
    expect(streamCalls[0].signal?.aborted).toBe(true);
    expect(seen.finished).toBe(false);
    await frames.reader.cancel();
  });

  test('a finished stream releases its abort link', async () => {
    useProvider(scriptedProvider({ pieces: ['done'] }).provider);
    await frameReader(await postStream({})).rest();
    expect(streamCalls[0].signal?.aborted).toBe(true);
  });

  test('a provider error before the first chunk is returned once, with its status: no retry without streaming', async () => {
    resolvedProvider = { name: 'openai', streamIsComplete: true };
    streamImpl = async function* () { throw new Error('upstream 503'); };
    const res = await postStream({});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ type: 'server_error', message: 'upstream 503' });
    expect(streamCalls).toHaveLength(1);
    expect(completeCalls).toHaveLength(0);
  });

  test('a refusal before the first chunk keeps its HTTP status and envelope', async () => {
    resolvedProvider = { name: 'openai', streamIsComplete: true };
    streamImpl = async function* () { throw new Error('No provider for model bogus'); };
    const res = await postStream({ model: 'bogus' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('model_not_found');
    expect(completeCalls).toHaveLength(0);
  });

  test('a provider failing midway ends the stream with an error frame, not a finish chunk', async () => {
    useProvider(scriptedProvider({ pieces: ['partial '], failAfterPieces: new Error('connection reset') }).provider);
    const frames = await frameReader(await postStream({})).rest();
    expect(contentOf(frames)).toBe('partial ');
    expect(frames.some((f) => f !== '[DONE]' && f.choices?.[0]?.finish_reason === 'stop')).toBe(false);
    expect(frames.at(-2)).toMatchObject({ error: { message: expect.stringContaining('connection reset') } });
    expect(frames.at(-1)).toBe('[DONE]');
  });

  test('`agent.streaming: false` chunks the finished reply instead', async () => {
    streamingSetting = false;
    useProvider(scriptedProvider({ pieces: ['not ', 'streamed'] }).provider);
    const frames = await frameReader(await postStream({})).rest();
    expect(contentOf(frames)).toBe('not streamed');
    expect(streamCalls).toHaveLength(0);
    expect(completeCalls).toHaveLength(1);
  });
});

describe('POST /v1/chat/completions — agent-mode streaming', () => {
  test('streams the turn\'s final answer only, in protocol order', async () => {
    vi.spyOn(getAgentService(), 'handleMessage').mockResolvedValue({
      response: 'The final answer, after the tools ran.', sessionId: 's1',
      classification: { type: 'task', confidence: 1 },
    } as never);
    const frames = await frameReader(await postStream({ model: 'octipus/agent' })).rest();
    expect(frames[0]).toMatchObject({ choices: [{ delta: { role: 'assistant' } }] });
    expect(contentOf(frames)).toBe('The final answer, after the tools ran.');
    expect(frames.at(-2)).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
    expect(frames.at(-1)).toBe('[DONE]');
    expect(streamCalls).toHaveLength(0);
  });
});
