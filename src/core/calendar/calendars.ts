/**
 * The calendars of a connected account — the reader's own and the ones other
 * people shared with them — and which of them the Calendar page shows.
 *
 * Google's `calendar` scope already covers the calendar list. Microsoft lists
 * a shared calendar under `/me/calendars` too, but opening one needs the
 * `Calendars.ReadWrite.Shared` consent: an account connected before Octipus
 * asked for it keeps working for its own calendars, and a shared one that
 * cannot be opened is reported as unreadable, never as empty.
 */
import { userRepository } from '@/db/repositories/user-repository';
import { getOAuthManager } from '@/security/oauth';
import { calendarKey, type CalendarInfo, type CalendarPreferences, type CalendarProvider } from '@/shared/calendar';
import { coreLogger } from '@/utils/logger';
import { type CalendarDeps, defaultCalendarDeps } from './events';

/** A calendar as the provider lists it, with the provider's own idea of whether it is shown. */
export type ListedCalendar = Omit<CalendarInfo, 'visible'> & { defaultVisible: boolean };

const HEX = /^#[0-9a-f]{6}$/i;

interface GoogleCalendar {
  id?: string; summary?: string; summaryOverride?: string; backgroundColor?: string;
  primary?: boolean; accessRole?: string; selected?: boolean; hidden?: boolean; deleted?: boolean;
}

export function parseGoogleCalendars(response: unknown): ListedCalendar[] {
  const items = (response as { items?: GoogleCalendar[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: ListedCalendar[] = [];
  for (const item of items) {
    if (!item.id || item.deleted) continue;
    const primary = item.primary === true;
    const shared = !primary && item.accessRole !== 'owner';
    out.push({
      provider: 'google', id: item.id,
      name: (item.summaryOverride ?? item.summary)?.trim() || item.id,
      ...(item.backgroundColor && HEX.test(item.backgroundColor) ? { color: item.backgroundColor.toLowerCase() } : {}),
      primary,
      readOnly: item.accessRole === 'reader' || item.accessRole === 'freeBusyReader',
      shared,
      // A shared calendar's id is its owner's address; a group calendar's is not a person's.
      ...(shared && /^[^@\s]+@[^@\s]+$/.test(item.id) && !item.id.endsWith('.calendar.google.com') ? { owner: item.id } : {}),
      // Google keeps its own tick per calendar: start from what the reader sees there.
      defaultVisible: primary || (item.selected === true && item.hidden !== true),
    });
  }
  return out;
}

/** Outlook's named calendar colours, for calendars without a `hexColor`. */
const OUTLOOK_COLORS: Record<string, string> = {
  lightBlue: '#4a90d9', lightGreen: '#4f9d69', lightOrange: '#d98236', lightGray: '#7f8b94', lightYellow: '#b8951f',
  lightTeal: '#2f9c95', lightPink: '#d0669a', lightBrown: '#9a7355', lightRed: '#d0554f',
};

interface GraphCalendar {
  id?: string; name?: string; hexColor?: string; color?: string;
  isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { name?: string; address?: string };
}

export function parseGraphCalendars(response: unknown): ListedCalendar[] {
  const items = (response as { value?: GraphCalendar[] })?.value;
  if (!Array.isArray(items)) return [];
  // The default calendar is the reader's own: its owner is who "me" is.
  const me = items.find((c) => c.isDefaultCalendar)?.owner?.address?.toLowerCase();
  const out: ListedCalendar[] = [];
  for (const item of items) {
    if (!item.id) continue;
    const owner = item.owner?.address?.toLowerCase();
    const shared = !item.isDefaultCalendar && !!me && !!owner && owner !== me;
    const color = item.hexColor && HEX.test(item.hexColor) ? item.hexColor.toLowerCase() : OUTLOOK_COLORS[item.color ?? ''];
    out.push({
      provider: 'microsoft', id: item.id,
      name: item.name?.trim() || 'Calendar',
      ...(color ? { color } : {}),
      primary: item.isDefaultCalendar === true,
      readOnly: item.canEdit === false,
      shared,
      ...(shared ? { owner: item.owner?.name?.trim() || owner } : {}),
      // A shared one is shown once the reader ticks it: opening it may need a reconnect.
      defaultVisible: !shared,
    });
  }
  return out;
}

const SOURCES: ReadonlyArray<{ provider: CalendarProvider; url: string; parse: (response: unknown) => ListedCalendar[] }> = [
  { provider: 'google', url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', parse: parseGoogleCalendars },
  { provider: 'microsoft', url: 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=100', parse: parseGraphCalendars },
];

export interface CalendarsResult {
  calendars: ListedCalendar[];
  /** Providers whose calendar list was read. */
  providers: CalendarProvider[];
  /** A connected provider's list could not be read. */
  partial: boolean;
}

/** Every calendar of the connected accounts, each account's default first. */
export async function listCalendars(userId: string, deps: CalendarDeps = defaultCalendarDeps): Promise<CalendarsResult> {
  const results = await Promise.all(SOURCES.map(async (source) => {
    const token = await deps.getToken(userId, source.provider).catch(() => null);
    if (!token) return null;
    try {
      const calendars = source.parse(await deps.fetchJson(source.url, { Authorization: `Bearer ${token}` }));
      return { provider: source.provider, failed: false, calendars: calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || Number(a.shared) - Number(b.shared) || a.name.localeCompare(b.name)) };
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, userId, provider: source.provider }, 'calendar: could not list calendars for provider');
      return { provider: source.provider, failed: true, calendars: [] as ListedCalendar[] };
    }
  }));
  const connected = results.filter((r): r is NonNullable<typeof r> => r !== null);
  return {
    calendars: connected.flatMap((r) => r.calendars),
    providers: connected.filter((r) => !r.failed).map((r) => r.provider),
    partial: connected.some((r) => r.failed),
  };
}

const MAX_VISIBLE = 200;

/** Validate stored or submitted preferences at the trust boundary. Returns an error string or the clean value. */
export function validateCalendarPreferences(input: unknown): CalendarPreferences | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'preferences must be an object';
  const raw = input as Record<string, unknown>;
  const out: CalendarPreferences = {};
  if (raw.visible !== undefined) {
    if (!Array.isArray(raw.visible) || raw.visible.length > MAX_VISIBLE) return `visible is a list of at most ${MAX_VISIBLE} calendars`;
    for (const key of raw.visible) {
      if (typeof key !== 'string' || key.length > 600 || !/^(google|microsoft):.+/.test(key)) return 'each visible calendar is "google:<id>" or "microsoft:<id>"';
    }
    out.visible = [...new Set(raw.visible as string[])];
  }
  if (raw.hideDeclined !== undefined) {
    if (typeof raw.hideDeclined !== 'boolean') return 'hideDeclined is true or false';
    out.hideDeclined = raw.hideDeclined;
  }
  return out;
}

export async function getCalendarPreferences(userId: string): Promise<CalendarPreferences> {
  const stored = (await userRepository.findById(userId))?.preferences?.calendar;
  const valid = stored ? validateCalendarPreferences(stored) : {};
  return typeof valid === 'string' ? {} : valid;
}

/** Merge a change into the reader's calendar preferences. */
export async function setCalendarPreferences(userId: string, change: CalendarPreferences): Promise<CalendarPreferences> {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error('User not found');
  const current = validateCalendarPreferences(user.preferences?.calendar ?? {});
  const next = { ...(typeof current === 'string' ? {} : current), ...change };
  await userRepository.update(userId, { preferences: { ...(user.preferences ?? {}), calendar: next } });
  calendarCache.delete(userId);
  return next;
}

/** The stored choice when there is one, else what the provider shows by default. */
export function applyVisibility(calendars: ListedCalendar[], preferences: CalendarPreferences): CalendarInfo[] {
  const chosen = preferences.visible ? new Set(preferences.visible) : null;
  return calendars.map(({ defaultVisible, ...calendar }) => ({ ...calendar, visible: chosen ? chosen.has(calendarKey(calendar)) : defaultVisible }));
}

export interface CalendarView {
  calendars: CalendarInfo[];
  providers: CalendarProvider[];
  partial: boolean;
  preferences: CalendarPreferences;
}

/** The list changes rarely and every page of events needs it: kept briefly per user. */
const CACHE_MS = 2 * 60_000;
const calendarCache = new Map<string, { at: number; value: CalendarsResult }>();

/** The reader's calendars with their visibility. `fresh` asks the providers again. */
export async function calendarView(userId: string, options: { fresh?: boolean; deps?: CalendarDeps } = {}): Promise<CalendarView> {
  const cached = calendarCache.get(userId);
  let listed = !options.fresh && !options.deps && cached && Date.now() - cached.at < CACHE_MS ? cached.value : null;
  if (!listed) {
    listed = await listCalendars(userId, options.deps);
    // A failed list is not kept: the next read tries again.
    if (!options.deps && !listed.partial) calendarCache.set(userId, { at: Date.now(), value: listed });
    if (calendarCache.size > 5000) calendarCache.clear();
  }
  const preferences = await getCalendarPreferences(userId);
  return { calendars: applyVisibility(listed.calendars, preferences), providers: listed.providers, partial: listed.partial, preferences };
}

/**
 * Whether the Microsoft connection may open calendars other people shared.
 * null: Microsoft is not connected. An account connected before the consent
 * was asked for says false until it is connected again.
 */
export async function microsoftSharedAccess(userId: string): Promise<boolean | null> {
  const status = await getOAuthManager().getConnectionStatus(userId, 'microsoft').catch(() => null);
  if (!status?.connected) return null;
  return (status.scopes ?? []).some((scope) => /(^|\/)Calendars\.(Read|ReadWrite)\.Shared$/i.test(scope));
}
