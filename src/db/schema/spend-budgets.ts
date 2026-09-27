import { numeric, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export type SpendScopeKind = 'user' | 'role' | 'workspace';
export type SpendPeriod = 'day' | 'month';

/**
 * Dollar spend budgets — a USD cap summed from `cost_log.total_cost` over a
 * UTC day or month, scoped to the whole user, one agent role, or one
 * workspace. `scope_ref` is NULL for the user scope, the role name or the
 * workspace id otherwise.
 *
 * `warned_at` / `paused_at` are compared against the current period's start,
 * so a stamp from a previous period is inert and the budget rolls over on its
 * own. Enforcement lives in `src/security/spend-budgets.ts`.
 */
export const spendBudgets = pgTable('spend_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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

export type SpendBudget = typeof spendBudgets.$inferSelect;
export type NewSpendBudget = typeof spendBudgets.$inferInsert;
