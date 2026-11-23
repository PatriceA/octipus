import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Which registry listing (and version) a person installed skills from
 * (docs/SKILL-EXCHANGE.md#registries): what the Skills page compares a
 * registry's newer versions with to show that an update is available. It
 * changes nothing by itself: an update is a new preview and install.
 * `owner_key` is the user id, or `system` for the single-user principal.
 */
export const skillRegistryInstalls = pgTable('skill_registry_installs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerKey: text('owner_key').notNull(),
  registry: text('registry').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').notNull(),
  /** The skills that install created or replaced. */
  skillIds: jsonb('skill_ids').$type<string[]>().notNull().default([]),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ownerListing: uniqueIndex('skill_registry_installs_owner_listing_idx').on(table.ownerKey, table.registry, table.name),
}));

export type SkillRegistryInstall = typeof skillRegistryInstalls.$inferSelect;
