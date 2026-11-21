/** The meeting import reads the calendars the user shows, or the defaults when they never chose. */
import { beforeEach, expect, test, vi } from 'vitest';

let prefs: Record<string, unknown> = {};
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: async () => ({ preferences: prefs }) } }));
vi.mock('@/db/repositories/note-repository', () => ({ getNoteRepository: () => ({ getBySlug: async () => null }) }));
const ingested: string[] = [];
vi.mock('@/core/knowledge/meetings', () => ({
  meetingSlug: (title: string) => title,
  ingestMeeting: async (m: { title: string }) => { ingested.push(m.title); return { slug: m.title, created: true }; },
}));
import { importCalendarMeetings } from './import-meetings';

const urls: string[] = [];
const deps = {
  getToken: async (_u: string, provider: string) => (provider === 'google' ? 'tok' : null),
  fetchJson: async (url: string) => {
    urls.push(url);
    if (url.includes('calendarList')) return { items: [{ id: 'me@x.dev', primary: true, accessRole: 'owner', selected: true }, { id: 'team@group.calendar.google.com', accessRole: 'writer', selected: true }] };
    const team = url.includes('team%40group');
    return { items: [{ id: team ? 't1' : 'm1', summary: team ? 'Team sync' : 'My meeting', start: { dateTime: '2026-11-20T09:00:00Z' }, end: { dateTime: '2026-11-20T10:00:00Z' } }] };
  },
};
const window = { userId: 'u1', from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-21T00:00:00Z'), deps };

beforeEach(() => { urls.length = 0; ingested.length = 0; prefs = {}; });

test('never chosen: the default calendar only, as before', async () => {
  await importCalendarMeetings(window);
  expect(urls.map((u) => u.split('?')[0])).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events']);
  expect(ingested).toEqual(['My meeting']);
});

test('chosen on the Calendar page: exactly the calendars shown there', async () => {
  prefs = { calendar: { visible: ['google:team@group.calendar.google.com'] } };
  await importCalendarMeetings(window);
  expect(urls.filter((u) => u.includes('/events?')).map((u) => u.split('?')[0])).toEqual(['https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events']);
  expect(ingested).toEqual(['Team sync']);
});
