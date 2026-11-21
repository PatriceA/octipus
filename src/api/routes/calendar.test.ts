import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ list: vi.fn(), write: vi.fn(), remove: vi.fn(), respond: vi.fn(), attendees: vi.fn(), view: vi.fn(), setPrefs: vi.fn(), shared: vi.fn() }));
vi.mock('@/core/calendar/events', () => ({ listCalendarEvents: mock.list }));
vi.mock('@/core/calendar/manage', () => ({ writeCalendarEvent: mock.write, deleteCalendarEvent: mock.remove, respondToCalendarEvent: mock.respond, calendarEventAttendees: mock.attendees, CalendarInputError: class extends Error {} }));
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: {} }));
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({}) }));
vi.mock('@/core/calendar/calendars', async () => {
  // The real validator: the route's boundary check is part of what is tested.
  const actual = await vi.importActual<typeof import('@/core/calendar/calendars')>('@/core/calendar/calendars');
  return { calendarView: mock.view, setCalendarPreferences: mock.setPrefs, microsoftSharedAccess: mock.shared, validateCalendarPreferences: actual.validateCalendarPreferences };
});
import { Elysia } from '@/api/http';
import { calendarRoutes } from './calendar';
import { principalFromUser, ANONYMOUS_PRINCIPAL } from '@/security/principal';

const alice = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', isAdmin: false };
type Kind = 'personal' | 'shared' | 'anonymous';
function app(kind: Kind = 'personal') {
  const principal = kind === 'anonymous' ? ANONYMOUS_PRINCIPAL : { ...principalFromUser(alice), workspaceKind: kind };
  return new Elysia().derive(() => ({ user: alice, session: null, principal })).group('/api', a => a.use(calendarRoutes));
}
async function call(method: string, path: string, body?: unknown, kind: Kind = 'personal') {
  const res = await app(kind).handle(new Request(`http://localhost/api/calendar${path}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }));
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
}
const input = { provider: 'google', confirm: true, title: 'Meeting', start: '2026-11-04T08:00:00Z', end: '2026-11-04T09:00:00Z', allDay: false };
const mine = { provider: 'google', id: 'me@x.dev', name: 'Mine', primary: true, readOnly: false, shared: false, visible: true };
const boss = { provider: 'google', id: 'boss@x.dev', name: 'Boss', primary: false, readOnly: true, shared: true, visible: true };
const team = { provider: 'google', id: 'team', name: 'Team', primary: false, readOnly: false, shared: true, visible: false };

beforeEach(() => {
  vi.clearAllMocks();
  mock.list.mockResolvedValue({ events: [], providers: ['google'], partial: false });
  mock.write.mockResolvedValue({ id: 'new-id' });
  mock.attendees.mockResolvedValue(0);
  mock.shared.mockResolvedValue(null);
  mock.view.mockResolvedValue({ calendars: [mine, boss, team], providers: ['google'], partial: false, preferences: {} });
});

/** What the core gets: the event, without the request's routing and confirmation. */
const fields = ({ provider: _p, calendarId: _c, confirm: _x, ...rest }: Record<string, unknown>) => rest;

test('unconfirmed writes never access a calendar provider', async () => {
  expect((await call('POST', '/events', { ...input, confirm: false })).status).toBe(409);
  expect((await call('PATCH', '/events/e1', { ...input, confirm: false })).status).toBe(409);
  expect((await call('DELETE', '/events/e1', { provider: 'google', confirm: false })).status).toBe(409);
  expect(mock.write).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled(); expect(mock.attendees).not.toHaveBeenCalled();
});

test('shared spaces and anonymous callers cannot use personal calendar credentials', async () => {
  for (const [method, path, body] of [['POST', '/events', input], ['DELETE', '/events/e1', { provider: 'google', confirm: true }], ['POST', '/events/e1/respond', { provider: 'google', response: 'accepted' }], ['GET', '/calendars', undefined], ['PUT', '/preferences', { hideDeclined: true }]] as const) {
    expect((await call(method, path, body, 'shared')).status).toBe(403);
    expect((await call(method, path, body, 'anonymous')).status).toBe(401);
  }
  expect(mock.write).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled(); expect(mock.respond).not.toHaveBeenCalled(); expect(mock.view).not.toHaveBeenCalled(); expect(mock.setPrefs).not.toHaveBeenCalled();
});

test('writes are attributed to the authenticated caller, on the default calendar unless one is named', async () => {
  expect(await call('POST', '/events', input)).toEqual({ status: 200, body: { success: true, id: 'new-id' } });
  expect(mock.write).toHaveBeenCalledWith(alice.id, 'google', fields(input), undefined, { calendarId: undefined });
  await call('POST', '/events', { ...input, calendarId: 'team', attendees: ['ada@x.dev'] });
  expect(mock.write).toHaveBeenLastCalledWith(alice.id, 'google', expect.objectContaining({ attendees: ['ada@x.dev'] }), undefined, { calendarId: 'team' });
});

test('a read-only or unknown calendar is refused before any write', async () => {
  const readOnly = await call('POST', '/events', { ...input, calendarId: 'boss@x.dev' });
  expect(readOnly.status).toBe(403); expect(readOnly.body.error).toMatch(/read-only/);
  expect((await call('PATCH', '/events/e1', { ...input, calendarId: 'boss@x.dev' })).status).toBe(403);
  expect((await call('DELETE', '/events/e1', { provider: 'google', calendarId: 'boss@x.dev', confirm: true })).status).toBe(403);
  // Same id under the other provider is a different calendar.
  expect((await call('POST', '/events', { ...input, provider: 'microsoft', calendarId: 'team' })).status).toBe(404);
  expect(mock.view).toHaveBeenLastCalledWith(alice.id, { fresh: true });
  expect(mock.write).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled(); expect(mock.attendees).not.toHaveBeenCalled();
});

test('changing or deleting an event with guests needs the caller to accept that they are notified', async () => {
  mock.attendees.mockResolvedValue(3);
  const edit = await call('PATCH', '/events/e1', { ...input, calendarId: 'team' });
  expect(edit).toEqual({ status: 409, body: { error: 'This event has 3 guests, who will be notified of the change.', requiresAttendeeConfirmation: true, attendees: 3 } });
  expect(mock.attendees).toHaveBeenCalledWith(alice.id, 'google', 'e1', 'team');
  expect((await call('DELETE', '/events/e1', { provider: 'google', confirm: true })).body).toMatchObject({ requiresAttendeeConfirmation: true, attendees: 3 });
  expect(mock.write).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled();

  expect((await call('PATCH', '/events/e1', { ...input, calendarId: 'team', notifyAttendees: true })).status).toBe(200);
  expect(mock.write).toHaveBeenCalledWith(alice.id, 'google', expect.objectContaining({ title: 'Meeting' }), 'e1', { calendarId: 'team', notify: true });
  expect((await call('DELETE', '/events/e1', { provider: 'google', confirm: true, notifyAttendees: true })).status).toBe(200);
  expect(mock.remove).toHaveBeenCalledWith(alice.id, 'google', 'e1', { calendarId: undefined, notify: true });
});

test('an event without guests is changed and deleted without a second question', async () => {
  expect((await call('PATCH', '/events/e%2F1', input)).status).toBe(200);
  expect(mock.write).toHaveBeenCalledWith(alice.id, 'google', fields(input), 'e/1', { calendarId: undefined, notify: false });
  expect((await call('DELETE', '/events/e1', { provider: 'microsoft', confirm: true })).status).toBe(200);
  expect(mock.remove).toHaveBeenCalledWith(alice.id, 'microsoft', 'e1', { calendarId: undefined, notify: false });
});

test('an invitation is answered as the caller; only the three answers exist', async () => {
  expect((await call('POST', '/events/e1/respond', { provider: 'microsoft', calendarId: 'cal', response: 'tentative' })).status).toBe(200);
  expect(mock.respond).toHaveBeenCalledWith(alice.id, 'microsoft', 'e1', 'tentative', { calendarId: 'cal' });
  expect((await call('POST', '/events/e1/respond', { provider: 'microsoft', response: 'needsAction' })).status).toBe(422);
});

test('events are read from the calendars the caller chose to see', async () => {
  const res = await call('GET', '/events?from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z');
  expect(res.status).toBe(200);
  expect(mock.list).toHaveBeenCalledWith(alice.id, expect.objectContaining({ limit: 250, calendars: [mine, boss] }));
});

test('a calendar list that could not be read makes the schedule incomplete, not empty', async () => {
  mock.view.mockResolvedValue({ calendars: [mine], providers: ['google'], partial: true, preferences: {} });
  expect((await call('GET', '/events?from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z')).body.partial).toBe(true);
});

test('invalid calendar windows fail without reading providers', async () => {
  expect((await call('GET', '/events?from=invalid&to=invalid')).status).toBe(400);
  expect((await call('GET', '/events?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z')).status).toBe(400);
  expect(mock.list).not.toHaveBeenCalled(); expect(mock.view).not.toHaveBeenCalled();
});

test('the calendar list says whether Microsoft may open shared calendars', async () => {
  mock.shared.mockResolvedValue(false);
  const res = await call('GET', '/calendars?fresh=true');
  expect(res.body).toMatchObject({ calendars: [mine, boss, team], microsoftSharedAccess: false });
  expect(mock.view).toHaveBeenCalledWith(alice.id, { fresh: true });
});

test('visibility choices are checked and stored for the caller', async () => {
  mock.setPrefs.mockResolvedValue({ visible: ['google:team'] });
  expect(await call('PUT', '/preferences', { visible: ['google:team'] })).toEqual({ status: 200, body: { preferences: { visible: ['google:team'] } } });
  expect(mock.setPrefs).toHaveBeenCalledWith(alice.id, { visible: ['google:team'] });
  expect((await call('PUT', '/preferences', { visible: ['caldav:x'] })).status).toBe(400);
  expect(mock.setPrefs).toHaveBeenCalledTimes(1);
});

test('a repeat rule and a reminder are checked at the boundary; a series change names its scope', async () => {
  const bad = await call('POST', '/events', { ...input, recurrence: { frequency: 'hourly' } });
  expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/frequency/);
  expect((await call('POST', '/events', { ...input, reminderMinutes: -5 })).status).toBe(422);
  expect(mock.write).not.toHaveBeenCalled();
  await call('POST', '/events', { ...input, timeZone: 'Europe/Berlin', reminderMinutes: 10, recurrence: { frequency: 'weekly', byDay: ['MO', 'WE'], count: 5 } });
  expect(mock.write).toHaveBeenLastCalledWith(alice.id, 'google', expect.objectContaining({ reminderMinutes: 10, timeZone: 'Europe/Berlin', recurrence: { frequency: 'weekly', byDay: ['MO', 'WE'], count: 5 } }), undefined, { calendarId: undefined });
  await call('PATCH', '/events/e1', { ...input, scope: 'all', reminderMinutes: null });
  expect(mock.write).toHaveBeenLastCalledWith(alice.id, 'google', expect.objectContaining({ reminderMinutes: null }), 'e1', { calendarId: undefined, notify: false, scope: 'all' });
  await call('DELETE', '/events/e1', { provider: 'google', confirm: true, scope: 'all' });
  expect(mock.remove).toHaveBeenLastCalledWith(alice.id, 'google', 'e1', { calendarId: undefined, notify: false, scope: 'all' });
});
