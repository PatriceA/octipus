import { index, integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { artifactDataSources } from './artifact-data-sources';

/**
 * Bounded snapshot history per source. Cleanup task keeps newest 50.
 * `payloadJson` is the normalized JSON the renderer/SDK consumes.
 */
export const artifactDataSnapshots = pgTable(
  'artifact_data_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => artifactDataSources.id, { onDelete: 'cascade' }),
    payloadJson: jsonb('payload_json').$type<unknown>().notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
    /** Optional advisory TTL (seconds) for downstream caches; 0 = no hint. */
    ttlSeconds: integer('ttl_seconds').notNull().default(0),
  },
  (table) => ({
    sourceCapturedIdx: index('artifact_data_snapshots_source_id_captured_at_idx').on(
      table.sourceId,
      table.capturedAt,
    ),
  }),
);

export type ArtifactDataSnapshot = typeof artifactDataSnapshots.$inferSelect;
export type NewArtifactDataSnapshot = typeof artifactDataSnapshots.$inferInsert;
