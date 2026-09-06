/**
 * Calendar parsing, and the rules that keep a repeatable import from doing
 * damage.
 *
 * The parsers are the part that quietly goes wrong: an all-day event whose
 * start has no time, a Microsoft timestamp with no zone suffix that is
 * actually UTC, a meeting room in the attendee list that would otherwise
 * become a "person". Each has a case below.
 */
import { describe, expect, it } from 'vitest';
import {
  type CalendarDeps,
  type CalendarEvent,
  listCalendarEvents,
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
