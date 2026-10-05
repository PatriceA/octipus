import { randomUUID } from 'node:crypto';
import type { GuestScope } from '@/shared/spaces';
import {
  boolean,
  index,
  integer,
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
 * Always on: every real user has at least a default workspace.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** URL-safe handle, unique across all orgs. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** User who created the org. NULL after that user is deleted. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.orgId, table.userId] }),
  userIdIdx: index('org_members_user_id_idx').on(table.userId),
}));

/**
 * A workspace — equivalent to a "project" in the product mental model.
 *
 * - `kind = 'personal'`: owned by `user_id`. A user can have many; one is
 *   marked `is_default` (enforced by partial unique index in the migration).
 *   `slug` is unique per user, not globally — two different users can each
 *   have a workspace named `default`.
 * - `kind = 'shared'` (a space, docs/plans/coworking-spec.md §5): no owning
 *   user row (`user_id` NULL, never default); access is `workspace_members`.
 *   `created_by` is attribution only. `archived_at` makes it read-only.
 *   The CHECK `workspaces_kind_chk` (migration 0128) ties `kind` to
 *   `user_id`.
 */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<WorkspaceKind>().default('personal').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  /**
   * How the agent edits a space's notes (docs/plans/coworking-spec.md §7.4):
   * `suggest` turns its writes into edit proposals, `direct` applies them
   * through the document hub. Personal workspaces ignore it.
   */
  agentEditMode: text('agent_edit_mode').$type<AgentEditMode>().default('suggest').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  /**
   * Directory segment of the workspace's files under
   * `users/<user_id>/workspaces/` (workspace-fs.ts): `default` for the
   * workspace that was its owner's default at upgrade (migration 0127),
   * the workspace id for every other. Set once; only a transfer changes it.
   */
  filesDir: text('files_dir').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('workspaces_user_id_idx').on(table.userId),
  userSlugUq: uniqueIndex('workspaces_user_id_slug_uq').on(table.userId, table.slug),
  userFilesDirUq: uniqueIndex('workspaces_user_id_files_dir_uq').on(table.userId, table.filesDir),
}));

export type WorkspaceKind = 'personal' | 'shared';

/** How the agent edits a space's notes (`workspaces.agent_edit_mode`). */
export type AgentEditMode = 'suggest' | 'direct';

/** A member's role in a space (`src/security/space-access.ts`). */
export type SpaceRole = 'owner' | 'editor' | 'commenter' | 'viewer' | 'guest';
/** What an invite may grant: every role but `owner`. */
export type InvitableSpaceRole = Exclude<SpaceRole, 'owner'>;

/** What a guest reaches in a space (S6); validated on write by `parseGuestScope` (`src/security/space-access.ts`). */
export type { GuestScope } from '@/shared/spaces';

/** Membership of a shared workspace. The only source of access to a space. */
export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<SpaceRole>().notNull(),
  /** Guests only (S6): what part of the space they see. */
  scope: jsonb('scope').$type<GuestScope>(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  userIdx: index('workspace_members_user_idx').on(table.userId),
}));

/** An invite link to a space. Only `sha256(token)` is stored. */
export const workspaceInvites = pgTable('workspace_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: text('role').$type<InvitableSpaceRole>().notNull(),
  /** Guest invites only (S6): the scope the guest joins with. */
  scope: jsonb('scope').$type<GuestScope>(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxUses: integer('max_uses').default(1).notNull(),
  useCount: integer('use_count').default(0).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index('workspace_invites_ws_idx').on(table.workspaceId),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrgMember = typeof orgMembers.$inferSelect;
export type NewOrgMember = typeof orgMembers.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;

/**
 * A new workspace row with its id chosen here, so its files directory
 * (`files_dir`) can be that id: a column default cannot name another column.
 */
export function newWorkspaceRow(values: Omit<NewWorkspace, 'id' | 'filesDir'>): NewWorkspace {
  const id = randomUUID();
  return { ...values, id, filesDir: id };
}
