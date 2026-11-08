/**
 * `GET /api/agents/overview` (Mission control) answers for the signed-in
 * principal only; the read itself is scoped by the principal's repositories.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({ user: { id: 'owner', isAdmin: false } as { id: string; isAdmin: boolean } | null, read: vi.fn() }));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user, principal: fixture.user ? { kind: 'user', userId: fixture.user.id } : null })) };
});
vi.mock('@/security/principal', async (original) => ({ ...await original<typeof import('@/security/principal')>(), isAuthenticated: (p: unknown) => !!p }));
vi.mock('@/core/mission-control', () => ({ readMissionControl: fixture.read }));
import { agentRoutes } from './agents';

const app = new App().group('/api', (route) => route.use(agentRoutes));
const get = () => app.handle(new Request('http://test/api/agents/overview'));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'owner', isAdmin: false };
  fixture.read.mockResolvedValue({ runs: [], counts: { live: 0, today: 0, failedToday: 0, bySource: {} }, upcoming: [] });
});

test('reads Mission control for the signed-in principal', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(fixture.read).toHaveBeenCalledWith({ kind: 'user', userId: 'owner' }, 'owner');
});

test('anonymous requests are refused without a read', async () => {
  fixture.user = null;
  expect((await get()).status).toBe(401);
  expect(fixture.read).not.toHaveBeenCalled();
});
