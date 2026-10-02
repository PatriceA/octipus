import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { type NewSession, type Session, sessions } from '../schema/sessions';

/** A jsonb path as a bound text[] — keys are parameters, never spliced into an array literal. */
function jsonPath(path: string[]) {
  return sql`ARRAY[${sql.join(path.map(key => sql`${key}::text`), sql`, `)}]::text[]`;
}

/**
 * `context` with ONE nested key set (or, with `undefined`, deleted). jsonb_set
 * can't create missing intermediate objects, so build the nested merge
 * explicitly: at each level, `existing || {new key}` — which keeps every
 * sibling and replaces only the addressed branch.
 */
function contextKeyExpr(path: [string, ...string[]], value: unknown) {
  const ctx = sql`coalesce(${sessions.context}, '{}'::jsonb)`;
  if (value === undefined) return sql`${ctx} #- ${jsonPath(path)}`;
  // Innermost first, wrapping outwards.
  let inner = sql`jsonb_build_object(${path[path.length - 1]}::text, ${JSON.stringify(value)}::jsonb)`;
  for (let i = path.length - 2; i >= 0; i--) {
    // A missing, null or non-object intermediate becomes `{}`: `null || {…}`
    // or `"x" || {…}` would build an array, not the nested object.
    const at = sql`${ctx} #> ${jsonPath(path.slice(0, i + 1))}`;
    inner = sql`jsonb_build_object(${path[i]}::text, (CASE WHEN jsonb_typeof(${at}) = 'object' THEN ${at} ELSE '{}'::jsonb END) || ${inner})`;
  }
  return sql`${ctx} || ${inner}`;
}

/** The row is still in `generation` — the predicate every generation-checked write shares. */
function inGeneration(generation: string) {
  return sql`coalesce(${sessions.context}->>'conversationGeneration', ${sessions.context}->>'clearedAt', '') = ${generation}`;
}

/** `ctx.cliSessions` as an object (`{}` when missing, null or not an object). */
function cliSessionsOf(ctx: SQL) {
  return sql`CASE WHEN jsonb_typeof(${ctx} -> 'cliSessions') = 'object' THEN ${ctx} -> 'cliSessions' ELSE '{}'::jsonb END`;
}
const cliSessionsMap = cliSessionsOf(sql`${sessions.context}`);

/** `key` starts with one of `prefixes` (bound as a text[]). */
function startsWithAny(key: SQL, prefixes: string[]) {
  return sql`EXISTS (SELECT 1 FROM unnest(${jsonPath(prefixes)}) AS p(prefix) WHERE starts_with(${key}, p.prefix))`;
}

/**
 * `ctx` with at most `max` of the `cliSessions` entries whose key starts with
 * one of `prefixes`, dropping the least recently used (`lastUsedAt`, missing
 * last, then key); every other entry is kept as is.
 */
function boundCliSessions(ctx: SQL, prefixes: string[], max: number) {
  const matches = startsWithAny(sql`e.key`, prefixes);
  return sql`${ctx} || jsonb_build_object('cliSessions', (
    SELECT coalesce(jsonb_object_agg(t.key, t.value), '{}'::jsonb) FROM (
      SELECT e.key, e.value, ${matches} AS matched,
        row_number() OVER (PARTITION BY ${matches} ORDER BY e.value->>'lastUsedAt' DESC NULLS LAST, e.key) AS rank
      FROM jsonb_each(${cliSessionsOf(ctx)}) AS e
    ) AS t WHERE NOT t.matched OR t.rank <= ${max}))`;
}

export class SessionRepository {
  private get db() { return getDb(); }

  async findById(id: string): Promise<Session | null> {
    const result = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return result[0] ?? null;
  }

  async findByUserAndChannel(
    userId: string,
    channelType: string,
    channelId: string
  ): Promise<Session | null> {
    const result = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.channelType, channelType),
          eq(sessions.channelId, channelId),
          eq(sessions.status, 'active'),
          // Group-thread sessions share the chat id but are separate conversations.
          isNull(sessions.groupChannelId)
        )
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1);

    return result[0] ?? null;
  }

  /** One member's active session for a group channel thread. */
  async findGroupThreadSession(userId: string, groupChannelId: string, threadId: string): Promise<Session | null> {
    const result = await this.db
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        eq(sessions.groupChannelId, groupChannelId),
        eq(sessions.threadId, threadId),
        eq(sessions.status, 'active'),
      ))
      .orderBy(desc(sessions.createdAt))
      .limit(1);
    return result[0] ?? null;
  }

  /** Whether any member has talked to the bot in this group thread (any status). */
  async hasGroupThread(groupChannelId: string, threadId: string): Promise<boolean> {
    const result = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.groupChannelId, groupChannelId), eq(sessions.threadId, threadId)))
      .limit(1);
    return result.length > 0;
  }

  /**
   * Return all sessions (active or not) matching the (user, channelType, channelId) tuple.
   * Used to aggregate cross-restart channel sessions (telegram, slack, etc.)
   * so the UI can show a single continuous transcript per channel conversation.
   */
  async findAllByUserAndChannel(
    userId: string,
    channelType: string,
    channelId: string
  ): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.channelType, channelType),
          eq(sessions.channelId, channelId),
          isNull(sessions.groupChannelId)
        )
      )
      .orderBy(desc(sessions.createdAt));
  }

  async findActiveByUser(userId: string): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.status, 'active')))
      .orderBy(desc(sessions.updatedAt));
  }

  async create(data: NewSession): Promise<Session> {
    const result = await this.db.insert(sessions).values(data).returning();
    dbLogger.info({ sessionId: result[0].id, userId: data.userId }, 'Session created');
    return result[0];
  }

  async update(id: string, data: Partial<NewSession>): Promise<Session | null> {
    const result = await this.db
      .update(sessions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sessions.id, id))
      .returning();

    return result[0] ?? null;
  }

  /**
   * Set (or, with `undefined`, delete) ONE key inside `context`, in the
   * database, without reading the row first.
   *
   * `update()` takes a whole `context` object, so every caller that wanted to
   * change one key did read-spread-write — and any concurrent change to a
   * DIFFERENT key was silently reverted to whatever the reader had seen. A
   * `/clear` landing during an in-flight turn was undone wholesale (its
   * `clearedAt` and its summary reset, the cleared conversation resumed on the
   * next turn) by a fire-and-forget `saveCliSession` that only ever meant to
   * touch `cliSessions`. No overlapping turns required.
   *
   * `path` addresses nested keys (`['cliSessions', 'Claude Code']`); missing
   * intermediate objects are created, and sibling keys at every level survive.
   */
  async setContextKey(id: string, path: [string, ...string[]], value: unknown): Promise<void> {
    await this.db
      .update(sessions)
      .set({ context: contextKeyExpr(path, value) as never, updatedAt: new Date() })
      .where(eq(sessions.id, id));
  }

  /**
   * `setContextKey`, published only while the session is still in
   * `generation` (the same predicate as `patchContextIfGeneration`), so a
   * write from before a /clear can never land after it. One key, one
   * statement: concurrent writers to sibling keys never clobber each other.
   * `boundCliSessions` trims the prefixed `cliSessions` entries to `max` in
   * the same statement (see `boundCliSessions`).
   */
  async setContextKeyIfGeneration(
    id: string, generation: string, path: [string, ...string[]], value: unknown,
    opts?: { boundCliSessions?: { prefixes: string[]; max: number } },
  ): Promise<boolean> {
    const bound = opts?.boundCliSessions;
    const context = bound ? boundCliSessions(contextKeyExpr(path, value), bound.prefixes, bound.max) : contextKeyExpr(path, value);
    const result = await this.db.update(sessions)
      .set({ context: context as never, updatedAt: new Date() })
      .where(and(eq(sessions.id, id), inGeneration(generation)))
      .returning({ id: sessions.id });
    return result.length > 0;
  }

  async incrementMessageCount(id: string, tokenDelta: number = 0): Promise<void> {
    await this.db
      .update(sessions)
      .set({
        messageCount: sql`${sessions.messageCount} + 1`,
        tokenCount: sql`${sessions.tokenCount} + ${tokenDelta}`,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, id));
  }

  /** Atomically publish a checkpoint/session update only in its original generation. */
  async patchContextIfGeneration(
    id: string, generation: string, patch: Record<string, unknown>,
    opts?: { keepCliSessionPrefixes?: string[] },
  ): Promise<boolean> {
    let context = sql`coalesce(${sessions.context}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
    // Same statement: `cliSessions` keeps only the keys starting with one of
    // these prefixes (child task sessions); every other entry is dropped.
    if (opts?.keepCliSessionPrefixes) {
      context = sql`${context} || jsonb_build_object('cliSessions', coalesce((
        SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(${cliSessionsMap}) AS e
        WHERE ${startsWithAny(sql`e.key`, opts.keepCliSessionPrefixes)}
      ), '{}'::jsonb))`;
    }
    const result = await this.db.update(sessions).set({
      context,
      updatedAt: new Date(),
    }).where(and(eq(sessions.id, id), inGeneration(generation)))
      .returning({ id: sessions.id });
    return result.length > 0;
  }

  async clearContext(id: string): Promise<void> {
    await this.db.update(sessions).set({
      context: sql`(coalesce(${sessions.context}, '{}'::jsonb) - ARRAY['checkpoint','compactionState','compactedSummary','cliSessions','nativeConversation','activeCommand','planningState']) || jsonb_build_object('clearedAt', ${new Date().toISOString()}::text, 'conversationGeneration', ${randomUUID()}::text)`,
      updatedAt: new Date(),
    }).where(eq(sessions.id, id));
  }

  async complete(id: string): Promise<Session | null> {
    return this.update(id, {
      status: 'completed',
      completedAt: new Date(),
    });
  }

  async pause(id: string): Promise<Session | null> {
    return this.update(id, { status: 'paused' });
  }

  async resume(id: string): Promise<Session | null> {
    return this.update(id, { status: 'active' });
  }

  async fail(id: string): Promise<Session | null> {
    return this.update(id, {
      status: 'failed',
      completedAt: new Date(),
    });
  }

  async delete(id: string): Promise<boolean> {
    // Manually delete related records — PGlite may not enforce ON DELETE CASCADE
    // from the Drizzle schema definition if the migration didn't include it.
    try {
      const { messages } = await import('../schema/messages');
      const { pipelines, pipelineNodes } = await import('../schema/pipelines');
      const { agents } = await import('../schema/agents');

      // Delete pipeline stages first (FK to pipelines)
      const pipelineRows = await this.db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.sessionId, id));
      for (const p of pipelineRows) {
        await this.db.delete(pipelineNodes).where(eq(pipelineNodes.pipelineId, p.id));
      }
      await this.db.delete(pipelines).where(eq(pipelines.sessionId, id));
      await this.db.delete(messages).where(eq(messages.sessionId, id));
      await this.db.delete(agents).where(eq(agents.sessionId, id));
    } catch (err) {
      dbLogger.warn({ sessionId: id, err }, 'Failed to clean up related records before session delete');
    }

    const result = await this.db.delete(sessions).where(eq(sessions.id, id)).returning();
    if (result.length > 0) {
      dbLogger.info({ sessionId: id }, 'Session deleted');
      return true;
    }
    return false;
  }

  async listByUser(userId: string, limit: number = 50): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit);
  }

  async listRecent(limit: number = 20): Promise<Session[]> {
    return this.db.select().from(sessions).orderBy(desc(sessions.updatedAt)).limit(limit);
  }

  /**
   * Archive webchat sessions older than `days` days.
   * Channel sessions (telegram, slack, etc.) are kept since they're long-lived.
   */
  async cleanupOldWebchatSessions(days: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.db
      .update(sessions)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(sessions.status, 'active'),
          eq(sessions.channelType, 'webchat'),
          eq(sessions.pinned, false),
          lt(sessions.updatedAt, cutoff),
        )
      )
      .returning();

    if (result.length > 0) {
      dbLogger.info({ count: result.length, days }, 'Archived old webchat sessions');
    }
    return result.length;
  }

  /**
   * Delete sessions idle since before `cutoff`, except pinned ones and any
   * with an agent still running or a monitor still pending. Goes through
   * `delete()` so messages, pipelines and agents go with each row. At most `limit` per call; the
   * hourly sweep picks up the rest. Returns the number deleted.
   */
  async deleteExpired(cutoff: Date, limit = 500): Promise<number> {
    const { agents } = await import('../schema/agents');
    const { monitors } = await import('../schema/monitors');
    const { tasks } = await import('../schema/tasks');
    // A session still waiting on a monitor (armed, or fired and about to
    // resume) is not idle even though nothing has touched its row; deleting it
    // would cascade the monitor away and silently drop the continuation.
    // Nor is a group-channel thread session with work still taken on in it:
    // the open task is linked to it (src/core/channels/taken-tasks.ts).
    const expiredFilter = (id?: string) => and(
      id ? eq(sessions.id, id) : undefined,
      eq(sessions.pinned, false),
      lt(sessions.updatedAt, cutoff),
      sql`NOT EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.sessionId} = ${sessions.id} AND ${agents.status} = 'running')`,
      sql`NOT EXISTS (SELECT 1 FROM ${monitors} WHERE ${monitors.sessionId} = ${sessions.id} AND ${monitors.status} IN ('armed', 'paused', 'ready', 'delivering'))`,
      sql`NOT EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.source} = 'channel' AND ${tasks.status} IN ('open', 'in_progress') AND ${tasks.sourceRef}->>'sessionId' = ${sessions.id}::text)`,
    );
    const expired = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(expiredFilter())
      .orderBy(sessions.updatedAt)
      .limit(limit);

    let deleted = 0;
    for (const { id } of expired) {
      // Re-check right before deleting: the batch is selected up front and
      // deleted one by one, so a session pinned, resumed or given a running
      // agent meanwhile must not be swept with a stale verdict.
      const still = await this.db.select({ id: sessions.id }).from(sessions).where(expiredFilter(id)).limit(1);
      if (still.length === 0) continue;
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async countActive(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.status, 'active'));

    return result[0]?.count ?? 0;
  }
}

export const sessionRepository = new SessionRepository();
