import { sql } from 'drizzle-orm';
import { index, inet, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  // Gateway events
  'gateway_connection_open',
  'gateway_connection_close',
  'gateway_auth_success',
  'gateway_auth_failure',
  'gateway_rate_limit',
  'gateway_connection_rejected',
  // Multi-user phase 0 — generic HTTP request audit, written by the
  // shadow-mode audit middleware on every state-changing API call.
  'api_request',
  // A task was created / updated / completed / deleted, by a user or an agent.
  'task_mutated',
  // An admin read or changed the knowledge base install-wide (`?scope=install`).
  'knowledge_install_access',
  // Shared spaces (docs/plans/coworking-spec.md §5.1): every membership,
  // invite, role and lifecycle change, stamped with the space's workspace_id.
  'space_created',
  'space_updated',
  'space_archived',
  'space_purged',
  'space_member_added',
  'space_member_role_changed',
  'space_member_removed',
  'space_invite_created',
  'space_invite_revoked',
  'space_invite_accepted',
  'space_content_changed',
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
  /** The workspace the action happened in (a space's activity feed). No foreign key: history outlives a purged space. */
  workspaceId: uuid('workspace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('audit_log_user_id_idx').on(table.userId),
  actionIdx: index('audit_log_action_idx').on(table.action),
  resourceTypeIdx: index('audit_log_resource_type_idx').on(table.resourceType),
  createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
  workspaceCreatedIdx: index('audit_log_ws_created_idx').on(table.workspaceId, table.createdAt.desc()).where(sql`${table.workspaceId} IS NOT NULL`),
}));

export interface AuditDetails {
  previousValue?: unknown;
  newValue?: unknown;
  error?: string;
  duration?: number;
  toolName?: string;
  toolId?: string;
  model?: string;
  tokenCount?: number;
  cost?: number;
  [key: string]: unknown;
}

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
