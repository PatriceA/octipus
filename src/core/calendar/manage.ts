import { getOAuthManager } from '@/security/oauth';
import type { CalendarProvider } from './events';

export interface CalendarWrite {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

export class CalendarInputError extends Error {}

/** Validate the complete time range before opening any provider connection. */
export function calendarWriteBody(provider: CalendarProvider, input: CalendarWrite): Record<string, unknown> {
  if (!input.title.trim()) throw new CalendarInputError('An event title is required.');
  const valid = (value: string) => {
    if (input.allDay) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  };
  if (!valid(input.start) || !valid(input.end) || Date.parse(input.end) <= Date.parse(input.start)) throw new CalendarInputError('Choose a valid start and a later end. All-day end dates are exclusive.');
  if (provider === 'google') return {
    summary: input.title.trim(),
    // PATCH merges nested fields: explicitly clear the opposite time form.
    start: input.allDay ? { date: input.start, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.start).toISOString(), timeZone: 'UTC' },
    end: input.allDay ? { date: input.end, dateTime: null, timeZone: null } : { date: null, dateTime: new Date(input.end).toISOString(), timeZone: 'UTC' },
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const time = (value: string) => ({ dateTime: input.allDay ? `${value}T00:00:00` : new Date(value).toISOString(), timeZone: 'UTC' });
  return {
    subject: input.title.trim(), start: time(input.start), end: time(input.end), isAllDay: input.allDay,
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
    ...(input.description !== undefined ? { body: { contentType: 'Text', content: input.description } } : {}),
  };
}

/** Fixed provider endpoints, caller-owned OAuth token, no arbitrary URL or tenant input. */
export async function writeCalendarEvent(userId: string, provider: CalendarProvider, input: CalendarWrite, id?: string): Promise<void> {
  const body = calendarWriteBody(provider, input);
  const token = await getOAuthManager().getValidToken(userId, provider);
  if (!token) throw new CalendarInputError('This calendar is not connected. Connect it in Settings → Integrations.');
  const base = provider === 'google'
    ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    : 'https://graph.microsoft.com/v1.0/me/events';
  const response = await fetch(id ? `${base}/${encodeURIComponent(id)}` : base, {
    method: id ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The calendar provider rejected the change (HTTP ${response.status}).`);
}
