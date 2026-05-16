/**
 * Workspace resolver — Phase 4 multi-user.
 *
 * Maps a request's `X-Octipus-Workspace` header to a workspace UUID
 * owned by the principal. The resolver lives next to the auth
 * stack: it runs after the principal is established and before
 * scopedRepos touch the database.
 *
 * Resolution order:
 *
 *   1. If `multiuser.orgWorkspaces` is OFF, ignore the header and
 *      return the user's default workspace. Single-user installs
 *      still need a workspace UUID — features like artifacts have
 *      a `workspace_id` FK and can't run without one. The flag
 *      gates header-driven *switching* between multiple workspaces,
 *      not workspace existence.
 *   2. If the header is absent OR points at the literal string
 *      `"all"`, ensure the user has a default workspace and return
 *      its id. Treating "no header" as "default" is what Phase 3g's
 *      `/api/me/workspaces` endpoint advertises — a fresh user gets
 *      a workspace lazily on first read.
 *   3. If the header is a UUID, accept it only when the workspace
 *      is owned by the principal. Cross-tenant UUIDs collapse to
 *      the user's default workspace — same enumeration-collapse
 *      pattern as scopedRepos. The route never returns 403; an
 *      attacker can't tell whether the UUID belongs to someone
 *      else or doesn't exist.
 *   4. Otherwise treat the header as a slug and look it up by
 *      `(user_id, slug)`. Misses fall back to the default
 *      workspace.
 *
 * Returning a non-null `workspaceId` from this helper means
 * "scopedRepos should filter on workspace_id". If you want a
 * principal that can see *every* workspace the user owns (e.g. an
 * admin running a search across the whole user account), pass
 * `X-Octipus-Workspace: all`. Phase 4 currently maps `all` to the
 * default — a follow-up may expand that to "no filter" if the
 * product needs it.
 */
import { getConfig } from '@/config';
import { getOrgWorkspaceManager } from '@/security/orgs';
import type { Principal } from '@/security/principal';

/** RFC 4122 UUID, case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceResolution {
  /** UUID of the workspace to scope to. NULL when feature flag is off. */
  workspaceId: string | null;
  /**
   * Whether the resolver actually used the user's default. Useful
   * for the "current workspace" UI hint — a `false` value tells the
   * client the user explicitly selected this workspace; `true`
   * means we picked it because no header was supplied.
   */
  isDefault: boolean;
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
  if (principal.kind !== 'user' && principal.kind !== 'master_key' && principal.kind !== 'service') {
    return { workspaceId: null, isDefault: true };
  }

  const mgr = getOrgWorkspaceManager();

  // Single-user mode: ignore header, always use the default workspace.
  // The flag gates multi-workspace switching, not workspace existence.
  if (!getConfig().multiuser?.orgWorkspaces) {
    const def = await mgr.ensureDefaultWorkspace(principal.userId);
    return { workspaceId: def.id, isDefault: true };
  }

  // Empty / sentinel "all" → default workspace.
  const trimmed = header?.trim();
  if (!trimmed || trimmed === 'all' || trimmed === 'default') {
    const def = await mgr.ensureDefaultWorkspace(principal.userId);
    return { workspaceId: def.id, isDefault: true };
  }

  if (UUID_RE.test(trimmed)) {
    const ws = await mgr.findOwnedById(principal.userId, trimmed);
    if (ws) return { workspaceId: ws.id, isDefault: ws.isDefault };
    // Cross-tenant or unknown UUID — collapse to default.
    const def = await mgr.ensureDefaultWorkspace(principal.userId);
    return { workspaceId: def.id, isDefault: true };
  }

  const bySlug = await mgr.findOwnedBySlug(principal.userId, trimmed);
  if (bySlug) return { workspaceId: bySlug.id, isDefault: bySlug.isDefault };
  const def = await mgr.ensureDefaultWorkspace(principal.userId);
  return { workspaceId: def.id, isDefault: true };
}
