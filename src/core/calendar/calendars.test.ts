/**
 * The calendar list, shared calendars, and what a multi-calendar read does
 * when one calendar cannot be opened.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: vi.fn(async () => null), update: vi.fn() } }));
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: async () => null, getConnectionStatus: async () => ({ connected: false }) }) }));

import { applyVisibility, listCalendars, parseGoogleCalendars, parseGraphCalendars, validateCalendarPreferences } from './calendars';
import { type CalendarDeps, graphAllDayDate, listCalendarEvents, parseGoogleEvents, parseGraphEvents } from './events';

const GOOGLE_LIST = { items: [
  { id: 'team@group.calendar.google.com', summary: 'Team', backgroundColor: '#16A765', accessRole: 'writer', selected: true },
  { id: 'me@x.dev', summary: 'me@x.dev', summaryOverride: 'Mine', backgroundColor: '#9fc6e7', primary: true, accessRole: 'owner', selected: true },
  { id: 'boss@x.dev', summary: 'Boss', accessRole: 'reader' },
  { id: 'gone@x.dev', summary: 'Gone', deleted: true },
] };
const GRAPH_LIST = { value: [
  { id: 'cal-default', name: 'Calendar', hexColor: '', color: 'lightBlue', isDefaultCalendar: true, canEdit: true, owner: { name: 'Me', address: 'Me@Corp.dev' } },
  { id: 'cal-birthdays', name: 'Birthdays', color: 'auto', canEdit: false, owner: { name: 'Me', address: 'me@corp.dev' } },
  { id: 'cal-ana', name: 'Ana', hexColor: '#AA5500', canEdit: false, owner: { name: 'Ana Ruiz', address: 'ana@corp.dev' } },
] };

describe('calendar lists', () => {
  it('Google: names, colours, read-only and shared calendars; its own tick decides what is shown first', () => {
    expect(parseGoogleCalendars(GOOGLE_LIST)).toEqual([
      { provider: 'google', id: 'team@group.calendar.google.com', name: 'Team', color: '#16a765', primary: false, readOnly: false, shared: true, defaultVisible: true },
      { provider: 'google', id: 'me@x.dev', name: 'Mine', color: '#9fc6e7', primary: true, readOnly: false, shared: false, defaultVisible: true },
      { provider: 'google', id: 'boss@x.dev', name: 'Boss', primary: false, readOnly: true, shared: true, owner: 'boss@x.dev', defaultVisible: false },
    ]);
    expect(parseGoogleCalendars(null)).toEqual([]);
  });

  it('Microsoft: a calendar owned by someone else is shared, and waits for the reader to tick it', () => {
    expect(parseGraphCalendars(GRAPH_LIST)).toEqual([
      { provider: 'microsoft', id: 'cal-default', name: 'Calendar', color: '#4a90d9', primary: true, readOnly: false, shared: false, defaultVisible: true },
      { provider: 'microsoft', id: 'cal-birthdays', name: 'Birthdays', primary: false, readOnly: true, shared: false, defaultVisible: true },
      { provider: 'microsoft', id: 'cal-ana', name: 'Ana', color: '#aa5500', primary: false, readOnly: true, shared: true, owner: 'Ana Ruiz', defaultVisible: false },
    ]);
  });

  it('lists both accounts, the default calendar first; a provider that fails makes the list partial', async () => {
    const deps: CalendarDeps = {
      getToken: async () => 'token',
      fetchJson: async (url) => { if (url.includes('graph.microsoft.com')) throw new Error('calendar API 503'); return GOOGLE_LIST; },
    };
    const result = await listCalendars('alice', deps);
    expect(result.calendars.map((c) => c.name)).toEqual(['Mine', 'Boss', 'Team']);
    expect(result.providers).toEqual(['google']);
    expect(result.partial).toBe(true);
  });

  it('a stored choice replaces the provider\'s default; without one the default stands', () => {
    const listed = parseGoogleCalendars(GOOGLE_LIST);
    expect(applyVisibility(listed, {}).map((c) => c.visible)).toEqual([true, true, false]);
    expect(applyVisibility(listed, { visible: ['google:boss@x.dev'] }).map((c) => c.visible)).toEqual([false, false, true]);
    expect(applyVisibility(listed, { visible: [] }).map((c) => c.visible)).toEqual([false, false, false]);
  });

  it('preferences are checked at the boundary', () => {
    expect(validateCalendarPreferences({ visible: ['google:a', 'google:a', 'microsoft:b'], hideDeclined: true })).toEqual({ visible: ['google:a', 'microsoft:b'], hideDeclined: true });
    expect(validateCalendarPreferences({ visible: ['caldav:x'] })).toMatch(/google/);
    expect(validateCalendarPreferences({ visible: 'google:a' })).toMatch(/list/);
    expect(validateCalendarPreferences({ hideDeclined: 'yes' })).toMatch(/true or false/);
    expect(validateCalendarPreferences([])).toMatch(/object/);
  });
});

describe('events of named calendars', () => {
  const window = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z') };
  const calendars = [
    { provider: 'google' as const, id: 'me@x.dev', name: 'Mine', color: '#9fc6e7', readOnly: false },
    { provider: 'google' as const, id: 'boss@x.dev', name: 'Boss', readOnly: true },
    { provider: 'microsoft' as const, id: 'cal-ana', name: 'Ana', color: '#aa5500', readOnly: true },
  ];
  const googleEvent = (id: string) => ({ items: [{ id, summary: id, start: { dateTime: '2026-09-02T10:00:00Z' }, end: { dateTime: '2026-09-02T11:00:00Z' } }] });

  it('reads each calendar by its id and says where each event came from', async () => {
    const urls: string[] = [];
    const deps: CalendarDeps = {
      getToken: async () => 'token',
      fetchJson: async (url) => {
        urls.push(url);
        if (url.includes('/calendars/me%40x.dev/')) return googleEvent('mine');
        if (url.includes('/calendars/boss%40x.dev/')) return googleEvent('theirs');
        return { value: [{ id: 'ms', subject: 'Review', start: { dateTime: '2026-09-03T08:00:00.0000000' }, end: { dateTime: '2026-09-03T09:00:00.0000000' } }] };
      },
    };
    const result = await listCalendarEvents('alice', { ...window, deps, calendars });
    expect(urls.some((u) => u.includes('graph.microsoft.com/v1.0/me/calendars/cal-ana/calendarView'))).toBe(true);
    expect(urls.some((u) => u.includes('/calendars/primary/'))).toBe(false);
    expect(result.events.map((e) => [e.id, e.calendarId, e.calendarName, e.color, e.readOnly])).toEqual([
      ['mine', 'me@x.dev', 'Mine', '#9fc6e7', undefined],
      ['theirs', 'boss@x.dev', 'Boss', undefined, true],
      ['ms', 'cal-ana', 'Ana', '#aa5500', true],
    ]);
    expect(result.partial).toBe(false);
  });

  it('a shared calendar that cannot be opened is named as unreadable; the others still show', async () => {
    const deps: CalendarDeps = {
      getToken: async () => 'token',
      fetchJson: async (url) => {
        if (url.includes('graph.microsoft.com')) throw new Error('calendar API 403');
        return url.includes('boss') ? googleEvent('theirs') : googleEvent('mine');
      },
    };
    const result = await listCalendarEvents('alice', { ...window, deps, calendars });
    expect(result.events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(result.partial).toBe(true);
    expect(result.failedCalendars).toEqual(['Ana']);
    // Microsoft is connected: the page must not say "no calendar connected".
    expect(result.providers).toEqual(['google', 'microsoft']);
  });

  it('no calendar ticked reads nothing, and is not an error', async () => {
    const fetchJson = vi.fn();
    const result = await listCalendarEvents('alice', { ...window, deps: { getToken: async () => 'token', fetchJson }, calendars: [] });
    expect(fetchJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({ events: [], partial: false, providers: ['google', 'microsoft'] });
  });

  it('without named calendars only the default calendar is read, as before', async () => {
    const urls: string[] = [];
    const deps: CalendarDeps = { getToken: async (_u, p) => (p === 'google' ? 'token' : null), fetchJson: async (url) => { urls.push(url); return googleEvent('mine'); } };
    const result = await listCalendarEvents('alice', { ...window, deps });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/calendars/primary/events');
    expect(result.events[0]).not.toHaveProperty('calendarId');
  });
});

describe('what an event says about the reader', () => {
  it('Google: own answer, meeting link, repeating, free time', () => {
    const [event, plain] = parseGoogleEvents({ items: [
      {
        id: 'g1', summary: 'Sync', start: { dateTime: '2026-09-02T10:00:00Z' }, end: { dateTime: '2026-09-02T11:00:00Z' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://www.google.com/calendar/event?eid=1',
        recurringEventId: 'series', transparency: 'transparent',
        attendees: [{ email: 'me@x.dev', self: true, responseStatus: 'declined' }, { email: 'ada@x.dev', responseStatus: 'accepted' }],
      },
      { id: 'g2', summary: 'Focus', start: { dateTime: '2026-09-02T12:00:00Z' }, hangoutLink: 'javascript:alert(1)' },
    ] });
    expect(event).toMatchObject({ responseStatus: 'declined', meetingUrl: 'https://meet.google.com/abc-defg-hij', recurring: true, showAs: 'free', webUrl: 'https://www.google.com/calendar/event?eid=1' });
    expect(event.attendees).toEqual([{ email: 'me@x.dev', response: 'declined' }, { email: 'ada@x.dev', response: 'accepted' }]);
    // No invitation, no answer; and only an https link becomes a button.
    expect(plain.responseStatus).toBeUndefined();
    expect(plain.meetingUrl).toBeUndefined();
    expect(plain.recurring).toBeUndefined();
  });

  it('Microsoft: own answer, Teams link, occurrence, away', () => {
    const [event, own] = parseGraphEvents({ value: [
      {
        id: 'm1', subject: 'Review', type: 'occurrence', seriesMasterId: 'series', showAs: 'oof', webLink: 'https://outlook.office.com/calendar/item/1',
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' }, responseStatus: { response: 'tentativelyAccepted' },
        start: { dateTime: '2026-09-03T08:00:00.0000000' }, end: { dateTime: '2026-09-03T09:00:00.0000000' },
        attendees: [{ type: 'required', status: { response: 'notResponded' }, emailAddress: { name: 'Ana', address: 'ana@corp.dev' } }],
      },
      { id: 'm2', subject: 'Mine', type: 'singleInstance', showAs: 'busy', responseStatus: { response: 'organizer' }, start: { dateTime: '2026-09-03T10:00:00.0000000' } },
    ] });
    expect(event).toMatchObject({ responseStatus: 'tentative', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/1', recurring: true, showAs: 'away' });
    expect(event.attendees).toEqual([{ name: 'Ana', email: 'ana@corp.dev', response: 'needsAction' }]);
    expect(own.responseStatus).toBeUndefined();
    expect(own.recurring).toBeUndefined();
    expect(own.showAs).toBeUndefined();
  });
});

describe('Microsoft all-day events keep their date in every zone', () => {
  it.each([
    ['UTC itself', '2026-09-03T00:00:00Z', undefined, '2026-09-03'],
    ['Berlin in summer (UTC+2): the evening before', '2026-09-02T22:00:00Z', 'W. Europe Standard Time', '2026-09-03'],
    ['Berlin in winter (UTC+1)', '2026-12-23T23:00:00Z', 'W. Europe Standard Time', '2026-12-24'],
    ['India (UTC+5:30)', '2026-09-02T18:30:00Z', 'India Standard Time', '2026-09-03'],
    ['Tokyo (UTC+9)', '2026-09-02T15:00:00Z', 'Tokyo Standard Time', '2026-09-03'],
    ['New York (UTC-4): the same morning', '2026-09-03T04:00:00Z', 'Eastern Standard Time', '2026-09-03'],
    ['Los Angeles (UTC-8)', '2026-12-24T08:00:00Z', 'Pacific Standard Time', '2026-12-24'],
    ['Honolulu (UTC-10)', '2026-09-03T10:00:00Z', 'Hawaiian Standard Time', '2026-09-03'],
    ['Auckland in summer (UTC+13): same clock as UTC-11', '2026-12-23T11:00:00Z', 'New Zealand Standard Time', '2026-12-24'],
    ['Auckland in winter (UTC+12)', '2026-07-01T12:00:00Z', 'Pacific/Auckland', '2026-07-02'],
    ['Kiritimati (UTC+14): same clock as Honolulu', '2026-09-02T10:00:00Z', 'Line Islands Standard Time', '2026-09-03'],
    ['Pago Pago (UTC-11)', '2026-09-03T11:00:00Z', 'UTC-11', '2026-09-03'],
  ])('%s', (_name, utc, zone, date) => {
    expect(graphAllDayDate(utc, zone)).toBe(date);
  });

  it('the parsed event names the date, start and exclusive end alike', () => {
    const [event] = parseGraphEvents({ value: [{
      id: 'm1', subject: 'Company day', isAllDay: true, originalStartTimeZone: 'W. Europe Standard Time',
      start: { dateTime: '2026-09-02T22:00:00.0000000' }, end: { dateTime: '2026-09-03T22:00:00.0000000' },
    }] });
    expect(event).toMatchObject({ allDay: true, start: '2026-09-03T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' });
  });
});
