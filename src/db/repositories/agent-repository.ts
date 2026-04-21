import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type AgentRecord, agents, type NewAgentRecord } from '../schema/agents';

export class AgentRepository {
  private get db() { return getDb(); }

  async create(record: NewAgentRecord): Promise<AgentRecord> {
    const result = await this.db.insert(agents).values(record).returning();
    return result[0];
  }

  async updateStatus(
    id: string,
    update: {
      status: 'completed' | 'failed' | 'stopped';
      iterations?: number;
      totalTokens?: number;
      durationMs?: number;
      error?: string;
      toolCalls?: Array<{ name: string; count: number }>;
    },
  ): Promise<void> {
    await this.db.update(agents).set({
      status: update.status,
      iterations: update.iterations,
      totalTokens: update.totalTokens,
      durationMs: update.durationMs,
      error: update.error,
      toolCalls: update.toolCalls,
      completedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async findById(id: string): Promise<AgentRecord | null> {
    const result = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return result[0] ?? null;
  }

  async findBySession(sessionId: string, limit = 50): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.sessionId, sessionId))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  async findBySessions(sessionIds: string[], limit = 200): Promise<AgentRecord[]> {
    if (sessionIds.length === 0) return [];
    return this.db
      .select()
      .from(agents)
      .where(inArray(agents.sessionId, sessionIds))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  async findByUser(userId: string, limit = 200): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  async listRecent(limit = 200): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  /** Mark any agents still "running" as failed — called on startup to clean up zombies from previous process */
  async cleanupStale(): Promise<number> {
    const result = await this.db
      .update(agents)
      .set({
        status: 'failed',
        error: 'Stale: backend restarted while agent was running',
        completedAt: new Date(),
      })
      .where(eq(agents.status, 'running'))
      .returning({ id: agents.id });
    return result.length;
  }
}

export const agentRepository = new AgentRepository();
