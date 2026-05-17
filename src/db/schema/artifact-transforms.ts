import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';

/**
 * Named transforms attached to an artifact. Pure functions applied at
 * pipeline-build time to source snapshots (or to earlier transforms). The
 * output is keyed by `name` in the data bus and bindable via `{{data.<name>…}}`
 * or widget `bind`.
 */
export const artifactTransforms = pgTable(
  'artifact_transforms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Toolbox tool id, must belong to family 'transform'. */
    toolId: text('tool_id').notNull(),
    /** Name of the upstream source or transform feeding this one. */
    inputName: text('input_name').notNull(),
    paramsJson: jsonb('params_json').$type<Record<string, unknown>>().notNull().default({}),
    /** Lower runs earlier. Ties broken by created_at. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    artifactIdx: index('artifact_transforms_artifact_id_idx').on(table.artifactId),
    artifactNameUq: uniqueIndex('artifact_transforms_artifact_id_name_uq').on(
      table.artifactId,
      table.name,
    ),
  }),
);

export type ArtifactTransform = typeof artifactTransforms.$inferSelect;
export type NewArtifactTransform = typeof artifactTransforms.$inferInsert;
