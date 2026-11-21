import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { calendarView, microsoftSharedAccess, setCalendarPreferences, validateCalendarPreferences } from '@/core/calendar/calendars';
import { listCalendarEvents } from '@/core/calendar/events';
import { CalendarInputError, calendarEventAttendees, calendarEventDetails, deleteCalendarEvent, queryFreeBusy, respondToCalendarEvent, writeCalendarEvent } from '@/core/calendar/manage';
import { validateRecurrence, validReminder } from '@/core/calendar/recurrence';
import { isAuthenticated, type Principal } from '@/security/principal';

const provider = t.Union([t.Literal('google'), t.Literal('microsoft')]);
/** Which calendar of the account. Absent: its default calendar. */
const calendarId = t.Optional(t.String({ minLength: 1, maxLength: 1024 }));
/** The caller has been told the event's guests are notified, and agreed. */
const notifyAttendees = t.Optional(t.Boolean());
/** For an occurrence of a repeating event: that one, or every event of the series. */
const scope = t.Optional(t.Union([t.Literal('this'), t.Literal('all')]));
const body = t.Object({
  provider, calendarId, confirm: t.Boolean(), title: t.String({ minLength: 1, maxLength: 500 }),
  start: t.String({ maxLength: 40 }), end: t.String({ maxLength: 40 }), allDay: t.Boolean(),
  location: t.Optional(t.String({ maxLength: 2000 })), description: t.Optional(t.String({ maxLength: 20000 })),
  /** On create: who is invited. On an edit: the complete new guest list; absent leaves it alone. */
  attendees: t.Optional(t.Array(t.String({ minLength: 3, maxLength: 320 }), { maxItems: 100 })),
  /** Minutes before the start; null: no reminder; absent: unchanged. */
  reminderMinutes: t.Optional(t.Union([t.Integer({ minimum: 0, maximum: 40320 }), t.Null()])),
  recurrence: t.Optional(t.Unknown()),
  timeZone: t.Optional(t.String({ maxLength: 64 })),
  scope,
  notifyAttendees,
});
const eventId = t.Object({ id: t.String({ minLength: 1, maxLength: 2048 }) });
type Reply = { status?: number | string };

function allowed(principal: Principal, set: Reply) {
  if (!isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
  if (principal.workspaceKind === 'shared') { set.status = 403; return { error: 'Switch to your personal workspace to access your connected calendars.' }; }
  return null;
}

/**
 * A write names a calendar the caller has and may write to. The default
 * calendar (no id) is always the caller's own.
 */
async function calendarRefusal(userId: string, target: { provider: 'google' | 'microsoft'; calendarId?: string }, set: Reply) {
  if (!target.calendarId) return null;
  const find = async (fresh: boolean) => (await calendarView(userId, { fresh })).calendars.find((c) => c.provider === target.provider && c.id === target.calendarId);
  // A calendar shared a moment ago is not in a kept list yet.
  const calendar = (await find(false)) ?? (await find(true));
  if (!calendar) { set.status = 404; return { error: 'This calendar is not one of your connected calendars.' }; }
  if (calendar.readOnly) { set.status = 403; return { error: `"${calendar.name}" is read-only: you can see its events but not change them.`, readOnly: true }; }
  return null;
}

/**
 * Changing or deleting an event with guests reaches them. The caller says it
 * knows (`notifyAttendees`), or is told how many people that is.
 */
async function attendeeRefusal(userId: string, target: { provider: 'google' | 'microsoft'; calendarId?: string; notifyAttendees?: boolean }, id: string, set: Reply) {
  if (target.notifyAttendees === true) return null;
  const attendees = await calendarEventAttendees(userId, target.provider, id, target.calendarId);
  if (attendees === 0) return null;
  set.status = 409;
  return { error: `This event has ${attendees} ${attendees === 1 ? 'guest' : 'guests'}, who will be notified of the change.`, requiresAttendeeConfirmation: true, attendees };
}

/** The write as the core takes it: the repeat rule and reminder checked here, at the boundary. */
function writeOf(raw: typeof body.static, set: Reply): { error: string } | Parameters<typeof writeCalendarEvent>[2] {
  const { provider: _p, calendarId: _c, confirm: _x, notifyAttendees: _n, scope: _s, recurrence, reminderMinutes, ...rest } = raw;
  if (reminderMinutes !== undefined && !validReminder(reminderMinutes)) { set.status = 400; return { error: 'reminderMinutes is a whole number of minutes, or null' }; }
  if (recurrence === undefined || recurrence === null) return { ...rest, ...(reminderMinutes !== undefined ? { reminderMinutes } : {}) };
  const rule = validateRecurrence(recurrence);
  if (typeof rule === 'string') { set.status = 400; return { error: rule }; }
  return { ...rest, ...(reminderMinutes !== undefined ? { reminderMinutes } : {}), recurrence: rule };
}

function failure(error: unknown, set: Reply) {
  set.status = error instanceof CalendarInputError ? 400 : 502;
  return { error: error instanceof Error ? error.message : 'Calendar change failed' };
}

export const calendarRoutes = new Elysia({ prefix: '/calendar' }).use(apiContext)
  // The caller's calendars (own and shared with them) and which of them the page shows.
  .get('/calendars', async ({ principal, query, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    const [view, sharedAccess] = await Promise.all([calendarView(principal.userId, { fresh: query.fresh === 'true' }), microsoftSharedAccess(principal.userId)]);
    return { ...view, microsoftSharedAccess: sharedAccess };
  }, { query: t.Object({ fresh: t.Optional(t.String({ maxLength: 5 })) }) })
  // `visible`: the calendar keys ("google:<id>") to show; `hideDeclined`. Only the given fields change.
  .put('/preferences', async ({ principal, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    const clean = validateCalendarPreferences(body);
    if (typeof clean === 'string') { set.status = 400; return { error: clean }; }
    return { preferences: await setCalendarPreferences(principal.userId, clean) };
  }, { body: t.Object({ visible: t.Optional(t.Array(t.String({ maxLength: 600 }), { maxItems: 200 })), hideDeclined: t.Optional(t.Boolean()) }) })
  .get('/events', async ({ principal, query, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    const from = new Date(query.from), to = new Date(query.to);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from || +to - +from > 93 * 86400000) { set.status = 400; return { error: 'Choose a valid calendar range of at most 93 days.' }; }
    const view = await calendarView(principal.userId);
    const listed = await listCalendarEvents(principal.userId, { from, to, limit: 250, allPages: true, calendars: view.calendars.filter((c) => c.visible) });
    // A provider whose calendar list could not be read shows nothing: say so.
    return { ...listed, partial: listed.partial || view.partial };
  }, { query: t.Object({ from: t.String({ maxLength: 40 }), to: t.String({ maxLength: 40 }) }) })
  .post('/events', async ({ principal, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try {
      const denied = await calendarRefusal(principal.userId, body, set); if (denied) return denied;
      const input = writeOf(body, set); if ('error' in input) return input;
      const { id } = await writeCalendarEvent(principal.userId, body.provider, input, undefined, { calendarId: body.calendarId });
      return { success: true, id };
    } catch (error) { return failure(error, set); }
  }, { body })
  .patch('/events/:id', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try {
      const denied = (await calendarRefusal(principal.userId, body, set)) ?? (await attendeeRefusal(principal.userId, body, params.id, set)); if (denied) return denied;
      const input = writeOf(body, set); if ('error' in input) return input;
      const { id } = await writeCalendarEvent(principal.userId, body.provider, input, params.id, { calendarId: body.calendarId, notify: body.notifyAttendees === true, ...(body.scope ? { scope: body.scope } : {}) });
      return { success: true, id };
    } catch (error) { return failure(error, set); }
  }, { body, params: eventId })
  // For a repeating event: the one occurrence the id names, or with `scope: 'all'` the whole series.
  .delete('/events/:id', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the deletion first.' }; }
    try {
      const denied = (await calendarRefusal(principal.userId, body, set)) ?? (await attendeeRefusal(principal.userId, body, params.id, set)); if (denied) return denied;
      await deleteCalendarEvent(principal.userId, body.provider, params.id, { calendarId: body.calendarId, notify: body.notifyAttendees === true, ...(body.scope ? { scope: body.scope } : {}) });
      return { success: true };
    } catch (error) { return failure(error, set); }
  }, { body: t.Object({ provider, calendarId, confirm: t.Boolean(), notifyAttendees, scope }), params: eventId })
  // What the edit dialog needs that the event list shortens or leaves out.
  .get('/events/:id/details', async ({ principal, params, query, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    try {
      return await calendarEventDetails(principal.userId, query.provider, params.id, query.calendarId);
    } catch (error) { return failure(error, set); }
  }, { query: t.Object({ provider, calendarId }), params: eventId })
  // When guests are busy, and the reader's own busy time, for finding a slot.
  .post('/freebusy', async ({ principal, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    const from = new Date(body.from), to = new Date(body.to);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from || +to - +from > 8 * 86400000) { set.status = 400; return { error: 'Choose a free/busy range of at most 8 days.' }; }
    try {
      const view = await calendarView(principal.userId);
      const [guests, mine] = await Promise.all([
        queryFreeBusy(principal.userId, body.provider, body.attendees, from, to),
        listCalendarEvents(principal.userId, { from, to, limit: 250, allPages: true, calendars: view.calendars.filter((c) => c.visible) }),
      ]);
      // Free time, declined invitations and all-day notes do not block a slot.
      const own = mine.events.filter((e) => !e.allDay && e.end && e.showAs !== 'free' && e.responseStatus !== 'declined').map((e) => ({ start: e.start, end: e.end! }));
      return { ...guests, own, ownPartial: mine.partial || view.partial };
    } catch (error) { return failure(error, set); }
  }, { body: t.Object({ provider, attendees: t.Array(t.String({ minLength: 3, maxLength: 320 }), { maxItems: 20 }), from: t.String({ maxLength: 40 }), to: t.String({ maxLength: 40 }) }) })
  // The caller's own answer to an invitation; the organiser is told.
  .post('/events/:id/respond', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    try {
      await respondToCalendarEvent(principal.userId, body.provider, params.id, body.response, { calendarId: body.calendarId });
      return { success: true };
    } catch (error) { return failure(error, set); }
  }, { body: t.Object({ provider, calendarId, response: t.Union([t.Literal('accepted'), t.Literal('tentative'), t.Literal('declined')]) }), params: eventId });
