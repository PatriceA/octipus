import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per unit of background work the process runs outside a request:
 * a research investigation, a document going through extraction. Before this
 * table each kept its own in-process record (a `Map` with a TTL, an array),
 * which a restart silently emptied — the client polled a job id nobody knew,
 * the upload sat at `queued` forever.
 *
 * The row IS the job. Whoever starts one writes it, the worker moves it
 * through `status`, the route that polls reads it back, and the boot sweep
 * marks whatever was `running` when the previous process died as
 * `interrupted` — the same rule pipelines follow: a run does not resume on
 * its own, it says it stopped. `queued` rows are different: nothing had begun,
 * so draining them after a restart is safe and is exactly what durability
 * buys.
 *
 * `payload` is what the worker needs to run (the question, the document id);
 * `result` is what the poller wants back (the report); `result_ref` is the
 * durable thing the run produced (the saved document) for anything that
 * outlives the row. `stage` / `detail` are the worker's progress line.
 */
export type BackgroundJobKind = 'research' | 'document';
export type BackgroundJobStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted';

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<BackgroundJobKind>().notNull(),
    status: text('status').$type<BackgroundJobStatus>().notNull().default('queued'),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** NULL = user-level, matching every other scoped table. */
    workspaceId: uuid('workspace_id'),
    /** What a human would call this run: the question, the file name. */
    title: text('title').notNull(),
    stage: text('stage'),
    detail: text('detail'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    resultRef: text('result_ref'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** The claim order: oldest queued row of a kind first. */
    index('background_jobs_claim_idx').on(t.kind, t.status, t.createdAt),
    /** The digest's read: what changed for a user since a point in time. */
    index('background_jobs_user_updated_idx').on(t.userId, t.updatedAt),
  ],
);

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJob = typeof backgroundJobs.$inferInsert;
