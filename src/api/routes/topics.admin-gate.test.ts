import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

// GET /topics: the bindings and extras are install configuration. An admin
// gets them; anyone else the labels only.
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
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getAllModelsIncludeDisabled: () => Promise.resolve([{ name: 'install-model', topicRoles: { build: 'primary' } }]),
  }),
}));
vi.mock('@/models/topic-config', () => ({
  getTopicConfig: () => ({ executorModel: 'exec-model', temperature: 0.2, maxTokens: 999 }),
  setTopicConfig: vi.fn(),
}));
vi.mock('@/models/providers', () => ({ getProviderRouter: () => ({}) }));
import { topicRoutes } from './topics';

const app = new App().group('/api', (route) => route.use(topicRoutes));
const get = async () => {
  const res = await app.handle(new Request('http://test/api/topics'));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { fixture.user = null; });

describe('GET /topics', () => {
  test('anonymous gets 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a non-admin gets labels only', async () => {
    fixture.user = { id: '00000000-0000-4000-8000-000000000002', username: 'alice', isAdmin: false };
    const r = await get();
    expect(r.status).toBe(200);
    const build = r.body.topics.find((t: { value: string }) => t.value === 'build');
    expect(Object.keys(build).sort()).toEqual(['description', 'kind', 'label', 'value']);
    expect(JSON.stringify(r.body)).not.toContain('install-model');
    expect(JSON.stringify(r.body)).not.toContain('exec-model');
  });

  test('an admin gets bindings and extras', async () => {
    fixture.user = { id: '00000000-0000-4000-8000-000000000001', username: 'root', isAdmin: true };
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.topics.find((t: { value: string }) => t.value === 'build')).toMatchObject({
      primaryModel: 'install-model', executorModel: 'exec-model', temperature: 0.2, maxTokens: 999,
    });
  });
});
