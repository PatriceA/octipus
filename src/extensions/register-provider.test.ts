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
}));
vi.mock('@/models/install-access', () => ({ mayUseInstallModels: vi.fn(async () => true) }));
vi.mock('@/services/org-membership', () => ({ getUserOrgIds: vi.fn(async () => []) }));

import { GatewayEventBus } from '@/core/gateway/event-bus';
import { _clearExtensionModelsForTesting, listExtensionModels } from '@/models/extension-models';
import { getModelRegistry } from '@/models/model-registry';
import { ProviderRouter } from '@/models/providers';
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

const def = (over: Partial<ExtensionProviderDef> = {}): ExtensionProviderDef => ({
  id: 'gateway',
  kind: 'openai-compatible',
  baseUrl: 'https://llm.example.com/',
  apiKeySecret: 'acme_gateway_key',
  models: [{ id: 'acme-large', contextWindow: 200_000, maxOutput: 8192 }],
  ...over,
});
const ROW = 'ext/acme/gateway/acme-large';

const registry = getModelRegistry();
const dbRowExists = vi.spyOn(registry, 'databaseRowExists');

beforeEach(() => {
  urlCheck.valid = true;
  urlCheck.reason = undefined;
  dbRowExists.mockReset().mockResolvedValue(false);
  // The database's own install rows: none, without a database.
  (registry as unknown as { getInstallModelByModelId: () => Promise<null> }).getInstallModelByModelId = async () => null;
  vaultSecrets.clear();
  guardedFetch.mockReset();
});

afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
  _clearExtensionModelsForTesting();
});

describe('octi.registerProvider — trust gate', () => {
  test('an untrusted extension cannot register a provider', () => {
    const { api } = ext('acme', false);
    expect(() => api.registerProvider(def())).toThrow(/may not register providers: it is not listed in extensions\.trusted/);
    expect(listExtensionModels()).toEqual([]);
  });
});

describe('octi.registerProvider — routing', () => {
  test('a registered model resolves to its row and to the custom-openai provider', async () => {
    const { api } = ext();
    await api.registerProvider(def());

    const row = await registry.getModel(ROW);
    expect(row).toMatchObject({
      provider: 'custom-openai', modelId: 'acme-large', endpoint: 'https://llm.example.com',
      apiKeyRef: 'acme_gateway_key', ownerUserId: null, contextWindow: 200_000, maxTokens: 8192, isDefault: false,
    });
    expect(row?.metadata?.customProvider).toEqual({ auth: { type: 'bearer' } });
    expect((await registry.getModelByModelId('acme-large'))?.name).toBe(ROW);
    expect((await registry.getModelVisibleTo(ROW, 'user-1'))?.name).toBe(ROW);
    expect(await registry.isRegistered('acme-large', 'user-1')).toBe(true);

    const router = new ProviderRouter();
    expect((await router.resolveProvider('acme-large', { modelConfigName: ROW })).name).toBe('custom-openai');
    expect((await router.resolveProvider('acme-large')).name).toBe('custom-openai');
  });

  test('a completion goes to the endpoint through the guarded fetch, with the vault key', async () => {
    vaultSecrets.set('acme_gateway_key', 'sk-from-vault');
    guardedFetch.mockResolvedValue(new Response(JSON.stringify({
      id: 'r1', model: 'acme-large', object: 'chat.completion', created: 0,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { api } = ext();
    await api.registerProvider(def({ headers: { 'X-Team': 'blue' } }));

    const result = await new CustomOpenAICompatProvider().complete({ model: 'acme-large', modelConfigName: ROW, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }] });
    expect(result.content).toBe('hello');
    const [url, init] = guardedFetch.mock.calls[0];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer sk-from-vault');
    expect(headers.get('x-team')).toBe('blue');
  });

  test('a missing vault secret fails the call; there is no env fallback', async () => {
    process.env.CUSTOM_OPENAI_API_KEY = 'sk-install-env';
    try {
      const { api } = ext();
      await api.registerProvider(def());
      await expect(new CustomOpenAICompatProvider().complete({ model: 'acme-large', modelConfigName: ROW, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }] }))
        .rejects.toThrow(/vault secret 'acme_gateway_key'/);
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

describe('octi.registerProvider — lifecycle', () => {
  test('dispose removes the rows', async () => {
    const { api, loaded } = ext();
    await api.registerProvider(def());
    expect(await registry.getModel(ROW)).not.toBeNull();
    await loaded.dispose();
    expect(await registry.getModel(ROW)).toBeNull();
    expect(await registry.getModelByModelId('acme-large')).toBeNull();
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

  test('a model id a configured model already uses is refused', async () => {
    dbRowExists.mockResolvedValue(true);
    const { api } = ext();
    await expect(api.registerProvider(def())).rejects.toThrow(/collides with a configured model/);
    expect(listExtensionModels()).toEqual([]);
    // The failed id is free again.
    dbRowExists.mockResolvedValue(false);
    await api.registerProvider(def());
  });

  test('a model id another extension serves is refused', async () => {
    await ext('acme').api.registerProvider(def());
    await expect(ext('other').api.registerProvider(def())).rejects.toThrow(/already served by extension model 'ext\/acme\/gateway\/acme-large'/);
    expect(listExtensionModels().map((r) => r.name)).toEqual([ROW]);
  });

  test('the admin registry may not create a row in the ext/ namespace', async () => {
    await expect(registry.registerModel({ name: 'ext/acme/x/y', provider: 'custom-openai', modelId: 'y' })).rejects.toThrow(/reserved for extension-registered models/);
    await expect(registry.updateModel('anything', { name: 'ext/acme/x/y' })).rejects.toThrow(/reserved for extension-registered models/);
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
    expect(() => api.registerProvider(def({ apiKeySecret: '' }))).toThrow(/must name a system vault secret/);
    expect(() => api.registerProvider(def({ apiKeySecret: 'env:OPENAI_API_KEY' }))).toThrow(/must name a system vault secret/);
  });

  test('credential headers cannot be smuggled through headers', () => {
    for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Proxy-Authorization', 'Host']) {
      expect(() => api.registerProvider(def({ headers: { [name]: 'v' } }))).toThrow(/may not be set/);
    }
    expect(() => api.registerProvider(def({ authHeader: 'X-Key', headers: { 'x-key': 'v' } }))).toThrow(/may not be set/);
    expect(() => api.registerProvider(def({ headers: { 'X-Team': 'a\r\nInjected: 1' } }))).toThrow(/single-line/);
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
