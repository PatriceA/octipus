import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ list: vi.fn(), write: vi.fn() }));
vi.mock('@/core/calendar/events', () => ({ listCalendarEvents: mock.list }));
vi.mock('@/core/calendar/manage', () => ({ writeCalendarEvent: mock.write, CalendarInputError: class extends Error {} }));
import { Elysia } from '@/api/http';
import { calendarRoutes } from './calendar';
import { principalFromUser, ANONYMOUS_PRINCIPAL } from '@/security/principal';
const alice = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', isAdmin: false };
function app(kind: 'personal' | 'shared' | 'anonymous' = 'personal') {
  const principal = kind === 'anonymous' ? ANONYMOUS_PRINCIPAL : { ...principalFromUser(alice), workspaceKind: kind };
  return new Elysia().derive(() => ({ user: alice, session: null, principal })).group('/api', a => a.use(calendarRoutes));
}
const input = { provider: 'google', confirm: true, title: 'Meeting', start: '2026-11-04T08:00:00Z', end: '2026-11-04T09:00:00Z', allDay: false };
function post(kind: 'personal' | 'shared' | 'anonymous', body = input) { return app(kind).handle(new Request('http://localhost/api/calendar/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })); }
beforeEach(() => { vi.clearAllMocks(); mock.list.mockResolvedValue({ events: [], providers: ['google'], partial: false }); mock.write.mockResolvedValue(undefined); });
test('unconfirmed writes never access a calendar provider', async () => { expect((await post('personal', { ...input, confirm: false })).status).toBe(409); expect(mock.write).not.toHaveBeenCalled(); });
test('shared spaces and anonymous callers cannot use personal calendar credentials', async () => { expect((await post('shared')).status).toBe(403); expect((await post('anonymous')).status).toBe(401); expect(mock.write).not.toHaveBeenCalled(); });
test('writes are attributed to the authenticated caller', async () => { expect((await post('personal')).status).toBe(200); expect(mock.write).toHaveBeenCalledWith(alice.id, 'google', input); });
test('invalid calendar windows fail without reading providers', async () => { expect((await app().handle(new Request('http://localhost/api/calendar/events?from=invalid&to=invalid'))).status).toBe(400); expect(mock.list).not.toHaveBeenCalled(); });
