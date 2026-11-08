import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// No DNS in the unit lane: the public check and the guarded fetch are stubbed,
// the synchronous URL rules (sanitize's IP helpers) stay real.
const urlCheck = vi.hoisted(() => ({ valid: true as boolean, reason: undefined as string | undefined }));
const guardedFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>());
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/sanitize')>()),
  validateExternalUrl: vi.fn(async () => ({ ...urlCheck })),
  fetchGuarded: guardedFetch,
}));
const vaultSecrets = vi.hoisted(() => new Map<string, string>());
vi.mock('@/security/vault', () => ({
  getVault: () => ({ getByName: vi.fn(async (owner: string, name: string) => (owner === 'system' ? vaultSecrets.get(name) ?? null : null)) }),
  isReservedSecretName: (name: string) => name === 'federation.identity' || name === 'ext.acme.reserved',
}));
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
  assertInstallModelAccess: async () => {},
}));
vi.mock('@/services/org-membership', () => ({ getUserOrgIds: vi.fn(async () => []) }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: vi.fn(async () => ({})) }) }));

import { GatewayEventBus } from '@/core/gateway/event-bus';
import type { ModelConfigEntry } from '@/db/schema/models';
import { getCircuitBreakerRegistry } from '@/models/circuit-breaker';
import { _clearExtensionModelsForTesting, listExtensionModels } from '@/models/extension-models';
import { getModelRegistry } from '@/models/model-registry';
import { ProviderRouter, resolveRateLimitKey } from '@/models/providers';
import { CustomOpenAICompatProvider } from '@/models/providers/custom/openai-compat-provider';
import { buildExtensionContext } from './api';
import type { ExtensionProviderDef } from './types';

const root = mkdtempSync(join(tmpdir(), 'octipus-ext-providers-'));
const entry = join(root, 'acme', 'index.ts');
mkdirSync(join(root, 'acme'), { recursive: true });
writeFileSync(entry, 'export default () => {}');

const disposers: Array<() => Promise<void>> = [];
function ext(name = 'acme', trusted = true) {
  const built = buildExtensionContext(name, entry, new GatewayEventBus(), trusted);
  disposers.push(() => built.loaded.dispose());
  return built;
}

const SECRET = 'ext.acme.gateway_key';
const def = (over: Partial<ExtensionProviderDef> = {}): ExtensionProviderDef => ({
  id: 'gateway',
  kind: 'openai-compatible',
  baseUrl: 'https://llm.example.com/',
  apiKeySecret: SECRET,
  models: [{ id: 'acme-large', contextWindow: 200_000, maxOutput: 8192 }],
  ...over,
});
const ROW = 'ext/acme/gateway/acme-large';
const hi = () => [{ role: 'user' as const, content: 'hi', timestamp: new Date() }];
const okCompletion = () => new Response(JSON.stringify({
  id: 'r1', model: 'acme-large', object: 'chat.completion', created: 0,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const registry = getModelRegistry();
const dbRowExists = vi.spyOn(registry, 'databaseRowExists');

/**
 * A stand-in database: every query answers `rows`, and writes are recorded.
 * Enough for the registry's lookups by model id, which must reach the
 * database (not an extension row) for a bare id.
 */
let dbRows: Partial<ModelConfigEntry>[] = [];
const dbWrites: string[] = [];
function fakeDb() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'innerJoin', 'set', 'values', 'returning']) chain[m] = () => chain;
  chain.limit = async () => dbRows;
  chain.then = (resolve: (v: unknown) => unknown) => resolve(dbRows);
  chain.update = () => { dbWrites.push('update'); return chain; };
  chain.delete = () => { dbWrites.push('delete'); return chain; };
  chain.insert = () => { dbWrites.push('insert'); return chain; };
  return chain;
}
Object.defineProperty(registry, 'db', { get: fakeDb });

beforeEach(() => {
  urlCheck.valid = true;
  urlCheck.reason = undefined;
  dbRowExists.mockReset().mockResolvedValue(false);
  dbRows = [];
  dbWrites.length = 0;
  vaultSecrets.clear();
  guardedFetch.mockReset();
});

afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
  _clearExtensionModelsForTesting();
  getCircuitBreakerRegistry().resetAll();
});

describe('octi.registerProvider — trust gate', () => {
  test('an untrusted extension cannot register a provider', () => {
    const { api } = ext('acme', false);
    expect(() => api.registerProvider(def())).toThrow(/may not register providers: it is not listed in extensions\.trusted/);
    expect(listExtensionModels()).toEqual([]);
  });
});

describe('octi.registerProvider — reachable by its exact name only', () => {
  test('the exact ext/ name resolves to the row and to the custom-openai provider', async () => {
    const { api } = ext();
    await api.registerProvider(def());

    const row = await registry.getModel(ROW);
    expect(row).toMatchObject({
      provider: 'custom-openai', modelId: ROW, endpoint: 'https://llm.example.com',
      apiKeyRef: SECRET, ownerUserId: null, contextWindow: 200_000, maxTokens: 8192, isDefault: false,
    });
    expect(row?.metadata?.customProvider).toEqual({ auth: { type: 'bearer' } });
    expect((await registry.getModelByModelId(ROW))?.name).toBe(ROW);
    expect((await registry.getModelVisibleTo(ROW, 'user-1'))?.name).toBe(ROW);
    expect((await registry.getModelByModelIdVisibleTo(ROW, 'user-1'))?.name).toBe(ROW);
    expect(await registry.isRegistered(ROW, 'user-1')).toBe(true);

    const router = new ProviderRouter();
    expect((await router.resolveProvider(ROW, { modelConfigName: ROW })).name).toBe('custom-openai');
    expect((await router.resolveProvider(ROW)).name).toBe('custom-openai');
  });

  test('the bare upstream id does not reach the extension row', async () => {
    const { api } = ext();
    await api.registerProvider(def());
    expect(await registry.getModelByModelId('acme-large')).toBeNull();
    expect(await registry.getModelByModelIdVisibleTo('acme-large', 'user-1')).toBeNull();
    expect(await registry.isRegistered('acme-large', 'user-1')).toBe(false);
  });

  test("a user's personal row with the same model id wins", async () => {
    const { api } = ext();
    await api.registerProvider(def({ models: [{ id: 'llama-3.3-70b', contextWindow: 1000, maxOutput: 100 }] }));
    const alice = { name: 'u/alice/llama', modelId: 'llama-3.3-70b', provider: 'ollama', ownerUserId: 'alice', isEnabled: true };
    dbRows = [alice];
    expect((await registry.getModelByModelId('llama-3.3-70b', { userId: 'alice' }))?.name).toBe('u/alice/llama');
    expect((await registry.getModelByModelIdVisibleTo('llama-3.3-70b', 'alice'))?.name).toBe('u/alice/llama');
  });

  test('a bare vendor id passes through to the built-in provider as before', async () => {
    const { api } = ext();
    await api.registerProvider(def({ models: [{ id: 'gpt-4o', contextWindow: 128_000, maxOutput: 4096 }] }));
    const router = new ProviderRouter();
    expect((await router.resolveProvider('gpt-4o')).name).toBe('openai');
    expect(await registry.isRegistered('gpt-4o', 'user-1')).toBe(false);
  });

  test('a completion goes to the endpoint through the guarded fetch, with the registered id and the vault key', async () => {
    vaultSecrets.set(SECRET, 'sk-from-vault');
    guardedFetch.mockResolvedValue(okCompletion());
    const { api } = ext();
    await api.registerProvider(def({ headers: { 'X-Team': 'blue' } }));

    const result = await new CustomOpenAICompatProvider().complete({ model: ROW, messages: hi() });
    expect(result.content).toBe('hello');
    const [url, init] = guardedFetch.mock.calls[0];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body)).model).toBe('acme-large');
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer sk-from-vault');
    expect(headers.get('x-team')).toBe('blue');
  });

  test('a missing vault secret fails the call; there is no env fallback', async () => {
    process.env.CUSTOM_OPENAI_API_KEY = 'sk-install-env';
    try {
      const { api } = ext();
      await api.registerProvider(def());
      await expect(new CustomOpenAICompatProvider().complete({ model: ROW, modelConfigName: ROW, messages: hi() }))
        .rejects.toThrow(/vault secret 'ext\.acme\.gateway_key'/);
      expect(guardedFetch).not.toHaveBeenCalled();
    } finally {
      delete process.env.CUSTOM_OPENAI_API_KEY;
    }
  });

  test('kinds map onto the other custom providers with their default auth header', async () => {
    const { api } = ext();
    await api.registerProvider(def({ id: 'claude-gw', kind: 'anthropic-compatible', models: [{ id: 'a1', contextWindow: 1000, maxOutput: 100 }] }));
    await api.registerProvider(def({ id: 'gem-gw', kind: 'gemini-compatible', models: [{ id: 'g1', contextWindow: 1000, maxOutput: 100 }] }));
    const a = await registry.getModel('ext/acme/claude-gw/a1');
    const g = await registry.getModel('ext/acme/gem-gw/g1');
    expect(a?.provider).toBe('custom-anthropic');
    expect(a?.metadata?.customProvider?.auth).toEqual({ type: 'header', headerName: 'x-api-key' });
    expect(g?.provider).toBe('custom-gemini');
    expect(g?.metadata?.customProvider?.auth).toEqual({ type: 'header', headerName: 'x-goog-api-key' });
  });
});

describe('octi.registerProvider — its own rate-limit bucket and circuit breaker', () => {
  test('the key is the logical provider id, not the shared custom-openai lane', async () => {
    const { api } = ext();
    await api.registerProvider(def());
    const provider = new ProviderRouter().getProviderByName('custom-openai')!;
    expect(resolveRateLimitKey(provider, ROW)).toBe('ext:acme:gateway');
    expect(resolveRateLimitKey(provider, 'x', ROW)).toBe('ext:acme:gateway');
    expect(resolveRateLimitKey(provider, 'admin-model')).toBe('custom-openai');
  });

  test("an open custom-openai breaker does not stop the extension's model, and its own breaker does", async () => {
    vaultSecrets.set(SECRET, 'sk-from-vault');
    guardedFetch.mockImplementation(async () => okCompletion());
    const { api } = ext();
    await api.registerProvider(def());
    const breakers = getCircuitBreakerRegistry();
    const router = new ProviderRouter();

    for (let i = 0; i < 10; i++) breakers.recordFailure('custom-openai');
    expect(breakers.getStatus('custom-openai').state).toBe('open');
    expect((await router.complete({ model: ROW, messages: hi() })).content).toBe('hello');
    expect(breakers.getStatus('ext:acme:gateway').successes).toBe(1);

    for (let i = 0; i < 10; i++) breakers.recordFailure('ext:acme:gateway');
    await expect(router.complete({ model: ROW, messages: hi() })).rejects.toThrow(/ext:acme:gateway/);
  });
});

describe('octi.registerProvider — lifecycle', () => {
  test('dispose removes the rows', async () => {
    const { api, loaded } = ext();
    await api.registerProvider(def());
    expect(await registry.getModel(ROW)).not.toBeNull();
    await loaded.dispose();
    expect(await registry.getModel(ROW)).toBeNull();
    expect(await registry.getModelByModelId(ROW)).toBeNull();
    expect(listExtensionModels()).toEqual([]);
  });

  test('the unregister function removes the rows, and the id can be registered again', async () => {
    const { api } = ext();
    const off = await api.registerProvider(def());
    off();
    expect(await registry.getModel(ROW)).toBeNull();
    await api.registerProvider(def());
    expect(await registry.getModel(ROW)).not.toBeNull();
  });

  test('a registration still checking when the extension is disposed never goes live', async () => {
    const { api, loaded } = ext();
    const pending = api.registerProvider(def());
    await loaded.dispose();
    await pending;
    expect(listExtensionModels()).toEqual([]);
  });

  test('a reload (dispose, then a fresh context) registers again', async () => {
    const first = ext();
    await first.api.registerProvider(def());
    await first.loaded.dispose();
    const second = ext();
    await second.api.registerProvider(def());
    expect(await registry.getModel(ROW)).not.toBeNull();
  });

  test('the definition is copied: changing it after the call changes nothing', async () => {
    const { api } = ext();
    const d = def();
    const pending = api.registerProvider(d);
    d.baseUrl = 'https://evil.example.net';
    d.models[0].id = 'other';
    await pending;
    expect((await registry.getModel(ROW))?.endpoint).toBe('https://llm.example.com');
  });

  test('a definition that is not plain data is refused', () => {
    const { api } = ext();
    expect(() => api.registerProvider({ ...def(), headers: { get x() { return 'v'; } }, label: (() => 'x') as unknown as string })).toThrow(/must be plain data/);
  });
});

describe('octi.registerProvider — collisions', () => {
  test('the same id twice in one extension is refused', async () => {
    const { api } = ext();
    await api.registerProvider(def());
    expect(() => api.registerProvider(def())).toThrow(/id 'gateway' is already registered/);
  });

  test('a built-in provider name is refused as an id', () => {
    const { api } = ext();
    for (const id of ['openai', 'custom-openai', 'ollama', 'litellm']) {
      expect(() => api.registerProvider(def({ id }))).toThrow(/is a built-in provider name/);
    }
  });

  test('a database row already holding the ext/ name is refused', async () => {
    dbRowExists.mockResolvedValue(true);
    const { api } = ext();
    await expect(api.registerProvider(def())).rejects.toThrow(/collides with a configured model/);
    expect(listExtensionModels()).toEqual([]);
    dbRowExists.mockResolvedValue(false);
    await api.registerProvider(def());
  });

  test('two extensions may serve the same upstream id: their names differ', async () => {
    await ext('acme').api.registerProvider(def());
    await ext('other').api.registerProvider(def({ apiKeySecret: 'ext.other.key' }));
    expect(listExtensionModels().map((r) => r.name)).toEqual([ROW, 'ext/other/gateway/acme-large']);
  });

  test('the registry refuses the ext/ namespace for database rows and admin writes', async () => {
    const reserved = /reserved for extension-registered models/;
    await expect(registry.registerModel({ name: 'ext/acme/x/y', provider: 'custom-openai', modelId: 'y' })).rejects.toThrow(reserved);
    await expect(registry.registerModel({ name: 'mine', provider: 'custom-openai', modelId: 'ext/acme/x/y' })).rejects.toThrow(reserved);
    await expect(registry.updateModel('anything', { name: 'ext/acme/x/y' })).rejects.toThrow(reserved);
    await expect(registry.updateModel(ROW, { contextWindow: 1 })).rejects.toThrow(reserved);
    await expect(registry.setModelEnabled(ROW, false)).rejects.toThrow(reserved);
    await expect(registry.setDefaultModel(ROW)).rejects.toThrow(reserved);
    await expect(registry.deleteModel(ROW)).rejects.toThrow(reserved);
    expect(dbWrites).toEqual([]);
  });

  test('setDefaultModel on a missing row leaves the current default alone', async () => {
    dbRows = [];
    expect(await registry.setDefaultModel('no-such-model')).toBe(false);
    expect(dbWrites).toEqual([]);
  });

  test('the admin listing shows extension rows, marked', async () => {
    const { api } = ext();
    await api.registerProvider(def());
    vi.spyOn(registry, 'getAllModelsIncludeDisabled').mockResolvedValueOnce([]);
    vi.spyOn(registry, 'getPersonalModels').mockResolvedValueOnce([]);
    const { listModels } = await import('@/services/model-service');
    const { models } = await listModels('admin-1', true);
    expect(models).toEqual([expect.objectContaining({ name: ROW, extension: true })]);
  });
});

describe('octi.registerProvider — endpoint and credential rules', () => {
  const { api } = buildExtensionContext('acme', entry, new GatewayEventBus(), true);

  test.each([
    ['http://llm.example.com', /must use https/],
    ['ftp://llm.example.com', /must use https/],
    ['not a url', /not a valid URL/],
    ['https://user:pw@llm.example.com', /may not carry credentials/],
    ['https://llm.example.com/?key=abc', /query or fragment/],
    ['https://localhost:8443', /localhost/],
    ['https://127.0.0.1', /private or reserved/],
    ['https://10.0.0.5', /private or reserved/],
    ['https://169.254.169.254', /private or reserved/],
    ['https://[::1]', /private or reserved/],
    // The URL parser normalizes these to 127.0.0.1 before the check sees them.
    ['https://2130706433', /private or reserved/],
    ['https://0x7f000001', /private or reserved/],
  ])('baseUrl %s is refused', (baseUrl, reason) => {
    expect(() => api.registerProvider(def({ baseUrl }))).toThrow(reason);
  });

  test('a host that resolves to a private address is refused after the DNS check', async () => {
    urlCheck.valid = false;
    urlCheck.reason = 'IP 10.1.2.3 is in a private/reserved range';
    const { api: fresh } = ext();
    await expect(fresh.registerProvider(def())).rejects.toThrow(/baseUrl refused: IP 10\.1\.2\.3/);
    expect(listExtensionModels()).toEqual([]);
  });

  test('a raw key, a missing secret name or an env: reference is refused', () => {
    expect(() => api.registerProvider({ ...def(), apiKey: 'sk-live' } as ExtensionProviderDef)).toThrow(/raw key is not accepted/);
    expect(() => api.registerProvider(def({ apiKeySecret: '' }))).toThrow(/must name a system vault secret 'ext\.acme\.<name>'/);
    expect(() => api.registerProvider(def({ apiKeySecret: 'env:OPENAI_API_KEY' }))).toThrow(/must name a system vault secret/);
  });

  test('only secrets in the extension namespace ext.<extension>.<name>', () => {
    for (const secret of ['openai_api_key', 'connector_github_access_token', 'federation.identity', 'ext.other.key', 'ext.acme.', 'ext.acme.a.b', 'ext.acme']) {
      expect(() => api.registerProvider(def({ apiKeySecret: secret }))).toThrow(/must name a system vault secret 'ext\.acme\.<name>'/);
    }
    expect(() => api.registerProvider(def({ apiKeySecret: 'ext.acme.reserved' }))).toThrow(/reserved system secret/);
  });

  test('an extension name unusable as a namespace cannot register providers', () => {
    const { api: odd } = ext('acme.v2');
    expect(() => odd.registerProvider(def({ apiKeySecret: 'ext.acme.v2.key' }))).toThrow(/extension name must be letters/);
  });

  test('credential headers cannot be smuggled through headers or authHeader', () => {
    for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Proxy-Authorization', 'Host']) {
      expect(() => api.registerProvider(def({ headers: { [name]: 'v' } }))).toThrow(/may not be set/);
    }
    expect(() => api.registerProvider(def({ authHeader: 'X-Key', headers: { 'x-key': 'v' } }))).toThrow(/may not be set/);
    expect(() => api.registerProvider(def({ headers: { 'X-Team': 'a\r\nInjected: 1' } }))).toThrow(/single-line/);
    for (const header of ['Cookie', 'Host', 'Proxy-Authorization', 'Content-Type', 'Transfer-Encoding']) {
      expect(() => api.registerProvider(def({ authHeader: header }))).toThrow(/may not carry the key/);
    }
  });

  test('authHeader: Authorization means Bearer, a key header is used as given', async () => {
    const { api: fresh } = ext();
    await fresh.registerProvider(def({ authHeader: 'Authorization' }));
    expect((await registry.getModel(ROW))?.metadata?.customProvider?.auth).toEqual({ type: 'bearer' });
    await fresh.registerProvider(def({ id: 'keyed', authHeader: 'X-Api-Key' }));
    expect((await registry.getModel('ext/acme/keyed/acme-large'))?.metadata?.customProvider?.auth).toEqual({ type: 'header', headerName: 'X-Api-Key' });
  });

  test('model definitions are validated', () => {
    expect(() => api.registerProvider(def({ models: [] }))).toThrow(/models must list/);
    expect(() => api.registerProvider(def({ models: [{ id: 'm', contextWindow: 0, maxOutput: 1 }] }))).toThrow(/contextWindow/);
    expect(() => api.registerProvider(def({ models: [{ id: 'm', contextWindow: 100, maxOutput: 200 }] }))).toThrow(/exceeds its contextWindow/);
    expect(() => api.registerProvider(def({ models: [{ id: 'u/x', contextWindow: 100, maxOutput: 10 }] }))).toThrow(/reserved namespace/);
    expect(() => api.registerProvider(def({ models: [{ id: 'm', contextWindow: 100, maxOutput: 10 }, { id: 'm', contextWindow: 100, maxOutput: 10 }] }))).toThrow(/listed twice/);
    expect(() => api.registerProvider(def({ path: '/../admin' }))).toThrow(/path must be/);
    expect(() => api.registerProvider(def({ kind: 'cohere' as never }))).toThrow(/kind must be one of/);
  });
});
