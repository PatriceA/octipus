/**
 * Test fixtures for shared spaces: a space with members joined through real
 * invites, and the principals the server derive would build for them.
 */
import type { Principal } from '@/security/principal';

export type JoinRole = 'editor' | 'commenter' | 'viewer' | 'guest';

/** A space owned by `ownerId`, with `members` joined through invites. Returns its id. */
export async function spaceWith(ownerId: string, members: Array<[string, JoinRole]>, name = `Space ${Math.random().toString(36).slice(2, 8)}`): Promise<string> {
  const { createSpace } = await import('@/core/spaces/service');
  const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
  const space = await createSpace({ userId: ownerId }, { name });
  for (const [userId, role] of members) {
    const invite = await createInvite({ userId: ownerId }, space.id, { role });
    await acceptInvite({ userId }, invite.token);
  }
  return space.id;
}

/**
 * The principal of `userId` with the workspace header `header` (a space id,
 * a personal workspace id, or null for the default), resolved by the real
 * resolver as the server derive does. Throws when the space is denied.
 */
export async function resolvedPrincipal(userId: string, header: string | null, opts: { isAdmin?: boolean } = {}): Promise<Principal> {
  const { principalFromUser } = await import('@/security/principal');
  const { resolveWorkspace } = await import('@/security/workspace-resolver');
  const base = principalFromUser({ id: userId, username: userId.slice(0, 8), isAdmin: opts.isAdmin ?? false });
  const r = await resolveWorkspace(base, header);
  if (r.denied) throw new Error(`workspace ${header} denied for ${userId}`);
  if (r.workspaceKind === 'shared') {
    return { ...base, workspaceId: r.workspaceId, workspaceKind: 'shared', spaceRole: r.spaceRole, spaceScope: r.spaceScope ?? null, spaceArchived: r.spaceArchived ?? false };
  }
  return { ...base, workspaceId: r.workspaceId, workspaceKind: 'personal' };
}
