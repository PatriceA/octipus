import { beforeEach, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { ANONYMOUS_PRINCIPAL, principalFromUser } from '@/security/principal';
const calls = vi.hoisted(() => ({ scopes: [] as unknown[], list: vi.fn(), create: vi.fn(), read: vi.fn(), start: vi.fn(), control: vi.fn(), inspect: vi.fn() }));
vi.mock('@/core/companion/service', () => ({ CompanionService: class {
  constructor(scope: unknown) { calls.scopes.push(scope); }
  listGoals = calls.list; createGoal = calls.create; readGoal = calls.read; startSession = calls.start; controlSession = calls.control; inspectSession = calls.inspect;
} }));
import { companionRoutes } from './companion';
import { CompanionSupervisionError } from '@/shared/companion-supervision';
const user = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const workspaceId = '22222222-2222-4222-8222-222222222222';
const goalId = '33333333-3333-4333-8333-333333333333';
function app(kind = 'personal', scopes?: string[]) {
  const principal = kind === 'anonymous' ? ANONYMOUS_PRINCIPAL : { ...principalFromUser(user), workspaceId, workspaceKind: kind as 'personal' | 'shared', scopes };
  return new Elysia().derive(() => ({ user, session: null, principal })).group('/api', a => a.use(companionRoutes));
}
const post = (kind: string, path: string, body: unknown, scopes?: string[]) => app(kind, scopes).handle(new Request(`http://localhost/api/companion${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => { vi.clearAllMocks(); calls.scopes.length = 0; calls.list.mockResolvedValue([]); calls.create.mockResolvedValue({ id: goalId }); calls.start.mockResolvedValue({ id: 'action' }); calls.control.mockResolvedValue({ state: 'paused' }); });
test('anonymous and shared-space requests cannot enroll work', async () => {
  expect((await post('anonymous', '/goals', {})).status).toBe(401);
  expect((await post('shared', '/goals', {})).status).toBe(403);
  expect(calls.create).not.toHaveBeenCalled();
});
test('an admin request is still bound to its authenticated user and selected workspace', async () => {
  expect((await post('personal', '/goals', { title: 'Goal' })).status).toBe(200);
  expect(calls.scopes).toEqual([{ userId: user.id, workspaceId }]);
});
test('restricted read tokens cannot start sessions or change goals', async () => {
  expect((await post('personal', '/goals', {}, ['api:read'])).status).toBe(403);
  expect((await app('personal', ['api:read']).handle(new Request('http://localhost/api/companion/goals'))).status).toBe(200);
  expect(calls.create).not.toHaveBeenCalled();
});
test('scope, conflict and invalid evidence errors retain actionable statuses', async () => {
  for (const [code, status] of [['not_found', 404], ['conflict', 409], ['invalid_evidence', 400]] as const) {
    calls.create.mockRejectedValueOnce(new CompanionSupervisionError(code, 'Actionable explanation'));
    const response = await post('personal', '/goals', {});
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error: 'Actionable explanation', code });
  }
});
test('session controls reach the scoped owner service with validated IDs', async () => {
  const response = await post('personal', `/goals/${goalId}/control`, { sessionId: workspaceId, state: 'paused' });
  expect(response.status).toBe(200); expect(calls.control).toHaveBeenCalledWith(goalId, workspaceId, 'paused');
});
