import { AsyncLocalStorage } from 'node:async_hooks';
import { htmlToText } from '@/core/mail/parse';
import { getOAuthManager } from '@/security/oauth';
import type { BusyInterval, CalendarAttendee, CalendarEventDetails, CalendarRecurrence, CalendarResponse, RecurrenceScope } from '@/shared/calendar';
import type { CalendarProvider } from './events';
import {
  googleRecurrence, googleReminders, graphRecurrence, graphReminders, parseGoogleRecurrence, parseGoogleReminder, parseGraphRecurrence,
  shiftWallTime, validTimeZone, wallTime, zoned,
} from './recurrence';

export interface CalendarWrite {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  /**
   * On create: the addresses to invite. On an edit: the complete new guest
   * list; absent leaves the guest list as it is (and is never sent).
   */
  attendees?: string[];
  /** Minutes before the start; null: no reminder; absent: unchanged (on create, the calendar's default). */
  reminderMinutes?: number | null;
  /** Make the event repeat (on create, or on an edit of the whole series). */
  recurrence?: CalendarRecurrence;
  /** The reader's IANA zone: a repeating event is anchored to it, so 09:00 stays 09:00 across a clock change. */
  timeZone?: string;
}

/** Where a write goes. Without `calendarId` it is the account's default calendar. */
export interface CalendarTarget {
  calendarId?: string;
  /** Tell the attendees (Google sends nothing unless asked; Microsoft always tells them). */
  notify?: boolean;
  /** For an occurrence of a repeating event: that one (default) or the whole series. */
  scope?: RecurrenceScope;
  /** Which connected account of the provider (its address). Absent: the default account. */
  account?: string;
}

/**
 * The account every provider call of one operation uses. An operation makes
 * several calls (read the series, then write it); scoping the account once at
 * the entry point means no inner call can fall back to the default account.
 */
const accountScope = new AsyncLocalStorage<string | undefined>();
const asAccount = <T>(account: string | undefined, fn: () => Promise<T>): Promise<T> => accountScope.run(account || undefined, fn);

export class CalendarInputError extends Error {}

const MAX_ATTENDEES = 100;
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type RawGoogleAttendee = { email?: string; self?: boolean; responseStatus?: string; resource?: boolean; displayName?: string; organizer?: boolean };
type RawGraphAttendee = { emailAddress?: { address?: string; name?: string }; type?: string; status?: { response?: string } };

/**
 * The provider's guest list for a new list of addresses: guests who stay keep
 * their row (and so their answer), new ones are added, the rest removed. Pure.
 */
export function mergeAttendees(provider: CalendarProvider, addresses: string[], existing: unknown[] = []): Array<Record<string, unknown>> {
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  if (provider === 'google') {
    const kept = (existing as RawGoogleAttendee[]).filter((a) => a.email && (wanted.has(a.email.toLowerCase()) || a.resource));
    const known = new Set(kept.map((a) => a.email!.toLowerCase()));
    return [...kept, ...addresses.filter((a) => !known.has(a.toLowerCase())).map((email) => ({ email }))];
  }
  const kept = (existing as RawGraphAttendee[])
    .filter((a) => a.emailAddress?.address && (wanted.has(a.emailAddress.address.toLowerCase()) || a.type === 'resource'))
    // `status` is the guest's own answer: Graph does not take it from the organiser.
    .map((a) => ({ emailAddress: a.emailAddress, type: a.type ?? 'required' }));
  const known = new Set(kept.map((a) => a.emailAddress!.address!.toLowerCase()));
  return [...kept, ...addresses.filter((a) => !known.has(a.toLowerCase())).map((address) => ({ emailAddress: { address }, type: 'required' }))];
}

/** Validate the complete time range before opening any provider connection. */
export function calendarWriteBody(provider: CalendarProvider, input: CalendarWrite, existingAttendees?: unknown[]): Record<string, unknown> {
  if (!input.title.trim()) throw new CalendarInputError('An event title is required.');
  const valid = (value: string) => {
    if (input.allDay) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  };
  if (!valid(input.start) || !valid(input.end) || Date.parse(input.end) <= Date.parse(input.start)) throw new CalendarInputError('Choose a valid start and a later end. All-day end dates are exclusive.');
  const attendees = input.attendees?.map((a) => a.trim()).filter(Boolean);
  if (attendees && (attendees.length > MAX_ATTENDEES || attendees.some((a) => a.length > 320 || !ADDRESS.test(a)))) {
    throw new CalendarInputError(`Attendees are email addresses, at most ${MAX_ATTENDEES}.`);
  }
  if (input.timeZone !== undefined && !validTimeZone(input.timeZone)) throw new CalendarInputError('Unknown time zone.');
  if (input.recurrence && !input.timeZone) throw new CalendarInputError('A repeating event needs your time zone.');
  // A repeating event is anchored to the reader's zone; a single one keeps the absolute instant in UTC.
  const zone = input.recurrence ? input.timeZone! : 'UTC';
  // On create an empty list means no guests; on an edit an explicit empty list removes them all.
  const guestList = attendees && (attendees.length || existingAttendees) ? mergeAttendees(provider, attendees, existingAttendees) : undefined;
  if (provider === 'google') return {
    summary: input.title.trim(),
    // PATCH merges nested fields: explicitly clear the opposite time form.
    start: input.allDay ? { date: input.start, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.start).toISOString(), timeZone: zone },
    end: input.allDay ? { date: input.end, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.end).toISOString(), timeZone: zone },
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(guestList ? { attendees: guestList } : {}),
    ...(input.reminderMinutes !== undefined ? { reminders: googleReminders(input.reminderMinutes) } : {}),
    ...(input.recurrence ? { recurrence: googleRecurrence(input.recurrence, { allDay: input.allDay, timeZone: zone }) } : {}),
  };
  const time = (value: string) => (input.allDay
    ? { dateTime: `${value}T00:00:00`, timeZone: input.recurrence ? zone : 'UTC' }
    : input.recurrence ? { dateTime: wallTime(value, zone), timeZone: zone } : { dateTime: new Date(value).toISOString(), timeZone: 'UTC' });
  return {
    subject: input.title.trim(), start: time(input.start), end: time(input.end), isAllDay: input.allDay,
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
    ...(input.description !== undefined ? { body: { contentType: 'Text', content: input.description } } : {}),
    ...(guestList ? { attendees: guestList } : {}),
    ...(input.reminderMinutes !== undefined ? graphReminders(input.reminderMinutes) : {}),
    ...(input.recurrence ? { recurrence: graphRecurrence(input.recurrence, { startDate: input.allDay ? input.start : zoned(input.start, zone).date, timeZone: zone }) } : {}),
  };
}

/** Fixed provider endpoints: the collection of a calendar's events, the default calendar's without an id. */
function eventsUrl(provider: CalendarProvider, calendarId?: string): string {
  if (provider === 'google') return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events`;
  return calendarId ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events` : 'https://graph.microsoft.com/v1.0/me/events';
}
const eventUrl = (provider: CalendarProvider, id: string, calendarId?: string) => `${eventsUrl(provider, calendarId)}/${encodeURIComponent(id)}`;

/** Google mails the guests only when asked to; Microsoft has no such switch. */
const notifyQuery = (provider: CalendarProvider, notify?: boolean) => (provider === 'google' && notify ? '?sendUpdates=all' : '');

/** Graph answers times in UTC when asked to. */
const UTC_TIMES = { Prefer: 'outlook.timezone="UTC"' };

/** One call with the caller's own token. `what` words the failure for the reader. */
async function providerCall(userId: string, provider: CalendarProvider, method: string, url: string, what: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  // The caller's own account of that provider; an account they have not connected has no token.
  const token = await getOAuthManager().getValidToken(userId, provider, accountScope.getStore());
  if (!token) throw new CalendarInputError('This calendar is not connected. Connect it in Settings → Integrations.');
  const response = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The calendar provider ${what} (HTTP ${response.status}).`);
  }
  return response;
}

async function readJson<T>(userId: string, provider: CalendarProvider, url: string, what: string, headers?: Record<string, string>): Promise<T> {
  return (await (await providerCall(userId, provider, 'GET', url, what, undefined, headers)).json()) as T;
}

/**
 * How many attendees an event has now: a change of an event with attendees
 * reaches them (the provider sends or refreshes their copies).
 */
export function calendarEventAttendees(userId: string, provider: CalendarProvider, id: string, calendarId?: string, account?: string): Promise<number> {
  return asAccount(account, () => calendarEventAttendeesInAccount(userId, provider, id, calendarId));
}

async function calendarEventAttendeesInAccount(userId: string, provider: CalendarProvider, id: string, calendarId?: string): Promise<number> {
  const query = provider === 'google' ? '?fields=attendees' : '?$select=attendees';
  const event = await readJson<{ attendees?: unknown }>(userId, provider, `${eventUrl(provider, id, calendarId)}${query}`, 'could not read the event');
  return Array.isArray(event.attendees) ? event.attendees.length : 0;
}

async function currentAttendees(userId: string, provider: CalendarProvider, id: string, calendarId?: string): Promise<unknown[]> {
  const query = provider === 'google' ? '?fields=attendees' : '?$select=attendees';
  const event = await readJson<{ attendees?: unknown }>(userId, provider, `${eventUrl(provider, id, calendarId)}${query}`, 'could not read the event');
  return Array.isArray(event.attendees) ? event.attendees : [];
}

const addressesOf = (provider: CalendarProvider, raw: unknown[]) => new Set((raw as Array<RawGoogleAttendee & RawGraphAttendee>)
  .map((a) => (provider === 'google' ? a.email : a.emailAddress?.address)?.toLowerCase()).filter((a): a is string => !!a));

/**
 * Fixed provider endpoints, caller-owned OAuth token, no arbitrary URL or tenant input.
 * Returns the event's id as the provider answers it (empty when it names none).
 */
export function writeCalendarEvent(userId: string, provider: CalendarProvider, input: CalendarWrite, id?: string, target: CalendarTarget = {}): Promise<{ id: string }> {
  return asAccount(target.account, () => writeCalendarEventInAccount(userId, provider, input, id, target));
}

async function writeCalendarEventInAccount(userId: string, provider: CalendarProvider, input: CalendarWrite, id?: string, target: CalendarTarget = {}): Promise<{ id: string }> {
  // Validated before any provider connection.
  calendarWriteBody(provider, input);
  if (id && target.scope === 'all') return writeSeries(userId, provider, input, id, target);
  if (id && input.recurrence) throw new CalendarInputError('Only a whole series can be given a repeat rule: choose "All events".');
  const existing = id && input.attendees ? await currentAttendees(userId, provider, id, target.calendarId) : undefined;
  const body = calendarWriteBody(provider, input, existing);
  // A guest added now gets an invitation, whatever the others were told.
  const before = existing ? addressesOf(provider, existing) : new Set<string>();
  const added = (input.attendees ?? []).some((a) => !before.has(a.trim().toLowerCase()));
  const notify = target.notify || added;
  const base = eventsUrl(provider, target.calendarId);
  const response = await providerCall(userId, provider, id ? 'PATCH' : 'POST', `${id ? `${base}/${encodeURIComponent(id)}` : base}${notifyQuery(provider, notify)}`, 'rejected the change', body);
  const answer = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return { id: typeof answer?.id === 'string' ? answer.id : (id ?? '') };
}

interface SeriesInfo {
  seriesId: string;
  /** The occurrence's own start and end, as instants (ms) or dates. */
  occurrence: { start: string; end: string; allDay: boolean };
}

/** The series an occurrence belongs to; null when the event does not repeat. */
async function seriesOf(userId: string, provider: CalendarProvider, id: string, calendarId?: string): Promise<SeriesInfo | null> {
  if (provider === 'google') {
    const e = await readJson<{ recurringEventId?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }>(
      userId, provider, `${eventUrl(provider, id, calendarId)}?fields=recurringEventId,start,end`, 'could not read the event');
    if (!e.recurringEventId) return null;
    return { seriesId: e.recurringEventId, occurrence: { start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '', allDay: !e.start?.dateTime } };
  }
  const e = await readJson<{ seriesMasterId?: string; type?: string; isAllDay?: boolean; start?: { dateTime?: string }; end?: { dateTime?: string } }>(
    userId, provider, `${eventUrl(provider, id, calendarId)}?$select=seriesMasterId,type,isAllDay,start,end`, 'could not read the event', UTC_TIMES);
  if (e.type === 'seriesMaster') return { seriesId: id, occurrence: { start: `${e.start?.dateTime ?? ''}Z`, end: `${e.end?.dateTime ?? ''}Z`, allDay: e.isAllDay === true } };
  if (!e.seriesMasterId) return null;
  const at = (v?: string) => (v ? (v.endsWith('Z') ? v : `${v}Z`) : '');
  return { seriesId: e.seriesMasterId, occurrence: { start: at(e.start?.dateTime), end: at(e.end?.dateTime), allDay: e.isAllDay === true } };
}

/**
 * A change to every event of a series, made from one occurrence. The series'
 * own start moves by as much as the occurrence was moved, so a meeting moved
 * from 09:00 to 10:00 moves every week, not to the occurrence's date. Moving
 * the whole series to another day is refused: that is a new repeat rule.
 */
async function writeSeries(userId: string, provider: CalendarProvider, input: CalendarWrite, id: string, target: CalendarTarget): Promise<{ id: string }> {
  const series = await seriesOf(userId, provider, id, target.calendarId);
  if (!series) return writeCalendarEvent(userId, provider, input, id, { ...target, scope: 'this' });
  if (series.occurrence.allDay !== input.allDay) throw new CalendarInputError('A whole series cannot change between all-day and timed here. Change this event only, or edit the series in the provider\'s own calendar.');
  const zone = input.timeZone ?? 'UTC';
  const dayOf = (value: string, allDay: boolean) => (allDay ? value.slice(0, 10) : zoned(value, zone).date);
  if (dayOf(input.start, input.allDay) !== dayOf(series.occurrence.start, series.occurrence.allDay)) {
    throw new CalendarInputError('Every event of a series cannot be moved to another day here: change its repeat days instead, or move this event only.');
  }
  const master = await readJson<{ start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string }; attendees?: unknown[]; recurrence?: unknown }>(
    userId, provider, `${eventUrl(provider, series.seriesId, target.calendarId)}${provider === 'google' ? '?fields=start,end,attendees,recurrence' : '?$select=start,end,attendees,recurrence'}`, 'could not read the series');
  const body = calendarWriteBody(provider, { ...input, recurrence: undefined }, input.attendees ? (master.attendees ?? []) : undefined);
  delete body.start; delete body.end;
  const startDelta = input.allDay ? 0 : Date.parse(input.start) - Date.parse(series.occurrence.start);
  const endDelta = input.allDay ? 0 : Date.parse(input.end) - Date.parse(series.occurrence.end);
  if (startDelta || endDelta) {
    if (provider === 'google') {
      const shift = (value: { dateTime?: string; timeZone?: string } | undefined, delta: number) => ({ dateTime: new Date(Date.parse(value?.dateTime ?? '') + delta).toISOString(), timeZone: value?.timeZone ?? zone });
      body.start = shift(master.start, startDelta);
      body.end = shift(master.end, endDelta);
    } else {
      body.start = { dateTime: shiftWallTime(master.start?.dateTime ?? '', startDelta), timeZone: master.start?.timeZone ?? 'UTC' };
      body.end = { dateTime: shiftWallTime(master.end?.dateTime ?? '', endDelta), timeZone: master.end?.timeZone ?? 'UTC' };
    }
    if (!Number.isFinite(Date.parse(String((body.start as { dateTime: string }).dateTime).replace(/Z?$/, 'Z')))) throw new Error('The calendar provider gave the series no start time.');
  }
  if (input.recurrence) {
    if (provider === 'google') {
      body.recurrence = googleRecurrence(input.recurrence, { allDay: input.allDay, timeZone: master.start?.timeZone ?? zone });
    } else {
      const range = (master.recurrence as { range?: { startDate?: string; recurrenceTimeZone?: string } } | undefined)?.range;
      body.recurrence = graphRecurrence(input.recurrence, {
        startDate: range?.startDate ?? (master.start?.dateTime ?? '').slice(0, 10),
        timeZone: range?.recurrenceTimeZone ?? master.start?.timeZone ?? zone,
      });
    }
  }
  const before = input.attendees ? addressesOf(provider, master.attendees ?? []) : new Set<string>();
  const notify = target.notify || (input.attendees ?? []).some((a) => !before.has(a.trim().toLowerCase()));
  const response = await providerCall(userId, provider, 'PATCH', `${eventUrl(provider, series.seriesId, target.calendarId)}${notifyQuery(provider, notify)}`, 'rejected the change', body);
  await response.body?.cancel();
  return { id: series.seriesId };
}

/** Remove one event, or for `scope: 'all'` the whole series the occurrence belongs to. */
export function deleteCalendarEvent(userId: string, provider: CalendarProvider, id: string, target: CalendarTarget = {}): Promise<void> {
  return asAccount(target.account, () => deleteCalendarEventInAccount(userId, provider, id, target));
}

async function deleteCalendarEventInAccount(userId: string, provider: CalendarProvider, id: string, target: CalendarTarget = {}): Promise<void> {
  const series = target.scope === 'all' ? await seriesOf(userId, provider, id, target.calendarId) : null;
  const response = await providerCall(userId, provider, 'DELETE', `${eventUrl(provider, series?.seriesId ?? id, target.calendarId)}${notifyQuery(provider, target.notify)}`, 'did not delete the event');
  await response.body?.cancel();
}

const GRAPH_RSVP: Record<Exclude<CalendarResponse, 'needsAction'>, string> = { accepted: 'accept', tentative: 'tentativelyAccept', declined: 'decline' };

/** Answer an invitation as the caller. The organiser is told. */
export function respondToCalendarEvent(userId: string, provider: CalendarProvider, id: string, response: Exclude<CalendarResponse, 'needsAction'>, target: CalendarTarget = {}): Promise<void> {
  return asAccount(target.account, () => respondToCalendarEventInAccount(userId, provider, id, response, target));
}

async function respondToCalendarEventInAccount(userId: string, provider: CalendarProvider, id: string, response: Exclude<CalendarResponse, 'needsAction'>, target: CalendarTarget = {}): Promise<void> {
  const item = eventUrl(provider, id, target.calendarId);
  if (provider === 'microsoft') {
    const answer = await providerCall(userId, provider, 'POST', `${item}/${GRAPH_RSVP[response]}`, 'did not record the answer', { sendResponse: true });
    await answer.body?.cancel();
    return;
  }
  // Google has no answer endpoint: the caller's own row in the guest list is changed.
  const current = (await (await providerCall(userId, provider, 'GET', `${item}?fields=attendees`, 'could not read the event')).json()) as { attendees?: Array<{ self?: boolean; responseStatus?: string }> };
  const attendees = Array.isArray(current.attendees) ? current.attendees : [];
  if (!attendees.some((a) => a.self)) throw new CalendarInputError('You are not on the guest list of this event, so there is nothing to answer.');
  const answer = await providerCall(userId, provider, 'PATCH', `${item}?sendUpdates=all`, 'did not record the answer', {
    attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a)),
  });
  await answer.body?.cancel();
}

// ── Details for the edit dialog ─────────────────────────────────────────────

const GOOGLE_ANSWER: Record<string, CalendarResponse> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needsAction' };
const GRAPH_ANSWER: Record<string, CalendarResponse> = { accepted: 'accepted', declined: 'declined', tentativelyAccepted: 'tentative', notResponded: 'needsAction' };
const HTML = /<\/?[a-z][^>]*>/i;

function plainText(raw: string): { text: string; formatted: boolean } {
  if (!HTML.test(raw)) return { text: raw, formatted: false };
  return { text: htmlToText(raw).replace(/\n{3,}/g, '\n\n').trim(), formatted: true };
}

/**
 * What the edit dialog needs and the event list leaves out: the whole
 * description (Microsoft's list gives a 255-character preview), the guests
 * with their answers, the reminder, and the series' repeat rule.
 */
export function calendarEventDetails(userId: string, provider: CalendarProvider, id: string, calendarId?: string, account?: string): Promise<CalendarEventDetails> {
  return asAccount(account, () => calendarEventDetailsInAccount(userId, provider, id, calendarId));
}

async function calendarEventDetailsInAccount(userId: string, provider: CalendarProvider, id: string, calendarId?: string): Promise<CalendarEventDetails> {
  const url = eventUrl(provider, id, calendarId);
  if (provider === 'google') {
    const e = await readJson<{ description?: string; attendees?: RawGoogleAttendee[]; reminders?: unknown; recurringEventId?: string; recurrence?: unknown }>(
      userId, provider, `${url}?fields=description,attendees,reminders,recurringEventId,recurrence`, 'could not read the event');
    const { text, formatted } = plainText(e.description ?? '');
    let recurrence = parseGoogleRecurrence(e.recurrence);
    if (e.recurringEventId) {
      const master = await readJson<{ recurrence?: unknown }>(userId, provider, `${eventUrl(provider, e.recurringEventId, calendarId)}?fields=recurrence`, 'could not read the series');
      recurrence = parseGoogleRecurrence(master.recurrence) ?? 'custom';
    }
    const reminder = parseGoogleReminder(e.reminders);
    return {
      description: text, descriptionHasFormatting: formatted,
      attendees: (e.attendees ?? []).filter((a) => !a.resource && a.email).map((a): CalendarAttendee => ({ email: a.email, ...(a.displayName ? { name: a.displayName } : {}), ...(GOOGLE_ANSWER[a.responseStatus ?? ''] ? { response: GOOGLE_ANSWER[a.responseStatus ?? ''] } : {}) })),
      ...(reminder !== undefined ? { reminderMinutes: reminder } : {}),
      ...(recurrence ? { recurrence } : {}),
      ...(e.recurringEventId ? { seriesId: e.recurringEventId } : {}),
    };
  }
  const e = await readJson<{ body?: { content?: string; contentType?: string }; attendees?: RawGraphAttendee[]; isReminderOn?: boolean; reminderMinutesBeforeStart?: number; seriesMasterId?: string; type?: string; recurrence?: unknown }>(
    userId, provider, `${url}?$select=body,attendees,isReminderOn,reminderMinutesBeforeStart,seriesMasterId,type,recurrence`, 'could not read the event');
  const raw = e.body?.content ?? '';
  const { text, formatted } = e.body?.contentType === 'html' ? { text: htmlToText(raw).replace(/\n{3,}/g, '\n\n').trim(), formatted: HTML.test(raw) && htmlToText(raw).trim().length > 0 } : plainText(raw);
  let recurrence = parseGraphRecurrence(e.recurrence);
  if (e.seriesMasterId) {
    const master = await readJson<{ recurrence?: unknown }>(userId, provider, `${eventUrl(provider, e.seriesMasterId, calendarId)}?$select=recurrence`, 'could not read the series');
    recurrence = parseGraphRecurrence(master.recurrence) ?? 'custom';
  }
  return {
    description: text, descriptionHasFormatting: formatted,
    attendees: (e.attendees ?? []).filter((a) => a.type !== 'resource' && a.emailAddress?.address).map((a): CalendarAttendee => ({ email: a.emailAddress!.address, ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}), ...(GRAPH_ANSWER[a.status?.response ?? ''] ? { response: GRAPH_ANSWER[a.status?.response ?? ''] } : {}) })),
    reminderMinutes: e.isReminderOn === false ? null : typeof e.reminderMinutesBeforeStart === 'number' ? e.reminderMinutesBeforeStart : null,
    ...(recurrence ? { recurrence } : {}),
    ...(e.seriesMasterId ? { seriesId: e.seriesMasterId } : {}),
  };
}

// ── Free/busy ───────────────────────────────────────────────────────────────

const MAX_FREEBUSY = 20;

/** Pure: Google's freeBusy answer → busy stretches and failures per address. */
export function parseGoogleFreeBusy(response: unknown, addresses: string[]): { busy: Record<string, BusyInterval[]>; failed: Record<string, string> } {
  const calendars = (response as { calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }> })?.calendars ?? {};
  const busy: Record<string, BusyInterval[]> = {};
  const failed: Record<string, string> = {};
  for (const address of addresses) {
    const entry = calendars[address] ?? Object.entries(calendars).find(([key]) => key.toLowerCase() === address.toLowerCase())?.[1];
    if (!entry) { failed[address] = 'No answer for this address.'; continue; }
    if (entry.errors?.length) { failed[address] = entry.errors[0]?.reason === 'notFound' ? 'Their calendar is not shared with you.' : 'Their calendar could not be read.'; continue; }
    busy[address] = (entry.busy ?? []).filter((b) => b.start && b.end).map((b) => ({ start: new Date(b.start!).toISOString(), end: new Date(b.end!).toISOString() }));
  }
  return { busy, failed };
}

/** Pure: Graph's getSchedule answer (times in UTC) → busy stretches and failures per address. */
export function parseGraphSchedule(response: unknown, addresses: string[]): { busy: Record<string, BusyInterval[]>; failed: Record<string, string> } {
  const value = (response as { value?: Array<{ scheduleId?: string; error?: { message?: string }; scheduleItems?: Array<{ status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }> }> })?.value ?? [];
  const busy: Record<string, BusyInterval[]> = {};
  const failed: Record<string, string> = {};
  const utc = (v: string) => new Date(v.endsWith('Z') ? v : `${v}Z`).toISOString();
  for (const address of addresses) {
    const entry = value.find((v) => v.scheduleId?.toLowerCase() === address.toLowerCase());
    if (!entry) { failed[address] = 'No answer for this address.'; continue; }
    if (entry.error) { failed[address] = 'Their calendar could not be read.'; continue; }
    busy[address] = (entry.scheduleItems ?? [])
      // Working elsewhere and free are not busy.
      .filter((i) => ['busy', 'tentative', 'oof'].includes(i.status ?? '') && i.start?.dateTime && i.end?.dateTime)
      .map((i) => ({ start: utc(i.start!.dateTime!), end: utc(i.end!.dateTime!) }));
  }
  return { busy, failed };
}

/** When the guests are busy between `from` and `to`, asked of the provider the event is in. */
export function queryFreeBusy(userId: string, provider: CalendarProvider, addresses: string[], from: Date, to: Date, account?: string): Promise<{ busy: Record<string, BusyInterval[]>; failed: Record<string, string> }> {
  return asAccount(account, () => queryFreeBusyInAccount(userId, provider, addresses, from, to));
}

async function queryFreeBusyInAccount(userId: string, provider: CalendarProvider, addresses: string[], from: Date, to: Date): Promise<{ busy: Record<string, BusyInterval[]>; failed: Record<string, string> }> {
  const list = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (list.length > MAX_FREEBUSY || list.some((a) => a.length > 320 || !ADDRESS.test(a))) throw new CalendarInputError(`Free/busy takes up to ${MAX_FREEBUSY} email addresses.`);
  if (!list.length) return { busy: {}, failed: {} };
  if (provider === 'google') {
    const response = await providerCall(userId, provider, 'POST', 'https://www.googleapis.com/calendar/v3/freeBusy', 'could not read free/busy times', {
      timeMin: from.toISOString(), timeMax: to.toISOString(), items: list.map((id) => ({ id })),
    });
    return parseGoogleFreeBusy(await response.json(), list);
  }
  const plain = (d: Date) => d.toISOString().replace('Z', '');
  const response = await providerCall(userId, provider, 'POST', 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule', 'could not read free/busy times', {
    schedules: list, startTime: { dateTime: plain(from), timeZone: 'UTC' }, endTime: { dateTime: plain(to), timeZone: 'UTC' }, availabilityViewInterval: 15,
  }, UTC_TIMES);
  return parseGraphSchedule(await response.json(), list);
}
