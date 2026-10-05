import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { users } from './users';

export const messageRoleEnum = pgEnum('message_role', ['system', 'user', 'assistant', 'tool']);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('tool_calls').$type<ToolCallData[]>(),
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  agentId: text('agent_id'),
  /**
   * The member who wrote a room post (coworking §6.3). Required on every
   * `user` row of a room (the repositories refuse one without it); NULL in
   * personal chats, whose user rows are the session owner's.
   */
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').$type<MessageMetadata>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionIdIdx: index('messages_session_id_idx').on(table.sessionId),
  createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
  agentIdIdx: index('messages_agent_id_idx').on(table.agentId),
}));

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MessageMetadata {
  /** An intermediate public update, distinct from the completed turn's answer. */
  kind?: 'progress';
  sessionGeneration?: string;
  /** Immutable context supplied with this user turn, outside the system prefix. */
  promptContext?: string;
  channelMessageId?: string;
  attachments?: AttachmentData[];
  tokenCount?: number;
  model?: string;
  latencyMs?: number;
  pipelineId?: string;
  stageId?: string;
  pipelineEvent?: string;
  /**
   * The turn was refused by a user cap: `LimitRefusal` from
   * `src/core/errors/limit-refusal.ts` ({ code, reason }). Typed loosely here
   * so the schema does not import core. The web chat renders it as a card.
   */
  limit?: { code: 'SPEND_BUDGET_EXCEEDED' | 'QUOTA_EXCEEDED'; reason: object };
  /** A room post (coworking §6.3): the client's id for the optimistic copy, echoed on `room.message`. */
  clientId?: string;
  /** A room post asked Octipus (the composer toggle, or `@octipus`). */
  addressed?: boolean;
  /** A room answer: the post it answers. */
  replyTo?: string;
  /** A room answer: the member it answers (the turn's requester). */
  requesterId?: string;
  /** A room post the agent made unprompted, in a listen room (coworking §9.3); members rate it. */
  unprompted?: boolean;
}

export interface AttachmentData {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  mimeType: string;
  filename?: string;
  size?: number;
}

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
