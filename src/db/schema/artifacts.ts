import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { workspaces } from './organizations';

export const artifactTypeEnum = pgEnum('artifact_type', [
  'dashboard',
  'table',
  'rss',
  'news',
  'html',
]);

export const artifactVisibilityEnum = pgEnum('artifact_visibility', [
  'private',
  'workspace',
  'signed',
  'public',
]);

/**
 * Live artifact — persistent hosted page tied to a workspace.
 * `currentVersionId` points at the active row in `artifact_versions`.
 * Soft-deleted via `deletedAt`; cleanup task purges after 30d.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set when an agent created the artifact (matches `agents.id` text PK). */
    createdByAgentId: text('created_by_agent_id'),
    title: text('title').notNull(),
    type: artifactTypeEnum('type').notNull(),
    visibility: artifactVisibilityEnum('visibility').notNull().default('workspace'),
    currentVersionId: uuid('current_version_id'),
    /** Per-artifact iframe allow-list (Phase 3 — `allowed_embed_origins`). */
    allowedEmbedOrigins: jsonb('allowed_embed_origins').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    workspaceIdx: index('artifacts_workspace_id_idx').on(table.workspaceId),
    /** Slug unique per workspace, not globally. */
    workspaceSlugUq: uniqueIndex('artifacts_workspace_id_slug_uq').on(table.workspaceId, table.slug),
    createdByUserIdx: index('artifacts_created_by_user_id_idx').on(table.createdByUserId),
  }),
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type ArtifactType = (typeof artifactTypeEnum.enumValues)[number];
export type ArtifactVisibility = (typeof artifactVisibilityEnum.enumValues)[number];
