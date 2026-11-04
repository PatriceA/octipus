import { afterEach, expect, test, vi } from 'vitest';
const token = vi.hoisted(() => vi.fn());
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: token }) }));
import { calendarWriteBody, writeCalendarEvent } from './manage';
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
test('provider writes use only the caller token and encode event IDs as one segment', async () => {
  token.mockResolvedValue('caller-secret'); const request = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', request);
  await writeCalendarEvent('alice', 'google', input, 'event/with?parts');
  expect(token).toHaveBeenCalledWith('alice', 'google');
  expect(request).toHaveBeenCalledWith('https://www.googleapis.com/calendar/v3/calendars/primary/events/event%2Fwith%3Fparts', expect.objectContaining({ method: 'PATCH', headers: { Authorization: 'Bearer caller-secret', 'Content-Type': 'application/json' } }));
});
