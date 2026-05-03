import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const sessionStatusEnum = pgEnum('session_status', ['active', 'paused', 'completed', 'failed']);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  /**
   * Phase 4 — optional workspace scope. NULL means "user-level"
   * (visible to every workspace the user owns); set means "scoped
   * to this workspace only". The FK uses ON DELETE SET NULL so
   * deleting a workspace falls back to user-level rather than
   * cascading the rows away.
   */
  workspaceId: uuid('workspace_id'),
  channelType: text('channel_type').notNull(), // telegram, teams, slack, webchat, api
  channelId: text('channel_id').notNull(),
  threadId: text('thread_id'),
  title: text('title'),
  status: sessionStatusEnum('status').default('active').notNull(),
  context: jsonb('context').$type<SessionContext>().default({}),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  messageCount: integer('message_count').default(0).notNull(),
  tokenCount: integer('token_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export interface PlanningState {
  active: boolean;
  step: number;
  area: string | null;
  answers: Array<{ question: string; answer: string; step: number }>;
  brief: string | null;
  executed?: boolean;
  createdAt: string;
}

/**
 * Per-session compaction effectiveness state.
 *
 * The anti-thrashing guard uses this to avoid looping on compaction passes
 * that fail to meaningfully reduce token usage. See
 * `src/core/orchestrator/session-compaction.ts` for the decision logic.
 */
export interface CompactionState {
  /** ISO timestamp of the most recent compaction pass (effective or not). */
  lastCompactedAt?: string;
  /** Savings ratio of the most recent pass: (before - after) / before. */
  lastSavingsRatio?: number;
  /** Number of consecutive ineffective passes (< minSavingsRatio). */
  ineffectivePasses?: number;
  /** Token count before the most recent compaction pass. */
  lastCompactTokens?: number;
  /**
   * When true, further compaction attempts are suppressed until the session
   * grows past `lastCompactTokens * growthMultiplier` or hits `hardCeiling`.
   * Cleared on an effective pass (>= 15% savings).
   */
  compactionIneffective?: boolean;
}

export interface SessionContext {
  workspaceId?: string;
  currentTopic?: string;
  activeAgentId?: string;
  compactedSummary?: string;
  activeCommand?: string;
  planningState?: PlanningState;
  /**
   * ISO timestamp of a user-initiated context reset (/clear).
   * Orchestrator + directResponse must ignore messages created before this
   * boundary when building system-prompt history.
   */
  clearedAt?: string;
  /** Anti-thrashing compaction guard state. */
  compactionState?: CompactionState;
  // Development Mode
  devMode?: boolean;
  projectPath?: string;
  projectName?: string;
}

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
