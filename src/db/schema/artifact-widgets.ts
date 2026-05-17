import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';

/**
 * Widget instances attached to an artifact. Each row is one rendered block
 * on the page, resolved via `<x-widget id="<slot>"/>` placeholders in the
 * template OR auto-laid-out by `position` when the artifact has no
 * template. `bind_json` maps widget input names to data-bus paths like
 * `"issues.items"`; the renderer resolves those paths at render time.
 */
export const artifactWidgets = pgTable(
  'artifact_widgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Template tag id used to resolve placement, e.g. "<x-widget id='kpi_stars'/>". Unique per artifact. */
    slot: text('slot').notNull(),
    /** Toolbox tool id, must belong to family 'widget'. */
    toolId: text('tool_id').notNull(),
    /** Map of widget-input-name → data-bus path. */
    bindJson: jsonb('bind_json').$type<Record<string, string>>().notNull().default({}),
    paramsJson: jsonb('params_json').$type<Record<string, unknown>>().notNull().default({}),
    /** Used by the default layout when no template is set. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    artifactIdx: index('artifact_widgets_artifact_id_idx').on(table.artifactId),
    artifactSlotUq: uniqueIndex('artifact_widgets_artifact_id_slot_uq').on(
      table.artifactId,
      table.slot,
    ),
  }),
);

export type ArtifactWidget = typeof artifactWidgets.$inferSelect;
export type NewArtifactWidget = typeof artifactWidgets.$inferInsert;
