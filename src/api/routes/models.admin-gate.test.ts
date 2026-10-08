import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

// The install-state model routes are an admin's: a non-admin (someone who
// joined through a space invite, say) gets 403 on each, an admin still gets
// through. The service layer is mocked — only the gate is under test here.
const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new App().derive(() => ({
      user: fixture.user,
      session: null,
      principal: fixture.user ? principalFromUser(fixture.user) : ANONYMOUS_PRINCIPAL,
    })),
  };
});
const ok = vi.hoisted(() => () => Promise.resolve({ ok: true }));
vi.mock('@/services/model-service', () => ({
  checkCapabilities: vi.fn(ok),
  clearCliQuota: vi.fn(ok),
  deleteModel: vi.fn(ok),
  getAvailableProviderModels: vi.fn(ok),
  getCliQuotaHistory: vi.fn(ok),
  getCliQuotas: vi.fn(ok),
  getCliStatus: vi.fn(ok),
  getDailyUsage: vi.fn(ok),
  getGlobalUsage: vi.fn(ok),
  getInstallJobScoped: vi.fn(ok),
  getKnownProviderModels: vi.fn(ok),
  getModelByName: vi.fn(ok),
  getSystemHealth: vi.fn(ok),
  getUsage: vi.fn(ok),
  installRecommendedModel: vi.fn(ok),
  listModels: vi.fn(ok),
  recommendModels: vi.fn(ok),
  registerModel: vi.fn(ok),
  setDefaultModel: vi.fn(ok),
  updateModel: vi.fn(ok),
  updateProviderCatalog: vi.fn(ok),
}));
vi.mock('@/services/provider-service', () => ({
  discoverCustomModels: vi.fn(ok),
  listDeepSeekModels: vi.fn(ok),
  listLiteLLMModels: vi.fn(ok),
  listOllamaModels: vi.fn(ok),
  searchOpenRouterModels: vi.fn(ok),
  testModelConnection: vi.fn(ok),
}));
vi.mock('@/models/providers/presets', () => ({
  discoverModels: vi.fn(() => Promise.resolve([])),
  listPresets: vi.fn(() => []),
  probeHealth: vi.fn(() => Promise.resolve(true)),
}));
import { getAvailableProviderModels } from '@/services/model-service';
import { modelRoutes } from './models';

const app = new App().group('/api', (route) => route.use(modelRoutes));
const ADMIN = { id: '00000000-0000-4000-8000-000000000001', username: 'root', isAdmin: true };
const MEMBER = { id: '00000000-0000-4000-8000-000000000002', username: 'alice', isAdmin: false };

function call(method: string, path: string, body?: unknown) {
  return app.handle(new Request(`http://test/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

// Reads that were open to any signed-in user and are now admin-only.
const NEWLY_GATED_READS = [
  '/models/health',
  '/models/cli/status',
  '/models/cli/quota',
  '/models/cli/quota/claude/history',
  '/models/providers/ollama/models',
  '/models/providers/deepseek/models',
  '/models/providers/litellm/models',
  '/models/providers/openrouter/search?q=x',
  '/models/providers/openai/known',
  '/models/providers/openai/available',
];

// Admin checks that used to answer `{ error }` with HTTP 200.
const FORMERLY_200_DENIALS: Array<[string, string, unknown?]> = [
  ['POST', '/models/discover', { endpoint: 'http://127.0.0.1:1' }],
  ['POST', '/models/test', { provider: 'openai', modelId: 'gpt' }],
  ['DELETE', '/models/some-model'],
  ['POST', '/models/some-model/default'],
  ['POST', '/models/cli/quota/claude/clear'],
  ['POST', '/models/custom/discover-models', {}],
  ['PUT', '/models/providers/openai/catalog', { models: [] }],
  ['GET', '/models/usage/global'],
];

beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = null;
});

describe('model routes — admin gate', () => {
  test.each(NEWLY_GATED_READS)('non-admin gets 403 on GET %s', async (path) => {
    fixture.user = MEMBER;
    const res = await call('GET', path);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
  });

  test.each(NEWLY_GATED_READS)('admin still reads GET %s', async (path) => {
    fixture.user = ADMIN;
    const res = await call('GET', path);
    expect(res.status).toBe(200);
  });

  test.each(NEWLY_GATED_READS)('anonymous gets 401 on GET %s', async (path) => {
    expect((await call('GET', path)).status).toBe(401);
  });

  test.each(FORMERLY_200_DENIALS)('non-admin gets 403 (not 200) on %s %s', async (method, path, body) => {
    fixture.user = MEMBER;
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
  });

  test.each(FORMERLY_200_DENIALS)('admin still gets through %s %s', async (method, path, body) => {
    fixture.user = ADMIN;
    expect((await call(method, path, body)).status).toBe(200);
  });

  test('a non-admin cannot make the server fetch ?endpoint= on /providers/:p/available', async () => {
    fixture.user = MEMBER;
    const res = await call('GET', '/models/providers/custom-openai/available?endpoint=http://169.254.169.254/');
    expect(res.status).toBe(403);
    expect(getAvailableProviderModels).not.toHaveBeenCalled();
  });

  test('GET /models stays open to a signed-in non-admin', async () => {
    fixture.user = MEMBER;
    expect((await call('GET', '/models')).status).toBe(200);
  });
});
