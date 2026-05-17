import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';

/**
 * Persistent download exporters attached to an artifact. Each row exposes
 * a `GET /a/:slug/export/:exportId` route. The named tool runs over the
 * current data bus at request time (always-fresh), wrapped by the same
 * auth flow as the embed page (visibility + share token).
 */
export const artifactExports = pgTable(
  'artifact_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Short id used in the URL: `/a/:slug/export/<exportId>`. */
    exportId: text('export_id').notNull(),
    /** Toolbox tool id, must belong to family 'export'. */
    toolId: text('tool_id').notNull(),
    bindJson: jsonb('bind_json').$type<Record<string, string>>().notNull().default({}),
    paramsJson: jsonb('params_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    artifactIdx: index('artifact_exports_artifact_id_idx').on(table.artifactId),
    artifactExportIdUq: uniqueIndex('artifact_exports_artifact_id_export_id_uq').on(
      table.artifactId,
      table.exportId,
    ),
  }),
);

export type ArtifactExport = typeof artifactExports.$inferSelect;
export type NewArtifactExport = typeof artifactExports.$inferInsert;
