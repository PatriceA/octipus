import { eq, inArray, lt, sql } from 'drizzle-orm';
import type { AgentCompletionReason } from '@/shared/agent-completion';
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
      /** Spend proxy (fresh input + output) — what the daily quota sums. */
      billableTokens?: number;
      durationMs?: number;
      error?: string;
      toolCalls?: Array<{ name: string; count: number }>;
      completionReason?: AgentCompletionReason;
      /** Why a failed run failed when it was a user cap, not a fault: 'spend_budget' | 'quota'. */
      failureReason?: 'spend_budget' | 'quota';
    },
  ): Promise<void> {
    const patch = {
      ...(update.completionReason && { completionReason: update.completionReason }),
      ...(update.failureReason && { failureReason: update.failureReason }),
    };
    await this.db.update(agents).set({
      status: update.status,
      iterations: update.iterations,
      totalTokens: update.totalTokens,
      billableTokens: update.billableTokens,
      durationMs: update.durationMs,
      error: update.error,
      toolCalls: update.toolCalls,
      metadata: Object.keys(patch).length > 0
        ? sql`coalesce(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`
        : undefined,
      completedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async findById(id: string): Promise<AgentRecord | null> {
    // i2: by agent id, for the worker that runs it and system callers; user routes use ScopedAgentRepo
    const result = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return result[0] ?? null;
  }

  /**
   * Delete agent rows (and their events) completed before `cutoff`.
   * Running agents have a NULL `completedAt`, so they're never swept.
   * Returns the number of agent rows removed. The cascade to
   * `agent_events` is handled by the caller (there's no FK), so we
   * delete events first to avoid orphans.
   */
  async deleteCompletedBefore(cutoff: Date): Promise<number> {
    const stale = await this.db
      .select({ id: agents.id })
      // i2: retention sweep, ids only
      .from(agents)
      .where(lt(agents.completedAt, cutoff));
    if (stale.length === 0) return 0;
    const ids = stale.map((s) => s.id);
    const { agentEvents } = await import('../schema/agent-events');
    await this.db.delete(agentEvents).where(inArray(agentEvents.agentId, ids));
    const removed = await this.db
      .delete(agents)
      .where(inArray(agents.id, ids))
      .returning({ id: agents.id });
    return removed.length;
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
