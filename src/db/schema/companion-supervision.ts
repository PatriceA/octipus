import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { CompanionCompletionEvidence, CompanionGoalState } from '@/shared/companion-supervision';
import { users } from './users';
import { workspaces } from './organizations';
import { sessions } from './sessions';
import { pipelines } from './pipelines';
import { tasks } from './tasks';

export const companionGoals = pgTable('companion_goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  requestKey: uuid('request_key').notNull(),
  title: text('title').notNull(),
  request: text('request').notNull(),
  outcome: text('outcome').notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
  state: text('state').$type<CompanionGoalState>().notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  tokenBudget: integer('token_budget'),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workPlanSessionId: uuid('work_plan_session_id').references(() => sessions.id, { onDelete: 'set null' }),
  protectionLevel: integer('protection_level').notNull().default(1),
  revision: integer('revision').notNull().default(0),
  completionEvidence: jsonb('completion_evidence').$type<CompanionCompletionEvidence[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  uniqueIndex('companion_goals_request_idx').on(t.userId, t.workspaceId, t.requestKey),
  index('companion_goals_scope_idx').on(t.userId, t.workspaceId, t.state),
  check('companion_goals_state_chk', sql`${t.state} IN ('queued', 'active', 'waiting', 'needs_decision', 'paused', 'completed', 'cancelled')`),
  check('companion_goals_priority_chk', sql`${t.priority} BETWEEN 0 AND 3`),
  check('companion_goals_protection_chk', sql`${t.protectionLevel} BETWEEN 1 AND 4`),
  check('companion_goals_budget_chk', sql`${t.tokenBudget} IS NULL OR ${t.tokenBudget} BETWEEN 1 AND 1000000000`),
]);

/** Links describe supervision only. Releasing ownership never stops an execution. */
export const companionSessionLinks = pgTable('companion_session_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').notNull().references(() => companionGoals.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  origin: text('origin').$type<'adopted' | 'created'>().notNull().default('adopted'),
  ownership: text('ownership').$type<'owner' | 'observer'>().notNull().default('owner'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, t => [
  index('companion_links_goal_idx').on(t.goalId),
  index('companion_links_session_idx').on(t.sessionId),
  uniqueIndex('companion_links_session_once_idx').on(t.goalId, t.sessionId).where(sql`${t.pipelineId} IS NULL`),
  uniqueIndex('companion_links_pipeline_once_idx').on(t.goalId, t.pipelineId).where(sql`${t.pipelineId} IS NOT NULL`),
  uniqueIndex('companion_links_session_owner_idx').on(t.sessionId).where(sql`${t.pipelineId} IS NULL AND ${t.active} AND ${t.ownership} = 'owner'`),
  uniqueIndex('companion_links_pipeline_owner_idx').on(t.pipelineId).where(sql`${t.pipelineId} IS NOT NULL AND ${t.active} AND ${t.ownership} = 'owner'`),
  check('companion_links_ownership_chk', sql`${t.ownership} IN ('owner', 'observer')`),
  check('companion_links_origin_chk', sql`${t.origin} IN ('adopted', 'created')`),
]);

export type CompanionGoal = typeof companionGoals.$inferSelect;
export type CompanionSessionLink = typeof companionSessionLinks.$inferSelect;
