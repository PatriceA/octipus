import { activateHeartbeatService } from '@/api/heartbeat-settings';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { detectProvider } from '@/core/email/providers';
import { recentEmailOutcomes } from '@/core/email/watch';
import { findStandingNote, getHeartbeatPrefs, setHeartbeatPrefs } from '@/core/heartbeat';
import { API_SCOPES } from '@/security/scopes';
import { isAuthenticated, requireScope } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

/**
 * The caller's own heartbeat (docs/HEARTBEAT.md): on or off, how often it
 * checks, whether it watches their inbox, and what agents recently did with
 * their mail. The server-wide settings (`heartbeat.*`, admin) come along
 * read-only so the card can say why nothing runs.
 */
export const heartbeatRoutes = new Elysia({ prefix: '/heartbeat' })
  .use(apiContext)

  .get('/me', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const server = getConfig().heartbeat;
    const [prefs, mailbox, outcomes, standing] = await Promise.all([
      getHeartbeatPrefs(user.id),
      detectProvider(user.id).catch(() => null),
      recentEmailOutcomes(user.id, 10),
      findStandingNote(user.id).then((note) => Boolean(note?.body?.trim())).catch(() => false),
    ]);
    return {
      ...prefs,
      server: {
        enabled: server.enabled,
        intervalMinutes: server.intervalMinutes,
        quietHoursStart: server.quietHoursStart,
        quietHoursEnd: server.quietHoursEnd,
        quietHoursTimezone: server.quietHoursTimezone,
        maxRunsPerDay: server.maxRunsPerDay,
        probeEmail: server.probeEmail,
      },
      mailbox,
      standingInstructions: standing,
      recentEmail: outcomes,
    };
  }, { detail: { tags: ['heartbeat'] } })

  .put('/me', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    if (!requireScope(principal, API_SCOPES.WRITE)) { set.status = 403; return { error: 'Write scope required to change heartbeat settings' }; }
    try {
      const prefs = await setHeartbeatPrefs(user.id, body);
      if (body.enabled === true) await activateHeartbeatService(user, principal);
      return prefs;
    } catch (err) {
      if (err instanceof RangeError) { set.status = 400; return { error: err.message }; }
      apiLogger.error({ err, userId: user.id }, 'heartbeat: preferences update failed');
      set.status = 500;
      return { error: 'Could not update the heartbeat' };
    }
  }, {
    body: t.Object({
      enabled: t.Optional(t.Boolean()),
      intervalMinutes: t.Optional(t.Union([t.Number(), t.Null()])),
      watchEmail: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['heartbeat'] },
  });
