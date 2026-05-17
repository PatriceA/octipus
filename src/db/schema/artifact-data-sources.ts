import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';

export const artifactSourceKindEnum = pgEnum('artifact_source_kind', [
  'tool',
  'http',
  'rss',
  'mcp',
  'skill_query',
  // Toolbox-routed source — see src/core/artifacts/toolbox/. When this kind is
  // used the `tool_id` column points at a registered collector and the
  // legacy kind-switch in refresh.ts is bypassed.
  'toolbox',
]);

export const artifactSourceStatusEnum = pgEnum('artifact_source_status', [
  'ok',
  'error',
  'pending',
]);

/**
 * Data source attached to an artifact. Refresh worker dispatches by `kind`
 * and runs under `principalId` so vault ACLs apply at refresh time. A
 * workspace viewer cannot escalate via someone else's vault secrets.
 */
export const artifactDataSources = pgTable(
  'artifact_data_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: artifactSourceKindEnum('kind').notNull(),
    /**
     * Toolbox collector id when `kind === 'toolbox'`. NULL for legacy rows
     * that dispatch via the kind-switch in refresh.ts. Both columns are kept
     * during the soft-migration window; new code should always set `tool_id`
     * with `kind = 'toolbox'`.
     */
    toolId: text('tool_id'),
    configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull().default({}),
    refreshSeconds: integer('refresh_seconds').notNull().default(300),
    /** Principal whose credentials/ACLs are used at refresh time. Required. */
    principalId: text('principal_id').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: artifactSourceStatusEnum('last_status').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    artifactIdx: index('artifact_data_sources_artifact_id_idx').on(table.artifactId),
    /** Source `name` unique per artifact for stable template binding. */
    artifactNameUq: uniqueIndex('artifact_data_sources_artifact_id_name_uq').on(table.artifactId, table.name),
  }),
);

export type ArtifactDataSource = typeof artifactDataSources.$inferSelect;
export type NewArtifactDataSource = typeof artifactDataSources.$inferInsert;
export type ArtifactSourceKind = (typeof artifactSourceKindEnum.enumValues)[number];
export type ArtifactSourceStatus = (typeof artifactSourceStatusEnum.enumValues)[number];
