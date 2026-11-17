import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';
const fixture = vi.hoisted(() => ({ admin: true, scopes: null as string[] | null, calls: 0 }));
vi.mock('@/api/context', async () => ({ apiContext: new (await import('@/api/http')).App().derive(() => ({
  user: { id: 'owner', isAdmin: fixture.admin },
  principal: { ...principalFromUser({ id: 'owner', username: 'owner', isAdmin: fixture.admin }), ...(fixture.scopes ? { scopes: fixture.scopes } : {}) },
})) }));
vi.mock('@/plugins/packages/setup', () => ({ setupResources: async () => { fixture.calls++; return { environments: [], connections: [] }; }, validateSetupSettings: async () => { fixture.calls++; return {}; } }));
vi.mock('@/plugins/packages/consent', () => ({ setupPreview: () => null }));
vi.mock('@/plugins/packages/service', async original => ({ ...await original<typeof import('@/plugins/packages/service')>(), findRow: async () => { fixture.calls++; return { name: 'demo', enabled: true, contentHash: `sha256:${'a'.repeat(64)}`, manifest: {} }; } }));
vi.mock('@/db/repositories/plugin-setup-repository', () => ({ pluginSetupRepository: { get: async () => { fixture.calls++; return null; }, save: async () => { fixture.calls++; return {}; } } }));
import { pluginSetupRoutes } from './plugin-setup';
const app = new App().use(pluginSetupRoutes);
const hash = `sha256:${'b'.repeat(64)}`;
beforeEach(() => { fixture.admin = true; fixture.scopes = null; fixture.calls = 0; });
const request = (path: string, body?: unknown) => app.handle(new Request('http://localhost/plugin-packages/setup/' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
test('resource and draft discovery require an administrator before any lookup', async () => {
  fixture.admin = false;
  expect((await request('resources')).status).toBe(403);
  expect((await request('demo/draft')).status).toBe(403);
  expect(fixture.calls).toBe(0);
});
test('scoped tokens cannot turn a resource read into setup administration', async () => {
  fixture.scopes = ['read'];
  expect((await request('demo/preflight', { contentHash: hash, settings: {} })).status).toBe(403);
  expect(fixture.calls).toBe(0);
});
test('changed package content fails before configuration or readiness execution', async () => {
  const response = await request('demo/preflight', { contentHash: hash, settings: {} });
  expect(response.status).toBe(409);
  expect(fixture.calls).toBe(1);
  expect((await request('demo/check', { contentHash: hash })).status).toBe(409);
});
test('a missing declared readiness check cannot dispatch an arbitrary plugin tool', async () => {
  const response = await request('demo/check', { contentHash: `sha256:${'a'.repeat(64)}` });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('read-only') });
});
