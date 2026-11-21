/**
 * Calendar parsing, and the rules that keep a repeatable import from doing
 * damage.
 *
 * The parsers are the part that quietly goes wrong: an all-day event whose
 * start has no time, a Microsoft timestamp with no zone suffix that is
 * actually UTC, a meeting room in the attendee list that would otherwise
 * become a "person". Each has a case below.
 */
import { describe, expect, it, test } from 'vitest';
import {
  type CalendarDeps,
  type CalendarEvent,
  googleNextPage,
  graphNextPage,
  listCalendarEvents,
  MAX_EVENTS_PER_CALENDAR,
  parseGoogleEvents,
  parseGraphEvents,
} from './events';
import { eventBody, hasOwnNotes } from './import-meetings';

describe('parseGoogleEvents', () => {
  it('reads a timed event with its attendees', () => {
    const [event] = parseGoogleEvents({
      items: [{
        id: 'g1',
        summary: 'Roadmap review',
        description: 'Bring the numbers',
        location: 'Room 3',
        start: { dateTime: '2026-09-02T10:00:00Z' },
        end: { dateTime: '2026-09-02T11:00:00Z' },
        organizer: { displayName: 'Ada Lovelace', email: 'ada@x.dev' },
        attendees: [
          { displayName: 'Grace Hopper', email: 'grace@x.dev' },
          { email: 'room3@x.dev', resource: true },
        ],
      }],
    });
    expect(event).toMatchObject({
      id: 'g1', title: 'Roadmap review', start: '2026-09-02T10:00:00.000Z', allDay: false,
      location: 'Room 3', description: 'Bring the numbers',
    });
    expect(event.organizer).toEqual({ name: 'Ada Lovelace', email: 'ada@x.dev' });
    // The room is a resource, not a person: linking it to a profile would
    // invent a colleague called Room 3.
    expect(event.attendees).toEqual([{ name: 'Grace Hopper', email: 'grace@x.dev' }]);
  });

  it('marks a date-only event as all day', () => {
    const [event] = parseGoogleEvents({
      items: [{ id: 'g2', summary: 'Public holiday', start: { date: '2026-09-03' }, end: { date: '2026-09-04' } }],
    });
    expect(event.allDay).toBe(true);
    expect(event.start).toBe('2026-09-03T00:00:00.000Z');
  });

  it('drops a cancelled event and one with no start', () => {
    const events = parseGoogleEvents({
      items: [
        { id: 'g3', summary: 'Gone', status: 'cancelled', start: { dateTime: '2026-09-02T10:00:00Z' } },
        { id: 'g4', summary: 'Broken' },
      ],
    });
    expect(events).toEqual([]);
  });

  it('returns nothing for a malformed response', () => {
    expect(parseGoogleEvents({})).toEqual([]);
    expect(parseGoogleEvents(null)).toEqual([]);
  });
});

describe('parseGraphEvents', () => {
  it('treats a zone-less timestamp as the UTC the request asked for', () => {
    // The request sends `Prefer: outlook.timezone="UTC"`, so Graph returns
    // `2026-09-02T10:00:00.0000000` meaning UTC. Parsing that without a
    // suffix would apply the server's local zone and shift the meeting.
    const [event] = parseGraphEvents({
      value: [{
        id: 'm1', subject: 'Standup',
        start: { dateTime: '2026-09-02T10:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-02T10:15:00.0000000', timeZone: 'UTC' },
      }],
    });
    expect(event.start).toBe('2026-09-02T10:00:00.000Z');
    expect(event.end).toBe('2026-09-02T10:15:00.000Z');
  });

  it('reads attendees and skips resources', () => {
    const [event] = parseGraphEvents({
      value: [{
        id: 'm2', subject: 'Review', bodyPreview: 'agenda',
        start: { dateTime: '2026-09-02T10:00:00Z' },
        location: { displayName: 'Teams' },
        organizer: { emailAddress: { name: 'Ada', address: 'ada@x.dev' } },
        attendees: [
          { type: 'required', emailAddress: { name: 'Grace', address: 'grace@x.dev' } },
          { type: 'resource', emailAddress: { name: 'Room 3', address: 'room3@x.dev' } },
        ],
      }],
    });
    expect(event.attendees).toEqual([{ name: 'Grace', email: 'grace@x.dev' }]);
    expect(event.description).toBe('agenda');
    expect(event.location).toBe('Teams');
  });

  it('drops a cancelled event', () => {
    expect(parseGraphEvents({
      value: [{ id: 'm3', subject: 'Gone', isCancelled: true, start: { dateTime: '2026-09-02T10:00:00Z' } }],
    })).toEqual([]);
  });
});

describe('listCalendarEvents', () => {
  const deps = (over: Partial<CalendarDeps> = {}): CalendarDeps => ({
    getToken: async () => 'token',
    fetchJson: async () => ({ items: [], value: [] }),
    ...over,
  });

  it('reports which providers answered', async () => {
    const result = await listCalendarEvents('u1', {
      from: new Date('2026-09-01'), to: new Date('2026-09-03'),
      deps: deps({ getToken: async (_u, p) => (p === 'google' ? 'token' : null) }),
    });
    expect(result.providers).toEqual(['google']);
    expect(result.partial).toBe(false);
  });

  it('marks the result partial when a connected provider fails', async () => {
    // Otherwise an outage reads as "nothing in the diary", which is the one
    // wrong answer a calendar tool must never give.
    const result = await listCalendarEvents('u1', {
      from: new Date('2026-09-01'), to: new Date('2026-09-03'),
      deps: deps({ fetchJson: async () => { throw new Error('503'); } }),
    });
    expect(result.partial).toBe(true);
    expect(result.providers).toEqual([]);
  });

  it('merges both calendars in start order', async () => {
    const result = await listCalendarEvents('u1', {
      from: new Date('2026-09-01'), to: new Date('2026-09-03'),
      deps: deps({
        fetchJson: async (url) => url.includes('googleapis')
          ? { items: [{ id: 'g', summary: 'Later', start: { dateTime: '2026-09-02T15:00:00Z' } }] }
          : { value: [{ id: 'm', subject: 'Earlier', start: { dateTime: '2026-09-02T09:00:00Z' } }] },
      }),
    });
    expect(result.events.map((e) => e.title)).toEqual(['Earlier', 'Later']);
    expect(result.providers).toEqual(['google', 'microsoft']);
  });

  it('asks Microsoft for attendees, which the heartbeat probe does not', async () => {
    let seen = '';
    await listCalendarEvents('u1', {
      from: new Date('2026-09-01'), to: new Date('2026-09-03'),
      deps: deps({
        getToken: async (_u, p) => (p === 'microsoft' ? 'token' : null),
        fetchJson: async (url) => { seen = url; return { value: [] }; },
      }),
    });
    expect(seen).toContain('attendees');
    expect(seen).toContain('bodyPreview');
  });
});

describe('eventBody / hasOwnNotes', () => {
  const event: CalendarEvent = {
    id: 'g1', title: 'Review', start: '2026-09-02T10:00:00Z', end: '2026-09-02T11:00:00Z',
    allDay: false, location: 'Room 3', description: 'Bring the numbers',
    organizer: { name: 'Ada' }, attendees: [], provider: 'google',
  };

  it('renders the invite plus a place for real notes', () => {
    const body = eventBody(event);
    expect(body).toContain('**Where:** Room 3');
    expect(body).toContain('Bring the numbers');
    expect(body).toContain('## Notes');
  });

  it('recognises a note nobody has written into yet', () => {
    expect(hasOwnNotes(eventBody(event))).toBe(false);
  });

  it('recognises a note somebody has written into', () => {
    // This is the guard that stops a morning re-import from deleting the
    // notes taken in the meeting itself.
    expect(hasOwnNotes(`${eventBody(event).split('_Add what')[0]}\nWe agreed to ship Friday.`)).toBe(true);
  });
});

it('reports provider pagination even when the combined event count is below the cap', async () => {
  const listed = await listCalendarEvents('alice', {
    from: new Date('2026-11-04'), to: new Date('2026-11-11'),
    deps: {
      getToken: async (_user, provider) => provider === 'google' ? 'token' : null,
      fetchJson: async () => ({ items: [], nextPageToken: 'more-events' }),
    },
  });
  expect(listed.truncated).toBe(true);
  expect(listed.partial).toBe(false);
});

test('the Calendar page reads every page, up to a cap; a next link off Graph\'s own API is never followed', async () => {
  const urls: string[] = [];
  const google = await listCalendarEvents('u1', {
    from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-30T00:00:00Z'), limit: 2, allPages: true,
    calendars: [{ provider: 'google', id: 'me@x.dev', name: 'Mine', readOnly: false }],
    deps: {
      getToken: async (_u, provider) => (provider === 'google' ? 'tok' : null),
      fetchJson: async (url) => {
        urls.push(url);
        const page = url.includes('pageToken=p2') ? 2 : 1;
        return { items: [{ id: `e${page}a`, summary: 'A', start: { dateTime: '2026-11-02T09:00:00Z' } }, { id: `e${page}b`, summary: 'B', start: { dateTime: '2026-11-02T10:00:00Z' } }], ...(page === 1 ? { nextPageToken: 'p2' } : {}) };
      },
    },
  });
  expect(google.events.map((e) => e.id).sort()).toEqual(['e1a', 'e1b', 'e2a', 'e2b']);
  expect(google.truncated).toBeUndefined();
  expect(urls[1]).toContain('&pageToken=p2');

  const graph = await listCalendarEvents('u1', {
    from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-30T00:00:00Z'), allPages: true,
    deps: {
      getToken: async (_u, provider) => (provider === 'microsoft' ? 'tok' : null),
      fetchJson: async () => ({ value: [{ id: 'm1', subject: 'M', start: { dateTime: '2026-11-02T09:00:00' } }], '@odata.nextLink': 'https://evil.example/v1.0/me/calendarView?$skip=1' }),
    },
  });
  expect(graph.events).toHaveLength(1);
  // There was more, but the link was not Graph's: the list says it is incomplete.
  expect(graph.truncated).toBe(true);
});

test('a list past the cap stops and says it is truncated', async () => {
  let calls = 0;
  const listed = await listCalendarEvents('u1', {
    from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-30T00:00:00Z'), limit: 250, allPages: true,
    deps: {
      getToken: async (_u, provider) => (provider === 'google' ? 'tok' : null),
      fetchJson: async () => {
        calls++;
        return { items: Array.from({ length: 250 }, (_, i) => ({ id: `e${calls}-${i}`, start: { dateTime: '2026-11-02T09:00:00Z' } })), nextPageToken: 'more' };
      },
    },
  });
  expect(listed.events).toHaveLength(MAX_EVENTS_PER_CALENDAR);
  expect(calls).toBe(MAX_EVENTS_PER_CALENDAR / 250);
  expect(listed.truncated).toBe(true);
});

test('next-page links: Google by token, Graph only on graph.microsoft.com under /v1.0/me/', () => {
  expect(googleNextPage({ nextPageToken: 'a b' }, 'https://x/events?q=1')).toBe('https://x/events?q=1&pageToken=a%20b');
  expect(googleNextPage({}, 'https://x')).toBeNull();
  expect(graphNextPage({ '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=50' })).toBe('https://graph.microsoft.com/v1.0/me/calendarView?$skip=50');
  for (const link of ['http://graph.microsoft.com/v1.0/me/x', 'https://graph.microsoft.com.evil.example/v1.0/me/x', 'https://graph.microsoft.com/v1.0/users/x', 'https://graph.microsoft.com:444/v1.0/me/x', 'not a url']) {
    expect(graphNextPage({ '@odata.nextLink': link })).toBeNull();
  }
});

describe('untitled events', () => {
  it('carry a placeholder title and say they have none of their own', () => {
    const [google] = parseGoogleEvents({ items: [{ id: 'g', summary: '  ', start: { dateTime: '2026-09-02T10:00:00Z' } }] });
    expect(google).toMatchObject({ title: '(no title)', untitled: true });
    const [graph] = parseGraphEvents({ value: [{ id: 'm', start: { dateTime: '2026-09-02T10:00:00' } }] });
    expect(graph).toMatchObject({ title: '(no title)', untitled: true });
    const [named] = parseGoogleEvents({ items: [{ id: 'n', summary: 'Plan', start: { dateTime: '2026-09-02T10:00:00Z' } }] });
    expect(named).not.toHaveProperty('untitled');
  });
});
