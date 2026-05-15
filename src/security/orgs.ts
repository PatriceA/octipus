/**
 * Organizations + workspaces — Phase 3g multi-user.
 *
 * `OrgWorkspaceManager` is the only module that writes to the
 * `organizations`, `org_members`, and `workspaces` tables. The REST
 * surface, audit middleware, and the (future Phase 4) data-scoping
 * code all go through these helpers, so authorization rules live in
 * one place.
 *
 * Responsibilities:
 *
 *   - **Org CRUD** is admin-gated. A non-admin asking the manager to
 *     create an organization gets `not_admin`. The manager doesn't
 *     consult `multiuser.orgWorkspaces` itself — that's the route
 *     layer's job — but the helper functions below stay safe even if
 *     a route forgets the check.
 *
 *   - **Membership** can be managed by any admin (system_admin); a
 *     later iteration adds `org_admin` role checks via `org_members`.
 *
 *   - **Workspaces** are owned by a user. Each user gets a default
 *     workspace lazily on first read (`ensureDefaultWorkspace`); the
 *     migration's partial unique index enforces "one default per
 *     user". A user can create / rename / delete their own
 *     workspaces; admins can do the same on behalf of any user via
 *     `*Admin` methods.
 *
 *   - **Cross-tenant safety**: every read/write that touches a
 *     workspace runs through a `(id, user_id)` filter so a leaked
 *     workspace UUID can't be used by user A to read user B's row.
 *     The same enumeration-collapse pattern as scopedRepos: misses +
 *     wrong-owner both surface as `null`.
 *
 * Phase 3g ships scaffolding only. No existing table grows a new
 * foreign key. Phase 4 will add `workspace_id` to sessions /
 * documents / hooks / vault and adopt the per-workspace data
 * boundary.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { documents } from '@/db/schema/documents';
import { hooks } from '@/db/schema/hooks';
import {
  type NewWorkspace,
  type Organization,
  type OrgMember,
  organizations,
  orgMembers,
  type Workspace,
  workspaces,
} from '@/db/schema/organizations';
import { sessions } from '@/db/schema/sessions';
import { users } from '@/db/schema/users';
import { vault } from '@/db/schema/vault';
import { securityLogger } from '@/utils/logger';

/**
 * Slug normalization for orgs and workspaces. Lowercase ASCII, hyphens
 * only, max 32 chars. Matches the URL-safe handle convention.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DEFAULT_WORKSPACE_SLUG = 'default';

export class OrgWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'invalid_slug'
      | 'invalid_name'
      | 'not_admin'
      | 'org_not_found'
      | 'user_not_found'
      | 'slug_conflict'
      | 'workspace_not_found'
      | 'cannot_delete_default'
      | 'recipient_not_found'
      | 'cannot_transfer_to_self',
    message: string,
  ) {
    super(message);
    this.name = 'OrgWorkspaceError';
  }
}

export interface ActorLike {
  id: string;
  username: string;
  isAdmin: boolean;
}

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new OrgWorkspaceError(
      'invalid_slug',
      'slug must be lowercase alphanumerics + hyphens (max 32 chars)',
    );
  }
}

function assertName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new OrgWorkspaceError('invalid_name', 'name must be 1–120 characters');
  }
}

export class OrgWorkspaceManager {
  private get db() { return getDb(); }

  // ─────────────────────────────────────────────────────────────────
  // Organizations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a new organization. Admin-only. The creator is recorded
   * as `created_by` and added as the first member with role
   * `org_admin`.
   */
  async createOrg(actor: ActorLike, input: { slug: string; name: string }): Promise<Organization> {
    if (!actor.isAdmin) {
      throw new OrgWorkspaceError('not_admin', 'only admins may create organizations');
    }
    assertSlug(input.slug);
    assertName(input.name);

    // Pre-check slug to give a friendly error before hitting the unique constraint.
    const existing = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.slug))
      .limit(1);
    if (existing.length > 0) {
      throw new OrgWorkspaceError('slug_conflict', `organization slug "${input.slug}" already exists`);
    }

    const [org] = await this.db
      .insert(organizations)
      .values({ slug: input.slug, name: input.name.trim(), createdBy: actor.id })
      .returning();

    await this.db
      .insert(orgMembers)
      .values({ orgId: org.id, userId: actor.id, role: 'org_admin' });

    await auditRepository.log({
      userId: actor.id,
      action: 'settings_changed',
      resourceType: 'organization',
      resourceId: org.id,
      details: { event: 'org_created', slug: org.slug, name: org.name },
    });
    securityLogger.info({ actorUserId: actor.id, orgId: org.id, slug: org.slug }, 'Organization created');

    return org;
  }

  /**
   * Look up by slug. Returns null when the slug doesn't exist OR when
   * a non-admin caller isn't a member — same enumeration-collapse
   * pattern as scopedRepos. Admins always see the full row.
   */
  async findBySlugForCaller(actor: ActorLike, slug: string): Promise<Organization | null> {
    const [row] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (!row) return null;
    if (actor.isAdmin) return row;
    const [membership] = await this.db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, row.id), eq(orgMembers.userId, actor.id)))
      .limit(1);
    return membership ? row : null;
  }

  /** Admin-only — list every org regardless of membership. */
  async listAllAdmin(actor: ActorLike): Promise<Organization[]> {
    if (!actor.isAdmin) {
      throw new OrgWorkspaceError('not_admin', 'admin only');
    }
    return this.db.select().from(organizations);
  }

  /** Orgs the caller is a member of. Empty list when not a member of any. */
  async listForUser(userId: string): Promise<Organization[]> {
    const rows = await this.db
      .select({ org: organizations })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId));
    return rows.map((r) => r.org);
  }

  /**
   * Add a member to an org. Admin-only. Idempotent — re-adding an
   * existing member is a no-op (returns the existing row).
   */
  async addMember(
    actor: ActorLike,
    orgId: string,
    targetUserId: string,
    role: 'member' | 'org_admin' = 'member',
  ): Promise<OrgMember> {
    if (!actor.isAdmin) {
      throw new OrgWorkspaceError('not_admin', 'admin only');
    }
    const [org] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new OrgWorkspaceError('org_not_found', `organization ${orgId} not found`);

    const [existing] = await this.db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId)))
      .limit(1);
    if (existing) return existing;

    const [member] = await this.db
      .insert(orgMembers)
      .values({ orgId, userId: targetUserId, role })
      .returning();

    await auditRepository.log({
      userId: actor.id,
      action: 'settings_changed',
      resourceType: 'organization',
      resourceId: orgId,
      details: { event: 'member_added', targetUserId, role },
    });
    return member;
  }

  /** Remove a member from an org. Admin-only. Returns true on success. */
  async removeMember(actor: ActorLike, orgId: string, targetUserId: string): Promise<boolean> {
    if (!actor.isAdmin) {
      throw new OrgWorkspaceError('not_admin', 'admin only');
    }
    const result = await this.db
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId)))
      .returning({ orgId: orgMembers.orgId });
    if (result.length === 0) return false;

    await auditRepository.log({
      userId: actor.id,
      action: 'settings_changed',
      resourceType: 'organization',
      resourceId: orgId,
      details: { event: 'member_removed', targetUserId },
    });
    return true;
  }

  /**
   * List members of an org, enriched with the user's username so admin
   * UIs can render a recognizable list without a separate roundtrip to
   * the users endpoint. Cross-tenant safe: non-admins must be members
   * themselves or the call returns an empty list.
   */
  async listMembers(
    actor: ActorLike,
    orgId: string,
  ): Promise<(OrgMember & { username: string })[]> {
    // Admins see everyone. Members can see their own org's members.
    if (!actor.isAdmin) {
      const [self] = await this.db
        .select({ orgId: orgMembers.orgId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, actor.id)))
        .limit(1);
      if (!self) return [];
    }
    const rows = await this.db
      .select({
        orgId: orgMembers.orgId,
        userId: orgMembers.userId,
        role: orgMembers.role,
        joinedAt: orgMembers.joinedAt,
        username: users.username,
      })
      .from(orgMembers)
      .leftJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, orgId));
    return rows.map((r) => ({
      orgId: r.orgId,
      userId: r.userId,
      role: r.role,
      joinedAt: r.joinedAt,
      username: r.username ?? `(unknown:${r.userId.slice(0, 8)})`,
    }));
  }

  // ─────────────────────────────────────────────────────────────────
  // Workspaces
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a workspace owned by the caller. The slug must be unique
   * among the caller's workspaces; cross-user collisions are fine
   * because the unique index is on (user_id, slug).
   */
  async createWorkspace(
    userId: string,
    input: { slug: string; name: string; isDefault?: boolean },
  ): Promise<Workspace> {
    assertSlug(input.slug);
    assertName(input.name);

    const [existing] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.slug, input.slug)))
      .limit(1);
    if (existing) {
      throw new OrgWorkspaceError(
        'slug_conflict',
        `workspace slug "${input.slug}" already exists for this user`,
      );
    }

    // If this row is being marked default, clear the previous default
    // first — the partial unique index would otherwise reject the insert.
    if (input.isDefault) {
      await this.db
        .update(workspaces)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)));
    }

    const values: NewWorkspace = {
      userId,
      slug: input.slug,
      name: input.name.trim(),
      isDefault: input.isDefault ?? false,
    };
    const [ws] = await this.db.insert(workspaces).values(values).returning();
    return ws;
  }

  /**
   * Find or create the user's default workspace. Phase 4 will call
   * this on every authenticated request to populate
   * `principal.workspaceId`. For Phase 3g it's just available so the
   * REST `list` endpoint can return at least one row even on a fresh
   * account.
   */
  async ensureDefaultWorkspace(userId: string): Promise<Workspace> {
    const [existing] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)))
      .limit(1);
    if (existing) return existing;

    // No default yet — create one. Use the canonical slug `default`
    // unless the user already has a workspace by that slug, in which
    // case promote the first one they have to default.
    const [bySlug] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.slug, DEFAULT_WORKSPACE_SLUG)))
      .limit(1);
    if (bySlug) {
      const [updated] = await this.db
        .update(workspaces)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(workspaces.id, bySlug.id))
        .returning();
      return updated;
    }
    return this.createWorkspace(userId, {
      slug: DEFAULT_WORKSPACE_SLUG,
      name: 'Default',
      isDefault: true,
    });
  }

  /**
   * Returns the workspace only if owned by `userId`. Cross-tenant
   * lookups silently collapse to null so a leaked UUID can't be used
   * to enumerate other users' workspaces.
   */
  async findOwnedById(userId: string, id: string): Promise<Workspace | null> {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async findOwnedBySlug(userId: string, slug: string): Promise<Workspace | null> {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  async listOwn(userId: string): Promise<Workspace[]> {
    return this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId));
  }

  /**
   * Rename a workspace. Slug stays immutable — renaming the slug would
   * break any URL/handle that references it. Use `delete` + `create`
   * if you really need a different slug.
   */
  async rename(userId: string, id: string, name: string): Promise<Workspace | null> {
    assertName(name);
    const [row] = await this.db
      .update(workspaces)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
      .returning();
    return row ?? null;
  }

  /**
   * Delete a workspace. The default workspace can't be deleted —
   * doing so would leave the user with no place to put new sessions
   * once Phase 4 adopts workspace_id. To "delete" the default,
   * promote a different workspace first via `setDefault`.
   */
  async delete(userId: string, id: string): Promise<boolean> {
    const existing = await this.findOwnedById(userId, id);
    if (!existing) return false;
    if (existing.isDefault) {
      throw new OrgWorkspaceError(
        'cannot_delete_default',
        'cannot delete the default workspace; promote another one first',
      );
    }
    const result = await this.db
      .delete(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
      .returning({ id: workspaces.id });
    return result.length > 0;
  }

  /**
   * Promote a workspace to default. Atomic-ish: clear the existing
   * default in the same transaction so the partial unique index never
   * sees two defaults at once.
   */
  async setDefault(userId: string, id: string): Promise<Workspace | null> {
    const target = await this.findOwnedById(userId, id);
    if (!target) return null;
    if (target.isDefault) return target;

    return this.db.transaction(async (tx) => {
      await tx
        .update(workspaces)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)));
      const [updated] = await tx
        .update(workspaces)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
        .returning();
      return updated;
    });
  }

  /**
   * Transfer workspace ownership from the caller (current owner) to
   * `recipientUserId`. Atomic — runs in a single transaction so any
   * partial failure rolls back.
   *
   * What follows the workspace:
   *   - `sessions`, `documents`, `hooks` rows scoped to this
   *     workspace_id have their `user_id` reassigned to the recipient.
   *     These ARE the working state of the workspace; moving the
   *     workspace without them would orphan the history.
   *   - `vault` rows with `scope='workspace'` AND `workspace_id` =
   *     this workspace follow too. Workspace-scoped secrets are part
   *     of the workspace, not the user.
   *
   * What stays put:
   *   - `vault` rows with `scope='user'` (user's personal secrets) —
   *     those are the user's, not the workspace's, regardless of
   *     where they happened to be created.
   *   - Artifacts on this workspace stay where they are; the new owner
   *     simply inherits them via the new ownership.
   *
   * Edge cases handled:
   *   - Transferring a default workspace clears its `isDefault` flag
   *     before the move so the recipient's existing default isn't
   *     displaced. The recipient can promote it later via setDefault.
   *   - Slug collision: if the recipient already has a workspace with
   *     this slug, we suffix `-from-<old-owner-username-or-id>` to the
   *     transferring slug. Cheap, deterministic, avoids the partial
   *     unique index conflict; the recipient can rename afterwards.
   */
  async transfer(
    actorUserId: string,
    workspaceId: string,
    recipientUserId: string,
  ): Promise<Workspace> {
    if (actorUserId === recipientUserId) {
      throw new OrgWorkspaceError('cannot_transfer_to_self', 'cannot transfer a workspace to yourself');
    }
    const owned = await this.findOwnedById(actorUserId, workspaceId);
    if (!owned) {
      throw new OrgWorkspaceError('workspace_not_found', 'workspace not found or not owned by caller');
    }

    const [recipient] = await this.db
      .select({ id: users.id, username: users.username, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, recipientUserId))
      .limit(1);
    if (!recipient || !recipient.isActive) {
      throw new OrgWorkspaceError('recipient_not_found', 'recipient user not found or inactive');
    }

    const [actor] = await this.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    const actorTag = (actor?.username || actorUserId).replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 16) || 'prev';

    // Find a non-colliding slug for the recipient. The partial unique
    // index is on (user_id, slug); collision is recoverable by suffixing.
    let finalSlug = owned.slug;
    const [slugCollision] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, recipientUserId), eq(workspaces.slug, owned.slug)))
      .limit(1);
    if (slugCollision) {
      const candidate = `${owned.slug}-from-${actorTag}`.slice(0, 32);
      finalSlug = candidate || `${owned.slug.slice(0, 24)}-rcv`;
    }

    return this.db.transaction(async (tx) => {
      // Strip the default flag so we never end up with two defaults
      // on the recipient (partial unique index would reject it).
      const [updated] = await tx
        .update(workspaces)
        .set({
          userId: recipientUserId,
          slug: finalSlug,
          isDefault: false,
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, actorUserId)))
        .returning();
      if (!updated) {
        // Defensive: another writer raced us. Roll back.
        throw new OrgWorkspaceError('workspace_not_found', 'workspace disappeared mid-transfer');
      }

      // Reassign workspace-scoped working state to the recipient.
      const updatedAt = new Date();
      await tx
        .update(sessions)
        .set({ userId: recipientUserId, updatedAt })
        .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.userId, actorUserId)));
      // documents has no updatedAt column — only createdAt.
      await tx
        .update(documents)
        .set({ userId: recipientUserId })
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.userId, actorUserId)));
      await tx
        .update(hooks)
        .set({ userId: recipientUserId, updatedAt })
        .where(and(eq(hooks.workspaceId, workspaceId), eq(hooks.userId, actorUserId)));
      // Workspace-scoped vault rows follow. User-scoped rows stay
      // with their owner (they're not part of the workspace).
      await tx
        .update(vault)
        .set({ userId: recipientUserId, updatedAt })
        .where(and(
          eq(vault.workspaceId, workspaceId),
          eq(vault.scope, 'workspace'),
          eq(vault.userId, actorUserId),
        ));

      return updated;
    }).then(async (result) => {
      await auditRepository.log({
        userId: actorUserId,
        action: 'settings_changed',
        resourceType: 'workspace',
        resourceId: workspaceId,
        details: {
          event: 'workspace_transferred',
          from: actorUserId,
          to: recipientUserId,
          originalSlug: owned.slug,
          finalSlug,
        },
      });
      securityLogger.info(
        { workspaceId, from: actorUserId, to: recipientUserId, slug: finalSlug },
        'Workspace ownership transferred',
      );
      return result;
    });
  }
}

let instance: OrgWorkspaceManager | null = null;
export function getOrgWorkspaceManager(): OrgWorkspaceManager {
  if (!instance) instance = new OrgWorkspaceManager();
  return instance;
}
export function _resetOrgWorkspaceManagerForTests(): void { instance = null; }
