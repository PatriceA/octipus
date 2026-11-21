import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { calendarView, microsoftSharedAccess, setCalendarPreferences, validateCalendarPreferences } from '@/core/calendar/calendars';
import { listCalendarEvents } from '@/core/calendar/events';
import { CalendarInputError, calendarEventAttendees, deleteCalendarEvent, respondToCalendarEvent, writeCalendarEvent } from '@/core/calendar/manage';
import { getOAuthManager, normalizeAccount } from '@/security/oauth';
import { isAuthenticated, type Principal } from '@/security/principal';

const provider = t.Union([t.Literal('google'), t.Literal('microsoft')]);
/** Which calendar of the account. Absent: its default calendar. */
const calendarId = t.Optional(t.String({ minLength: 1, maxLength: 1024 }));
/** Which connected account of the provider (its address). Absent: the default account. */
const account = t.Optional(t.String({ minLength: 3, maxLength: 320 }));
/** The caller has been told the event's guests are notified, and agreed. */
const notifyAttendees = t.Optional(t.Boolean());
const body = t.Object({
  provider, account, calendarId, confirm: t.Boolean(), title: t.String({ minLength: 1, maxLength: 500 }),
  start: t.String({ maxLength: 40 }), end: t.String({ maxLength: 40 }), allDay: t.Boolean(),
  location: t.Optional(t.String({ maxLength: 2000 })), description: t.Optional(t.String({ maxLength: 20000 })),
  attendees: t.Optional(t.Array(t.String({ minLength: 3, maxLength: 320 }), { maxItems: 100 })),
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
 * calendar (no id) is always the caller's own; an `account` must be one of
 * the caller's own connected accounts.
 */
async function calendarRefusal(userId: string, target: { provider: 'google' | 'microsoft'; calendarId?: string; account?: string }, set: Reply) {
  const wanted = target.account ? normalizeAccount(target.account) : undefined;
  if (wanted === null) { set.status = 400; return { error: 'account must be an email address.' }; }
  if (wanted) {
    const role = await getOAuthManager().accountRole(userId, target.provider, wanted);
    if (!role) { set.status = 404; return { error: `${wanted} is not one of your connected accounts.` }; }
    // The default account named explicitly is the default account.
    if (role === 'default') target.account = undefined; else target.account = wanted;
  }
  if (!target.calendarId) return null;
  const find = async (fresh: boolean) => (await calendarView(userId, { fresh })).calendars.find((c) => c.provider === target.provider && c.id === target.calendarId && (c.account ?? undefined) === target.account);
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
async function attendeeRefusal(userId: string, target: { provider: 'google' | 'microsoft'; calendarId?: string; account?: string; notifyAttendees?: boolean }, id: string, set: Reply) {
  if (target.notifyAttendees === true) return null;
  const attendees = await calendarEventAttendees(userId, target.provider, id, target.calendarId, target.account);
  if (attendees === 0) return null;
  set.status = 409;
  return { error: `This event has ${attendees} ${attendees === 1 ? 'guest' : 'guests'}, who will be notified of the change.`, requiresAttendeeConfirmation: true, attendees };
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
    const listed = await listCalendarEvents(principal.userId, { from, to, limit: 250, calendars: view.calendars.filter((c) => c.visible) });
    // A provider whose calendar list could not be read shows nothing: say so.
    return { ...listed, partial: listed.partial || view.partial };
  }, { query: t.Object({ from: t.String({ maxLength: 40 }), to: t.String({ maxLength: 40 }) }) })
  .post('/events', async ({ principal, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try {
      const denied = await calendarRefusal(principal.userId, body, set); if (denied) return denied;
      const { id } = await writeCalendarEvent(principal.userId, body.provider, body, undefined, { calendarId: body.calendarId, account: body.account });
      return { success: true, id };
    } catch (error) { return failure(error, set); }
  }, { body })
  .patch('/events/:id', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try {
      const denied = (await calendarRefusal(principal.userId, body, set)) ?? (await attendeeRefusal(principal.userId, body, params.id, set)); if (denied) return denied;
      await writeCalendarEvent(principal.userId, body.provider, body, params.id, { calendarId: body.calendarId, account: body.account, notify: body.notifyAttendees === true });
      return { success: true };
    } catch (error) { return failure(error, set); }
  }, { body, params: eventId })
  // For a repeating event this removes the one occurrence the id names.
  .delete('/events/:id', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the deletion first.' }; }
    try {
      const denied = (await calendarRefusal(principal.userId, body, set)) ?? (await attendeeRefusal(principal.userId, body, params.id, set)); if (denied) return denied;
      await deleteCalendarEvent(principal.userId, body.provider, params.id, { calendarId: body.calendarId, account: body.account, notify: body.notifyAttendees === true });
      return { success: true };
    } catch (error) { return failure(error, set); }
  }, { body: t.Object({ provider, account, calendarId, confirm: t.Boolean(), notifyAttendees }), params: eventId })
  // The caller's own answer to an invitation; the organiser is told.
  .post('/events/:id/respond', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    try {
      // The account is checked; a read-only calendar may still be answered on, so no calendar is named here.
      const target = { provider: body.provider, account: body.account };
      const denied = await calendarRefusal(principal.userId, target, set); if (denied) return denied;
      await respondToCalendarEvent(principal.userId, body.provider, params.id, body.response, { calendarId: body.calendarId, account: target.account });
      return { success: true };
    } catch (error) { return failure(error, set); }
  }, { body: t.Object({ provider, account, calendarId, response: t.Union([t.Literal('accepted'), t.Literal('tentative'), t.Literal('declined')]) }), params: eventId });
