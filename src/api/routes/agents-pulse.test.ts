/** `GET /api/agents/pulse` (the sidebar's live and needs-you counts) answers for the signed-in principal only. */
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({ user: { id: 'owner', isAdmin: false } as { id: string; isAdmin: boolean } | null, read: vi.fn() }));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user, principal: fixture.user ? { kind: 'user', userId: fixture.user.id } : null })) };
});
vi.mock('@/security/principal', async (original) => ({ ...await original<typeof import('@/security/principal')>(), isAuthenticated: (p: unknown) => !!p }));
vi.mock('@/core/mission-control', () => ({ readAgentPulse: fixture.read }));
import { agentRoutes } from './agents';

const app = new App().group('/api', (route) => route.use(agentRoutes));
const get = () => app.handle(new Request('http://test/api/agents/pulse'));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'owner', isAdmin: false };
  fixture.read.mockResolvedValue({ live: 2, pendingApprovals: 1 });
});

test('reads the pulse of the signed-in principal', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ live: 2, pendingApprovals: 1 });
  expect(fixture.read).toHaveBeenCalledWith({ kind: 'user', userId: 'owner' }, 'owner');
});

test('anonymous requests are refused without a read', async () => {
  fixture.user = null;
  expect((await get()).status).toBe(401);
  expect(fixture.read).not.toHaveBeenCalled();
});
