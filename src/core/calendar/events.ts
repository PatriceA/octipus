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
 *
 * Without `calendars` only each account's default calendar is read, as the
 * import and the plugin host expect. The Calendar page names the calendars it
 * shows (the reader's own and the ones shared with them), and each event then
 * says which calendar it came from.
 */

import { getOAuthManager } from '@/security/oauth';
import { mapLimit } from '@/utils/concurrency';
import { fetchWithTimeout } from '@/utils/http';
import { coreLogger } from '@/utils/logger';

import type { CalendarAttendee, CalendarEvent, CalendarInfo, CalendarProvider, CalendarResponse, CalendarShowAs } from '@/shared/calendar';
export type { CalendarEvent, CalendarProvider } from '@/shared/calendar';

export interface CalendarDeps {
  /** The user's token for the provider: its default account, or the named `account`. */
  getToken: (userId: string, provider: CalendarProvider, account?: string) => Promise<string | null>;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  /** The user's further accounts of a provider (not the default), by address. Absent: none. */
  otherAccounts?: (userId: string, provider: CalendarProvider) => Promise<string[]>;
}

const CALENDAR_TIMEOUT_MS = 10_000;

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithTimeout(url, { method: 'GET', headers, timeoutMs: CALENDAR_TIMEOUT_MS });
  if (!res.ok) throw new Error(`calendar API ${res.status}`);
  return res.json();
}

export const defaultCalendarDeps: CalendarDeps = {
  getToken: (userId, provider, account) => getOAuthManager().getValidToken(userId, provider, account),
  fetchJson: defaultFetchJson,
  otherAccounts: async (userId, provider) =>
    (await getOAuthManager().listAccounts(userId, provider)).filter((a) => !a.isDefault && a.account).map((a) => a.account as string),
};

/** Only an https link is offered as a button to press. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  recurringEventId?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; resource?: boolean; responseStatus?: string; self?: boolean }>;
}

const GOOGLE_RESPONSE: Record<string, CalendarResponse> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needsAction' };

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
        .map((a) => attendee(a.displayName, a.email, GOOGLE_RESPONSE[a.responseStatus ?? '']))
        .filter((a): a is CalendarAttendee => a !== null),
      provider: 'google',
    };
    const endRaw = item.end?.dateTime ?? item.end?.date;
    if (endRaw) event.end = allDay ? `${endRaw}T00:00:00.000Z` : new Date(endRaw).toISOString();
    if (item.description?.trim()) event.description = item.description.trim();
    if (item.location?.trim()) event.location = item.location.trim();
    const org = attendee(item.organizer?.displayName, item.organizer?.email);
    if (org) event.organizer = org;
    const mine = GOOGLE_RESPONSE[item.attendees?.find((a) => a.self)?.responseStatus ?? ''];
    if (mine) event.responseStatus = mine;
    const meeting = httpsUrl(item.hangoutLink) ?? httpsUrl(item.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri);
    if (meeting) event.meetingUrl = meeting;
    if (item.recurringEventId) { event.recurring = true; event.seriesId = item.recurringEventId; }
    if (item.transparency === 'transparent') event.showAs = 'free';
    const web = httpsUrl(item.htmlLink);
    if (web) event.webUrl = web;
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
  type?: string;
  seriesMasterId?: string;
  showAs?: string;
  webLink?: string;
  originalStartTimeZone?: string;
  onlineMeetingUrl?: string;
  onlineMeeting?: { joinUrl?: string };
  responseStatus?: { response?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ type?: string; status?: { response?: string }; emailAddress?: { name?: string; address?: string } }>;
}

const GRAPH_RESPONSE: Record<string, CalendarResponse> = { accepted: 'accepted', declined: 'declined', tentativelyAccepted: 'tentative', notResponded: 'needsAction' };
const GRAPH_SHOW_AS: Record<string, CalendarShowAs> = { free: 'free', tentative: 'tentative', busy: 'busy', oof: 'away', workingElsewhere: 'free' };

/**
 * Zones twelve or more hours ahead of UTC, by the names Graph uses for them
 * (Windows names, or IANA ones). Only needed to tell them from zones ten to
 * twelve hours behind: see graphAllDayDate.
 */
const FAR_EAST_ZONE = /new zealand|auckland|chatham|fiji|tonga|samoa|apia|kamchatka|magadan|line islands|kiritimati|tarawa|majuro|kwajalein|funafuti|wake|wallis|nauru|fakaofo|enderbury|kanton|anadyr|utc\+1[234]/i;

/**
 * The calendar date of an all-day Graph event from its UTC timestamp.
 *
 * An all-day event runs midnight to midnight in the zone it was made in. Asked
 * for in UTC, that midnight can come back as the evening before (zones ahead
 * of UTC: Berlin's 3 September is `2026-09-02T22:00`) or the morning after
 * (zones behind). The date is the UTC midnight nearest to it. Ten to twelve
 * hours off is ambiguous (UTC-10 Honolulu or UTC+14 Kiritimati), and there the
 * event's original zone decides. Pure.
 */
export function graphAllDayDate(utc: string, originalZone?: string): string {
  const at = new Date(utc);
  if (!Number.isFinite(+at)) return utc.slice(0, 10);
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const sameDay = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const ahead = minutes > 12 * 60 || (minutes >= 10 * 60 && FAR_EAST_ZONE.test(originalZone ?? ''));
  return new Date(ahead ? sameDay + 86_400_000 : sameDay).toISOString().slice(0, 10);
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
    const utc = (raw: string) => (raw.endsWith('Z') ? raw : `${raw}Z`);
    const allDay = item.isAllDay === true;
    const startRaw = utc(item.start.dateTime);
    if (!Number.isFinite(Date.parse(startRaw))) continue;

    const event: CalendarEvent = {
      id: item.id,
      title: item.subject?.trim() || '(no title)',
      // An all-day event is a date, not an instant: see graphAllDayDate.
      start: allDay ? `${graphAllDayDate(startRaw, item.originalStartTimeZone)}T00:00:00.000Z` : new Date(startRaw).toISOString(),
      allDay,
      attendees: (item.attendees ?? [])
        .filter((a) => a.type !== 'resource')
        .map((a) => attendee(a.emailAddress?.name, a.emailAddress?.address, GRAPH_RESPONSE[a.status?.response ?? '']))
        .filter((a): a is CalendarAttendee => a !== null),
      provider: 'microsoft',
    };
    if (item.end?.dateTime && Number.isFinite(Date.parse(utc(item.end.dateTime)))) {
      const endRaw = utc(item.end.dateTime);
      event.end = allDay ? `${graphAllDayDate(endRaw, item.originalStartTimeZone)}T00:00:00.000Z` : new Date(endRaw).toISOString();
    }
    if (item.bodyPreview?.trim()) event.description = item.bodyPreview.trim();
    if (item.location?.displayName?.trim()) event.location = item.location.displayName.trim();
    const org = attendee(item.organizer?.emailAddress?.name, item.organizer?.emailAddress?.address);
    if (org) event.organizer = org;
    // 'organizer' and 'none' are not answers to an invitation.
    const mine = GRAPH_RESPONSE[item.responseStatus?.response ?? ''];
    if (mine) event.responseStatus = mine;
    const meeting = httpsUrl(item.onlineMeeting?.joinUrl) ?? httpsUrl(item.onlineMeetingUrl);
    if (meeting) event.meetingUrl = meeting;
    if (item.seriesMasterId || item.type === 'occurrence' || item.type === 'exception') event.recurring = true;
    if (item.seriesMasterId) event.seriesId = item.seriesMasterId;
    const showAs = GRAPH_SHOW_AS[item.showAs ?? ''];
    if (showAs && showAs !== 'busy') event.showAs = showAs;
    const web = httpsUrl(item.webLink);
    if (web) event.webUrl = web;
    events.push(event);
  }
  return events;
}

function attendee(name?: string, email?: string, response?: CalendarResponse): CalendarAttendee | null {
  const n = name?.trim();
  const e = email?.trim();
  if (!n && !e) return null;
  const out: CalendarAttendee = {};
  if (n) out.name = n;
  if (e) out.email = e;
  if (response) out.response = response;
  return out;
}

interface ProviderSpec {
  provider: CalendarProvider;
  /** `calendarId` absent: the account's default calendar. */
  url: (from: Date, to: Date, limit: number, calendarId?: string) => string;
  headers: (token: string) => Record<string, string>;
  parse: (response: unknown) => CalendarEvent[];
  /** The next page of the same list, or null at the end. `first` is the URL of the first page. */
  next: (response: unknown, first: string) => string | null;
}

/** Events read from one calendar for one range at most: beyond it the result says it is truncated. */
export const MAX_EVENTS_PER_CALENDAR = 2500;

/**
 * Google's next page: the first URL with `pageToken`. The token is opaque, so
 * it is only ever sent back as one encoded query value. Pure.
 */
export function googleNextPage(response: unknown, first: string): string | null {
  const token = (response as { nextPageToken?: unknown })?.nextPageToken;
  if (typeof token !== 'string' || !token || token.length > 2048) return null;
  return `${first}&pageToken=${encodeURIComponent(token)}`;
}

/**
 * Graph's next page, as Graph names it — but only when it stays on Graph's own
 * host and the caller's own calendar API: a list answer cannot send the token
 * anywhere else. Pure.
 */
export function graphNextPage(response: unknown): string | null {
  const link = (response as { '@odata.nextLink'?: unknown })?.['@odata.nextLink'];
  if (typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || url.port || url.username || !url.pathname.startsWith('/v1.0/me/')) return null;
    return url.toString();
  } catch { return null; }
}

const GRAPH_SELECT = 'id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,isCancelled,type,seriesMasterId,showAs,webLink,originalStartTimeZone,onlineMeeting,onlineMeetingUrl,responseStatus';

const PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'google',
    url: (from, to, limit, calendarId) =>
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events?timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=${limit}`,
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    parse: parseGoogleEvents,
    next: googleNextPage,
  },
  {
    provider: 'microsoft',
    url: (from, to, limit, calendarId) =>
      // `attendees` and `body` are the whole point of this call and are exactly
      // what the heartbeat probe's narrower $select leaves out.
      `https://graph.microsoft.com/v1.0/me/${calendarId ? `calendars/${encodeURIComponent(calendarId)}/` : ''}calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=${GRAPH_SELECT}&$orderby=start/dateTime&$top=${limit}`,
    headers: (token) => ({ Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' }),
    parse: parseGraphEvents,
    next: (response) => graphNextPage(response),
  },
];

export interface CalendarListResult {
  /** A provider returned more events than this window's bounded response. */
  truncated?: boolean;
  events: CalendarEvent[];
  /** Providers that answered. Empty means no calendar is connected. */
  providers: CalendarProvider[];
  /** True when a connected provider or one of its calendars failed: the list is a lower bound. */
  partial: boolean;
  /** Names of the calendars that could not be read (only when `calendars` were named). */
  failedCalendars?: string[];
}

/** A calendar to read, as the calendar list describes it. */
export type CalendarSource = Pick<CalendarInfo, 'provider' | 'id' | 'name' | 'color' | 'readOnly' | 'account'>;

/**
 * Events in a window, across whichever calendars the user connected.
 *
 * A provider that is not connected costs one token lookup and is silently
 * absent; one that errors is reported through `partial`, so a caller never
 * mistakes "could not read" for "nothing scheduled". With `calendars`, exactly
 * those are read (an empty list reads nothing) and one that fails — a shared
 * calendar the token may not open — makes the result partial without hiding
 * the others.
 */
export async function listCalendarEvents(
  userId: string,
  options: {
    from: Date; to: Date;
    /** Events per request (at most 250). */
    limit?: number;
    deps?: CalendarDeps; calendars?: CalendarSource[];
    /** Follow the provider's pages up to MAX_EVENTS_PER_CALENDAR. Without it one page is read, as before. */
    allPages?: boolean;
  },
): Promise<CalendarListResult> {
  const deps = options.deps ?? defaultCalendarDeps;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 250));
  const failedCalendars: string[] = [];

  const results = await Promise.all(PROVIDERS.map(async (spec) => {
    const token = await deps.getToken(userId, spec.provider).catch(() => null);
    if (!token) return { events: [] as CalendarEvent[], provider: null, failed: false, truncated: false };
    // Each further account's calendars are read with that account's own token.
    const tokens = new Map<string, Promise<string | null>>();
    const tokenFor = (account?: string) => {
      if (!account) return Promise.resolve(token);
      if (!tokens.has(account)) tokens.set(account, deps.getToken(userId, spec.provider, account).catch(() => null));
      return tokens.get(account)!;
    };
    const read = async (calendar?: CalendarSource) => {
      const own = await tokenFor(calendar?.account);
      if (!own) throw new Error('account not connected');
      // Page by page, up to MAX_EVENTS_PER_CALENDAR; past that the result says it is incomplete.
      const first = spec.url(options.from, options.to, limit, calendar?.id);
      const parsed: CalendarEvent[] = [];
      let url: string | null = first;
      let truncated = false;
      while (url) {
        const response = await deps.fetchJson(url, spec.headers(own));
        parsed.push(...spec.parse(response));
        const following = spec.next(response, first);
        const rawMore = !!(response as { nextPageToken?: unknown; '@odata.nextLink'?: unknown })?.nextPageToken || !!(response as { '@odata.nextLink'?: unknown })?.['@odata.nextLink'];
        if (!options.allPages) { truncated = parsed.length >= limit || rawMore; break; }
        if (!following) { truncated = rawMore; break; }
        if (parsed.length >= MAX_EVENTS_PER_CALENDAR) { truncated = true; break; }
        url = following;
      }
      return {
        truncated,
        events: calendar
          ? parsed.map((e) => ({ ...e, ...(calendar.account ? { account: calendar.account } : {}), calendarId: calendar.id, calendarName: calendar.name, ...(calendar.color ? { color: calendar.color } : {}), ...(calendar.readOnly ? { readOnly: true } : {}) }))
          : parsed,
      };
    };
    if (!options.calendars) {
      try {
        return { ...(await read()), provider: spec.provider, failed: false };
      } catch (err) {
        coreLogger.warn(
          { err: (err as Error).message, userId, provider: spec.provider },
          'calendar: could not list events for provider',
        );
        return { events: [] as CalendarEvent[], provider: spec.provider, failed: true, truncated: false };
      }
    }
    const pages = await mapLimit(options.calendars.filter((c) => c.provider === spec.provider), 4, async (calendar) => {
      try {
        return await read(calendar);
      } catch (err) {
        // No calendar name in the log: it is often a person's name.
        coreLogger.warn({ err: (err as Error).message, userId, provider: spec.provider }, 'calendar: could not list events for one calendar');
        failedCalendars.push(calendar.name);
        return null;
      }
    });
    return {
      events: pages.flatMap((p) => p?.events ?? []),
      provider: spec.provider,
      failed: pages.some((p) => p === null),
      truncated: pages.some((p) => p?.truncated),
    };
  }));

  return {
    events: results.flatMap((r) => r.events).sort((a, b) => a.start.localeCompare(b.start)),
    // With named calendars a provider still counts as answering when only one of its calendars failed.
    providers: results.filter((r) => r.provider && (options.calendars ? true : !r.failed)).map((r) => r.provider as CalendarProvider),
    partial: results.some((r) => r.failed),
    ...(results.some(r => r.truncated) ? { truncated: true } : {}),
    ...(failedCalendars.length ? { failedCalendars } : {}),
  };
}
