import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * A user's context hooks (docs/CONTEXT-HOOKS.md): what Octipus puts in front
 * of the agent before it starts, without the agent having to ask. The
 * built-in hooks need no row; a row with `builtin` set stores the user's
 * change to one (switched off, a different budget), and a row without it is
 * a hook the user added.
 */
export const contextHooks = pgTable('context_hooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The built-in hook this row changes (`knowledge-recall`, `notes-index`); null for the user's own. */
  builtin: text('builtin'),
  name: text('name').notNull(),
  /** 'recall' | 'note' | 'notes_index' (core/context-hooks/kinds.ts). */
  kind: text('kind').notNull(),
  /** 'turn_start' and/or 'worker_start'. */
  events: text('events').array().notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('context_hooks_user_idx').on(t.userId),
  uniqueIndex('context_hooks_builtin_idx').on(t.userId, t.builtin),
]);

/** What one hook did for one turn. Ids, titles and numbers: no query text, no content. */
export interface ContextHookRunRecord {
  hook: string;
  kind: string;
  status: 'injected' | 'abstained' | 'skipped' | 'error';
  reason?: string;
  items: Array<{ id: string; sourceId: string; title: string; score: number }>;
  tokens: number;
  latencyMs: number;
}

/**
 * One agent start with context hooks run: what was injected, and what the
 * agent then did with it — whether it searched the knowledge base or notes
 * itself, and whether its answer named an injected source. The numbers
 * behind GET /api/context-hooks/stats.
 */
export const contextTurns = pgTable('context_turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  /** 'turn_start' (a root turn) or 'worker_start' (a specialist or role agent). */
  event: text('event').notNull(),
  /** The agent role (`general` for a root turn). */
  role: text('role'),
  channel: text('channel'),
  agentId: text('agent_id'),
  model: text('model'),
  /** Whether the agent ran as a vendor CLI (Claude Code, Codex, …). */
  cli: boolean('cli'),
  hooks: jsonb('hooks').$type<ContextHookRunRecord[]>().notNull().default([]),
  injectedItems: integer('injected_items').notNull().default(0),
  tokens: integer('tokens').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  /** Knowledge-base reads (search_knowledge, read_knowledge, …) while the turn ran. Null until it finished. */
  knowledgeToolCalls: integer('knowledge_tool_calls'),
  /** Note reads (search_notes, read_note, …) while the turn ran. */
  notesToolCalls: integer('notes_tool_calls'),
  /** Injected sources the answer named. */
  citedItems: integer('cited_items'),
  outcome: text('outcome'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  index('context_turns_user_idx').on(t.userId, t.createdAt),
]);

export type ContextHookRow = typeof contextHooks.$inferSelect;
export type ContextTurnRow = typeof contextTurns.$inferSelect;
