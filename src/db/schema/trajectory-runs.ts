import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const trajectoryOutcomeEnum = pgEnum('trajectory_outcome',
  ['success', 'failure', 'partial', 'cancelled']);

export const trajectoryRuns = pgTable('trajectory_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  rootSessionId: uuid('root_session_id').notNull(),
  outcome: trajectoryOutcomeEnum('outcome').notNull(),
  startedAt: timestamp('started_at').notNull(),
  endedAt: timestamp('ended_at').notNull(),
  totalTokens: integer('total_tokens').notNull().default(0),
  jsonlPath: text('jsonl_path').notNull(),
  jsonlLine: integer('jsonl_line').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx: index('trajectory_runs_user_idx').on(t.userId),
  sessionIdx: index('trajectory_runs_session_idx').on(t.rootSessionId),
  outcomeIdx: index('trajectory_runs_outcome_idx').on(t.outcome),
  startedAtIdx: index('trajectory_runs_started_at_idx').on(t.startedAt),
}));

export type TrajectoryRunRecord = typeof trajectoryRuns.$inferSelect;
export type NewTrajectoryRunRecord = typeof trajectoryRuns.$inferInsert;
