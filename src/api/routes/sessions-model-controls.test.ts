import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
const f = vi.hoisted(() => ({
  user: { id: 'owner' } as { id: string } | null,
  session: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
  scope: true,
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return {
    apiContext: new App().derive(() => ({
      user: f.user,
      principal: f.user ? { kind: 'user', userId: f.user.id } : null,
    })),
  };
});
vi.mock('@/security/principal', async (original) => ({
  ...(await original<typeof import('@/security/principal')>()),
  isAuthenticated: (p: unknown) => !!p,
  requireScope: () => f.scope,
}));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: f.session, setCliOverrides: f.save },
}));
vi.mock('@/core/agent/session-model-controls', () => ({
  readSessionModelControls: f.read,
  validateSessionCliOverrides: f.validate,
  readSessionCliCatalog: f.read,
}));
import { sessionRoutes } from './sessions';
const app = new App().group('/api', (a) => a.use(sessionRoutes));
const request = (method = 'GET', body?: unknown, suffix = '') =>
  app.handle(
    new Request(`http://test/api/sessions/61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29/model-controls${suffix}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  f.user = { id: 'owner' };
  f.scope = true;
  f.session.mockResolvedValue({ id: '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29', userId: 'owner', kind: 'chat', context: {} });
  f.read.mockResolvedValue({ revision: 0, runs: [], bindings: [], overrides: [] });
  f.save.mockResolvedValue(true);
  f.validate.mockResolvedValue(undefined);
});
test('owner can read and save scoped CLI controls', async () => {
  expect((await request()).status).toBe(200);
  const overrides = [{ modelName: 'registered-row', topic: 'verify', role: 'review', model: 'chosen', effort: 'high' }];
  expect((await request('PUT', { revision: 0, overrides })).status).toBe(200);
  expect(f.save).toHaveBeenCalledWith('61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29', 'owner', 0, overrides);
});
test('other owners, rooms and anonymous callers cannot read prompts or change controls', async () => {
  f.session.mockResolvedValue({ id: '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29', userId: 'other', kind: 'chat' });
  expect((await request()).status).toBe(404);
  expect((await request('PUT', { revision: 0, overrides: [] })).status).toBe(404);
  f.session.mockResolvedValue({ id: '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29', userId: 'owner', kind: 'room' });
  expect((await request()).status).toBe(404);
  f.user = null;
  expect((await request()).status).toBe(401);
  expect(f.save).not.toHaveBeenCalled();
});
test('CHAT scope, supported controls, revision and Companion binding are enforced', async () => {
  f.scope = false;
  expect((await request('PUT', { revision: 0, overrides: [] })).status).toBe(403);
  f.scope = true;
  f.validate.mockRejectedValueOnce(new Error('Effort unsupported'));
  expect((await request('PUT', { revision: 0, overrides: [] })).status).toBe(400);
  f.save.mockResolvedValue(false);
  expect((await request('PUT', { revision: 0, overrides: [] })).status).toBe(409);
  f.session.mockResolvedValue({
    id: '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29',
    userId: 'owner',
    kind: 'chat',
    context: { companionSupervisor: { modelName: 'supervisor' } },
  });
  expect((await request('PUT', { revision: 0, overrides: [] })).status).toBe(400);
});
