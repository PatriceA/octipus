/** `GET /api/agents/:id/run` answers for the signed-in principal only; another user's run reads as not found. */
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({ user: { id: 'owner', isAdmin: false } as { id: string; isAdmin: boolean } | null, read: vi.fn() }));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user, principal: fixture.user ? { kind: 'user', userId: fixture.user.id } : null })) };
});
vi.mock('@/security/principal', async (original) => ({ ...await original<typeof import('@/security/principal')>(), isAuthenticated: (p: unknown) => !!p }));
vi.mock('@/core/run-detail', () => ({ readRunDetail: fixture.read }));
import { agentRoutes } from './agents';

const app = new App().group('/api', (route) => route.use(agentRoutes));
const get = (id = 'agent-1') => app.handle(new Request(`http://test/api/agents/${id}/run`));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'owner', isAdmin: false };
  fixture.read.mockResolvedValue({ id: 'agent-1', chain: [], children: [] });
});

test('reads the run as the signed-in principal', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: 'agent-1' });
  expect(fixture.read).toHaveBeenCalledWith({ kind: 'user', userId: 'owner' }, 'agent-1');
});

test('a run the principal cannot see is not found', async () => {
  fixture.read.mockResolvedValue(null);
  expect((await get('someone-elses')).status).toBe(404);
});

test('anonymous requests are refused without a read', async () => {
  fixture.user = null;
  expect((await get()).status).toBe(401);
  expect(fixture.read).not.toHaveBeenCalled();
});
