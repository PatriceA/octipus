import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { InlineUiView, InlineUiViewState } from '@/shared/inline-ui/view/types';
import { sessions } from './sessions';
import { users } from './users';

/**
 * Interactive answers ("inline UI", docs/plans/inline-ui-spec.md): the source
 * of an `octi-ui` block the root agent wrote in a reply. The reply itself keeps
 * a marker line, `[[octi-ui:<id>|<title>]]`; the web fetches the source by id
 * and renders it — an HTML block in a sandboxed frame, a view
 * (docs/plans/inline-ui-views-spec.md) as native components. Session content:
 * deleted with the session.
 */
export const inlineUiBlocks = pgTable('inline_ui_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  /** The turn that wrote it: the per-reply cap and log correlation. */
  runId: text('run_id').notNull(),
  agentId: text('agent_id'),
  /** Who asked (a room's requester; the owner in a personal chat). */
  requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  /** `html`: css/html/js below. `view`: a declarative view in `view`; css/html/js are empty. */
  kind: text('kind').$type<'html' | 'view'>().notNull().default('html'),
  /** The normalized view (`lintInlineUiView(…, { closed: true }).view`); null for an HTML block. */
  view: jsonb('view').$type<InlineUiView>(),
  /** A view's last answer: the data model at the click and the event (spec §4); null until answered. */
  state: jsonb('state').$type<InlineUiViewState>(),
  heightHint: integer('height_hint').notNull().default(320),
  css: text('css').notNull().default(''),
  html: text('html').notNull().default(''),
  js: text('js').notNull().default(''),
  /** `js` is non-empty: the block runs code when shown. */
  scripts: boolean('scripts').notNull(),
  /**
   * The session's flow label had `suspicious`, `private` or `secret` when the
   * block was written (src/security/flow-guard.ts): its script waits for a
   * click before it runs.
   */
  tainted: boolean('tainted').notNull().default(false),
  /** `high`: the label had `secret`, or `private` with `suspicious` — the click comes with a warning. */
  risk: text('risk').$type<'normal' | 'high'>().notNull().default('normal'),
  /** Lint codes of parts the frame will remove or that will not run (spec §4.3). */
  issues: jsonb('issues').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionCreatedIdx: index('inline_ui_blocks_session_created_idx').on(table.sessionId, table.createdAt),
  sessionRunIdx: index('inline_ui_blocks_session_run_idx').on(table.sessionId, table.runId),
}));

export type InlineUiBlock = typeof inlineUiBlocks.$inferSelect;
export type NewInlineUiBlock = typeof inlineUiBlocks.$inferInsert;
