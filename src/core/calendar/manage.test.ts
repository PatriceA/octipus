import { afterEach, expect, test, vi } from 'vitest';
const token = vi.hoisted(() => vi.fn());
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: token }) }));
import { calendarEventAttendees, calendarWriteBody, deleteCalendarEvent, respondToCalendarEvent, writeCalendarEvent } from './manage';
const input = { title: 'Review', start: '2026-11-04T09:00:00+01:00', end: '2026-11-04T10:00:00+01:00', allDay: false, location: '' };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
test('timed events use absolute times and edits leave description and attendees untouched', () => {
  expect(calendarWriteBody('google', input)).toEqual({ summary: 'Review', start: { date: null, dateTime: '2026-11-04T08:00:00.000Z', timeZone: 'UTC' }, end: { date: null, dateTime: '2026-11-04T09:00:00.000Z', timeZone: 'UTC' }, location: '' });
  const graph = calendarWriteBody('microsoft', input);
  expect(graph).toMatchObject({ subject: 'Review', start: { dateTime: '2026-11-04T08:00:00.000Z', timeZone: 'UTC' }, isAllDay: false });
  expect(graph).not.toHaveProperty('body'); expect(graph).not.toHaveProperty('attendees');
});
test('all-day dates are date-only for Google, exclusive UTC midnights for Microsoft', () => {
  const allDay = { ...input, allDay: true, start: '2026-11-04', end: '2026-11-05' };
  expect(calendarWriteBody('google', allDay)).toMatchObject({ start: { date: '2026-11-04', dateTime: null, timeZone: null }, end: { date: '2026-11-05', dateTime: null, timeZone: null } });
  expect(calendarWriteBody('microsoft', allDay)).toMatchObject({ start: { dateTime: '2026-11-04T00:00:00', timeZone: 'UTC' }, isAllDay: true });
});
test.each([
  { ...input, end: input.start }, { ...input, title: ' ' }, { ...input, start: '2026-11-04T09:00' },
  { ...input, allDay: true, start: '2026-02-30', end: '2026-03-04' },
])('bad event ranges fail before a token lookup', async value => {
  await expect(writeCalendarEvent('alice', 'google', value)).rejects.toThrow(); expect(token).not.toHaveBeenCalled();
});
test('an event\'s attendees are counted with the caller\'s token, its id one path segment', async () => {
  token.mockResolvedValue('caller-secret');
  const request = vi.fn(async () => new Response('{"attendees":[{"email":"a@x.de"},{"email":"b@x.de"}]}'));
  vi.stubGlobal('fetch', request);
  expect(await calendarEventAttendees('alice', 'google', 'evt/1')).toBe(2);
  expect(request).toHaveBeenCalledWith('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt%2F1?fields=attendees', expect.objectContaining({ headers: { Authorization: 'Bearer caller-secret' } }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  expect(await calendarEventAttendees('alice', 'microsoft', 'evt')).toBe(0);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  await expect(calendarEventAttendees('alice', 'google', 'evt')).rejects.toThrow('HTTP 404');
});
test('a write answers the event id the provider names', async () => {
  token.mockResolvedValue('caller-secret');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"evt-42","summary":"Review"}')));
  expect(await writeCalendarEvent('alice', 'google', input)).toEqual({ id: 'evt-42' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
  expect(await writeCalendarEvent('alice', 'google', input, 'known')).toEqual({ id: 'known' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
  await expect(writeCalendarEvent('alice', 'google', input)).rejects.toThrow('HTTP 403');
});
test('provider writes use only the caller token and encode event IDs as one segment', async () => {
  token.mockResolvedValue('caller-secret'); const request = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', request);
  await writeCalendarEvent('alice', 'google', input, 'event/with?parts');
  expect(token).toHaveBeenCalledWith('alice', 'google');
  expect(request).toHaveBeenCalledWith('https://www.googleapis.com/calendar/v3/calendars/primary/events/event%2Fwith%3Fparts', expect.objectContaining({ method: 'PATCH', headers: { Authorization: 'Bearer caller-secret', 'Content-Type': 'application/json' } }));
});

const calls = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([url, init]) => ({ url, method: (init as RequestInit).method, body: (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : undefined }));

test('a named calendar is written by its id, one path segment; Microsoft through the calendar', async () => {
  token.mockResolvedValue('caller-secret'); const request = vi.fn(async () => new Response('{"id":"e"}')); vi.stubGlobal('fetch', request);
  await writeCalendarEvent('alice', 'google', input, undefined, { calendarId: 'team/x@group.calendar.google.com' });
  await writeCalendarEvent('alice', 'microsoft', input, 'evt', { calendarId: 'cal=1' });
  await deleteCalendarEvent('alice', 'microsoft', 'evt');
  expect(calls(request).map((c) => [c.method, c.url])).toEqual([
    ['POST', 'https://www.googleapis.com/calendar/v3/calendars/team%2Fx%40group.calendar.google.com/events'],
    ['PATCH', 'https://graph.microsoft.com/v1.0/me/calendars/cal%3D1/events/evt'],
    ['DELETE', 'https://graph.microsoft.com/v1.0/me/events/evt'],
  ]);
});

test('guests are invited on create only, and Google is asked to tell them', async () => {
  token.mockResolvedValue('caller-secret'); const request = vi.fn(async () => new Response('{"id":"e"}')); vi.stubGlobal('fetch', request);
  await writeCalendarEvent('alice', 'google', { ...input, attendees: ['ada@x.dev', ' grace@x.dev '] });
  await writeCalendarEvent('alice', 'google', { ...input, attendees: ['ada@x.dev'] }, 'evt');
  await writeCalendarEvent('alice', 'google', input, 'evt', { notify: true });
  await deleteCalendarEvent('alice', 'google', 'evt', { calendarId: 'team', notify: true });
  const [create, edit, notified, removed] = calls(request);
  expect(create.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
  expect(create.body.attendees).toEqual([{ email: 'ada@x.dev' }, { email: 'grace@x.dev' }]);
  // An edit never replaces the guest list, and stays quiet unless the caller agreed to notify.
  expect(edit.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt');
  expect(edit.body).not.toHaveProperty('attendees');
  expect(notified.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt?sendUpdates=all');
  expect(removed).toMatchObject({ method: 'DELETE', url: 'https://www.googleapis.com/calendar/v3/calendars/team/events/evt?sendUpdates=all' });
  expect(calendarWriteBody('microsoft', { ...input, attendees: ['ada@x.dev'] }).attendees).toEqual([{ emailAddress: { address: 'ada@x.dev' }, type: 'required' }]);
  expect(() => calendarWriteBody('google', { ...input, attendees: ['Ada <ada@x.dev>'] })).toThrow(/email addresses/);
});

test('answering an invitation: Microsoft has an endpoint, Google changes the caller\'s own guest row', async () => {
  token.mockResolvedValue('caller-secret');
  const graph = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', graph);
  await respondToCalendarEvent('alice', 'microsoft', 'evt', 'tentative');
  expect(calls(graph)).toEqual([{ method: 'POST', url: 'https://graph.microsoft.com/v1.0/me/events/evt/tentativelyAccept', body: { sendResponse: true } }]);

  const google = vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.method === 'GET' ? '{"attendees":[{"email":"ada@x.dev","responseStatus":"accepted"},{"email":"me@x.dev","self":true,"responseStatus":"needsAction"}]}' : '{}'));
  vi.stubGlobal('fetch', google);
  await respondToCalendarEvent('alice', 'google', 'evt', 'declined', { calendarId: 'me@x.dev' });
  const [read, write] = calls(google);
  expect(read.url).toBe('https://www.googleapis.com/calendar/v3/calendars/me%40x.dev/events/evt?fields=attendees');
  expect(write).toEqual({ method: 'PATCH', url: 'https://www.googleapis.com/calendar/v3/calendars/me%40x.dev/events/evt?sendUpdates=all', body: { attendees: [{ email: 'ada@x.dev', responseStatus: 'accepted' }, { email: 'me@x.dev', self: true, responseStatus: 'declined' }] } });

  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"attendees":[{"email":"ada@x.dev"}]}')));
  await expect(respondToCalendarEvent('alice', 'google', 'evt', 'accepted')).rejects.toThrow(/guest list/);
});
