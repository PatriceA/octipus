import { pgTable, text, timestamp, uuid, jsonb, integer, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';

export const sessionStatusEnum = pgEnum('session_status', ['active', 'paused', 'completed', 'failed']);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
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

export interface SessionContext {
  workspaceId?: string;
  currentTopic?: string;
  activeAgentId?: string;
  compactedSummary?: string;
  activeCommand?: string;
  planningState?: PlanningState;
  // Development Mode
  devMode?: boolean;
  projectPath?: string;
  projectName?: string;
}

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
