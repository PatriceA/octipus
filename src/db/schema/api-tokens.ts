import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Personal access tokens — Phase 2a multi-user.
 *
 * Lets non-browser clients (CI, MCP servers, scripts, the browser
 * extension) authenticate as a real user instead of using the legacy
 * `MASTER_KEY` Bearer fallback. The fallback is suppressed when
 * `multiuser.enabled = true`; this table replaces it.
 *
 * Token format: `octi_<43-char-base64url>` — 32 bytes of randomness +
 * a stable `octi_` prefix that makes the token recognizable in logs
 * and grep. The plaintext is shown ONCE at creation time and never
 * stored; only the SHA-256 hash lives in the DB.
 *
 * `prefix` stores the first 8 plaintext characters (e.g. `octi_abc`)
 * so the list endpoint can show a recognizable handle without ever
 * exposing the full secret. The hash column is unique-indexed for
 * O(1) validation lookup on every Bearer request.
 *
 * `scopes` is reserved for fine-grained scoping in a later phase
 * (`['read:sessions', 'write:agents']` etc.). Empty array means
 * "full access as the owning user" — same authority the user has via
 * their own session login. Phase 2a does not interpret `scopes` yet
 * but ships the column so the API contract is stable.
 *
 * Lifecycle columns:
 *   - `expires_at`     — nullable; null = never expires.
 *   - `last_used_at`   — updated on successful validation; lets the
 *                        user / admin spot stale tokens.
 *   - `revoked_at`     — soft-delete. Validation rejects rows where
 *                        this is non-null. We keep the row so an
 *                        operator can audit which token was used
 *                        before revocation.
 */
export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  scopes: text('scopes').array().default([]).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  expiresAt: timestamp('expires_at'),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('api_tokens_user_id_idx').on(table.userId),
  tokenHashIdx: index('api_tokens_token_hash_idx').on(table.tokenHash),
  revokedAtIdx: index('api_tokens_revoked_at_idx').on(table.revokedAt),
}));

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;

/**
 * Public-facing shape — never exposes the hash or other internals.
 * Used by the list endpoint and the create response (for everything
 * except the one-time plaintext).
 */
export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}
