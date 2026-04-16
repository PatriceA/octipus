import { eq, lt, gt, and } from 'drizzle-orm';
import { getDb } from '../postgres';
import { agentEvents, type AgentEventRecord, type NewAgentEventRecord } from '../schema/agent-events';

export class AgentEventRepository {
  private get db() { return getDb(); }

  async create(record: NewAgentEventRecord): Promise<void> {
    await this.db.insert(agentEvents).values(record);
  }

  async createMany(records: NewAgentEventRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.insert(agentEvents).values(records);
  }

  async findByAgent(agentId: string, afterId?: number): Promise<AgentEventRecord[]> {
    const conditions = afterId
      ? and(eq(agentEvents.agentId, agentId), gt(agentEvents.id, afterId))
      : eq(agentEvents.agentId, agentId);

    return this.db
      .select()
      .from(agentEvents)
      .where(conditions)
      .orderBy(agentEvents.id)
      .limit(200);
  }

  async findBySession(sessionId: string): Promise<AgentEventRecord[]> {
    return this.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.sessionId, sessionId))
      .orderBy(agentEvents.id)
      .limit(1000);
  }

  /** Delete events older than the given date. Returns number of deleted rows. */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(agentEvents)
      .where(lt(agentEvents.createdAt, cutoff))
      .returning({ id: agentEvents.id });
    return result.length;
  }
}

export const agentEventRepository = new AgentEventRepository();
