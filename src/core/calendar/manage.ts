import { getOAuthManager } from '@/security/oauth';
import type { CalendarResponse } from '@/shared/calendar';
import type { CalendarProvider } from './events';

export interface CalendarWrite {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  /** Addresses to invite. Only when creating: an edit leaves the guest list alone. */
  attendees?: string[];
}

/** Where a write goes. Without `calendarId` it is the account's default calendar. */
export interface CalendarTarget {
  calendarId?: string;
  /** Which connected account of the provider (its address). Absent: the default account. */
  account?: string;
  /** Tell the attendees (Google sends nothing unless asked; Microsoft always tells them). */
  notify?: boolean;
}

export class CalendarInputError extends Error {}

const MAX_ATTENDEES = 100;
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Validate the complete time range before opening any provider connection. */
export function calendarWriteBody(provider: CalendarProvider, input: CalendarWrite): Record<string, unknown> {
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
  if (provider === 'google') return {
    summary: input.title.trim(),
    // PATCH merges nested fields: explicitly clear the opposite time form.
    start: input.allDay ? { date: input.start, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.start).toISOString(), timeZone: 'UTC' },
    end: input.allDay ? { date: input.end, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.end).toISOString(), timeZone: 'UTC' },
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
  };
  const time = (value: string) => ({ dateTime: input.allDay ? `${value}T00:00:00` : new Date(value).toISOString(), timeZone: 'UTC' });
  return {
    subject: input.title.trim(), start: time(input.start), end: time(input.end), isAllDay: input.allDay,
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
    ...(input.description !== undefined ? { body: { contentType: 'Text', content: input.description } } : {}),
    ...(attendees?.length ? { attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
  };
}

/** Fixed provider endpoints: the collection of a calendar's events, the default calendar's without an id. */
function eventsUrl(provider: CalendarProvider, calendarId?: string): string {
  if (provider === 'google') return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events`;
  return calendarId ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events` : 'https://graph.microsoft.com/v1.0/me/events';
}

/** Google mails the guests only when asked to; Microsoft has no such switch. */
const notifyQuery = (provider: CalendarProvider, notify?: boolean) => (provider === 'google' && notify ? '?sendUpdates=all' : '');

/** One call with the caller's own token. `what` words the failure for the reader. */
async function providerCall(userId: string, provider: CalendarProvider, method: string, url: string, what: string, body?: unknown, account?: string): Promise<Response> {
  // The caller's own account of that provider; an account they have not connected has no token.
  const token = await getOAuthManager().getValidToken(userId, provider, account);
  if (!token) throw new CalendarInputError('This calendar is not connected. Connect it in Settings → Integrations.');
  const response = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The calendar provider ${what} (HTTP ${response.status}).`);
  }
  return response;
}

/**
 * How many attendees an event has now: a change of an event with attendees
 * reaches them (the provider sends or refreshes their copies).
 */
export async function calendarEventAttendees(userId: string, provider: CalendarProvider, id: string, calendarId?: string, account?: string): Promise<number> {
  const query = provider === 'google' ? '?fields=attendees' : '?$select=attendees';
  const response = await providerCall(userId, provider, 'GET', `${eventsUrl(provider, calendarId)}/${encodeURIComponent(id)}${query}`, 'could not read the event', undefined, account);
  const event = (await response.json()) as { attendees?: unknown };
  return Array.isArray(event.attendees) ? event.attendees.length : 0;
}

/**
 * Fixed provider endpoints, caller-owned OAuth token, no arbitrary URL or tenant input.
 * Returns the event's id as the provider answers it (empty when it names none).
 */
export async function writeCalendarEvent(userId: string, provider: CalendarProvider, input: CalendarWrite, id?: string, target: CalendarTarget = {}): Promise<{ id: string }> {
  // An edit never replaces the guest list.
  const body = calendarWriteBody(provider, id ? { ...input, attendees: undefined } : input);
  const base = eventsUrl(provider, target.calendarId);
  const notify = target.notify ?? (!id && !!input.attendees?.length);
  const response = await providerCall(userId, provider, id ? 'PATCH' : 'POST', `${id ? `${base}/${encodeURIComponent(id)}` : base}${notifyQuery(provider, notify)}`, 'rejected the change', body, target.account);
  const answer = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return { id: typeof answer?.id === 'string' ? answer.id : (id ?? '') };
}

/** Remove one event (for a repeating event: the listed occurrence). */
export async function deleteCalendarEvent(userId: string, provider: CalendarProvider, id: string, target: CalendarTarget = {}): Promise<void> {
  const response = await providerCall(userId, provider, 'DELETE', `${eventsUrl(provider, target.calendarId)}/${encodeURIComponent(id)}${notifyQuery(provider, target.notify)}`, 'did not delete the event', undefined, target.account);
  await response.body?.cancel();
}

const GRAPH_RSVP: Record<Exclude<CalendarResponse, 'needsAction'>, string> = { accepted: 'accept', tentative: 'tentativelyAccept', declined: 'decline' };

/** Answer an invitation as the caller. The organiser is told. */
export async function respondToCalendarEvent(userId: string, provider: CalendarProvider, id: string, response: Exclude<CalendarResponse, 'needsAction'>, target: CalendarTarget = {}): Promise<void> {
  const item = `${eventsUrl(provider, target.calendarId)}/${encodeURIComponent(id)}`;
  if (provider === 'microsoft') {
    const answer = await providerCall(userId, provider, 'POST', `${item}/${GRAPH_RSVP[response]}`, 'did not record the answer', { sendResponse: true }, target.account);
    await answer.body?.cancel();
    return;
  }
  // Google has no answer endpoint: the caller's own row in the guest list is changed.
  const current = (await (await providerCall(userId, provider, 'GET', `${item}?fields=attendees`, 'could not read the event', undefined, target.account)).json()) as { attendees?: Array<{ self?: boolean; responseStatus?: string }> };
  const attendees = Array.isArray(current.attendees) ? current.attendees : [];
  if (!attendees.some((a) => a.self)) throw new CalendarInputError('You are not on the guest list of this event, so there is nothing to answer.');
  const answer = await providerCall(userId, provider, 'PATCH', `${item}?sendUpdates=all`, 'did not record the answer', {
    attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a)),
  }, target.account);
  await answer.body?.cancel();
}
