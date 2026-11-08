/**
 * `GET /api/sessions/:id/context` holds the session's prompt text: the
 * owner's alone, under the same rule as session usage.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({
  user: { id: 'owner' } as { id: string } | null,
  findSession: vi.fn(), read: vi.fn(),
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user, principal: fixture.user ? { kind: 'user', userId: fixture.user.id } : null })) };
});
vi.mock('@/security/principal', async (original) => ({ ...await original<typeof import('@/security/principal')>(), isAuthenticated: (p: unknown) => !!p }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: fixture.findSession } }));
vi.mock('@/core/agent/session-context', () => ({ readSessionContext: fixture.read }));
import { sessionRoutes } from './sessions';

const app = new App().group('/api', (route) => route.use(sessionRoutes));
const sessionId = '61e356f4-3e1b-432c-bc6b-b7e7ef9e5e29';
const get = (id = sessionId) => app.handle(new Request(`http://test/api/sessions/${id}/context`));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'owner' };
  fixture.findSession.mockResolvedValue({ id: sessionId, userId: 'owner', kind: 'chat' });
  fixture.read.mockResolvedValue({ latest: null, turns: [], usage: null });
});

test('the owner reads the session context', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ latest: null, turns: [], usage: null });
  expect(fixture.read).toHaveBeenCalledWith(sessionId);
});

test('another user, or a room, gets not-found and nothing is read', async () => {
  fixture.findSession.mockResolvedValue({ id: sessionId, userId: 'someone-else', kind: 'chat' });
  expect((await get()).status).toBe(404);
  fixture.findSession.mockResolvedValue({ id: sessionId, userId: 'owner', kind: 'room' });
  expect((await get()).status).toBe(404);
  expect(fixture.read).not.toHaveBeenCalled();
});

test('malformed ids are rejected before lookup; anonymous requests are refused', async () => {
  expect((await get('not-a-uuid')).status).toBe(422);
  expect(fixture.findSession).not.toHaveBeenCalled();
  fixture.user = null;
  expect((await get()).status).toBe(401);
});
