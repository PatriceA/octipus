import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  isAdmin: boolean('is_admin').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  /**
   * Optional organization grouping. Phase 0 ships the column nullable so
   * single-user installs don't have to fabricate an org. Phase 3 layers
   * an `organizations` table on top and starts populating this column.
   */
  orgId: uuid('org_id'),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  passkeyCredentials: jsonb('passkey_credentials').$type<PasskeyCredential[]>().default([]),
  channelBindings: jsonb('channel_bindings').$type<ChannelBinding[]>().default([]),
  preferences: jsonb('preferences').$type<UserPreferences>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export interface PasskeyCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceName?: string;
  createdAt: string;
}

// Canonical definition lives in the dependency-free shared module so the web UI
// can import the same type instead of re-declaring it (M19). Imported for local
// use below and re-exported for existing `from '@/db/schema/users'` consumers.
import type { ChannelBinding } from '@/shared/types';
export type { ChannelBinding };

export interface UserPreferences {
  theme?: 'light' | 'dark' | 'system';
  language?: string;
  notificationsEnabled?: boolean;
  defaultModel?: string;
  timezone?: string;
}

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
