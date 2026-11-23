/**
 * The provider registry (ProviderRouter) at its boundary: real providers,
 * rows and keys from the in-memory registry and vault doubles
 * (src/models/testing/model-doubles.ts), and the scripted provider
 * (src/models/testing/scripted-provider.ts) standing in for a custom endpoint
 * and for the LiteLLM proxy. Asserted: which provider a model resolves to,
 * which key and endpoint the request went out with, and what the router does
 * with a failure — classification, the circuit breaker, the proxy fallback.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: async () => ({}) }) }));
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
import type { CustomProviderConfig, ModelConfigEntry } from '@/db/schema/models';
import { modelRow, registryDouble, vaultDouble } from '@/models/testing/model-doubles';
import {
  chatChunk, chatCompletion, json, openAIError, sse, startScriptedProvider,
} from '@/models/testing/scripted-provider';

process.env.LOG_LEVEL = 'fatal';
process.env.NODE_ENV ??= 'test';
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const proxy = await startScriptedProvider();
const upstream = await startScriptedProvider();
process.env.LITELLM_URL = proxy.url;
process.env.LITELLM_API_KEY = 'sk-proxy';
process.env.LITELLM_MAX_RETRIES = '0';
delete process.env.CUSTOM_OPENAI_API_KEY;
delete process.env.CUSTOM_GEMINI_API_KEY;

const { resetConfig, refreshConfigKey, getConfig } = await import('@/config');
const { resetLiteLLMClient } = await import('../litellm-client');
const { resetCircuitBreakerRegistry, getCircuitBreakerRegistry } = await import('../circuit-breaker');
const { resetRateLimitManager } = await import('../rate-limiter');
const { ProviderRouter, isTransportFailure, resolveRateLimitKey } = await import('./index');

const at = new Date(0);
const hi = [{ role: 'user' as const, content: 'hi', timestamp: at }];
/** The SDK under the custom OpenAI provider retries 5xx; these answers say not to. */
const final = { headers: { 'x-should-retry': 'false' } };

function customRow(over: Partial<ModelConfigEntry> & { custom?: Partial<CustomProviderConfig> } = {}): ModelConfigEntry {
  const { custom, ...rest } = over;
  return modelRow({
    provider: 'custom-openai',
    modelId: 'wire-model',
    name: 'gateway model',
    endpoint: upstream.url,
    apiKeyRef: 'gateway_key',
    metadata: { customProvider: { auth: { type: 'bearer' }, ...custom } },
    ...rest,
  });
}

async function rejection(p: Promise<unknown>): Promise<ClassifiedError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ClassifiedError);
  return err as ClassifiedError;
}

/** Advance the fake clock in steps, letting socket I/O run between them, until `done()`. */
async function advanceUntil(done: () => boolean, limitMs: number): Promise<void> {
  for (let elapsed = 0; !done() && elapsed < limitMs; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

/** Run the fake clock until `p` settles (an SDK's own retry backoff included). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await advanceUntil(() => done, 60_000);
  return p;
}

const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

let router: InstanceType<typeof ProviderRouter>;

beforeEach(() => {
  proxy.reset();
  upstream.reset();
  registryDouble.clear();
  vaultDouble.clear();
  resetConfig();
  resetLiteLLMClient();
  resetCircuitBreakerRegistry();
  resetRateLimitManager();
  router = new ProviderRouter();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CUSTOM_OPENAI_API_KEY;
  delete process.env.CUSTOM_GEMINI_API_KEY;
  delete process.env.GATEWAY_KEY_FROM_ENV;
});

afterAll(async () => {
  await proxy.close();
  await upstream.close();
  resetConfig();
});

describe('resolution', () => {
  test('a row names the provider; without one the model name decides', async () => {
    expect((await router.resolveProvider('gpt-4o')).name).toBe('openai');
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'gpt-4o' }));
    expect((await router.resolveProvider('gpt-4o')).name).toBe('litellm');
  });

  test('a row naming a provider that is not registered falls back to the model name', async () => {
    registryDouble.add(modelRow({ provider: 'no-such-provider', modelId: 'gpt-4o' }));
    expect((await router.resolveProvider('gpt-4o')).name).toBe('openai');
  });

  test('a registry outage falls back to the model name', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'gpt-4o' }));
    registryDouble.failWith(new Error('connection ended'));
    expect((await router.resolveProvider('gpt-4o')).name).toBe('openai');
  });

  test('a disabled row is not consulted', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'gpt-4o', isEnabled: false }));
    expect((await router.resolveProvider('gpt-4o')).name).toBe('openai');
  });

  test('the named row wins over another row with the same model id', async () => {
    registryDouble.add(customRow({ name: 'a' }), modelRow({ provider: 'litellm', modelId: 'wire-model', name: 'b' }));
    expect((await router.resolveProvider('wire-model')).name).toBe('custom-openai');
    expect((await router.resolveProvider('wire-model', { modelConfigName: 'b' })).name).toBe('litellm');
  });

  test("a personal row resolves for its owner only", async () => {
    const owner = '11111111-1111-4111-8111-111111111111';
    registryDouble.add(customRow({ ownerUserId: owner, modelId: 'mine' }));
    expect((await router.resolveProvider('mine', { userId: owner })).name).toBe('custom-openai');
    expect((await router.resolveProvider('mine', { userId: '22222222-2222-4222-8222-222222222222' })).name).toBe('litellm');
    expect((await router.resolveProvider('mine')).name).toBe('litellm');
  });

  test('an unknown model with no row goes to the LiteLLM catch-all', async () => {
    expect(router.getProvider('zz-unheard-of').name).toBe('litellm');
    expect(router.getProviderByName('no-such-provider')).toBeUndefined();
  });

  test('without a proxy URL there is no LiteLLM provider, and the last registered provider is the catch-all', () => {
    getConfig();
    refreshConfigKey('litellm.proxyUrl', '');
    const bare = new ProviderRouter();
    expect(bare.getProviderByName('litellm')).toBeUndefined();
    expect(bare.getProvider('zz-unheard-of').name).toBe('custom-gemini');
  });

  test('embedding-capable providers are the ones with embed, plus the proxy', () => {
    const names = router.getEmbedCapableProviderNames();
    expect(names).toEqual(expect.arrayContaining(['ollama', 'openai', 'voyage', 'litellm']));
    expect(names).not.toContain('anthropic');
    expect(names).not.toContain('custom-openai');
  });

  test.each([
    ['claude-code', 'cli-claude'], ['gemini-cli', 'cli-gemini'], ['antigravity', 'cli-gemini'], ['codex-cli', 'cli-codex'],
    ['vibe', 'cli-vibe'], ['muse-cli', 'cli-muse'], ['glm-cli', 'cli-glm'], ['kimi-cli', 'cli-kimi'], ['something-else', 'cli-claude'],
  ])('a CLI model %s shares the %s rate bucket', (model, key) => {
    expect(resolveRateLimitKey(router.getCLIProvider(), model)).toBe(key);
  });

  test('a direct provider rate-limits under its own name', () => {
    expect(resolveRateLimitKey(router.getProviderByName('custom-openai')!, 'wire-model')).toBe('custom-openai');
  });

  test.each([
    [{ status: 503 }, true], [{ status: 429 }, true], [{ status: 401 }, false], [{ status: 400 }, false],
    [{ code: 'ECONNRESET' }, true], [{ code: 'UND_ERR_SOCKET' }, true], [new Error('socket hang up'), true],
    [new Error('fetch failed'), true], [new Error('invalid tool arguments'), false],
    [new ClassifiedError({ reason: FailoverReason.TOOL_CALL_INVALID, recovery: RecoveryAction.RETRY_NOW }), false],
    [new ClassifiedError({ reason: FailoverReason.PROVIDER_DOWN, recovery: RecoveryAction.FALLBACK_PROVIDER }), true],
  ])('isTransportFailure(%o) is %s', (err, expected) => {
    expect(isTransportFailure(err)).toBe(expected);
  });
});

describe('a custom OpenAI-compatible endpoint', () => {
  test('gets the row model id at its chat path with the vault key', async () => {
    registryDouble.add(customRow({ modelId: 'wire-model' }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'from gateway' })));
    const res = await router.complete({ model: 'wire-model', messages: hi });
    expect(res.content).toBe('from gateway');
    const [req] = upstream.requests;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer vault-key');
    expect(req.body?.model).toBe('wire-model');
    expect(proxy.requests).toHaveLength(0);
  });

  test('a key the caller brings wins over the vault', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi, apiKey: 'caller-key' });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer caller-key');
  });

  test('an env: reference reads that variable and never the vault', async () => {
    registryDouble.add(customRow({ apiKeyRef: 'env:GATEWAY_KEY_FROM_ENV' }));
    vaultDouble.set('system', 'env:GATEWAY_KEY_FROM_ENV', 'vault-key');
    process.env.GATEWAY_KEY_FROM_ENV = 'env-key';
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer env-key');
  });

  test('a vault reference with no entry falls back to CUSTOM_OPENAI_API_KEY', async () => {
    registryDouble.add(customRow());
    process.env.CUSTOM_OPENAI_API_KEY = 'fallback-key';
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer fallback-key');
  });

  test('a vault that cannot be read falls back to CUSTOM_OPENAI_API_KEY', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    vaultDouble.failWith(new Error('decrypt failed'));
    process.env.CUSTOM_OPENAI_API_KEY = 'fallback-key';
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer fallback-key');
  });

  test('the key of an install row is never read from the requester vault', async () => {
    const requester = '33333333-3333-4333-8333-333333333333';
    registryDouble.add(customRow());
    vaultDouble.set(requester, 'gateway_key', 'requester-key');
    vaultDouble.set('system', 'gateway_key', 'system-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi, userId: requester });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer system-key');
  });

  test.each([
    ['no key anywhere', {}],
    ['an env: reference to an unset variable', { apiKeyRef: 'env:GATEWAY_KEY_FROM_ENV' }],
  ])('%s fails before any request, as an auth failure nothing retries', async (_label, over) => {
    registryDouble.add(customRow(over));
    const err = await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
    expect(err.recovery).toBe(RecoveryAction.USER_PROMPT);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toMatch(/Set it|Store the key|Set the model's API key/);
    expect(err.providerHint).toBe('custom-openai');
    expect(upstream.requests).toHaveLength(0);
  });

  test('a 401 from the endpoint stays a credential to rotate', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(openAIError(401, 'invalid api key'));
    const err = await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
    expect(err.recovery).toBe(RecoveryAction.ROTATE_CREDENTIAL);
  });

  test.each([
    ['no endpoint', { endpoint: null }],
    ['no customProvider metadata', { metadata: {} }],
  ])('a row with %s fails before any request', async (_label, over) => {
    registryDouble.add(customRow(over));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(upstream.requests).toHaveLength(0);
  });

  test('header auth, extra headers and a path override reach the wire', async () => {
    registryDouble.add(customRow({ custom: { auth: { type: 'header', headerName: 'x-api-key' }, pathOverride: '/openai/v2/chat/completions', extraHeaders: { 'x-tenant': 'acme' } } }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi });
    const [req] = upstream.requests;
    expect(req.path).toBe('/openai/v2/chat/completions');
    expect(req.headers['x-api-key']).toBe('vault-key');
    expect(req.headers['x-tenant']).toBe('acme');
  });

  test('query auth puts the key in the query string of the chat path', async () => {
    registryDouble.add(customRow({ custom: { auth: { type: 'query', paramName: 'key' } } }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'wire-model', messages: hi });
    const [req] = upstream.requests;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.query).toEqual({ key: 'vault-key' });
  });

  test('streams through the router with the same key and path', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(sse([chatChunk({ content: 'a' }), chatChunk({ content: 'b' }), chatChunk({ finishReason: 'stop' })]));
    const chunks = [];
    for await (const c of router.stream({ model: 'wire-model', messages: hi })) chunks.push(c);
    expect(chunks.filter(c => c.content).map(c => c.content).join('')).toBe('ab');
    expect(upstream.requests[0]).toMatchObject({ path: '/v1/chat/completions', body: expect.objectContaining({ stream: true }) });
    expect(upstream.requests[0].headers.authorization).toBe('Bearer vault-key');
  });

  test('a thinking model gets the medium thinking budget added to its output budget', async () => {
    registryDouble.add(customRow({ modelId: 'o3-gateway', maxTokens: 64_000 }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })), json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'o3-gateway', messages: hi, maxTokens: 1_000 });
    expect(upstream.requests[0].body?.max_tokens).toBe(9_192);
  });

  test('a thinking model whose row sets think in extraBody keeps the caller budget', async () => {
    registryDouble.add(customRow({ modelId: 'o3-gateway', metadata: { customProvider: { auth: { type: 'bearer' } }, extraBody: { think: false } } }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(json(chatCompletion({ content: 'ok' })));
    await router.complete({ model: 'o3-gateway', messages: hi, maxTokens: 1_000 });
    expect(upstream.requests[0].body?.max_tokens).toBe(1_000);
  });
});

describe('a custom Gemini-compatible endpoint', () => {
  const geminiRow = () => modelRow({
    provider: 'custom-gemini', modelId: 'gem-wire', name: 'gem', endpoint: upstream.url, apiKeyRef: 'gem_key',
    metadata: { customProvider: { auth: { type: 'query', paramName: 'key' } } },
  });
  const candidate = (parts: unknown[], finishReason = 'STOP') => ({
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    modelVersion: 'gem-wire-001',
  });

  test('speaks the native generateContent wire and maps a function call to a tool call', async () => {
    registryDouble.add(geminiRow());
    vaultDouble.set('system', 'gem_key', 'gem-secret');
    upstream.enqueue(json(candidate([{ functionCall: { name: 'add', args: { a: 1 } } }])));
    const res = await router.complete({ model: 'gem-wire', messages: hi });
    const [req] = upstream.requests;
    expect(req.path).toBe('/v1beta/models/gem-wire:generateContent');
    expect(req.query).toEqual({ key: 'gem-secret' });
    expect(req.body?.contents).toEqual([expect.objectContaining({ role: 'user', parts: [{ text: 'hi' }] })]);
    expect(res).toMatchObject({ finishReason: 'tool_calls', toolCalls: [{ id: 'call_0', name: 'add', arguments: { a: 1 } }], model: 'gem-wire-001' });
    expect(res.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  });

  test('streams from streamGenerateContent with alt=sse', async () => {
    registryDouble.add(geminiRow());
    vaultDouble.set('system', 'gem_key', 'gem-secret');
    upstream.enqueue(sse([candidate([{ text: 'Hel' }], ''), candidate([{ text: 'lo' }])], { done: false }));
    const chunks = [];
    for await (const c of router.stream({ model: 'gem-wire', messages: hi })) chunks.push(c);
    expect(upstream.requests[0].path).toBe('/v1beta/models/gem-wire:streamGenerateContent');
    expect(upstream.requests[0].query).toEqual({ key: 'gem-secret', alt: 'sse' });
    expect(chunks.filter(c => c.content).map(c => c.content).join('')).toBe('Hello');
    expect(chunks.at(-1)).toMatchObject({ finishReason: 'stop' });
  });

  test('a 429 with Retry-After is waited out once, then classified as a rate limit', async () => {
    fakeClock();
    registryDouble.add(geminiRow());
    vaultDouble.set('system', 'gem_key', 'gem-secret');
    const limited = json({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }, { status: 429, headers: { 'retry-after': '2' } });
    upstream.enqueue(limited, limited);
    const pending = rejection(router.complete({ model: 'gem-wire', messages: hi }));
    await upstream.waitForRequests(1);
    await advanceUntil(() => upstream.requests.length === 2, 10_000);
    const err = await pending;
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1].receivedAt - upstream.requests[0].receivedAt).toBeGreaterThanOrEqual(2_000);
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
  });
});

describe('failure policy', () => {
  test('transport failures open the breaker, and an open breaker sends nothing', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    for (let i = 0; i < 5; i++) upstream.enqueue(openAIError(503, 'overloaded', final));
    for (let i = 0; i < 5; i++) {
      const err = await rejection(router.complete({ model: 'wire-model', messages: hi }));
      expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
    }
    expect(getCircuitBreakerRegistry().getStatus('custom-openai').state).toBe('open');
    const err = await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
    expect(err.message).toMatch(/circuit breaker is open/i);
    expect(upstream.requests).toHaveLength(5);
  });

  test('an unreachable custom endpoint fails fast and leaves the breaker its rows share closed', async () => {
    fakeClock();
    const dead = await startScriptedProvider();
    const deadUrl = dead.url;
    await dead.close();
    registryDouble.add(customRow({ name: 'mistyped', modelId: 'mistyped-model', endpoint: deadUrl }), customRow({ name: 'healthy', modelId: 'healthy-model' }));
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    for (let i = 0; i < 6; i++) {
      const err = await settle(rejection(router.complete({ model: 'mistyped-model', messages: hi })));
      expect(err.reason).toBe(FailoverReason.ENDPOINT_UNREACHABLE);
      expect(err.isRetryable).toBe(false);
    }
    expect(getCircuitBreakerRegistry().getStatus('custom-openai')).toMatchObject({ state: 'closed', failures: 0 });
    upstream.enqueue(json(chatCompletion({ content: 'still served' })));
    expect((await settle(router.complete({ model: 'healthy-model', messages: hi }))).content).toBe('still served');
  });

  test('auth failures never open the breaker', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    for (let i = 0; i < 6; i++) upstream.enqueue(openAIError(401, 'bad key'));
    for (let i = 0; i < 6; i++) {
      expect((await rejection(router.complete({ model: 'wire-model', messages: hi }))).reason).toBe(FailoverReason.AUTH_FAILED);
    }
    expect(upstream.requests).toHaveLength(6);
    expect(getCircuitBreakerRegistry().getStatus('custom-openai').state).toBe('closed');
  });

  test('a 5xx is retried by the custom provider SDK twice before the router sees it', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    const noWait = { headers: { 'retry-after-ms': '0' } };
    upstream.enqueue(openAIError(500, 'a', noWait), openAIError(500, 'b', noWait), openAIError(500, 'c', noWait));
    await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(upstream.requests).toHaveLength(3);
  });

  test('a rate-limited proxy model is sent once more through the proxy fallback after the limiter backoff, not the Retry-After', async () => {
    fakeClock();
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'proxy-model' }));
    proxy.enqueue(openAIError(429, 'rate limit', { headers: { 'retry-after': '20' } }), json(chatCompletion({ content: 'second try' })));
    const pending = router.complete({ model: 'proxy-model', messages: hi });
    await proxy.waitForRequests(1);
    await advanceUntil(() => proxy.requests.length === 2, 30_000);
    expect((await pending).content).toBe('second try');
    const waited = proxy.requests[1].receivedAt - proxy.requests[0].receivedAt;
    expect(waited).toBeGreaterThanOrEqual(1_000);
    expect(waited).toBeLessThan(20_000);
  });

  test('a proxy model whose fallback is rate limited too fails as a rate limit after two sends', async () => {
    fakeClock();
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'proxy-model' }));
    proxy.enqueue(openAIError(429, 'rate limit'), openAIError(429, 'rate limit again'));
    const pending = rejection(router.complete({ model: 'proxy-model', messages: hi }));
    await proxy.waitForRequests(1);
    await advanceUntil(() => proxy.requests.length === 2, 30_000);
    expect((await pending).reason).toBe(FailoverReason.RATE_LIMIT);
    expect(proxy.requests).toHaveLength(2);
  });

  test('an open proxy breaker still sends a proxy model to the proxy, through the fallback', async () => {
    registryDouble.add(modelRow({ provider: 'litellm', modelId: 'proxy-model' }));
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('litellm');
    proxy.enqueue(json(chatCompletion({ content: 'sent anyway' })), sse([chatChunk({ content: 'streamed anyway' }), chatChunk({ finishReason: 'stop' })]));
    expect((await router.complete({ model: 'proxy-model', messages: hi })).content).toBe('sent anyway');
    const chunks = [];
    for await (const c of router.stream({ model: 'proxy-model', messages: hi })) chunks.push(c);
    expect(chunks).toContainEqual({ content: 'streamed anyway' });
    expect(proxy.requests).toHaveLength(2);
  });

  test('an open breaker on a direct provider refuses a stream before any request', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('custom-openai');
    let error: unknown;
    try {
      for await (const _ of router.stream({ model: 'wire-model', messages: hi })) { /* drain */ }
    } catch (e) {
      error = e;
    }
    expect((error as ClassifiedError).reason).toBe(FailoverReason.PROVIDER_DOWN);
    expect(upstream.requests).toHaveLength(0);
    expect(proxy.requests).toHaveLength(0);
  });

  test('a rate-limited direct provider is not re-routed to the proxy', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(openAIError(429, 'rate limit', final));
    const err = await rejection(router.complete({ model: 'wire-model', messages: hi }));
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
    expect(proxy.requests).toHaveLength(0);
  });

  test('a failure mid-stream is classified with the provider and counts against the breaker', async () => {
    registryDouble.add(customRow());
    vaultDouble.set('system', 'gateway_key', 'vault-key');
    upstream.enqueue(sse([chatChunk({ content: 'part' })], { then: 'reset' }));
    const chunks = [];
    let error: unknown;
    try {
      for await (const c of router.stream({ model: 'wire-model', messages: hi })) chunks.push(c);
    } catch (e) {
      error = e;
    }
    expect(chunks).toEqual([{ content: 'part' }]);
    expect(error).toBeInstanceOf(ClassifiedError);
    expect((error as ClassifiedError).reason).toBe(FailoverReason.NETWORK_TIMEOUT);
    expect((error as ClassifiedError).providerHint).toBe('custom-openai');
    expect(getCircuitBreakerRegistry().getStatus('custom-openai').failures).toBe(1);
  });

  test('router.embed picks the provider by model name and refuses one without embeddings', async () => {
    await expect(router.embed(['x'], 'claude-sonnet-4-6')).rejects.toThrow('does not support embeddings');
    await expect(router.embed(['x'], 'zz-unheard-of')).rejects.toThrow('Provider litellm does not support embeddings');
    expect(proxy.requests).toHaveLength(0);
  });
});
