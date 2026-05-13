import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user quota overrides — Phase 3c multi-user.
 *
 * One row per user that has had ANY quota explicitly set. Missing
 * rows mean "inherit the global default" (typically read from
 * `config.agent.maxConcurrentAgents`, `config.agent.maxTokenBudget`,
 * `config.api.rateLimitMax`).
 *
 * Each column is independently nullable: an admin can override the
 * concurrent-agent cap without touching the daily token budget.
 * NULL = inherit. The QuotaManager (`src/security/quotas.ts`)
 * resolves the effective value at query time.
 *
 * Phase 3c-1 ships the schema + read-side helpers + admin UI so
 * operators can see per-user usage and set caps. Phase 3c-2 wires
 * enforcement into the agent worker (concurrency + token budget)
 * and rate-limiter (per-user request rate).
 *
 * The table is small (one row per overridden user) and is read on
 * every quota check, so we keep it lean — no JSON, no audit columns
 * beyond `updatedAt` (audit_log already records who changed what
 * via the admin route).
 */
export const userQuotas = pgTable('user_quotas', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** Max concurrent running agents. NULL = inherit global default. */
  maxConcurrentAgents: integer('max_concurrent_agents'),
  /** Max LLM tokens consumed in a UTC day, summed across the user's
   *  agents. NULL = inherit global default. */
  maxTokensPerDay: integer('max_tokens_per_day'),
  /** Max API requests per minute (sliding window). NULL = inherit. */
  maxApiCallsPerMinute: integer('max_api_calls_per_minute'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type UserQuota = typeof userQuotas.$inferSelect;
export type NewUserQuota = typeof userQuotas.$inferInsert;
