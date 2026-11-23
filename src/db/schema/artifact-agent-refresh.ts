import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';
import { users } from './users';

/**
 * Agent-authored refresh of one artifact (docs/ARTIFACTS.md#agent-refresh):
 * the instruction an agent re-runs to regenerate the page, the owner whose
 * permissions and budget the run uses, an optional schedule, and the state
 * of the last attempt. One row per artifact, gone with it (cascade).
 *
 * `runStartedAt` is the in-flight claim: set by a conditional update, so one
 * refresh of an artifact runs at a time across processes. `scheduleChain`
 * names the scheduler chain that may re-arm the schedule; a task of any
 * other chain (the schedule was changed, turned off or re-armed at boot)
 * ends without running.
 */
export const artifactAgentRefresh = pgTable(
  'artifact_agent_refresh',
  {
    artifactId: uuid('artifact_id')
      .primaryKey()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instruction: text('instruction').notNull(),
    /** Minutes between scheduled runs; null = manual refresh only. */
    intervalMinutes: integer('interval_minutes'),
    scheduleChain: text('schedule_chain'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** Why the schedule was switched off by the server (failures, owner disabled, artifact gone). */
    scheduleDisabledReason: text('schedule_disabled_reason'),
    /** The automation session refresh runs are recorded in (created on the first run). */
    sessionId: uuid('session_id'),
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** `success`, `failed` or `refused` (budget, quota, concurrency, not allowed). */
    lastOutcome: text('last_outcome').$type<AgentRefreshOutcome>(),
    lastError: text('last_error'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Scheduled attempts in a row that did not succeed; reset by a success. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: index('artifact_agent_refresh_owner_idx').on(table.ownerUserId),
  }),
);

export type AgentRefreshOutcome = 'success' | 'failed' | 'refused';
export type ArtifactAgentRefresh = typeof artifactAgentRefresh.$inferSelect;
export type NewArtifactAgentRefresh = typeof artifactAgentRefresh.$inferInsert;
