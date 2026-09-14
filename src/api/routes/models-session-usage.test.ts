import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({
  user: { id: 'owner' } as { id: string } | null,
  findSession: vi.fn(), stats: vi.fn(),
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user })) };
});
vi.mock('@/services/model-service', () => ({}));
vi.mock('@/services/provider-service', () => ({}));
vi.mock('@/models/providers/presets', () => ({}));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: fixture.findSession } }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ getSessionStats: fixture.stats }) }));
import { modelRoutes } from './models';

const app = new App().group('/api', route => route.use(modelRoutes));
const sessionId = '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29';
const get = (id = sessionId) => app.handle(new Request(`http://test/api/models/usage/session/${id}`));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'owner' };
  fixture.findSession.mockResolvedValue({ id: sessionId, userId: 'owner' });
  fixture.stats.mockResolvedValue({ requestCount: 2, totalCost: 0.12, totalInputTokens: 100, totalOutputTokens: 20 });
});

test('the real usage HTTP route accepts a valid session UUID and returns its usage', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ stats: { requestCount: 2, totalCost: 0.12 } });
  expect(fixture.stats).toHaveBeenCalledWith(sessionId);
});

test('malformed session IDs are rejected before lookup', async () => {
  expect((await get('not-a-uuid')).status).toBe(422);
  expect(fixture.findSession).not.toHaveBeenCalled();
});

test('another user cannot read session usage', async () => {
  fixture.findSession.mockResolvedValue({ id: sessionId, userId: 'someone-else' });
  expect((await get()).status).toBe(404);
  expect(fixture.stats).not.toHaveBeenCalled();
});

test('unauthenticated usage requests are rejected', async () => {
  fixture.user = null;
  expect((await get()).status).toBe(401);
  expect(fixture.stats).not.toHaveBeenCalled();
});
