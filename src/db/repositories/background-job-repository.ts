import { and, asc, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type BackgroundJob,
  type BackgroundJobKind,
  type BackgroundJobStatus,
  backgroundJobs,
  type NewBackgroundJob,
} from '../schema/background-jobs';

/** Statuses a job cannot leave. */
export const TERMINAL_STATUSES: readonly BackgroundJobStatus[] = ['done', 'error', 'interrupted', 'cancelled'];

/** What the boot sweep writes on a run the previous process took with it. */
export const INTERRUPTED_ERROR = 'Interrupted by a restart';

/** Keep finished rows this long so the away digest can still report them. */
export const FINISHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface StartJobInput {
  kind: BackgroundJobKind;
  userId: string;
  workspaceId?: string | null;
  title: string;
  payload: Record<string, unknown>;
  /** `running` for work that starts on the caller's thread; `queued` (default) for a worker to claim. */
  status?: 'queued' | 'running';
}

/**
 * Unscoped writer for the workers and the boot sweep. Reads on behalf of a
 * user go through `ScopedJobRepo` in `scoped.ts`, which enforces ownership.
 */
export class BackgroundJobRepository {
  private get db() { return getDb(); }

  async create(input: StartJobInput): Promise<BackgroundJob> {
    const now = new Date();
    const status = input.status ?? 'queued';
    const row: NewBackgroundJob = {
      kind: input.kind,
      status,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      title: input.title,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      startedAt: status === 'running' ? now : null,
    };
    const [created] = await this.db.insert(backgroundJobs).values(row).returning();
    return created;
  }

  async findById(id: string): Promise<BackgroundJob | null> {
    const rows = await this.db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Take the oldest `queued` job of a kind and mark it `running`, atomically:
   * the row lock is what keeps two workers (two processes, two ticks) from
   * running the same document twice. Returns null when the queue is empty.
   *
   * The subquery is compared with `=`, not `IN`: as a scalar it is planned
   * once, whereas an `IN (... LIMIT 1 FOR UPDATE)` semi-join can be rescanned
   * per candidate row and claim more than one — which is what happened.
   * Same shape as `kv_queue`'s pop.
   */
  async claimNext(kind: BackgroundJobKind): Promise<BackgroundJob | null> {
    const next = this.db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.kind, kind), eq(backgroundJobs.status, 'queued')))
      .orderBy(asc(backgroundJobs.seq))
      .limit(1)
      .for('update', { skipLocked: true });
    const now = new Date();
    const rows = await this.db
      .update(backgroundJobs)
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where(and(sql`${backgroundJobs.id} = (${next})`, eq(backgroundJobs.status, 'queued')))
      .returning();
    return rows[0] ?? null;
  }

  /** The worker's progress line. A no-op once the job is terminal. */
  async progress(id: string, update: { stage?: string; detail?: string | null }): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({ ...update, updatedAt: new Date() })
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, 'running')));
  }

  /**
   * Close a job. Only a `running` row can finish, so a worker that outlived a
   * boot sweep (marked `interrupted` underneath it) cannot overwrite that
   * verdict with a success nobody can trust — the sweep already told the
   * user the run stopped. Returns the row as written, or null if it was not
   * running.
   */
  async finish(
    id: string,
    outcome: { status: 'done' | 'error' | 'cancelled'; stage?: string; result?: Record<string, unknown> | null; resultRef?: string | null; error?: string | null },
  ): Promise<BackgroundJob | null> {
    const now = new Date();
    const rows = await this.db
      .update(backgroundJobs)
      .set({
        status: outcome.status,
        stage: outcome.stage ?? (outcome.status === 'done' ? 'done' : undefined),
        result: outcome.result ?? null,
        resultRef: outcome.resultRef ?? null,
        error: outcome.error ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, 'running')))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Drop `queued` jobs of a kind whose payload matches — a document deleted
   * or cancelled before its turn. Returns how many rows went. A `running`
   * row is left alone: the worker holds it and will close it.
   */
  async dropQueued(kind: BackgroundJobKind, payload: Record<string, string>): Promise<number> {
    const filters: SQL[] = [eq(backgroundJobs.kind, kind), eq(backgroundJobs.status, 'queued')];
    for (const [key, value] of Object.entries(payload)) {
      filters.push(sql`${backgroundJobs.payload} ->> ${key} = ${value}`);
    }
    const rows = await this.db.delete(backgroundJobs).where(and(...filters)).returning({ id: backgroundJobs.id });
    return rows.length;
  }

  async countByStatus(kind: BackgroundJobKind): Promise<{ queued: number; running: number }> {
    const rows = await this.db
      .select({ status: backgroundJobs.status, n: sql<number>`count(*)::int` })
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.kind, kind), inArray(backgroundJobs.status, ['queued', 'running'])))
      .groupBy(backgroundJobs.status);
    const out = { queued: 0, running: 0 };
    for (const r of rows) {
      if (r.status === 'queued') out.queued = Number(r.n);
      if (r.status === 'running') out.running = Number(r.n);
    }
    return out;
  }

  /**
   * Boot sweep: a job still `running` belongs to a process that is gone.
   * Mark it `interrupted` and return the rows so each kind can put its own
   * house in order (a document marked failed, say). Never auto-resumes —
   * the pipeline rule. Global, like the pipeline sweep: in a deployment with
   * several processes a booting one interrupts its siblings' in-flight jobs
   * too, which the workers notice (`finish` returns null) and log.
   */
  async sweepInterrupted(now = new Date()): Promise<BackgroundJob[]> {
    return this.db
      .update(backgroundJobs)
      .set({ status: 'interrupted', error: INTERRUPTED_ERROR, finishedAt: now, updatedAt: now })
      .where(eq(backgroundJobs.status, 'running'))
      .returning();
  }

  /** Reclaim space: terminal rows older than the retention window. Returns the count removed. */
  async pruneFinished(now = new Date(), retentionMs = FINISHED_RETENTION_MS): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionMs);
    const rows = await this.db
      .delete(backgroundJobs)
      .where(and(inArray(backgroundJobs.status, [...TERMINAL_STATUSES]), lt(backgroundJobs.finishedAt, cutoff)))
      .returning({ id: backgroundJobs.id });
    return rows.length;
  }

  /** Most recent jobs of a user, newest first — the operator's view. */
  async recentForUser(userId: string, limit = 50): Promise<BackgroundJob[]> {
    return this.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.userId, userId))
      .orderBy(desc(backgroundJobs.seq))
      .limit(limit);
  }
}

export const backgroundJobRepository = new BackgroundJobRepository();
