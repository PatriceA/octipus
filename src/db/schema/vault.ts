import { pgTable, text, timestamp, uuid, jsonb, boolean, index, pgEnum } from 'drizzle-orm/pg-core';

export const credentialTypeEnum = pgEnum('credential_type', [
  'api_key',
  'oauth_token',
  'password',
  'ssh_key',
  'certificate',
  'other',
]);

export const vault = pgTable('vault', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // UUID for user credentials, 'system' for app-level credentials
  name: text('name').notNull(),
  credentialType: credentialTypeEnum('credential_type').notNull(),
  // Encrypted with AES-256-GCM
  encryptedValue: text('encrypted_value').notNull(),
  encryptionIv: text('encryption_iv').notNull(),
  encryptionAuthTag: text('encryption_auth_tag').notNull(),
  // Optional metadata (not encrypted)
  description: text('description'),
  tags: text('tags').array().default([]),
  metadata: jsonb('metadata').$type<VaultMetadata>().default({}),
  // Access control
  allowedTools: text('allowed_tools').array().default([]), // Empty = all tools
  allowedAgents: text('allowed_agents').array().default([]), // Empty = all agents
  // Lifecycle
  isActive: boolean('is_active').default(true).notNull(),
  expiresAt: timestamp('expires_at'),
  lastAccessedAt: timestamp('last_accessed_at'),
  accessCount: text('access_count').default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('vault_user_id_idx').on(table.userId),
  nameIdx: index('vault_name_idx').on(table.name),
  typeIdx: index('vault_type_idx').on(table.credentialType),
}));

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
