import { and, desc, eq, lt, sql, } from 'drizzle-orm';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { type NewSession, type Session, sessions } from '../schema/sessions';

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
          eq(sessions.status, 'active')
        )
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1);

    return result[0] ?? null;
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
          eq(sessions.channelId, channelId)
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
    // jsonb_set can't create missing intermediate objects, so build the nested
    // merge explicitly: at each level, `existing || {new key}` — which keeps
    // every sibling and replaces only the addressed branch.
    const ctx = sql`coalesce(${sessions.context}, '{}'::jsonb)`;
    let expr;
    if (value === undefined) {
      expr = sql`${ctx} #- ${`{${path.join(',')}}`}::text[]`;
    } else {
      // Innermost first, wrapping outwards.
      let inner = sql`jsonb_build_object(${path[path.length - 1]}::text, ${JSON.stringify(value)}::jsonb)`;
      for (let i = path.length - 2; i >= 0; i--) {
        const prefix = `{${path.slice(0, i + 1).join(',')}}`;
        inner = sql`jsonb_build_object(${path[i]}::text, coalesce(${ctx} #> ${prefix}::text[], '{}'::jsonb) || ${inner})`;
      }
      expr = sql`${ctx} || ${inner}`;
    }
    await this.db
      .update(sessions)
      .set({ context: expr as never, updatedAt: new Date() })
      .where(eq(sessions.id, id));
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
          lt(sessions.updatedAt, cutoff),
        )
      )
      .returning();

    if (result.length > 0) {
      dbLogger.info({ count: result.length, days }, 'Archived old webchat sessions');
    }
    return result.length;
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
