/**
 * Workspace resolver — Phase 4 multi-user.
 *
 * Maps a request's `X-Octipus-Workspace` header to a workspace UUID
 * owned by the principal. The resolver lives next to the auth
 * stack: it runs after the principal is established and before
 * scopedRepos touch the database.
 *
 * Workspaces are always on. Resolution order:
 *
 *   1. If the header is absent OR points at the literal string
 *      `"all"`, ensure the user has a default workspace and return
 *      its id. Treating "no header" as "default" is what Phase 3g's
 *      `/api/me/workspaces` endpoint advertises — a fresh user gets
 *      a workspace lazily on first read.
 *   2. If the header is a UUID, accept it only when the workspace
 *      is owned by the principal. Cross-tenant UUIDs collapse to
 *      the user's default workspace — same enumeration-collapse
 *      pattern as scopedRepos. The route never returns 403; an
 *      attacker can't tell whether the UUID belongs to someone
 *      else or doesn't exist.
 *   3. Otherwise treat the header as a slug and look it up by
 *      `(user_id, slug)`. Misses fall back to the default
 *      workspace.
 *
 * Shared workspaces (spaces, docs/plans/coworking-spec.md §5.4) are
 * looked up after the caller's own, by id or slug: with a membership
 * (read from the database, D5) the resolution is `workspaceKind:
 * 'shared'` with the member's role; without one it is `denied`, and the
 * server answers 404 (I3) instead of collapsing to the default — a
 * removed member's client must learn the space is gone, not silently
 * write into their personal workspace.
 *
 * Returning a non-null `workspaceId` from this helper means
 * "scopedRepos should filter on workspace_id". If you want a
 * principal that can see *every* workspace the user owns (e.g. an
 * admin running a search across the whole user account), pass
 * `X-Octipus-Workspace: all`. Phase 4 currently maps `all` to the
 * default — a follow-up may expand that to "no filter" if the
 * product needs it.
 */
import { and, eq } from 'drizzle-orm';
import { getMembership } from '@/core/spaces/service';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { workspaces } from '@/db/schema/organizations';
import { pipelines } from '@/db/schema/pipelines';
import { sessions } from '@/db/schema/sessions';
import { getOrgWorkspaceManager } from '@/security/orgs';
import type { Principal } from '@/security/principal';
import type { GuestScope, SpaceRole } from '@/security/space-access';

/** RFC 4122 UUID, case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceResolution {
  /** UUID of the workspace to scope to. NULL for non-user principals and for `denied`. */
  workspaceId: string | null;
  /**
   * Whether the resolver actually used the user's default. Useful
   * for the "current workspace" UI hint — a `false` value tells the
   * client the user explicitly selected this workspace; `true`
   * means we picked it because no header was supplied.
   */
  isDefault: boolean;
  /** `'shared'` for a space the user is a member of; absent for non-user principals. */
  workspaceKind?: 'personal' | 'shared';
  spaceRole?: SpaceRole;
  spaceScope?: GuestScope | null;
  spaceArchived?: boolean;
  /** The header named a space the user is not a member of: answer 404. */
  denied?: true;
}

/** A shared workspace by id or slug, with what the resolver needs of it. */
async function findSpace(ref: { id: string } | { slug: string }): Promise<{ id: string; archived: boolean } | null> {
  const [row] = await getDb()
    .select({ id: workspaces.id, archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(and(eq(workspaces.kind, 'shared'), 'id' in ref ? eq(workspaces.id, ref.id) : eq(workspaces.slug, ref.slug)))
    .limit(1);
  return row ? { id: row.id, archived: row.archivedAt !== null } : null;
}

/** The resolution for a space: shared with the member's role, or denied. */
async function spaceResolution(userId: string, space: { id: string; archived: boolean }): Promise<WorkspaceResolution> {
  const membership = await getMembership(userId, space.id);
  if (!membership) return { workspaceId: null, isDefault: false, denied: true };
  return {
    workspaceId: space.id,
    isDefault: false,
    workspaceKind: 'shared',
    spaceRole: membership.role,
    spaceScope: membership.scope,
    spaceArchived: space.archived,
  };
}

/** The user's default (personal) workspace. */
export async function defaultWorkspaceResolution(userId: string): Promise<WorkspaceResolution> {
  const def = await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
  return { workspaceId: def.id, isDefault: true, workspaceKind: 'personal' };
}

/**
 * Resolve the principal's workspace context. Cheap on the hot path:
 * one indexed lookup against `(user_id, slug)` or `(id, user_id)`.
 *
 * Anonymous / system principals get `workspaceId: null` — they have
 * no workspaces. Real users always get a UUID; `ensureDefaultWorkspace`
 * creates one lazily if it doesn't exist.
 */
export async function resolveWorkspace(
  principal: Principal,
  header: string | null | undefined,
): Promise<WorkspaceResolution> {
  if (principal.kind !== 'user' && principal.kind !== 'service') {
    return { workspaceId: null, isDefault: true };
  }

  const mgr = getOrgWorkspaceManager();

  // Empty / sentinel "all" → default workspace.
  const trimmed = header?.trim();
  if (!trimmed || trimmed === 'all' || trimmed === 'default') {
    return defaultWorkspaceResolution(principal.userId);
  }

  if (UUID_RE.test(trimmed)) {
    const ws = await mgr.findOwnedById(principal.userId, trimmed);
    if (ws) return { workspaceId: ws.id, isDefault: ws.isDefault, workspaceKind: 'personal' };
    const space = await findSpace({ id: trimmed });
    if (space) return spaceResolution(principal.userId, space);
    // Cross-tenant or unknown UUID — collapse to default.
    return defaultWorkspaceResolution(principal.userId);
  }

  const bySlug = await mgr.findOwnedBySlug(principal.userId, trimmed);
  if (bySlug) return { workspaceId: bySlug.id, isDefault: bySlug.isDefault, workspaceKind: 'personal' };
  const space = await findSpace({ slug: trimmed });
  if (space) return spaceResolution(principal.userId, space);
  return defaultWorkspaceResolution(principal.userId);
}

/**
 * The workspace of a session, agent or pipeline the user owns, for a
 * personal route that addresses one by id (`spaceTargetOf`,
 * src/api/space-routes.ts). Null when the row is not the user's or has no
 * workspace.
 */
export async function workspaceOfTarget(
  userId: string,
  target: { kind: 'session' | 'agent' | 'pipeline'; id: string },
): Promise<string | null> {
  const db = getDb();
  if (target.kind === 'session') {
    const [row] = await db.select({ ws: sessions.workspaceId }).from(sessions)
      .where(and(eq(sessions.id, target.id), eq(sessions.userId, userId))).limit(1);
    return row?.ws ?? null;
  }
  if (target.kind === 'agent') {
    const [row] = await db.select({ ws: agents.workspaceId }).from(agents)
      .where(and(eq(agents.id, target.id), eq(agents.userId, userId))).limit(1);
    return row?.ws ?? null;
  }
  const [row] = await db.select({ ws: pipelines.workspaceId }).from(pipelines)
    .where(and(eq(pipelines.id, target.id), eq(pipelines.userId, userId))).limit(1);
  return row?.ws ?? null;
}
