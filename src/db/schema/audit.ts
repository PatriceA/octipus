import { pgTable, text, timestamp, uuid, jsonb, inet, index, pgEnum } from 'drizzle-orm/pg-core';

export const auditActionEnum = pgEnum('audit_action', [
  'login',
  'logout',
  'login_failed',
  'session_created',
  'session_completed',
  'message_sent',
  'tool_executed',
  'permission_requested',
  'permission_granted',
  'permission_denied',
  'credential_accessed',
  'credential_created',
  'credential_updated',
  'credential_deleted',
  'settings_changed',
  'user_created',
  'user_updated',
  'user_deleted',
  'agent_spawned',
  'agent_completed',
  'agent_failed',
  'hook_triggered',
  'mcp_connected',
  'mcp_disconnected',
]);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id'), // UUID for users, 'system' for system operations
  action: auditActionEnum('action').notNull(),
  resourceType: text('resource_type'), // session, message, credential, agent, etc.
  resourceId: text('resource_id'),
  details: jsonb('details').$type<AuditDetails>().default({}),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  channelType: text('channel_type'),
  sessionId: uuid('session_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('audit_log_user_id_idx').on(table.userId),
  actionIdx: index('audit_log_action_idx').on(table.action),
  resourceTypeIdx: index('audit_log_resource_type_idx').on(table.resourceType),
  createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
}));

export interface AuditDetails {
  previousValue?: unknown;
  newValue?: unknown;
  error?: string;
  duration?: number;
  toolName?: string;
  skillId?: string;
  model?: string;
  tokenCount?: number;
  cost?: number;
  [key: string]: unknown;
}

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
