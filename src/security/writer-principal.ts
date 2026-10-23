/**
 * Acting for a user outside a request (docs/RECORDS.md forms, docs/MAIL.md,
 * docs/SCAN-FOLDERS.md): the user resolved again, the way the server
 * resolves a request, so a user who was deactivated, left the space or lost
 * the right to write writes nothing.
 */
import { coreLogger } from '@/utils/logger';
import { userRepository } from '@/db/repositories/user-repository';
import { principalFromUser, type Principal } from './principal';

/**
 * `userId` as a principal that writes in `workspaceId`, or null when they
 * may no longer write there. A space must still resolve to the same space
 * with a writing role; a personal type needs an active owner.
 */
export async function writerPrincipal(userId: string, workspaceId: string | null): Promise<Principal | null> {
  const user = await userRepository.findById(userId);
  if (!user || user.isActive === false) return null;
  const base = principalFromUser({ id: user.id, username: user.username, isAdmin: false });
  const { resolveWorkspace } = await import('@/security/workspace-resolver');
  const resolution = await resolveWorkspace(base, workspaceId);
  if (resolution.denied) return null;
  if (resolution.workspaceKind === 'shared') {
    if (resolution.workspaceId !== workspaceId || resolution.spaceArchived) return null;
    if (resolution.spaceRole !== 'owner' && resolution.spaceRole !== 'editor') return null;
    return {
      ...base,
      workspaceId: resolution.workspaceId,
      workspaceKind: 'shared',
      spaceRole: resolution.spaceRole,
      spaceScope: resolution.spaceScope ?? null,
      spaceArchived: false,
    };
  }
  // A personal type: the workspace must be the creator's own (null = user-level).
  if (workspaceId && resolution.workspaceId !== workspaceId) {
    coreLogger.warn({ userId, workspaceId }, 'A writer is no longer in the workspace their content points at');
    return null;
  }
  return { ...base, workspaceId: resolution.workspaceId, workspaceKind: 'personal' };
}
