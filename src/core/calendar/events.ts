/**
 * Reading calendar events in enough detail to remember them.
 *
 * `heartbeat-probes.ts` already fetches calendar events, but only wants to
 * know whether something starts soon: its shape is `{ title, start, end }`,
 * it drops all-day events, and its Microsoft `$select` does not even ask for
 * attendees. Ingesting a meeting needs the opposite — who was there, what the
 * invite said, and a stable id so a second import updates the same note.
 *
 * Rather than widen the probe (whose narrowness is deliberate and tested),
 * this is a sibling with the same injectable-deps shape, so both stay
 * testable without a Google or Microsoft tenant.
 */

import type { Attendee } from '@/core/knowledge/meetings';
import { getOAuthManager } from '@/security/oauth';
import { fetchWithTimeout } from '@/utils/http';
import { coreLogger } from '@/utils/logger';

export type CalendarProvider = 'google' | 'microsoft';

export interface CalendarEvent {
  /** The provider's own id, stable across syncs. */
  id: string;
  title: string;
  /** ISO-8601 start. An all-day event starts at midnight in its own zone. */
  start: string;
  end?: string;
  allDay: boolean;
  description?: string;
  location?: string;
  organizer?: Attendee;
  attendees: Attendee[];
  provider: CalendarProvider;
}

export interface CalendarDeps {
  getToken: (userId: string, provider: CalendarProvider) => Promise<string | null>;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

const CALENDAR_TIMEOUT_MS = 10_000;

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithTimeout(url, { method: 'GET', headers, timeoutMs: CALENDAR_TIMEOUT_MS });
  if (!res.ok) throw new Error(`calendar API ${res.status}`);
  return res.json();
}

export const defaultCalendarDeps: CalendarDeps = {
  getToken: (userId, provider) => getOAuthManager().getValidToken(userId, provider),
  fetchJson: defaultFetchJson,
};

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; resource?: boolean; responseStatus?: string }>;
}

export function parseGoogleEvents(response: unknown): CalendarEvent[] {
  const items = (response as { items?: GoogleEvent[] })?.items;
  if (!Array.isArray(items)) return [];

  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const startRaw = item.start?.dateTime ?? item.start?.date;
    if (!item.id || !startRaw) continue;
    const allDay = !item.start?.dateTime;

    const event: CalendarEvent = {
      id: item.id,
      title: item.summary?.trim() || '(no title)',
      // A date-only value is midnight local to the event; normalising to UTC
      // here keeps every downstream comparison on one clock.
      start: allDay ? `${startRaw}T00:00:00.000Z` : new Date(startRaw).toISOString(),
      allDay,
      // A meeting room is a resource, not a person, and linking one to a
      // profile would create a "person" called "Room 3".
      attendees: (item.attendees ?? [])
        .filter((a) => !a.resource)
        .map((a) => attendee(a.displayName, a.email))
        .filter((a): a is Attendee => a !== null),
      provider: 'google',
    };
    const endRaw = item.end?.dateTime ?? item.end?.date;
    if (endRaw) event.end = allDay ? `${endRaw}T00:00:00.000Z` : new Date(endRaw).toISOString();
    if (item.description?.trim()) event.description = item.description.trim();
    if (item.location?.trim()) event.location = item.location.trim();
    const org = attendee(item.organizer?.displayName, item.organizer?.email);
    if (org) event.organizer = org;
    events.push(event);
  }
  return events;
}

interface GraphEvent {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ type?: string; emailAddress?: { name?: string; address?: string } }>;
}

export function parseGraphEvents(response: unknown): CalendarEvent[] {
  const items = (response as { value?: GraphEvent[] })?.value;
  if (!Array.isArray(items)) return [];

  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (item.isCancelled) continue;
    if (!item.id || !item.start?.dateTime) continue;
    // The request asks for UTC via the Prefer header, so a bare local-looking
    // timestamp is UTC and must be marked as such before Date parses it.
    const startRaw = item.start.dateTime.endsWith('Z') ? item.start.dateTime : `${item.start.dateTime}Z`;

    const event: CalendarEvent = {
      id: item.id,
      title: item.subject?.trim() || '(no title)',
      start: new Date(startRaw).toISOString(),
      allDay: item.isAllDay === true,
      attendees: (item.attendees ?? [])
        .filter((a) => a.type !== 'resource')
        .map((a) => attendee(a.emailAddress?.name, a.emailAddress?.address))
        .filter((a): a is Attendee => a !== null),
      provider: 'microsoft',
    };
    if (item.end?.dateTime) {
      const endRaw = item.end.dateTime.endsWith('Z') ? item.end.dateTime : `${item.end.dateTime}Z`;
      event.end = new Date(endRaw).toISOString();
    }
    if (item.bodyPreview?.trim()) event.description = item.bodyPreview.trim();
    if (item.location?.displayName?.trim()) event.location = item.location.displayName.trim();
    const org = attendee(item.organizer?.emailAddress?.name, item.organizer?.emailAddress?.address);
    if (org) event.organizer = org;
    events.push(event);
  }
  return events;
}

function attendee(name?: string, email?: string): Attendee | null {
  const n = name?.trim();
  const e = email?.trim();
  if (!n && !e) return null;
  const out: Attendee = {};
  if (n) out.name = n;
  if (e) out.email = e;
  return out;
}

interface ProviderSpec {
  provider: CalendarProvider;
  url: (from: Date, to: Date, limit: number) => string;
  headers: (token: string) => Record<string, string>;
  parse: (response: unknown) => CalendarEvent[];
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'google',
    url: (from, to, limit) =>
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=${limit}`,
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    parse: parseGoogleEvents,
  },
  {
    provider: 'microsoft',
    url: (from, to, limit) =>
      // `attendees` and `body` are the whole point of this call and are exactly
      // what the heartbeat probe's narrower $select leaves out.
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,isCancelled&$orderby=start/dateTime&$top=${limit}`,
    headers: (token) => ({ Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' }),
    parse: parseGraphEvents,
  },
];

export interface CalendarListResult {
  events: CalendarEvent[];
  /** Providers that answered. Empty means no calendar is connected. */
  providers: CalendarProvider[];
  /** True when a connected provider failed: the list is a lower bound. */
  partial: boolean;
}

/**
 * Events in a window, across whichever calendars the user connected.
 *
 * A provider that is not connected costs one token lookup and is silently
 * absent; one that errors is reported through `partial`, so a caller never
 * mistakes "could not read" for "nothing scheduled".
 */
export async function listCalendarEvents(
  userId: string,
  options: { from: Date; to: Date; limit?: number; deps?: CalendarDeps },
): Promise<CalendarListResult> {
  const deps = options.deps ?? defaultCalendarDeps;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 250));

  const results = await Promise.all(PROVIDERS.map(async (spec) => {
    const token = await deps.getToken(userId, spec.provider).catch(() => null);
    if (!token) return { events: [] as CalendarEvent[], provider: null, failed: false };
    try {
      const response = await deps.fetchJson(spec.url(options.from, options.to, limit), spec.headers(token));
      return { events: spec.parse(response), provider: spec.provider, failed: false };
    } catch (err) {
      coreLogger.warn(
        { err: (err as Error).message, userId, provider: spec.provider },
        'calendar: could not list events for provider',
      );
      return { events: [] as CalendarEvent[], provider: spec.provider, failed: true };
    }
  }));

  return {
    events: results.flatMap((r) => r.events).sort((a, b) => a.start.localeCompare(b.start)),
    providers: results.filter((r) => r.provider && !r.failed).map((r) => r.provider as CalendarProvider),
    partial: results.some((r) => r.failed),
  };
}
