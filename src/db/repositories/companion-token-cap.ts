import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionActions, companionWakes } from '@/db/schema/companion-supervision';

/**
 * The token cap a Companion run in `sessionId` is held to, if one is running:
 * the running dispatched action's cap (steering excluded), else — for a
 * background wake of the controller — the running wake's. Undefined when
 * neither applies. Lifted out of root-runner, which used to run these queries
 * inline while it assembled the prompt.
 */
export async function companionTurnTokenCap(sessionId: string, opts: { backgroundWake: boolean }): Promise<number | undefined> {
  const db = getDb();
  const [action] = await db.select({ cap: companionActions.tokenCap }).from(companionActions)
    .where(and(eq(companionActions.sessionId, sessionId), eq(companionActions.status, 'running'), ne(companionActions.kind, 'steer_session')));
  if (action?.cap) return action.cap;
  if (opts.backgroundWake) {
    const [wake] = await db.select({ cap: companionWakes.tokenCap }).from(companionWakes)
      .where(and(eq(companionWakes.sessionId, sessionId), eq(companionWakes.status, 'running'), isNotNull(companionWakes.startedAt)));
    return wake?.cap ?? undefined;
  }
  return undefined;
}
