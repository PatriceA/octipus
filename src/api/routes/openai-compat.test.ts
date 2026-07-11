/**
 * OpenAI-compatible API (WS6) — route-level contract tests.
 *
 * Mounts the route under an injecting `.derive()` (standing in for the server's
 * app-level auth derive) and stubs the provider router / model registry /
 * orchestrator singletons with spies. No DB, no live providers.
 *
 * Asserts the OpenAI wire shapes an off-the-shelf SDK depends on: model list,
 * chat.completion object, usage mapping, SSE stream framing, auth + scope
 * envelopes, and error shapes.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import { getOrchestratorService } from '@/core/orchestrator';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import { ANONYMOUS_PRINCIPAL, type Principal, principalFromUser } from '@/security/principal';
import { openaiCompatRoutes } from './openai-compat';

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

afterEach(() => {
  // spyOn auto-restores at process exit, but restore between tests to avoid
  // one test's mock bleeding into the next.
  (getProviderRouter().complete as ReturnType<typeof spyOn>).mockRestore?.();
});

describe('GET /v1/models', () => {
  test('401 without auth (OpenAI error envelope)', async () => {
    const res = await appFor(null).handle(new Request('http://localhost/v1/models'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });

  test('lists the orchestrator model + registry models', async () => {
    spyOn(getModelRegistry(), 'getAllModels').mockResolvedValue([
      { name: 'gpt-4o', provider: 'openai' },
      { name: 'llama3.2', provider: 'ollama' },
    ] as never);
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
    spyOn(getProviderRouter(), 'complete').mockResolvedValue({
      content: 'ok', model: 'gpt-4o', finishReason: 'stop', latencyMs: 1,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    } as never);
    const res = await post(appFor(scopedWithChat), {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/chat/completions — passthrough mode', () => {
  test('maps a provider completion to a chat.completion object with real usage', async () => {
    const spy = spyOn(getProviderRouter(), 'complete').mockResolvedValue({
      content: 'The answer is 42.', model: 'gpt-4o', finishReason: 'stop', latencyMs: 5,
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
    } as never);

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
    const opts = spy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(opts.model).toBe('gpt-4o');
    expect(opts.temperature).toBe(0.2);
    expect(opts.maxTokens).toBe(100);
    expect(opts.stopSequences).toEqual(['\n\n']);
    expect((opts.messages as unknown[]).length).toBe(2);
  });

  test('stream:true returns SSE frames terminated by [DONE]', async () => {
    spyOn(getProviderRouter(), 'complete').mockResolvedValue({
      content: 'hello world', model: 'gpt-4o', finishReason: 'stop', latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as never);

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
    spyOn(getProviderRouter(), 'complete').mockRejectedValue(new Error('No provider for model bogus'));
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
    const spy = spyOn(getOrchestratorService(), 'handleMessage').mockResolvedValue({
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
    spyOn(getOrchestratorService(), 'handleMessage').mockResolvedValue({
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
