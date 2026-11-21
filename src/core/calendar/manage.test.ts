import { afterEach, expect, test, vi } from 'vitest';
const token = vi.hoisted(() => vi.fn());
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: token }) }));
import { calendarEventAttendees, calendarEventDetails, calendarWriteBody, deleteCalendarEvent, parseGoogleFreeBusy, parseGraphSchedule, queryFreeBusy, respondToCalendarEvent, writeCalendarEvent } from './manage';
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
  expect(token).toHaveBeenCalledWith('alice', 'google', undefined);
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
  await writeCalendarEvent('alice', 'google', input, 'evt');
  await writeCalendarEvent('alice', 'google', input, 'evt', { notify: true });
  await deleteCalendarEvent('alice', 'google', 'evt', { calendarId: 'team', notify: true });
  const [create, edit, notified, removed] = calls(request);
  expect(create.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
  expect(create.body.attendees).toEqual([{ email: 'ada@x.dev' }, { email: 'grace@x.dev' }]);
  // An edit without a guest list leaves it alone, and stays quiet unless the caller agreed to notify.
  expect(edit.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt');
  expect(edit.body).not.toHaveProperty('attendees'); expect(edit.body).not.toHaveProperty('description'); expect(edit.body).not.toHaveProperty('reminders');
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

/** A provider stub answering by URL part and method; it records every call. */
function stubProvider(answers: Array<[method: string, contains: string, body: unknown]>) {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const hit = answers.find(([m, part]) => (init?.method ?? 'GET') === m && url.includes(part));
    return new Response(JSON.stringify(hit ? hit[2] : {}));
  });
  vi.stubGlobal('fetch', request);
  return request;
}

test('an edited guest list keeps the guests who stay (with their answers), adds new ones, and invites them', async () => {
  token.mockResolvedValue('caller-secret');
  const request = stubProvider([['GET', 'fields=attendees', { attendees: [{ email: 'ada@x.dev', responseStatus: 'accepted' }, { email: 'bob@x.dev', responseStatus: 'declined' }, { email: 'room@resource.calendar.google.com', resource: true }] }]]);
  await writeCalendarEvent('alice', 'google', { ...input, attendees: ['ADA@x.dev', 'cy@x.dev'] }, 'evt');
  const write = calls(request).find((c) => c.method === 'PATCH')!;
  expect(write.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt?sendUpdates=all');
  expect(write.body.attendees).toEqual([{ email: 'ada@x.dev', responseStatus: 'accepted' }, { email: 'room@resource.calendar.google.com', resource: true }, { email: 'cy@x.dev' }]);
});

test('removing a guest without adding one is not an invitation; Graph rows lose the answer it does not take', async () => {
  token.mockResolvedValue('caller-secret');
  const request = stubProvider([['GET', 'select=attendees', { attendees: [{ emailAddress: { address: 'ada@x.dev', name: 'Ada' }, type: 'optional', status: { response: 'accepted' } }, { emailAddress: { address: 'bob@x.dev' }, type: 'required' }] }]]);
  await writeCalendarEvent('alice', 'microsoft', { ...input, attendees: ['ada@x.dev'] }, 'evt');
  const write = calls(request).find((c) => c.method === 'PATCH')!;
  expect(write.body.attendees).toEqual([{ emailAddress: { address: 'ada@x.dev', name: 'Ada' }, type: 'optional' }]);
});

test('description, reminder and repeat rule are sent only when given; a repeating event is anchored to the reader\'s zone', () => {
  const series = calendarWriteBody('google', { ...input, description: 'Agenda', reminderMinutes: 15, timeZone: 'Europe/Berlin', recurrence: { frequency: 'weekly', byDay: ['WE'], count: 4 } });
  expect(series).toMatchObject({
    description: 'Agenda', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    start: { dateTime: '2026-11-04T08:00:00.000Z', timeZone: 'Europe/Berlin' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4'],
  });
  const graph = calendarWriteBody('microsoft', { ...input, reminderMinutes: null, timeZone: 'Europe/Berlin', recurrence: { frequency: 'daily', until: '2026-11-30' } });
  expect(graph).toMatchObject({
    isReminderOn: false, start: { dateTime: '2026-11-04T09:00:00', timeZone: 'Europe/Berlin' },
    recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-11-04', endDate: '2026-11-30', recurrenceTimeZone: 'Europe/Berlin' } },
  });
  expect(() => calendarWriteBody('google', { ...input, recurrence: { frequency: 'daily' } })).toThrow(/time zone/);
  expect(() => calendarWriteBody('google', { ...input, timeZone: 'Nowhere/Land' })).toThrow(/time zone/);
});

test('"all events": the series moves by as much as the occurrence did, in the series\' own zone', async () => {
  token.mockResolvedValue('caller-secret');
  const request = stubProvider([
    ['GET', 'events/occ?fields=recurringEventId', { recurringEventId: 'master', start: { dateTime: '2026-11-18T09:00:00+01:00' }, end: { dateTime: '2026-11-18T10:00:00+01:00' } }],
    ['GET', 'events/master?fields=start', { start: { dateTime: '2026-11-04T09:00:00+01:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-11-04T10:00:00+01:00', timeZone: 'Europe/Berlin' }, recurrence: ['RRULE:FREQ=WEEKLY'] }],
  ]);
  const moved = { ...input, start: '2026-11-18T10:00:00+01:00', end: '2026-11-18T11:30:00+01:00', timeZone: 'Europe/Berlin' };
  expect(await writeCalendarEvent('alice', 'google', moved, 'occ', { scope: 'all' })).toEqual({ id: 'master' });
  const write = calls(request).find((c) => c.method === 'PATCH')!;
  expect(write.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/master');
  expect(write.body.start).toEqual({ dateTime: '2026-11-04T09:00:00.000Z', timeZone: 'Europe/Berlin' });
  expect(write.body.end).toEqual({ dateTime: '2026-11-04T10:30:00.000Z', timeZone: 'Europe/Berlin' });
  // To another day: that is a new repeat rule, refused.
  await expect(writeCalendarEvent('alice', 'google', { ...moved, start: '2026-11-19T10:00:00+01:00', end: '2026-11-19T11:00:00+01:00' }, 'occ', { scope: 'all' })).rejects.toThrow(/another day/);
});

test('"all events" on Graph shifts the series\' wall time and keeps its Windows zone; deleting removes the series', async () => {
  token.mockResolvedValue('caller-secret');
  const request = stubProvider([
    ['GET', 'events/occ?$select=seriesMasterId', { seriesMasterId: 'master', type: 'occurrence', start: { dateTime: '2026-11-18T08:00:00.0000000' }, end: { dateTime: '2026-11-18T09:00:00.0000000' } }],
    ['GET', 'events/master?$select=start', { start: { dateTime: '2026-11-04T09:00:00.0000000', timeZone: 'W. Europe Standard Time' }, end: { dateTime: '2026-11-04T10:00:00.0000000', timeZone: 'W. Europe Standard Time' } }],
  ]);
  await writeCalendarEvent('alice', 'microsoft', { ...input, start: '2026-11-18T08:30:00Z', end: '2026-11-18T09:30:00Z' }, 'occ', { scope: 'all' });
  const write = calls(request).find((c) => c.method === 'PATCH')!;
  expect(write.url).toBe('https://graph.microsoft.com/v1.0/me/events/master');
  expect(write.body.start).toEqual({ dateTime: '2026-11-04T09:30:00', timeZone: 'W. Europe Standard Time' });
  await deleteCalendarEvent('alice', 'microsoft', 'occ', { scope: 'all' });
  expect(calls(request).at(-1)).toMatchObject({ method: 'DELETE', url: 'https://graph.microsoft.com/v1.0/me/events/master' });
  // An occurrence cannot become a series of its own.
  await expect(writeCalendarEvent('alice', 'microsoft', { ...input, timeZone: 'UTC', recurrence: { frequency: 'daily' } }, 'occ')).rejects.toThrow(/whole series/);
});

test('details: the whole description as text, guests with answers, reminder and the series\' rule', async () => {
  token.mockResolvedValue('caller-secret');
  stubProvider([
    ['GET', 'events/occ?fields=description', { description: '<p>Agenda</p><ul><li>One</li></ul>', attendees: [{ email: 'ada@x.dev', displayName: 'Ada', responseStatus: 'tentative' }, { email: 'r@resource.calendar.google.com', resource: true }], reminders: { useDefault: false, overrides: [{ minutes: 30 }] }, recurringEventId: 'master' }],
    ['GET', 'events/master?fields=recurrence', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }],
  ]);
  const google = await calendarEventDetails('alice', 'google', 'occ');
  expect(google).toMatchObject({
    descriptionHasFormatting: true,
    attendees: [{ email: 'ada@x.dev', name: 'Ada', response: 'tentative' }],
    reminderMinutes: 30, recurrence: { frequency: 'weekly', byDay: ['MO'] }, seriesId: 'master',
  });
  expect(google.description).toMatch(/^Agenda\s+One$/);
  stubProvider([['GET', 'events/e?$select=body', { body: { contentType: 'text', content: 'Plain' }, attendees: [], isReminderOn: true, reminderMinutesBeforeStart: 15 }]]);
  expect(await calendarEventDetails('alice', 'microsoft', 'e')).toEqual({ description: 'Plain', descriptionHasFormatting: false, attendees: [], reminderMinutes: 15 });
});

test('free/busy: busy stretches per guest, and a guest whose calendar cannot be read is never free', async () => {
  expect(parseGoogleFreeBusy({ calendars: { 'ada@x.dev': { busy: [{ start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:00:00Z' }] }, 'bob@x.dev': { errors: [{ reason: 'notFound' }] } } }, ['ada@x.dev', 'bob@x.dev', 'cy@x.dev']))
    .toEqual({ busy: { 'ada@x.dev': [{ start: '2026-11-18T09:00:00.000Z', end: '2026-11-18T10:00:00.000Z' }] }, failed: { 'bob@x.dev': 'Their calendar is not shared with you.', 'cy@x.dev': 'No answer for this address.' } });
  expect(parseGraphSchedule({ value: [
    { scheduleId: 'Ada@x.dev', scheduleItems: [{ status: 'busy', start: { dateTime: '2026-11-18T09:00:00.0000000' }, end: { dateTime: '2026-11-18T10:00:00.0000000' } }, { status: 'free', start: { dateTime: '2026-11-18T11:00:00' }, end: { dateTime: '2026-11-18T12:00:00' } }] },
    { scheduleId: 'bob@x.dev', error: { message: 'no access' } },
  ] }, ['ada@x.dev', 'bob@x.dev'])).toEqual({ busy: { 'ada@x.dev': [{ start: '2026-11-18T09:00:00.000Z', end: '2026-11-18T10:00:00.000Z' }] }, failed: { 'bob@x.dev': 'Their calendar could not be read.' } });
  token.mockResolvedValue('caller-secret');
  const request = stubProvider([['POST', 'getSchedule', { value: [] }]]);
  await queryFreeBusy('alice', 'microsoft', ['ada@x.dev'], new Date('2026-11-18T00:00:00Z'), new Date('2026-11-19T00:00:00Z'));
  expect(calls(request)[0]).toEqual({ url: 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule', method: 'POST', body: { schedules: ['ada@x.dev'], startTime: { dateTime: '2026-11-18T00:00:00.000', timeZone: 'UTC' }, endTime: { dateTime: '2026-11-19T00:00:00.000', timeZone: 'UTC' }, availabilityViewInterval: 15 } });
  await expect(queryFreeBusy('alice', 'google', ['not an address'], new Date(), new Date())).rejects.toThrow(/email addresses/);
});
test('every provider call of an operation on another account uses that account\'s token, never the default', async () => {
  token.mockImplementation(async (_user: string, _provider: string, account?: string) => (account === 'me@work.example' ? 'work-token' : 'home-token'));
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers.Authorization);
    return new Response(JSON.stringify({ id: 'e1', recurringEventId: 'series', start: { dateTime: '2026-11-04T08:00:00Z' }, end: { dateTime: '2026-11-04T09:00:00Z' }, attendees: [] }));
  }));
  // A series change reads the occurrence and the series before it writes: three calls, all on the work account.
  await writeCalendarEvent('alice', 'google', input, 'e1', { account: 'me@work.example', scope: 'all', notify: true });
  await deleteCalendarEvent('alice', 'google', 'e1', { account: 'me@work.example', scope: 'all', notify: true });
  await calendarEventDetails('alice', 'google', 'e1', undefined, 'me@work.example');
  await queryFreeBusy('alice', 'google', ['a@x.de'], new Date('2026-11-04T00:00:00Z'), new Date('2026-11-05T00:00:00Z'), 'me@work.example');
  expect(seen.length).toBeGreaterThan(4);
  expect(new Set(seen)).toEqual(new Set(['Bearer work-token']));
  // Without an account: the default, as before.
  seen.length = 0;
  await calendarEventAttendees('alice', 'google', 'e1');
  expect(seen).toEqual(['Bearer home-token']);
});
