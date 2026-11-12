import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '@/api/http';
import { tmpdir } from 'node:os';
const fixture = vi.hoisted(() => ({ user: { id: '11111111-1111-4111-8111-111111111111', isAdmin: true }, profiles: [] as unknown[], secrets: [] as unknown[], scopes: undefined as string[] | undefined }));
vi.mock('@/api/context', async () => ({ apiContext: new (await import('@/api/http')).App().derive(() => ({ user: fixture.user, principal: { kind: 'user', userId: fixture.user.id, scopes: fixture.scopes } })) }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ get: async () => fixture.profiles, update: async (_: string, change: (current: unknown) => unknown) => { fixture.profiles = change(fixture.profiles) as unknown[]; } }) }));
vi.mock('@/security/vault', () => ({ getVault: () => ({ list: async () => fixture.secrets }) }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
const { settingsRoutes } = await import('./settings');
const app = new App().use(settingsRoutes);
const profile = () => ({ id: 'host', name: 'Host', userId: fixture.user.id, backend: 'host', roots: [tmpdir()], revision: 0 });
async function save(body: unknown) { return app.handle(new Request('http://test/settings/execution-environments/host', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); }
beforeEach(() => { fixture.scopes = undefined; fixture.user.isAdmin = true; fixture.profiles = []; fixture.secrets = []; });
it('saves centrally, advances revision and refuses a stale edit', async () => {
  const response = await save(profile()); expect(response.status).toBe(200);
  const first = (await response.json()).environment; expect(first.revision).toBe(1);
  expect((await save(profile())).status).toBe(400);
  expect((await save({ ...first, name: 'Updated' })).status).toBe(200);
  expect(fixture.profiles).toMatchObject([{ revision: 2, name: 'Updated' }]);
});
it('an admin cannot take another owner’s environment ID', async () => {
  fixture.profiles = [{ ...profile(), userId: '22222222-2222-4222-8222-222222222222' }];
  expect((await save(profile())).status).toBe(400);
  expect(fixture.profiles).toMatchObject([{ userId: '22222222-2222-4222-8222-222222222222' }]);
});
it('non-admins cannot grant trusted machine access', async () => { fixture.user.isAdmin = false; expect((await save(profile())).status).toBe(403); expect(fixture.profiles).toEqual([]); });
it('rejects missing/restricted bindings before an environment is saved', async () => {
  expect((await save({ ...profile(), credentials: [{ variable: 'GH_TOKEN', secret: 'missing' }] })).status).toBe(400);
  fixture.secrets = [{ name: 'restricted', workspaceId: null, allowedTools: ['github'] }];
  expect((await save({ ...profile(), credentials: [{ variable: 'GH_TOKEN', secret: 'restricted' }] })).status).toBe(400);
  expect(fixture.profiles).toEqual([]);
});

it('read-only admin tokens cannot grant machine execution or run a readiness command', async () => {
  fixture.scopes = ['api:read'];
  expect((await save(profile())).status).toBe(403);
  expect((await app.handle(new Request('http://test/settings/execution-environments/host/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(403);
});
it('revocation does not require a still-mounted folder or still-existing secret', async () => {
  expect((await save({ ...profile(), enabled: false, roots: ['/no-longer-mounted/project'], credentials: [{ variable: 'GH_TOKEN', secret: 'removed' }] })).status).toBe(200);
});
