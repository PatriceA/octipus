import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const credentialTypeEnum = pgEnum('credential_type', [
  'api_key',
  'oauth_token',
  'password',
  'ssh_key',
  'certificate',
  'other',
]);

/**
 * Vault scope — determines who can read a secret and how it's resolved
 * during secret injection.
 *
 *   - `system`    : app-level credentials (LLM provider keys, OAuth client
 *                   secrets, …). Visible to system-scoped tooling and to
 *                   any user-scoped agent that doesn't override the same
 *                   secret name.
 *   - `user`      : owned by exactly one user (`user_id`). The default.
 *   - `workspace` : owned by a specific workspace within a user. Reserved
 *                   for Phase 2 multi-workspace support; written here so
 *                   the migration doesn't have to touch the enum twice.
 *
 * Phase 1b-1 introduces the column with a backfill: rows with the legacy
 * `user_id = 'system'` sentinel become `scope = 'system'`; everything
 * else becomes `scope = 'user'`. Reads are now strict — `system`-scope
 * lookups only return system rows, no more fallback into user-owned
 * secrets (that fallback was a cross-tenant leak).
 */
export const vaultScopeEnum = pgEnum('vault_scope', ['system', 'user', 'workspace']);

export const vault = pgTable('vault', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Owner. UUID for user/workspace scopes; the literal sentinel string
   * `'system'` for system-scoped rows (kept for backwards compat with
   * pre-Phase-1b inserts that don't yet pass `scope`). New code should
   * set `scope` explicitly and use UUIDs only for user/workspace rows.
   */
  userId: text('user_id').notNull(),
  /**
   * Scope discriminator. Defaults to 'user' for new inserts that don't
   * set it; the migration backfills existing rows.
   */
  scope: vaultScopeEnum('scope').default('user').notNull(),
  /**
   * Phase 4 follow-up — workspace_id binding for `scope='workspace'`
   * rows. Vault.set/get accept this id when the caller wants to
   * narrow a secret to one workspace; reads filter on the column
   * when the request principal carries a workspace context. NULL
   * for system + user scopes (and for legacy workspace-scoped rows
   * written before this migration — they remain visible to every
   * workspace owned by the user).
   */
  workspaceId: uuid('workspace_id'),
  name: text('name').notNull(),
  credentialType: credentialTypeEnum('credential_type').notNull(),
  // Encrypted with AES-256-GCM
  encryptedValue: text('encrypted_value').notNull(),
  encryptionIv: text('encryption_iv').notNull(),
  encryptionAuthTag: text('encryption_auth_tag').notNull(),
  /**
   * Key derivation version.
   *   1 = legacy PBKDF2(masterKey, fixed salt) — same key for every row.
   *   2 = HKDF(masterKey, salt=userId, info=scope+userId) — per-(scope,user)
   *       DEK. New writes use this; reads of v1 rows still work and are
   *       opportunistically re-encrypted to v2 on the next access (in a
   *       follow-up commit).
   */
  keyVersion: integer('key_version').default(1).notNull(),
  // Optional metadata (not encrypted)
  description: text('description'),
  tags: text('tags').array().default([]),
  metadata: jsonb('metadata').$type<VaultMetadata>().default({}),
  // Access control
  allowedTools: text('allowed_skills').array().default([]), // Empty = all tools
  allowedAgents: text('allowed_agents').array().default([]), // Empty = all agents
  // Lifecycle
  isActive: boolean('is_active').default(true).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  accessCount: text('access_count').default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('vault_user_id_idx').on(table.userId),
  nameIdx: index('vault_name_idx').on(table.name),
  typeIdx: index('vault_type_idx').on(table.credentialType),
  scopeIdx: index('vault_scope_idx').on(table.scope),
}));

export type VaultScope = typeof vaultScopeEnum.enumValues[number];

export interface VaultMetadata {
  service?: string;
  environment?: 'production' | 'staging' | 'development';
  rotationPolicy?: {
    enabled: boolean;
    intervalDays: number;
    lastRotated?: string;
  };
  oauthConfig?: {
    provider: string;
    scopes: string[];
    refreshToken?: string;
    expiresAt?: string;
  };
}

export type VaultEntry = typeof vault.$inferSelect;
export type NewVaultEntry = typeof vault.$inferInsert;

// Placeholder patterns for secret injection
export const SECRET_PLACEHOLDER_PATTERN = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;
