import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { PluginHostApproval, PluginManifest, PluginOrigin } from '@/shared/plugin-package';
import { workspaces } from './organizations';
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
   * granted; enabling asks for any declared scope missing here. It may also
   * hold `model:cli-tools`, the approval of the manifest's `model.trustedInput`
   * (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes), which enabling does not ask for.
   */
  approvedHostScopes: jsonb('approved_host_scopes').$type<PluginHostApproval[]>(),
  /**
   * The contributions hash an admin approved (src/plugins/packages/contributions/approval.ts):
   * commands, schedules, events, prompt and context bind only while it equals
   * the package's current one. Null: not approved; install and upgrade clear it.
   */
  approvedContributionsHash: text('approved_contributions_hash'),
  /**
   * Where the installed version came from (docs/PLUGIN-PACKAGES.md#provenance):
   * the marketplace, a named registry, a URL, a directory, the bundled
   * plugins or an agent. Null: installed before provenance was recorded.
   */
  origin: jsonb('origin').$type<PluginOrigin>(),
  settings: jsonb('settings').$type<Record<string, string | number | boolean>>().default({}).notNull(),
  installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PluginPackageRow = typeof pluginPackages.$inferSelect;
export type NewPluginPackageRow = typeof pluginPackages.$inferInsert;

/**
 * The last accepted signed index of each registry (by URL): `generatedAt`
 * only moves forward, so a replayed older index is refused
 * (src/plugins/packages/registry-state.ts).
 */
export const pluginRegistryState = pgTable('plugin_registry_state', {
  registryUrl: text('registry_url').primaryKey(),
  lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }).notNull(),
  lastIndexSha256: text('last_index_sha256').notNull(),
  /** The key id that signed it: an index from a key revoked since does not hold the next one back. */
  lastSignedBy: text('last_signed_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Revocations learnt from the marketplace's signed index
 * (src/plugins/packages/revocations.ts). They accumulate: an index that drops
 * one does not lift it; an admin may clear one (audited), and an index that
 * still lists it revokes it again.
 */
export const pluginRevocations = pgTable('plugin_revocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'package' | 'key'>().notNull(),
  name: text('name'),
  version: text('version'),
  keyId: text('key_id'),
  reason: text('reason').notNull().default(''),
  registryUrl: text('registry_url').notNull(),
  signedByKey: text('signed_by_key').notNull(),
  indexGeneratedAt: timestamp('index_generated_at', { withTimezone: true }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  clearedBy: uuid('cleared_by').references(() => users.id, { onDelete: 'set null' }),
  clearReason: text('clear_reason'),
});

export type PluginRevocationRow = typeof pluginRevocations.$inferSelect;

/** New versions the admins were told about by the daily update check: once per version. */
export const pluginUpdateNotices = pgTable('plugin_update_notices', {
  name: text('name').notNull(),
  version: text('version').notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.name, t.version] })]);

/**
 * The marketplace's last accepted `keys.json` (its signing keys, signed by a
 * built-in root key), with its signature (src/plugins/packages/marketplace-keys-file.ts).
 * Re-verified against the root keys whenever it is read; `version` only moves forward.
 */
export const pluginMarketplaceKeys = pgTable('plugin_marketplace_keys', {
  registryUrl: text('registry_url').primaryKey(),
  version: integer('version').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  body: text('body').notNull(),
  signature: text('signature').notNull(),
  sha256: text('sha256').notNull(),
  signedByRoot: text('signed_by_root').notNull(),
  /** Every signing key any accepted keys.json listed: keys.json may revoke only these (and roots). */
  endorsedKeyIds: jsonb('endorsed_key_ids').$type<string[]>().notNull().default([]),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
});

/** The content hash of each name@version as first listed by each registry (src/plugins/packages/listing-pins.ts). */
export const pluginListingPins = pgTable('plugin_listing_pins', {
  registryUrl: text('registry_url').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').notNull(),
  /** The key that signed the index that first listed it (null: an unsigned registry). A pin of a key revoked since holds nothing. */
  signedBy: text('signed_by'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.registryUrl, t.name, t.version] })]);

/**
 * The per-user plugin store (docs/PLUGIN-PACKAGES.md#store,
 * src/db/repositories/plugin-store-repository.ts): small JSON values a
 * package keeps, per key, separately for each user and workspace
 * (`workspaceId` null: the user's personal one). Every row has a user; there
 * is no store shared across users. `sizeBytes` (128 bytes of overhead, the
 * key, and the value as the database serialises it) counts against the
 * package's quota per user; `protectionLevel` is the call's level when it was
 * written (never lowered by an overwrite), and reading the entry raises the
 * call's level to it; `version` moves by one on every write
 * (compare-and-set). Uninstalling the package, deleting the user or the
 * workspace deletes the rows. Migration 0182 makes the unique index NULLS NOT
 * DISTINCT (drizzle's builder has no such option).
 */
export const pluginStore = pgTable('plugin_store', {
  packageName: text('package_name').notNull().references(() => pluginPackages.name, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: jsonb('value').$type<unknown>().notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  protectionLevel: smallint('protection_level').notNull().default(1),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('plugin_store_key_uq').on(t.packageName, t.userId, t.workspaceId, t.key),
  index('plugin_store_user_idx').on(t.userId),
  index('plugin_store_workspace_idx').on(t.workspaceId),
]);

/**
 * What each (package, user, workspace) keeps in the store: a running total
 * of `plugin_store.size_bytes` and its entries, updated in the same
 * transaction as every write and delete there, so the quota check reads a
 * few rows instead of summing every entry.
 */
export const pluginStoreUsage = pgTable('plugin_store_usage', {
  packageName: text('package_name').notNull().references(() => pluginPackages.name, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  entries: integer('entries').notNull().default(0),
}, (t) => [uniqueIndex('plugin_store_usage_uq').on(t.packageName, t.userId, t.workspaceId)]);

export type PluginStoreRow = typeof pluginStore.$inferSelect;

/**
 * What a plugin package created in the user's mail and calendars through the
 * host API (docs/PLUGIN-PACKAGES.md#mail-and-calendar), so that it may change
 * or send those and nothing else: a draft in a Mail module mailbox
 * (`provider` `mail`, `item_id` the message id), or an event in a connected
 * calendar (`provider` `google` or `microsoft`, the provider's event id).
 * Only the user the call acted for, through the same package, reaches the
 * row. Uninstalling the package deletes its rows, and so does an upgrade to
 * another signer or source: the items stay the user's, no package may change
 * them any more.
 */
export const pluginItems = pgTable('plugin_items', {
  packageName: text('package_name').notNull().references(() => pluginPackages.name, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'mail_draft' | 'calendar_event'>().notNull(),
  provider: text('provider').$type<'mail' | 'google' | 'microsoft'>().notNull(),
  itemId: text('item_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.packageName, t.kind, t.provider, t.itemId] }),
  index('plugin_items_user_idx').on(t.userId),
]);
