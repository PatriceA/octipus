/**
 * OpenAI-compatible API (WS6) — route-level contract tests.
 *
 * Mounts the route under an injecting `.derive()` (standing in for the server's
 * app-level auth derive). No DB, no live providers.
 *
 * Dependency isolation: bun's `mock.module` is process-global, and sibling
 * suites (evaluators, litellm-client) replace `getProviderRouter` /
 * `getModelRegistry` with PARTIAL stubs that leak forward — so grabbing the real
 * singletons here and spying on them is order-dependent and crashes when their
 * mock lands first (`getProviderRouter().complete is not a function`). Following
 * the pattern in `litellm-provider.test.ts`, we pin our OWN stubs (spreading the
 * real module so other exports survive) driven by mutable impls, and restore the
 * real modules in `afterAll` so this file doesn't pollute later suites. The
 * orchestrator barrel is NOT contaminated, so `getOrchestratorService` is spied
 * normally.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

// Snapshot the real exports into plain objects BEFORE the mock.module calls
// below. bun's `mock.module` leaves the live `import * as` namespace binding
// pointing at the installed stub, so restoring from the namespace in afterAll
// re-installs the stub (a silent cross-file leak: later suites see a partial
// `getModelRegistry()` and crash on e.g. `registerModel is not a function`).
// A plain-object copy taken before mocking is immune and restores cleanly.
import { ANONYMOUS_PRINCIPAL, type Principal, principalFromUser } from '@/security/principal';

// ── Mutable per-test behavior the pinned stubs delegate to ──────────────────
let completeImpl: (opts: unknown) => Promise<unknown>;
let getAllModelsImpl: () => Promise<unknown[]>;
let completeCalls: unknown[];

vi.mock('@/models/providers', async () => ({
  ...(await vi.importActual<typeof import('@/models/providers')>('@/models/providers')),
  getProviderRouter: () => ({
    complete: (opts: unknown) => {
      completeCalls.push(opts);
      return completeImpl(opts);
    },
  }),
}));
vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getAllModels: () => getAllModelsImpl() }),
}));

const { getOrchestratorService } = await import('@/core/orchestrator');
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
  completeImpl = async () => {
    throw new Error('completeImpl not set for this test');
  };
  getAllModelsImpl = async () => [];
});

afterEach(() => {
  vi.restoreAllMocks(); // revert getOrchestratorService spies
});

afterAll(() => {
  // Restore the real modules so this file's stubs don't leak into later suites.
});

describe('GET /v1/models', () => {
  test('401 without auth (OpenAI error envelope)', async () => {
    const res = await appFor(null).handle(new Request('http://localhost/v1/models'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });

  test('lists the orchestrator model + registry models', async () => {
    getAllModelsImpl = async () => [
      { name: 'gpt-4o', provider: 'openai' },
      { name: 'llama3.2', provider: 'ollama' },
    ];
    const res = await appFor(fullUser).handle(new Request('http://localhost/v1/models'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('octipus/orchestrator');
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

describe('POST /v1/chat/completions — orchestrator mode', () => {
  test('octipus/orchestrator routes the last user message and maps the response', async () => {
    const spy = vi.spyOn(getOrchestratorService(), 'handleMessage').mockResolvedValue({
      response: 'orchestrated reply', sessionId: 's1',
      classification: { type: 'task', confidence: 1 }, metadata: { tokens: 42 },
    } as never);

    const res = await post(appFor(fullUser), {
      model: 'octipus/orchestrator',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'the real question' },
      ],
      user: 'sticky-session-id',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('octipus/orchestrator');
    expect(body.choices[0].message.content).toBe('orchestrated reply');
    expect(body.usage.total_tokens).toBe(42);

    // Last user message + sticky session + api channel.
    const [sessionId, userId, message, channel] = spy.mock.calls[0];
    expect(sessionId).toBe('sticky-session-id');
    expect(userId).toBe('u1');
    expect(message).toBe('the real question');
    expect(channel).toBe('api');
  });

  test('defaults to orchestrator when no model is given', async () => {
    vi.spyOn(getOrchestratorService(), 'handleMessage').mockResolvedValue({
      response: 'default routed', classification: { type: 'casual', confidence: 1 },
    } as never);
    const res = await post(appFor(fullUser), { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('octipus/orchestrator');
    expect(body.usage.total_tokens).toBe(0); // metadata absent → 0
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
