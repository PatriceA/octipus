import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PluginManifest } from '@/shared/plugin-package';
import { users } from './users';

/**
 * Installed plugin packages (docs/PLUGIN-PACKAGES.md): install-wide, managed
 * by admins. The package's files live under the plugin directory; this row is
 * what was installed (the manifest as checked at install), whether it runs,
 * and its non-secret settings. Its secrets are vault system rows named
 * `plugin:<name>:<KEY>`.
 *
 * `contentHash` pins the package's files as approved (src/plugins/packages/integrity.ts):
 * recorded at install, upgrade and content approval, checked before every
 * start. Null for a package installed before pinning; its first start records it.
 *
 * `signedBy` names the trusted publisher (`plugins.trustedPublishers`) whose
 * valid signature covered that hash (src/plugins/packages/signature.ts); null
 * for unsigned content, a key not trusted, or content an admin approved
 * without a valid signature.
 */
export const pluginPackages = pgTable('plugin_packages', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  contentHash: text('content_hash'),
  signedBy: text('signed_by'),
  settings: jsonb('settings').$type<Record<string, string | number | boolean>>().default({}).notNull(),
  installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PluginPackageRow = typeof pluginPackages.$inferSelect;
export type NewPluginPackageRow = typeof pluginPackages.$inferInsert;
