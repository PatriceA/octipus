import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const permissionLevelEnum = pgEnum('permission_level', ['ALLOW', 'ASK', 'DENY']);

export const toolPermissions = pgTable('skill_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  toolId: text('skill_id').notNull(),
  action: text('action').notNull(), // read, write, execute, etc.
  level: permissionLevelEnum('level').notNull(),
  // Optional conditions
  conditions: jsonb('conditions').$type<PermissionCondition[]>().default([]),
  // Metadata
  grantedBy: uuid('granted_by').references(() => users.id),
  reason: text('reason'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userToolActionUnique: unique('user_skill_action_unique').on(table.userId, table.toolId, table.action),
  userIdIdx: index('skill_permissions_user_id_idx').on(table.userId),
  toolIdIdx: index('skill_permissions_skill_id_idx').on(table.toolId),
}));

export interface PermissionCondition {
  type: 'path_pattern' | 'command_pattern' | 'time_window' | 'rate_limit' | 'ip_whitelist';
  value: string | number | TimeWindow | RateLimitConfig;
}

export interface TimeWindow {
  startHour: number;
  endHour: number;
  daysOfWeek?: number[]; // 0-6, Sunday = 0
  timezone?: string;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

// Permission requests (for ASK level)
export const permissionRequests = pgTable('permission_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  agentId: text('agent_id').notNull(),
  sessionId: uuid('session_id'),
  toolId: text('skill_id').notNull(),
  action: text('action').notNull(),
  context: jsonb('context').$type<PermissionRequestContext>().notNull(),
  status: text('status').notNull().default('pending'), // pending, approved, denied, expired
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at'),
  resolution: text('resolution'), // User's response or reason
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('permission_requests_user_id_idx').on(table.userId),
  statusIdx: index('permission_requests_status_idx').on(table.status),
  agentIdIdx: index('permission_requests_agent_id_idx').on(table.agentId),
}));

export interface PermissionRequestContext {
  toolName: string;
  toolArguments: Record<string, unknown>;
  reason?: string;
  risk?: 'low' | 'medium' | 'high';
  previewResult?: string;
}

export type ToolPermission = typeof toolPermissions.$inferSelect;
export type NewToolPermission = typeof toolPermissions.$inferInsert;
export type PermissionRequest = typeof permissionRequests.$inferSelect;
export type NewPermissionRequest = typeof permissionRequests.$inferInsert;
