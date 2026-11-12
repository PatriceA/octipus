import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { sessions } from '@/db/schema/sessions';
import type { AgentContext } from '@/core/types';

/** Pin automatic selection durably, so disabling a profile cannot fall back to legacy access. */
export async function bindDefaultEnvironment(context: AgentContext, id: string): Promise<void> {
  const rows = await getDb().update(sessions).set({
    context: sql`coalesce(${sessions.context}, '{}'::jsonb) || jsonb_build_object('executionEnvironmentId', ${id}::text)`,
  }).where(and(eq(sessions.id, context.sessionId), eq(sessions.userId, context.userId),
    sql`(${sessions.context}->>'executionEnvironmentId' IS NULL OR ${sessions.context}->>'executionEnvironmentId' = ${id})`))
    .returning({ id: sessions.id });
  if (!rows.length) throw new Error('Session execution environment changed or is no longer accessible. Refresh before continuing.');
}

// Admission and switching share a short lock, separate from a whole conversation turn.
const admissions = new Map<string, Promise<void>>();
export async function withEnvironmentSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = admissions.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => held); admissions.set(sessionId, tail);
  await previous;
  try { return await run(); } finally { release(); if (admissions.get(sessionId) === tail) admissions.delete(sessionId); }
}

/** Full context CAS prevents concurrent selections from overwriting each other. */
export async function switchSessionEnvironment(userId: string, sessionId: string, previous: unknown, patch: Record<string, unknown>): Promise<boolean> {
  const rows = await getDb().update(sessions).set({ context: sql`coalesce(${sessions.context}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId),
      sql`coalesce(${sessions.context}, '{}'::jsonb) = ${JSON.stringify(previous ?? {})}::jsonb`,
      sql`NOT EXISTS (SELECT 1 FROM agents WHERE session_id = ${sessionId}::uuid AND status = 'running')`))
    .returning({ id: sessions.id });
  return rows.length > 0;
}
