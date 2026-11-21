/**
 * The two heartbeat probe sources that live outside the database: pull
 * requests of the user's whose checks are failing, and calendar events about
 * to start. Both are what a developer actually wants a nudge about, and both
 * are cheap to ask — one `gh` call, one calendar request — but not free, so
 * each is a config switch (`heartbeat.probeGithub`, `heartbeat.probeCalendar`)
 * and each fails soft: an unavailable `gh`, a missing OAuth token or a slow
 * API yields an empty list, never a failed heartbeat.
 *
 * Parsers are pure and exported so the shapes are tested without a network;
 * the runners are injectable for the same reason.
 */
import { getOAuthManager } from '@/security/oauth';
import { runGh as runGhShared } from '@/utils/gh';
import { fetchWithTimeout } from '@/utils/http';
import { coreLogger } from '@/utils/logger';

export interface FailingPullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The rollup state that made it failing (`FAILURE` | `ERROR`) — part of its "seen" identity. */
  state: string;
}

export interface UpcomingEvent {
  title: string;
  /** ISO instant. */
  start: string;
  end?: string;
  provider: 'google' | 'microsoft';
}

// ── GitHub: open PRs by me whose last commit's checks failed ────────────────

/**
 * One search across every repo the token can see. `gh pr list` is repo-bound,
 * so the search API is the only cross-repo answer, and only GraphQL exposes the
 * status rollup on the search result.
 */
export const FAILING_PR_QUERY = `query {
  search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 30) {
    nodes {
      ... on PullRequest {
        number title url isDraft
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const FAILING_STATES = new Set(['FAILURE', 'ERROR']);

/** Pure: the GraphQL response → the PRs whose latest checks are red. */
export function parseFailingPullRequests(response: unknown): FailingPullRequest[] {
  const nodes = (response as { data?: { search?: { nodes?: unknown[] } } })?.data?.search?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: FailingPullRequest[] = [];
  for (const n of nodes) {
    const pr = n as {
      number?: number; title?: string; url?: string; isDraft?: boolean;
      repository?: { nameWithOwner?: string };
      commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> };
    };
    if (typeof pr?.number !== 'number' || typeof pr.url !== 'string') continue;
    // A draft with red checks is work in progress, not a failure to act on.
    if (pr.isDraft) continue;
    const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    if (!state || !FAILING_STATES.has(state)) continue;
    out.push({ repo: pr.repository?.nameWithOwner ?? '', number: pr.number, title: pr.title ?? '', url: pr.url, state });
  }
  return out;
}

const GH_TIMEOUT_MS = 10_000;

/** The shared runner with the probe's timeout: a background tick cannot wait on a hung `gh`. */
export function runGh(args: string[], signal?: AbortSignal): Promise<string> {
  return runGhShared(args, { timeoutMs: GH_TIMEOUT_MS, signal });
}

export interface GithubProbeDeps {
  runGh: (args: string[], signal?: AbortSignal) => Promise<string>;
}

/**
 * Open PRs by the token's user with failing checks. `null` means the source
 * could not be read (gh absent, timed out, bad JSON) — which is not the same
 * as "nothing is red", and the caller keeps what it already knew instead of
 * treating every PR as cleared.
 */
export async function probeFailingPullRequests(deps: GithubProbeDeps = { runGh }, signal?: AbortSignal): Promise<FailingPullRequest[] | null> {
  try {
    const raw = await deps.runGh(['api', 'graphql', '-f', `query=${FAILING_PR_QUERY}`], signal);
    return parseFailingPullRequests(JSON.parse(raw));
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message }, 'heartbeat: github probe unavailable (skipping)');
    return null;
  }
}

// ── Calendar: events starting within the lookahead window ───────────────────

function withinWindow(startIso: string | undefined, now: Date, until: Date): boolean {
  if (!startIso) return false;
  const t = new Date(startIso).getTime();
  return Number.isFinite(t) && t >= now.getTime() && t <= until.getTime();
}

/** Pure: a Google Calendar `events.list` response → timed events starting in [now, until]. */
export function parseGoogleEvents(response: unknown, now: Date, until: Date): UpcomingEvent[] {
  const items = (response as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: UpcomingEvent[] = [];
  for (const it of items) {
    const ev = it as { summary?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string } };
    if (ev?.status === 'cancelled') continue;
    // All-day events carry `date`, not `dateTime`; they do not "start within the hour".
    if (!ev.start?.dateTime || !withinWindow(ev.start.dateTime, now, until)) continue;
    out.push({ title: ev.summary?.trim() || '(untitled)', start: new Date(ev.start.dateTime).toISOString(), end: ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : undefined, provider: 'google' });
  }
  return out;
}

/**
 * Graph returns `dateTime` without an offset, in the zone it names; we ask for
 * UTC (`Prefer: outlook.timezone="UTC"`). A zone-less value in any OTHER zone
 * cannot be placed on the timeline without a zone database, so it is skipped
 * rather than read as server-local time and reported at the wrong hour.
 */
function graphInstant(v: { dateTime?: string; timeZone?: string } | undefined): string | undefined {
  if (!v?.dateTime) return undefined;
  const base = v.dateTime.replace(/(\.\d{3})\d*$/, '$1');
  const hasZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(base);
  if (hasZone) return base;
  if (v.timeZone && v.timeZone !== 'UTC') return undefined;
  return `${base}Z`;
}

/** Pure: a Graph `calendarView` response → timed events starting in [now, until]. */
export function parseGraphEvents(response: unknown, now: Date, until: Date): UpcomingEvent[] {
  const value = (response as { value?: unknown[] })?.value;
  if (!Array.isArray(value)) return [];
  const out: UpcomingEvent[] = [];
  for (const it of value) {
    const ev = it as { subject?: string; isAllDay?: boolean; isCancelled?: boolean; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string } };
    if (ev?.isCancelled || ev?.isAllDay) continue;
    const start = graphInstant(ev.start);
    if (!withinWindow(start, now, until)) continue;
    const end = graphInstant(ev.end);
    out.push({ title: ev.subject?.trim() || '(untitled)', start: new Date(start!).toISOString(), end: end ? new Date(end).toISOString() : undefined, provider: 'microsoft' });
  }
  return out;
}

export interface CalendarProbeDeps {
  getToken: (userId: string, provider: 'google' | 'microsoft') => Promise<string | null>;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  /**
   * The calendars the user chose to see on the Calendar page (`provider:id`
   * keys), or undefined when they never chose: then each account's default
   * calendar is read, as before.
   */
  visibleCalendars?: (userId: string) => Promise<string[] | undefined>;
}

/** The calendar ids of one provider to read: `[undefined]` is the account's default calendar. Pure. */
export function calendarsToProbe(provider: 'google' | 'microsoft', visible: string[] | undefined): Array<string | undefined> {
  if (!visible) return [undefined];
  return visible.filter((key) => key.startsWith(`${provider}:`)).map((key) => key.slice(provider.length + 1)).filter(Boolean).slice(0, 25);
}

const CALENDAR_TIMEOUT_MS = 8_000;

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithTimeout(url, { method: 'GET', headers, timeoutMs: CALENDAR_TIMEOUT_MS });
  if (!res.ok) throw new Error(`calendar API ${res.status}`);
  return res.json();
}

export const defaultCalendarDeps: CalendarProbeDeps = {
  getToken: (userId, provider) => getOAuthManager().getValidToken(userId, provider),
  fetchJson: defaultFetchJson,
  visibleCalendars: async (userId) => (await (await import('@/core/calendar/calendars')).getCalendarPreferences(userId)).visible,
};

export interface UpcomingEventsProbe {
  events: UpcomingEvent[];
  /** True when a connected provider could not be read: the list is a lower bound, not the truth. */
  partial: boolean;
}

interface CalendarProvider {
  provider: UpcomingEvent['provider'];
  /** `calendarId` absent: the account's default calendar. */
  url: (now: Date, until: Date, calendarId?: string) => string;
  headers: (token: string) => Record<string, string>;
  parse: (response: unknown, now: Date, until: Date) => UpcomingEvent[];
}

const CALENDAR_PROVIDERS: readonly CalendarProvider[] = [
  {
    provider: 'google',
    url: (now, until, calendarId) =>
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(until.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=20`,
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    parse: parseGoogleEvents,
  },
  {
    provider: 'microsoft',
    url: (now, until, calendarId) =>
      `https://graph.microsoft.com/v1.0/me/${calendarId ? `calendars/${encodeURIComponent(calendarId)}/` : ''}calendarView?startDateTime=${encodeURIComponent(now.toISOString())}&endDateTime=${encodeURIComponent(until.toISOString())}&$select=subject,start,end,isAllDay,isCancelled&$orderby=start/dateTime&$top=20`,
    headers: (token) => ({ Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' }),
    parse: parseGraphEvents,
  },
];

/**
 * Events starting within `lookaheadMinutes` on whichever calendars the user
 * connected (Google, Microsoft, or both). A provider that is not connected
 * costs one vault read; one that errors costs a debug line and marks the
 * result partial so the caller does not mistake "could not read" for "no
 * events".
 */
export async function probeUpcomingEvents(
  userId: string,
  now: Date,
  lookaheadMinutes: number,
  deps: CalendarProbeDeps = defaultCalendarDeps,
): Promise<UpcomingEventsProbe> {
  const until = new Date(now.getTime() + lookaheadMinutes * 60_000);
  // The calendars the user shows on the Calendar page; a failed read falls back to the defaults.
  const visible = await deps.visibleCalendars?.(userId).catch(() => undefined);
  const results = await Promise.all(
    CALENDAR_PROVIDERS.map(async (cal): Promise<{ events: UpcomingEvent[]; failed: boolean }> => {
      const ids = calendarsToProbe(cal.provider, visible);
      if (!ids.length) return { events: [], failed: false };
      const token = await deps.getToken(userId, cal.provider).catch(() => null);
      if (!token) return { events: [], failed: false };
      const read = await Promise.all(ids.map(async (calendarId) => {
        try {
          return { events: cal.parse(await deps.fetchJson(cal.url(now, until, calendarId), cal.headers(token)), now, until), failed: false };
        } catch (err) {
          coreLogger.debug({ err: (err as Error).message, userId, provider: cal.provider }, 'heartbeat: calendar probe failed (skipping calendar)');
          return { events: [] as UpcomingEvent[], failed: true };
        }
      }));
      return { events: read.flatMap((r) => r.events), failed: read.some((r) => r.failed) };
    }),
  );
  return {
    events: results.flatMap((r) => r.events).sort((a, b) => a.start.localeCompare(b.start)),
    partial: results.some((r) => r.failed),
  };
}
