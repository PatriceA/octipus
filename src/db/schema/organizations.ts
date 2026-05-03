import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Organizations + workspaces — Phase 3g multi-user.
 *
 * Schema-only scaffolding for the org/workspace grouping layer
 * described in `docs/architecture/MULTI-USER.md` § 2. The previous
 * phases scoped every isolated row by `user_id`. These tables add an
 * optional grouping above (organizations) and below (workspaces) the
 * user without breaking that contract — no foreign keys are added to
 * existing tables in this phase. Phase 4 wires `workspace_id` onto
 * sessions/documents/etc. once the UI lets users actually switch
 * workspaces.
 *
 * Gated on `multiuser.orgWorkspaces`. Off by default; the REST
 * surface returns 404 when the flag is off so single-user installs
 * see no behavior change.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** URL-safe handle, unique across all orgs. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** User who created the org. NULL after that user is deleted. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  slugIdx: index('organizations_slug_idx').on(table.slug),
  createdByIdx: index('organizations_created_by_idx').on(table.createdBy),
}));

/**
 * Many-to-many: which users belong to which organizations.
 *
 * `role` reserves room for `org_admin` (manage members + org settings)
 * vs the default `member`. Phase 3g doesn't enforce role distinctions
 * — that's layered on once the flag flips on and the admin UI lands.
 */
export const orgMembers = pgTable('org_members', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').default('member').notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.orgId, table.userId] }),
  userIdIdx: index('org_members_user_id_idx').on(table.userId),
}));

/**
 * Per-user workspace — equivalent to a "project" in the product
 * mental model. A user can have many workspaces; one is marked
 * `is_default` (enforced by partial unique index in the migration).
 *
 * `slug` is unique per user, not globally — two different users can
 * each have a workspace named `default`.
 */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('workspaces_user_id_idx').on(table.userId),
  userSlugUq: uniqueIndex('workspaces_user_id_slug_uq').on(table.userId, table.slug),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrgMember = typeof orgMembers.$inferSelect;
export type NewOrgMember = typeof orgMembers.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
