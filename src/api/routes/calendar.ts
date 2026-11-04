import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { listCalendarEvents } from '@/core/calendar/events';
import { CalendarInputError, writeCalendarEvent } from '@/core/calendar/manage';
import { isAuthenticated, type Principal } from '@/security/principal';

const provider = t.Union([t.Literal('google'), t.Literal('microsoft')]);
const body = t.Object({
  provider, confirm: t.Boolean(), title: t.String({ minLength: 1, maxLength: 500 }),
  start: t.String({ maxLength: 40 }), end: t.String({ maxLength: 40 }), allDay: t.Boolean(),
  location: t.Optional(t.String({ maxLength: 2000 })), description: t.Optional(t.String({ maxLength: 20000 })),
});
function allowed(principal: Principal, set: { status?: number | string }) {
  if (!isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
  if (principal.workspaceKind === 'shared') { set.status = 403; return { error: 'Switch to your personal workspace to access your connected calendars.' }; }
  return null;
}
export const calendarRoutes = new Elysia({ prefix: '/calendar' }).use(apiContext)
  .get('/events', async ({ principal, query, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    const from = new Date(query.from), to = new Date(query.to);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from || +to - +from > 93 * 86400000) { set.status = 400; return { error: 'Choose a valid calendar range of at most 93 days.' }; }
    return listCalendarEvents(principal.userId, { from, to, limit: 250 });
  }, { query: t.Object({ from: t.String({ maxLength: 40 }), to: t.String({ maxLength: 40 }) }) })
  .post('/events', async ({ principal, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try { await writeCalendarEvent(principal.userId, body.provider, body); return { success: true }; }
    catch (error) { set.status = error instanceof CalendarInputError ? 400 : 502; return { error: error instanceof Error ? error.message : 'Calendar change failed' }; }
  }, { body })
  .patch('/events/:id', async ({ principal, params, body, set }) => {
    const refusal = allowed(principal, set); if (refusal) return refusal;
    if (!body.confirm) { set.status = 409; return { error: 'Confirm the event change before saving.' }; }
    try { await writeCalendarEvent(principal.userId, body.provider, body, params.id); return { success: true }; }
    catch (error) { set.status = error instanceof CalendarInputError ? 400 : 502; return { error: error instanceof Error ? error.message : 'Calendar change failed' }; }
  }, { body, params: t.Object({ id: t.String({ minLength: 1, maxLength: 2048 }) }) });
