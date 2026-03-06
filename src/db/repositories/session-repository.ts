import { eq, and, desc, sql, lt, ne } from 'drizzle-orm';
import { getDb } from '../postgres';
import { sessions, type Session, type NewSession } from '../schema/sessions';
import { dbLogger } from '@/utils/logger';

export class SessionRepository {
  private db = getDb();

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
