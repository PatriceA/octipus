import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { type Message, messages, type NewMessage } from '../schema/messages';

export class MessageRepository {
  private get db() { return getDb(); }

  async findById(id: string): Promise<Message | null> {
    const result = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return result[0] ?? null;
  }

  async findBySession(sessionId: string, limit: number = 100, offset: number = 0, roles?: string[]): Promise<Message[]> {
    const conditions = roles?.length
      ? and(eq(messages.sessionId, sessionId), inArray(messages.role, roles as ('system' | 'user' | 'assistant' | 'tool')[]))
      : eq(messages.sessionId, sessionId);

    return this.db
      .select()
      .from(messages)
      .where(conditions)
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Get the N most recent messages for a session (ordered oldest→newest).
   * Unlike findBySession which gets the first N messages, this gets the last N.
   */
  async findRecentBySession(
    sessionId: string,
    limit: number = 10,
    roles?: string[],
    since?: Date,
  ): Promise<Message[]> {
    const filters = [eq(messages.sessionId, sessionId)];
    if (roles?.length) {
      filters.push(inArray(messages.role, roles as ('system' | 'user' | 'assistant' | 'tool')[]));
    }
    if (since) {
      filters.push(gte(messages.createdAt, since));
    }
    const conditions = filters.length === 1 ? filters[0] : and(...filters);

    const recent = await this.db
      .select()
      .from(messages)
      .where(conditions)
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return recent.reverse(); // Return in chronological order
  }

  /**
   * Fetch messages across multiple sessions in chronological order.
   * Used to aggregate channel-wide transcripts (e.g. all telegram messages
   * for a chat across restart-created session rows).
   */
  async findBySessions(
    sessionIds: string[],
    limit: number = 100,
    offset: number = 0,
    roles?: string[]
  ): Promise<Message[]> {
    if (sessionIds.length === 0) return [];

    const base = inArray(messages.sessionId, sessionIds);
    const conditions = roles?.length
      ? and(base, inArray(messages.role, roles as ('system' | 'user' | 'assistant' | 'tool')[]))
      : base;

    return this.db
      .select()
      .from(messages)
      .where(conditions)
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async countBySessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(inArray(messages.sessionId, sessionIds));
    return result[0]?.count ?? 0;
  }

  async findByAgent(agentId: string, limit: number = 100): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.agentId, agentId))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
  }

  async create(data: NewMessage): Promise<Message> {
    const result = await this.db.insert(messages).values(data).returning();
    return result[0];
  }

  async createMany(data: NewMessage[]): Promise<Message[]> {
    if (data.length === 0) return [];
    const result = await this.db.insert(messages).values(data).returning();
    dbLogger.debug({ count: result.length }, 'Messages created');
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(messages).where(eq(messages.id, id)).returning();
    return result.length > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db.delete(messages).where(eq(messages.sessionId, sessionId)).returning();
    dbLogger.info({ sessionId, count: result.length }, 'Session messages deleted');
    return result.length;
  }

  async countBySession(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId));

    return result[0]?.count ?? 0;
  }

  async getLastMessages(sessionId: string, count: number): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(count);
  }

  async getMessagesBetween(sessionId: string, startTime: Date, endTime: Date): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          gte(messages.createdAt, startTime),
          lte(messages.createdAt, endTime)
        )
      )
      .orderBy(asc(messages.createdAt));
  }

  async getToolCallMessages(sessionId: string): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), sql`${messages.toolCalls} IS NOT NULL`))
      .orderBy(asc(messages.createdAt));
  }

  async getConversationContext(sessionId: string, maxTokens: number = 32000): Promise<Message[]> {
    // Get messages in reverse order and estimate tokens
    const allMessages = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt));

    const result: Message[] = [];
    let estimatedTokens = 0;

    for (const msg of allMessages) {
      // Rough token estimation: ~4 chars per token
      const msgTokens = Math.ceil(msg.content.length / 4);

      if (estimatedTokens + msgTokens > maxTokens) {
        break;
      }

      result.unshift(msg); // Add to beginning to maintain order
      estimatedTokens += msgTokens;
    }

    return result;
  }
}

export const messageRepository = new MessageRepository();
