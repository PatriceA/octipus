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
 */
export const pluginPackages = pgTable('plugin_packages', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  contentHash: text('content_hash'),
  settings: jsonb('settings').$type<Record<string, string | number | boolean>>().default({}).notNull(),
  installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PluginPackageRow = typeof pluginPackages.$inferSelect;
export type NewPluginPackageRow = typeof pluginPackages.$inferInsert;
