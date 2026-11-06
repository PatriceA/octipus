import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  attachments:jsonb('attachments').$type<import('@/core/session-files').AttachedFileRef[]>().notNull().default([]),
  requestKey: uuid('request_key').notNull(),
  title: text('title').notNull(),
  request: text('request').notNull(),
  outcome: text('outcome').notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
  state: text('state').$type<CompanionGoalState>().notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  tokenBudget: integer('token_budget'),
  dependencies: jsonb('dependencies').$type<string[]>().notNull().default([]),
  executionPolicy: jsonb('execution_policy').$type<{ profile: unknown; approvedBy: string; approvedAt: string } | null>(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workPlanSessionId: uuid('work_plan_session_id').references(() => sessions.id, { onDelete: 'set null' }),
  sourceSessionId: uuid('source_session_id').references(() => sessions.id, { onDelete: 'set null' }),
  flowLabel: jsonb('flow_label').$type<Partial<Record<'private' | 'suspicious' | 'secret', string>>>().notNull().default({}),
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

export const companionActions = pgTable('companion_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').notNull().references(() => companionGoals.id, { onDelete: 'cascade' }),
  attachments:jsonb('attachments').$type<import('@/core/session-files').AttachedFileRef[]>().notNull().default([]),
  requestKey: uuid('request_key').notNull(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  generation: text('generation').notNull().default(''),
  authoritySettingsId: uuid('authority_settings_id'),
  authorityRevision: integer('authority_revision'),
  tokenCap: integer('token_cap'),
  incidentId: uuid('incident_id'),
  strategyIndex: integer('strategy_index'),
  protectionLevel: integer('protection_level').notNull().default(1),
  flowLabel: jsonb('flow_label').$type<CompanionGoal['flowLabel']>().notNull().default({}),
  pipelineId:uuid('pipeline_id').references(()=>pipelines.id,{onDelete:'set null'}),
  kind: text('kind').$type<'start_session' | 'message_session' | 'steer_session' | 'resume_pipeline'>().notNull(),
  message: text('message').notNull(),
  status: text('status').$type<'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled'>().notNull().default('queued'),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  result: text('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('companion_actions_request_idx').on(t.goalId, t.requestKey), index('companion_actions_due_idx').on(t.status, t.createdAt),
  uniqueIndex('companion_actions_session_claim_idx').on(t.sessionId).where(sql`${t.status} IN ('running', 'unknown') AND ${t.kind} <> 'steer_session'`),
  check('companion_actions_kind_chk', sql`${t.kind} IN ('start_session', 'message_session', 'steer_session','resume_pipeline')`),
  check('companion_actions_status_chk', sql`${t.status} IN ('queued', 'running', 'completed', 'failed', 'unknown', 'cancelled')`),
]);
export type CompanionAction = typeof companionActions.$inferSelect;

export const companionSettings = pgTable('companion_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  modelName: text('model_name').notNull().default(''),
  autonomy: text('autonomy').$type<'observe' | 'coordinate' | 'repair'>().notNull().default('observe'),
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  supervisorSessionId: uuid('supervisor_session_id').references(() => sessions.id, { onDelete: 'set null' }),
  revision: integer('revision').notNull().default(0),
  reconciledRevision: integer('reconciled_revision').notNull().default(-1),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('companion_settings_scope_idx').on(t.userId, t.workspaceId)]);

export const companionEvents = pgTable('companion_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  goalId: uuid('goal_id').notNull().references(() => companionGoals.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id'),
  kind: text('kind').notNull(), sourceId: text('source_id').notNull(), state: text('state').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('companion_events_pending_idx').on(t.consumedAt, t.seq), index('companion_events_goal_idx').on(t.goalId, t.seq),
  uniqueIndex('companion_events_stall_idx').on(t.goalId, t.kind, t.sourceId).where(sql`${t.kind} = 'stall'`)]);

export const companionWakes = pgTable('companion_wakes', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull().references(() => companionSettings.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  generation: text('generation').notNull().default(''),
  status: text('status').$type<'running' | 'completed' | 'failed' | 'unknown'>().notNull(),
  tokenCap: integer('token_cap'),
  eventSeqs: jsonb('event_seqs').$type<number[]>().notNull(),
  leaseToken: uuid('lease_token').notNull(), leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  result: text('result'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('companion_wakes_active_idx').on(t.settingsId).where(sql`${t.status} IN ('running','unknown')`)]);

export const companionIncidents = pgTable('companion_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').notNull().references(() => companionGoals.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  fingerprint: text('fingerprint').notNull(),
  category: text('category').notNull(),
  summary: text('summary').notNull(),
  state: text('state').$type<'observed' | 'repairing' | 'verifying' | 'resolved' | 'escalated'>().notNull().default('observed'),
  attemptLimit:integer('attempt_limit'),
  attemptAllowance:integer('attempt_allowance').notNull().default(0),
  attemptApprovals:jsonb('attempt_approvals').$type<Array<{userId:string;at:string;additionalStrategies:number;ownerTurnId?:string}>>().notNull().default([]),
  strategies: jsonb('strategies').$type<string[]>().notNull().default([]),
  evidenceId: uuid('evidence_id'),
  revision: integer('revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('companion_incidents_identity_idx').on(t.goalId, t.sessionId, t.fingerprint)]);

export const companionActivations = pgTable('companion_activations', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').notNull().references(() => companionGoals.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  requestKey: uuid('request_key').notNull(), authorityRevision: integer('authority_revision').notNull(), binding: text('binding').notNull(), root: text('root').notNull(),
  status: text('status').$type<'queued' | 'launched' | 'restarted' | 'reconciled' | 'failed' | 'unknown'>().notNull().default('queued'),
  resumeGenerations:jsonb('resume_generations').$type<Record<string,string>>().notNull().default({}),
  resumeIds: jsonb('resume_ids').$type<string[]>().notNull().default([]), result: text('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('companion_activations_request_idx').on(t.goalId, t.requestKey),
  uniqueIndex('companion_activations_active_idx').on(sql`(true)`).where(sql`${t.status} IN ('queued','launched','unknown')`)]);

export const companionClaims = pgTable('companion_claims', {
  resource: text('resource').primaryKey(),
  actionId: uuid('action_id').notNull().references(() => companionActions.id,{onDelete:'cascade'}),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});

export const companionClaimMutex=pgTable('companion_claim_mutex',{id:text('id').primaryKey()});
export const companionStageReservations=pgTable('companion_stage_reservations',{
 pipelineId:uuid('pipeline_id').primaryKey().references(()=>pipelines.id,{onDelete:'cascade'}),
 goalId:uuid('goal_id').notNull().references(()=>companionGoals.id,{onDelete:'cascade'}),tokens:integer('tokens').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
