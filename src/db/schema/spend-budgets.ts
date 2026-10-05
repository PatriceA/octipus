import { numeric, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { users } from './users';

export type SpendScopeKind = 'user' | 'role' | 'workspace' | 'group_channel' | 'space' | 'space_member';
/** Budget kinds of a space (§9.2): filed under the space, `user_id` is their author only. */
export const SPACE_SCOPE_KINDS = ['space', 'space_member'] as const;
export type SpaceScopeKind = (typeof SPACE_SCOPE_KINDS)[number];
export type SpendPeriod = 'day' | 'month';

/**
 * Dollar spend budgets — a USD cap summed from `cost_log.total_cost` over a
 * UTC day or month, scoped to the whole user, one agent role, one workspace,
 * or one group channel. `scope_ref` is NULL for the user scope, the role
 * name, the workspace id or the group channel's id otherwise. A group
 * channel budget counts every member's spend in the channel's sessions; it
 * is filed under the channel's owner (who is notified), one per channel and
 * period (migration 0123).
 *
 * A space budget (`space`, `space_member`, migration 0132) is keyed by the
 * space id in `scope_ref`, one per kind and period; `user_id` is the owner
 * who wrote it (author only, SET NULL with their account). `space` caps what
 * the sponsor pays in the space, `space_member` each member's share of it.
 *
 * `warned_at` / `paused_at` are compared against the current period's start,
 * so a stamp from a previous period is inert and the budget rolls over on its
 * own. Enforcement lives in `src/security/spend-budgets.ts`.
 */
export const spendBudgets = pgTable('spend_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The budget's user; for a space budget its author only (nullable, SET NULL). */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  scopeKind: text('scope_kind').$type<SpendScopeKind>().notNull(),
  scopeRef: text('scope_ref'),
  period: text('period').$type<SpendPeriod>().notNull(),
  limitUsd: numeric('limit_usd').notNull(),
  warnRatio: real('warn_ratio').notNull().default(0.8),
  warnedAt: timestamp('warned_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('spend_budgets_scope_uniq').on(t.userId, t.scopeKind, t.scopeRef, t.period)]);

/**
 * The per-member cap's notices (§9.2): the cap is checked from `cost_log`
 * for each member, and its once-per-period warning and pause are stamped
 * here per member, never on the shared budget row (a member at their cap
 * does not pause the others).
 */
export const spaceMemberNotices = pgTable('space_member_notices', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  period: text('period').$type<SpendPeriod>().notNull(),
  warnedAt: timestamp('warned_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId, t.period] })]);

export type SpendBudget = typeof spendBudgets.$inferSelect;
export type NewSpendBudget = typeof spendBudgets.$inferInsert;
