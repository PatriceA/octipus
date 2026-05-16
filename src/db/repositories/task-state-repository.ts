import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type NewTaskState,
  type TaskState,
  taskState,
  type TaskStateStatus,
} from '../schema/task-state';

/**
 * Memory-redesign Phase B — typed workflow state.
 *
 * Replaces the cosine-search-over-`agent_output`-RAG-rows pattern. A
 * `task_state` row is the authoritative typed record of one unit of
 * agent work scoped to a session. Sibling agents read each other's
 * results through this repository (typed) instead of through a
 * similarity ranker over chunked text.
 *
 * LISTEN/NOTIFY for live fan-out: the migration installs a trigger
 * that publishes a small payload on channel `task_state_<session_id>`
 * after each insert/update. A long-lived subscriber lands in a
 * follow-up — callers that need to react now should poll
 * `listSessionRecent` with a short interval.
 */
export class TaskStateRepository {
  private get db() {
    return getDb();
  }

  /**
   * Insert a new task. Defaults `status` to `pending`. Callers that
   * record a one-shot agent completion typically pass status='done'
   * directly with the outputs payload populated.
   */
  async create(record: Omit<NewTaskState, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: TaskStateStatus }): Promise<TaskState> {
    const result = await this.db.insert(taskState).values({
      ...record,
      status: record.status ?? 'pending',
    }).returning();
    return result[0];
  }

  /**
   * Move a task to its terminal state. Uses jsonb merge for outputs so
   * partial writers don't overwrite earlier siblings' fields.
   */
  async complete(id: string, outputs: Record<string, unknown>): Promise<void> {
    await this.db
      .update(taskState)
      .set({
        status: 'done',
        outputs,
        updatedAt: new Date(),
      })
      .where(eq(taskState.id, id));
  }

  async fail(id: string, error: string, outputs?: Record<string, unknown>): Promise<void> {
    await this.db
      .update(taskState)
      .set({
        status: 'failed',
        error,
        outputs: outputs ?? {},
        updatedAt: new Date(),
      })
      .where(eq(taskState.id, id));
  }

  async updateStatus(id: string, status: TaskStateStatus): Promise<void> {
    await this.db
      .update(taskState)
      .set({ status, updatedAt: new Date() })
      .where(eq(taskState.id, id));
  }

  async getById(id: string): Promise<TaskState | null> {
    const rows = await this.db.select().from(taskState).where(eq(taskState.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Recent tasks in a session, newest first. Sibling-discovery primary
   * use case: an agent asks "what did my peers just finish?".
   */
  async listSessionRecent(sessionId: string, limit = 50): Promise<TaskState[]> {
    return this.db
      .select()
      .from(taskState)
      .where(eq(taskState.sessionId, sessionId))
      .orderBy(desc(taskState.createdAt))
      .limit(limit);
  }

  async listByOwnerStatus(ownerAgent: string, status: TaskStateStatus, limit = 50): Promise<TaskState[]> {
    return this.db
      .select()
      .from(taskState)
      .where(and(eq(taskState.ownerAgent, ownerAgent), eq(taskState.status, status)))
      .orderBy(desc(taskState.createdAt))
      .limit(limit);
  }

  /**
   * Cleanup helper for the retention pass. Returns the number of rows
   * deleted so the cleanup audit log can record it. Status filter so
   * a long-running task can't be reaped just because it's old.
   */
  async deleteDoneOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(taskState)
      .where(and(eq(taskState.status, 'done'), lt(taskState.updatedAt, cutoff)))
      .returning({ id: taskState.id });
    return result.length;
  }
}

let _instance: TaskStateRepository | null = null;
export function getTaskStateRepository(): TaskStateRepository {
  if (!_instance) _instance = new TaskStateRepository();
  return _instance;
}
