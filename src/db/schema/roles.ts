import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull().unique(),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]).notNull(),
  /**
   * True once a user has edited this role. When set, the boot-time seed stops
   * resyncing ANY field from the role's folder, so an edit — a removed tool, a
   * rewritten prompt, a cleared rule list — survives restarts. When false, the
   * row tracks the code config (code is the default/fallback).
   *
   * It guarded only `toolIds` when roles were editable only from the Tools
   * page; every field it did not guard was silently reverted on the next boot.
   */
  customized: boolean('customized').default(false).notNull(),
  /** Lazy-discovery core set; must be a subset of `toolIds`. */
  coreToolIds: jsonb('core_tool_ids').$type<string[]>().default([]),
  /** Strips the file-mutating handlers — a boundary, not a request. */
  readOnly: boolean('read_only').default(false).notNull(),
  /** The numbered "# Critical Rules" block appended to this role's prompt. */
  criticalRules: jsonb('critical_rules').$type<string[]>().default([]),
  /**
   * The one line the MODEL reads when choosing a role to spawn. Nothing selects
   * a role out of a lane — a role resolves TO a lane — so this is how a new
   * role gets picked at all; without one it is invisible to delegation.
   */
  description: text('description'),
  defaultTopic: text('default_topic').notNull().default('general'),
  systemPromptTemplate: text('system_prompt_template').notNull(),
  isSystem: boolean('is_system').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
