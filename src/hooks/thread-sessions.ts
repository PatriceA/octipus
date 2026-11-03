/**
 * One session per thread of work for a `spawn_agent` hook.
 *
 * Without a thread key, a webhook hook either runs every delivery in its one
 * persisted session (every PR of the repo in one transcript) or, triggered from
 * a session, in that session. Neither keeps "the agent working on PR #42" on
 * PR #42: the follow-up review comment lands next to three unrelated PRs, or in
 * a session that never saw the PR.
 *
 * `actionConfig.threadKey` is a template over the trigger context, for example
 * `{{webhook.body.repository.full_name}}#{{webhook.body.pull_request.number}}`.
 * The first event that renders a key mints a session for it; later events with
 * the same key run in that session, after the turn before them (the session
 * turn queue serializes them). `threadEndActions` names the payload actions
 * that close a thread (`closed`, `merge`): that event still runs in the
 * thread's session, and the next event on the key starts a fresh one.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hookThreadSessions } from '@/db/schema/hook-thread-sessions';
import type { TriggerContext } from './triggers';

/** A thread with no event for this long is forgotten; its next event starts a new session. */
export const THREAD_IDLE_DAYS = 30;
/** Longest key stored; a template that renders more is refused, not cut (two keys must not collide). */
export const MAX_THREAD_KEY_CHARS = 300;

export type RenderedThreadKey = { key: string } | { key: null; reason: string };

/**
 * Check a rendered thread key. A key that still holds a `{{placeholder}}` came
 * from an event without that field (a GitHub `ping`, a push with no PR): it
 * has no thread, and the caller falls back to the hook's own session.
 */
export function checkThreadKey(rendered: string): RenderedThreadKey {
  const key = rendered.trim();
  if (!key) return { key: null, reason: 'the thread key rendered empty' };
  const missing = key.match(/\{\{\s*([^}]+?)\s*\}\}/);
  if (missing) return { key: null, reason: `the event has no ${missing[1]}` };
  if (key.length > MAX_THREAD_KEY_CHARS) return { key: null, reason: `the thread key is longer than ${MAX_THREAD_KEY_CHARS} characters` };
  return { key };
}

/** The action a GitHub (`action`) or GitLab (`object_attributes.action`) payload reports. */
export function payloadAction(context: TriggerContext): string | undefined {
  const body = context.webhook?.body;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.action === 'string') return b.action;
  const attrs = b.object_attributes;
  if (attrs && typeof attrs === 'object' && typeof (attrs as Record<string, unknown>).action === 'string') {
    return (attrs as Record<string, string>).action;
  }
  return undefined;
}

/** Does this event close its thread under the hook's `threadEndActions`? */
export function endsThread(endActions: unknown, context: TriggerContext): boolean {
  if (!Array.isArray(endActions) || endActions.length === 0) return false;
  const action = payloadAction(context);
  return action !== undefined && endActions.some((a) => typeof a === 'string' && a === action);
}

/**
 * The session of `hookId`'s thread `key`, minting one on its first event.
 * Concurrent first events agree: the insert does nothing on conflict and both
 * read back the row that won. Idle threads of the hook are pruned on a mint.
 */
export async function threadSession(hookId: string, key: string, attempt = 0): Promise<{ sessionId: string; created: boolean }> {
  const db = getDb();
  const candidate = crypto.randomUUID();
  const inserted = await db.insert(hookThreadSessions)
    .values({ hookId, threadKey: key, sessionId: candidate })
    .onConflictDoNothing()
    .returning({ sessionId: hookThreadSessions.sessionId });
  if (inserted.length > 0) {
    await db.delete(hookThreadSessions).where(and(
      eq(hookThreadSessions.hookId, hookId),
      lt(hookThreadSessions.lastUsedAt, sql.raw(`now() - interval '${THREAD_IDLE_DAYS} days'`)),
    ));
    return { sessionId: candidate, created: true };
  }
  const [row] = await db.update(hookThreadSessions)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(hookThreadSessions.hookId, hookId), eq(hookThreadSessions.threadKey, key)))
    .returning({ sessionId: hookThreadSessions.sessionId });
  if (!row) {
    // Ended between the insert and the update: this event starts the next one.
    if (attempt > 0) throw new Error(`Thread ${key} of hook ${hookId} could not be claimed or read back`);
    return threadSession(hookId, key, attempt + 1);
  }
  return { sessionId: row.sessionId, created: false };
}

/** Forget a thread: its next event starts a new session. */
export async function endThread(hookId: string, key: string): Promise<void> {
  await getDb().delete(hookThreadSessions)
    .where(and(eq(hookThreadSessions.hookId, hookId), eq(hookThreadSessions.threadKey, key)));
}
