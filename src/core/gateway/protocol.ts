import { z } from 'zod';

// ── Trust Levels ──────────────────────────────────────────────────

export type TrustLevel = 'user' | 'local' | 'system' | 'agent';

export const TRUST_LEVELS: Record<TrustLevel, number> = {
  agent: 0,
  user: 1,
  local: 2,
  system: 3,
};

// ── Client Types ──────────────────────────────────────────────────

export type ClientType = 'webchat' | 'tui' | 'channel' | 'mobile' | 'acp' | 'agent';

// ── Connection Context ────────────────────────────────────────────

export interface ConnectionContext {
  connectionId: string;
  userId: string;
  sessionId?: string;
  clientType: ClientType;
  trustLevel: TrustLevel;
  ip: string;
  connectedAt: number;
  lastActivityAt: number;
  eventSubscriptions: Set<string>;
  metadata: Record<string, unknown>;
}

// ── Gateway Events ────────────────────────────────────────────────

/**
 * Discriminator for events flowing through the gateway event bus.
 * New event types must be added here so subscribers can be type-checked
 * against typos and stale references.
 */
export type GatewayEventType =
  // Agent lifecycle
  | 'agent.spawned'
  | 'agent.completed'
  | 'agent.stopped'
  | 'agent.event'
  // Worker (orchestrator-spawned) lifecycle
  | 'worker_spawned'
  | 'worker_completed'
  // Pipeline + team
  | 'pipeline_event'
  | 'pipeline.event'
  | 'team.started'
  | 'team.completed'
  // Swarm (Phase 1 + Phase 2)
  | 'swarm.node_spawned'
  | 'swarm.node_completed'
  | 'swarm.node_status'
  | 'swarm.budget_warning'
  | 'swarm.call_graph_cycle_blocked'
  // Channel-side status
  | 'status_update'
  | 'typing'
  | 'message'
  // Chat
  | 'chat.response'
  | 'chat.message'
  // Approval / permission flows
  | 'approval_required'
  | 'orchestrator.approval_required'
  | 'orchestrator.status'
  | 'permission.request'
  // Session
  | 'session.cleared'
  | 'session.compaction_stalled'
  // Audit (catch-all for connection-manager audit signals — payload carries
  // the specific audit event name in `originalType`).
  | 'audit'
  // Extensions (user-authored)
  | 'extension.notify'
  // Live Artifacts (Phase 8)
  | 'artifact.data_updated'
  | 'artifact.version_updated'
  | 'artifact.source_error'
  // Reserved
  | 'test.event'
  | 'error';

export interface GatewayEvent {
  id: string;
  type: GatewayEventType;
  source: string;
  userId?: string;
  sessionId?: string;
  timestamp: number;
  payload: unknown;
}

// ── Client → Gateway Messages ─────────────────────────────────────

export const AuthMessageSchema = z.object({
  type: z.literal('auth'),
  method: z.enum(['session_token', 'api_key', 'hmac', 'local']),
  credentials: z.record(z.string(), z.unknown()),
  clientType: z.enum(['webchat', 'tui', 'channel', 'mobile', 'acp', 'agent']),
  clientVersion: z.string().optional(),
});

export const ChatSendSchema = z.object({
  type: z.literal('chat.send'),
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(100_000),
  expertId: z.string().optional(),
  projectPath: z.string().optional(),
  attachments: z.array(z.object({
    name: z.string(),
    mimeType: z.string(),
    data: z.string(),
  })).optional(),
});

export const CommandSchema = z.object({
  type: z.literal('command'),
  name: z.string().min(1).max(50),
  args: z.record(z.string(), z.string()).optional(),
});

export const SubscribeSchema = z.object({
  type: z.literal('subscribe'),
  patterns: z.array(z.string().min(1).max(100)).min(1).max(50),
});

export const UnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  patterns: z.array(z.string().min(1).max(100)).min(1).max(50),
});

export const PermissionRespondSchema = z.object({
  type: z.literal('permission.respond'),
  requestId: z.string(),
  approved: z.boolean(),
});

export const ApprovalRespondSchema = z.object({
  type: z.literal('approval.respond'),
  requestId: z.string(),
  response: z.string(),
  approved: z.boolean(),
});

export const AgentStopSchema = z.object({
  type: z.literal('agent.stop'),
  agentId: z.string(),
});

export const PingSchema = z.object({
  type: z.literal('ping'),
});

// Union of all client messages
export const ClientMessageSchema = z.discriminatedUnion('type', [
  AuthMessageSchema,
  ChatSendSchema,
  CommandSchema,
  SubscribeSchema,
  UnsubscribeSchema,
  PermissionRespondSchema,
  ApprovalRespondSchema,
  AgentStopSchema,
  PingSchema,
]);

export type AuthMessage = z.infer<typeof AuthMessageSchema>;
export type ChatSendMessage = z.infer<typeof ChatSendSchema>;
export type CommandMessage = z.infer<typeof CommandSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ── Gateway → Client Messages ─────────────────────────────────────

export interface AuthOkMessage {
  type: 'auth_ok';
  connectionId: string;
  sessionId?: string;
  userId: string;
  capabilities: string[];
  serverTime: string;
  serverTimezone: string;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: string;
}

export interface EventMessage {
  type: 'event';
  event: GatewayEvent;
}

export interface CommandResultMessage {
  type: 'command.result';
  name: string;
  result: unknown;
  error?: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  serverTime: string;
}

export interface EventsDroppedMessage {
  type: 'events_dropped';
  count: number;
  reason: string;
}

export type GatewayMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | EventMessage
  | CommandResultMessage
  | ErrorMessage
  | PongMessage
  | EventsDroppedMessage;

// ── Protocol Version ──────────────────────────────────────────────

export const PROTOCOL_VERSION = '1.0';
export const SUPPORTED_VERSIONS = ['1.0'];

// ── Connection States ─────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'authenticating' | 'active' | 'draining' | 'closed';

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Validate a raw JSON message from a client.
 * Returns the parsed message or null if invalid.
 */
export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    const firstError = result.error.issues[0];
    return { ok: false, error: `Invalid message: ${firstError?.path.join('.')} — ${firstError?.message}` };
  }

  return { ok: true, message: result.data };
}

/**
 * Check if an event type matches a subscription pattern.
 * Supports: exact match, prefix wildcard (e.g., "agent.*"), global wildcard ("*")
 */
export function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + '.');
  }
  return false;
}
