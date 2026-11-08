import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { getRunId } from '@/core/run-context';
import { getDb } from '../postgres';
import { type AgentEventRecord, agentEvents, type NewAgentEventRecord } from '../schema/agent-events';

export class AgentEventRepository {
  private get db() { return getDb(); }

  /** Stamp the ambient runId (WS4) unless the caller set one explicitly. */
  private withRun(record: NewAgentEventRecord): NewAgentEventRecord {
    if (record.runId != null) return record;
    const runId = getRunId();
    return runId ? { ...record, runId } : record;
  }

  async create(record: NewAgentEventRecord): Promise<void> {
    await this.db.insert(agentEvents).values(this.withRun(record));
  }

  async createMany(records: NewAgentEventRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.insert(agentEvents).values(records.map((r) => this.withRun(r)));
  }

  async findByAgent(agentId: string, afterId?: number): Promise<AgentEventRecord[]> {
    const conditions = afterId
      ? and(eq(agentEvents.agentId, agentId), gt(agentEvents.id, afterId))
      : eq(agentEvents.agentId, agentId);

    return this.db
      .select()
      // i2: by agent id; the route reads the agent through the scoped repo first
      .from(agentEvents)
      .where(conditions)
      .orderBy(agentEvents.id)
      .limit(200);
  }

  /**
   * What a run ended with and the files its tools wrote: its `complete` and
   * `error` events and its `file_change` actions (emitted only after a write
   * tool succeeded), oldest first. The run view's outcome (docs/MISSION-CONTROL.md).
   */
  async outcomeEvents(agentId: string, limit = 500): Promise<Array<Pick<AgentEventRecord, 'type' | 'data' | 'createdAt'>>> {
    return this.db
      .select({ type: agentEvents.type, data: agentEvents.data, createdAt: agentEvents.createdAt })
      // i2: by agent id; the run view reads the agent through the scoped repo first
      .from(agentEvents)
      .where(and(eq(agentEvents.agentId, agentId), or(
        inArray(agentEvents.type, ['complete', 'error']),
        and(eq(agentEvents.type, 'action'), sql`${agentEvents.data}->>'type' = 'file_change'`),
      )))
      .orderBy(agentEvents.id)
      .limit(limit);
  }

  async findBySession(sessionId: string): Promise<AgentEventRecord[]> {
    return this.db
      .select()
      // i2: by session id, for a system caller that already holds the session
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
