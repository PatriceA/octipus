import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PluginHostScope, PluginManifest } from '@/shared/plugin-package';
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
 * without a valid signature. It is what held at install or approval; the
 * package view recomputes it. `signatureHash` is the sha256 of the signature
 * file's bytes recorded with `contentHash` (null: no signature file): the
 * file is outside the content hash, so it is pinned on its own and compared
 * before every start.
 *
 * `inProcessApprovedHash` is the content hash an admin approved to run in the
 * server process (runtime `in-process`, docs/PLUGIN-PACKAGES.md#runtimes),
 * with who and when; it holds only while it equals `contentHash`, and
 * approving other content clears it.
 */
export const pluginPackages = pgTable('plugin_packages', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  contentHash: text('content_hash'),
  signedBy: text('signed_by'),
  signatureHash: text('signature_hash'),
  inProcessApprovedHash: text('in_process_approved_hash'),
  inProcessApprovedBy: uuid('in_process_approved_by').references(() => users.id, { onDelete: 'set null' }),
  inProcessApprovedAt: timestamp('in_process_approved_at', { withTimezone: true }),
  /**
   * The host API scopes an admin approved (docs/PLUGIN-PACKAGES.md#host-api);
   * null: none yet. Only scopes the manifest declares AND this lists are
   * granted; enabling asks for any declared scope missing here.
   */
  approvedHostScopes: jsonb('approved_host_scopes').$type<PluginHostScope[]>(),
  /**
   * The contributions hash an admin approved (src/plugins/packages/contributions/approval.ts):
   * commands, schedules, events, prompt and context bind only while it equals
   * the package's current one. Null: not approved; install and upgrade clear it.
   */
  approvedContributionsHash: text('approved_contributions_hash'),
  settings: jsonb('settings').$type<Record<string, string | number | boolean>>().default({}).notNull(),
  installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PluginPackageRow = typeof pluginPackages.$inferSelect;
export type NewPluginPackageRow = typeof pluginPackages.$inferInsert;
