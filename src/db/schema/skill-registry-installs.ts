import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Which registry listing (and version) a person installed skills from
 * (docs/SKILL-EXCHANGE.md#registries): what the Skills page compares a
 * registry's newer versions with to show that an update is available. It
 * changes nothing by itself: an update is a new preview and install.
 * `owner_key` is the user id, or `system` for the single-user principal.
 * `registry_url_sha256` keys it to the registry's URL as well as its name
 * (the URL itself is never stored: it may carry a token), so a name reused
 * for another index starts afresh. `history` keeps every version and content
 * hash installed (at most 50), to tell a relabelled old bundle (a rollback)
 * from new content.
 */
/** One install of a listing: its version and content hash. */
export interface SkillRegistryInstallEvent {
  version: string;
  contentHash: string;
  installedAt: string;
}

export const skillRegistryInstalls = pgTable('skill_registry_installs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerKey: text('owner_key').notNull(),
  registry: text('registry').notNull(),
  registryUrlSha256: text('registry_url_sha256').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').notNull(),
  /** The skills that install created or replaced. */
  skillIds: jsonb('skill_ids').$type<string[]>().notNull().default([]),
  history: jsonb('history').$type<SkillRegistryInstallEvent[]>().notNull().default([]),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ownerListing: uniqueIndex('skill_registry_installs_owner_listing_idx').on(table.ownerKey, table.registry, table.registryUrlSha256, table.name),
}));

export type SkillRegistryInstall = typeof skillRegistryInstalls.$inferSelect;
