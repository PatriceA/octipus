/**
 * `calendar:read` and `calendar:write` of the plugin host API
 * (docs/PLUGIN-PACKAGES.md#mail-and-calendar): the calendars the user
 * connected (Google, Microsoft 365; the Inbox module), in the personal
 * workspace only (./host-sources.ts).
 *
 * - **Protection.** Events carry no level of their own: they count as the
 *   level an admin sets (`plugins.calendarProtectionLevel`, default 3). A
 *   package reads them only if it may see that level (403
 *   `protection_level` otherwise), and what it reads raises the calling
 *   session and the package's level for this user.
 * - **Writes** put the call's content into the user's calendar at that
 *   level: a call holding data above it (what it read, or what the calling
 *   session holds) may not write there (403 `read_level`), or it would carry
 *   that data down. A package changes only the events it created
 *   (`plugin_items`); there is no delete. Events take no attendees, so a
 *   write never invites anyone.
 */
import type { CalendarEvent, CalendarProvider } from '@/shared/calendar';
import type { Principal } from '@/security/principal';
import type { HostTokenGrant } from './host-api';
import type { Outcome } from './host-mail';
import { calendarRefusal } from './host-sources';

/** The longest window one read covers (as the Calendar page). */
export const CALENDAR_MAX_DAYS = 93;
const EVENT_ID_RE = /^[A-Za-z0-9_=+/@.-]{1,1024}$/;
const PROVIDERS: readonly CalendarProvider[] = ['google', 'microsoft'];

/** The level plugin packages see the calendars at. */
export async function calendarLevel(): Promise<number> {
  const { getConfig } = await import('@/config');
  return getConfig().plugins?.calendarProtectionLevel ?? 3;
}

export interface CalendarDeps {
  list?: (userId: string, opts: { from: Date; to: Date; limit: number }) => Promise<{ events: CalendarEvent[]; providers: CalendarProvider[]; partial: boolean; truncated?: boolean }>;
  write?: (userId: string, provider: CalendarProvider, input: CalendarEventInput, id?: string) => Promise<{ id: string }>;
}

export interface CalendarEventInput {
  title: string;
  /** ISO-8601 with an offset; for an all-day event a date (YYYY-MM-DD), the end exclusive. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

/** Events between `from` and `to` (at most 93 days), across the connected calendars. */
export async function listPluginCalendar(grant: HostTokenGrant, principal: Principal, q: { from: string; to: string; limit?: number }, deps: CalendarDeps = {}): Promise<Outcome<unknown>> {
  const refused = await calendarRefusal(grant, principal, 'read', PROVIDERS);
  if (refused) return { ok: false, ...refused };
  const level = await calendarLevel();
  if (level > grant.maxProtection) {
    return { ok: false, status: 403, code: 'protection_level', error: `Calendar events are at protection level ${level}; this package may see up to ${grant.maxProtection}` };
  }
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from || +to - +from > CALENDAR_MAX_DAYS * 86_400_000) {
    return { ok: false, status: 400, code: 'invalid', error: `from and to are dates, to after from, at most ${CALENDAR_MAX_DAYS} days apart` };
  }
  const list = deps.list ?? (async (userId: string, opts: { from: Date; to: Date; limit: number }) => (await import('@/core/calendar/events')).listCalendarEvents(userId, opts));
  const result = await list(grant.userId, { from, to, limit: Math.max(1, Math.min(250, q.limit ?? 100)) });
  if (level > 1) {
    const { raiseSessionLevel } = await import('@/core/protection/session-level');
    const { noteHostRead } = await import('./host-api');
    if (grant.sessionId) raiseSessionLevel(grant.sessionId, level);
    await noteHostRead(grant, level);
  }
  return {
    ok: true,
    value: {
      events: result.events.map((e) => ({ ...e, protectionLevel: level })),
      providers: result.providers, partial: result.partial, truncated: result.truncated === true, protectionLevel: level,
    },
  };
}

/** A write's refusal for the call's level, or null. */
async function writeRefusal(grant: HostTokenGrant): Promise<{ status: number; code: string; error: string } | null> {
  const level = await calendarLevel();
  const held = grant.readLevel ?? 1;
  if (held <= level) return null;
  return {
    status: 403, code: 'read_level',
    error: `This call works at protection level ${held} (what the package has read for this user, or what the calling session holds); `
      + `calendar events are kept at level ${level}, so it may not write them`,
  };
}

/** Create an event in a connected calendar (`POST /api/plugin-host/calendar/events`). */
export async function createPluginEvent(grant: HostTokenGrant, principal: Principal, provider: CalendarProvider, input: CalendarEventInput, deps: CalendarDeps = {}): Promise<Outcome<{ id: string; provider: CalendarProvider }>> {
  const refused = (await calendarRefusal(grant, principal, 'write', [provider])) ?? (await writeRefusal(grant));
  if (refused) return { ok: false, ...refused };
  const { CalendarInputError, calendarWriteBody, writeCalendarEvent } = await import('@/core/calendar/manage');
  const write = deps.write ?? writeCalendarEvent;
  let id: string;
  try {
    // Checked before anything reaches the provider.
    calendarWriteBody(provider, input);
    ({ id } = await write(grant.userId, provider, input));
  } catch (err) {
    if (err instanceof CalendarInputError) return { ok: false, status: 400, code: 'invalid', error: err.message };
    throw err;
  }
  if (!id) return { ok: false, status: 502, code: 'provider_error', error: 'The calendar saved the event but named no id for it' };
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  await pluginItemsRepository.record({ plugin: grant.plugin, userId: grant.userId, kind: 'calendar_event', provider, itemId: id });
  return { ok: true, value: { id, provider } };
}

/** Change an event this package created (`PUT /api/plugin-host/calendar/events/:id`). */
export async function updatePluginEvent(grant: HostTokenGrant, principal: Principal, provider: CalendarProvider, id: string, input: CalendarEventInput, deps: CalendarDeps = {}): Promise<Outcome<{ id: string; provider: CalendarProvider }>> {
  const refused = (await calendarRefusal(grant, principal, 'write', [provider])) ?? (await writeRefusal(grant));
  if (refused) return { ok: false, ...refused };
  if (!EVENT_ID_RE.test(id)) return { ok: false, status: 404, code: 'not_found', error: 'Event not found' };
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  if (!(await pluginItemsRepository.owns({ plugin: grant.plugin, userId: grant.userId, kind: 'calendar_event', provider, itemId: id }))) {
    return { ok: false, status: 403, code: 'not_created_by_plugin', error: 'This package may change only the events it created' };
  }
  const { CalendarInputError, calendarWriteBody, writeCalendarEvent } = await import('@/core/calendar/manage');
  const write = deps.write ?? writeCalendarEvent;
  try {
    calendarWriteBody(provider, input);
    await write(grant.userId, provider, input, id);
  } catch (err) {
    if (err instanceof CalendarInputError) return { ok: false, status: 400, code: 'invalid', error: err.message };
    throw err;
  }
  return { ok: true, value: { id, provider } };
}
