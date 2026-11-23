import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';
import { users } from './users';

/**
 * Append-only version history for an artifact. Each save creates a new row;
 * `artifacts.current_version_id` points to the active one. `htmlTemplate` is
 * the server-rendered template body; `jsBundleSha256`/`css` only set when
 * the version ships a custom JS bundle (Phase 6).
 */
export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    htmlTemplate: text('html_template').notNull().default(''),
    jsBundleSha256: text('js_bundle_sha256'),
    css: text('css').notNull().default(''),
    schemaJson: text('schema_json').notNull().default('{}'),
    changeSummary: text('change_summary').notNull().default(''),
    /**
     * `none`: this version reaches nothing — served with the closed embed
     * policy (no fetch, socket or external image, style, font or frame),
     * whatever the artifact's own `network`. Set on a page an agent refresh
     * wrote from the owner's knowledge base (docs/ARTIFACTS.md#agent-refresh),
     * and carried by a restore; a hand edit or a web refresh writes `default`.
     */
    network: text('network').$type<'default' | 'none'>().notNull().default('default'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    artifactIdx: index('artifact_versions_artifact_id_idx').on(table.artifactId),
    createdAtIdx: index('artifact_versions_created_at_idx').on(table.createdAt),
  }),
);

export type ArtifactVersion = typeof artifactVersions.$inferSelect;
export type NewArtifactVersion = typeof artifactVersions.$inferInsert;
