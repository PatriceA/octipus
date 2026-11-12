import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { getConfig } from '@/config';
const fixture = vi.hoisted(() => ({ user: { id: '11111111-1111-4111-8111-111111111111', isAdmin: true }, scopes: undefined as string[] | undefined, enabled: false, write: vi.fn(), service: vi.fn() }));
vi.mock('@/api/context', async () => ({ apiContext: new (await import('@/api/http')).App().derive(() => ({ user: fixture.user, principal: { kind: 'user', userId: fixture.user.id, scopes: fixture.scopes } })) }));
vi.mock('@/core/heartbeat', () => ({ findStandingNote: async () => null, getHeartbeatPrefs: async () => ({ enabled: fixture.enabled }), setHeartbeatPrefs: async (_: string, patch: { enabled?: boolean }) => { fixture.write(patch); if (patch.enabled !== undefined) fixture.enabled = patch.enabled; return { enabled: fixture.enabled }; } }));
vi.mock('@/core/email/providers', () => ({ detectProvider: async () => null }));
vi.mock('@/core/email/watch', () => ({ recentEmailOutcomes: async () => [] }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ set: async (...args: unknown[]) => { fixture.service(...args); getConfig().heartbeat.enabled = true; } }) }));
const { heartbeatRoutes } = await import('./heartbeat');
const app = new App().use(heartbeatRoutes);
const put = (body: unknown) => app.handle(new Request('http://test/heartbeat/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => { getConfig().heartbeat.enabled = false; fixture.user.isAdmin = true; fixture.scopes = undefined; fixture.enabled = false; vi.clearAllMocks(); });
test('one settings save activates the admin’s heartbeat and its server prerequisite', async () => {
  expect((await put({ enabled: true })).status).toBe(200);
  const state = await (await app.handle(new Request('http://test/heartbeat/me'))).json();
  expect(state).toMatchObject({ enabled: true, server: { enabled: true } });
  expect(fixture.service).toHaveBeenCalledWith('heartbeat.enabled', true, fixture.user.id);
});
test('read-only tokens cannot change heartbeat preferences or activate the server', async () => {
  fixture.scopes = ['api:read'];
  expect((await put({ enabled: true })).status).toBe(403);
  expect(fixture.write).not.toHaveBeenCalled(); expect(fixture.service).not.toHaveBeenCalled();
});
test('a member can save a preference but cannot override an operator-paused server', async () => {
  fixture.user.isAdmin = false;
  expect((await put({ enabled: true })).status).toBe(200);
  expect(getConfig().heartbeat.enabled).toBe(false); expect(fixture.service).not.toHaveBeenCalled();
});
