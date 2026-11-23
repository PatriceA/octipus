/**
 * The post-task "distil this into a skill?" offer (docs/SESSION-LEARNING.md,
 * "Offer to distil a finished task"): the session's open offer, the owner's
 * decision on it, and the owner's switch for the offers.
 *
 * Only the session's owner, in their own chat: an admin may read another
 * user's chat but not decide for them, and nothing here acts while an admin
 * acts as the user. A space or room session never carries an offer.
 */
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { DistillNudgeError, openDistillNudge, resolveDistillNudge } from '@/core/learning/distill-nudge-service';
import { canActInSession } from '@/core/rooms/access';
import { auditRepository } from '@/db/repositories/audit-repository';
import { contentRepos } from '@/db/repositories/content';
import { userRepository } from '@/db/repositories/user-repository';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { DISTILL_NUDGE_DECISIONS } from '@/shared/distill-nudge';
import { coreLogger } from '@/utils/logger';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const STATUS: Record<DistillNudgeError['code'], number> = { not_found: 404, decided: 409, lapsed: 409, refused: 403, failed: 502 };

export const distillNudgeRoutes = new Elysia()
  .use(apiContext)
  .get('/sessions/:id/distill-nudge', async ({ user, principal, params, set }) => {
    set.headers['cache-control'] = 'no-store';
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const session = await contentRepos(principal).sessions.findById(params.id);
    if (!session) { set.status = 404; return { error: 'Session not found' }; }
    // Another user's chat (an admin reading it) shows no offer. `learning`: the
    // session's owner only, and refused in a room whoever asks.
    if (principal.actorUserId || !(await canActInSession(session, principal.userId, 'learning'))) return { nudge: null };
    return { nudge: await openDistillNudge(session.id, principal.userId) };
  }, { params: t.Object({ id: t.String({ pattern: UUID }) }) })
  .post('/sessions/:id/distill-nudge/:messageId', async ({ user, principal, params, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    if (!requireScope(principal, API_SCOPES.CHAT)) { set.status = 403; return { error: 'Chat scope required' }; }
    if (principal.actorUserId) { set.status = 403; return { error: 'Not available while acting as another user.' }; }
    const session = await contentRepos(principal).sessions.findById(params.id);
    if (!session || !(await canActInSession(session, principal.userId, 'learning'))) {
      set.status = 404; return { error: 'Session not found' };
    }
    try {
      return await resolveDistillNudge(session.id, params.messageId, principal.userId, body.decision);
    } catch (err) {
      if (!(err instanceof DistillNudgeError)) throw err;
      if (err.code === 'failed') coreLogger.warn({ sessionId: session.id, messageId: params.messageId, reason: err.message }, 'Distil offer: accept failed');
      set.status = STATUS[err.code];
      return { error: err.message, code: err.code, ...(err.final ? { final: true } : {}) };
    }
  }, {
    params: t.Object({ id: t.String({ pattern: UUID }), messageId: t.String({ pattern: UUID }) }),
    body: t.Object({ decision: t.Union(DISTILL_NUDGE_DECISIONS.map((d) => t.Literal(d))) }),
  })
  .put('/auth/distill-nudge', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    if (principal.actorUserId) { set.status = 403; return { error: 'Not available while acting as another user.' }; }
    const updated = await userRepository.setDistillNudge(principal.userId, body.enabled);
    if (!updated) { set.status = 404; return { error: 'Account not found' }; }
    await auditRepository.log({ userId: principal.userId, action: 'settings_changed', resourceType: 'user', resourceId: principal.userId,
      details: { setting: 'preferences.distillNudge', enabled: body.enabled } })
      .catch(error => coreLogger.error({ error, userId: principal.userId }, 'Distil offer preference saved but audit write failed'));
    return { distillNudge: updated.preferences?.distillNudge !== false };
  }, { body: t.Object({ enabled: t.Boolean() }) });
