import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `local`: an account of this install. `remote` (S7, docs/SPACES.md →
 * Across installs): a member of a space hosted here who lives on another
 * install — a username with a leading `~`, no email, no password, never an
 * admin, and never signed in here (`users_kind_chk`).
 */
export type UserKind = 'local' | 'remote';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** A local username never starts with `~` (`assertLocalUsername`); a remote one always does. */
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  kind: text('kind').$type<UserKind>().default('local').notNull(),
  /** Remote members only: the fingerprint of the install they live on. */
  remoteInstanceId: text('remote_instance_id'),
  /** Remote members only: their user id on that install. */
  remoteUserRef: text('remote_user_ref'),
  passwordHash: text('password_hash'),
  isAdmin: boolean('is_admin').default(false).notNull(),
  /**
   * Whether the account may run on the install's models and keys
   * (`src/models/install-access.ts`). Without it, only on its own models and
   * what a space sponsors. An admin always may. Off only for accounts
   * created on the sign-in page (`security.selfRegisteredInstallModels`) or by
   * an admin's choice.
   */
  installModels: boolean('install_models').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  /**
   * Who switched `isActive` off: 'admin' or 'scim:<orgId>'. Null while active.
   * A SCIM `active: true` never re-enables an admin's deactivation. Written only
   * by `setUserActive` (src/security/user-lifecycle.ts).
   */
  deactivatedBy: text('deactivated_by'),
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
  /** Email triage categories, name → description (src/core/email/service.ts). Unset = presets. */
  emailCategories?: Record<string, string>;
}

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
