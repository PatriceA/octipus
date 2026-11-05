import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionSettings } from '@/db/schema/companion-supervision';
import { sessions } from '@/db/schema/sessions';

/** Called only after an existing command/API/gateway stop authorized its actor. */
export async function recordCompanionOwnerStop(sessionId: string, actorUserId: string) {
  await getDb().transaction(async tx => {
    await tx.update(companionSettings).set({ enabled: false, approvedAt: null, revision: sql`${companionSettings.revision}+1`, updatedAt: new Date() })
      .where(eq(companionSettings.supervisorSessionId, sessionId));
    await tx.update(sessions).set({ status: 'paused', updatedAt: new Date(), context: sql`jsonb_set(coalesce(${sessions.context},'{}'::jsonb),
      '{companionOwnerPause}',${JSON.stringify({ actorUserId, at: new Date().toISOString() })}::jsonb)` })
      .where(and(eq(sessions.id, sessionId), sql`(EXISTS (SELECT 1 FROM companion_session_links l JOIN companion_goals g ON g.id=l.goal_id
        WHERE l.session_id=${sessions.id} AND l.active AND l.ownership='owner' AND g.user_id=${sessions.userId}
          AND g.workspace_id=${sessions.workspaceId} AND g.state NOT IN ('completed','cancelled'))
        OR EXISTS (SELECT 1 FROM companion_settings c WHERE c.supervisor_session_id=${sessions.id}))`));
  });
}
