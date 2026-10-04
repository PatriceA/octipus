/**
 * Roles in a shared space (docs/plans/coworking-spec.md §5.2, D6).
 *
 * Roles are code: one `can(role, action)` table, read by the space service,
 * the access layer and the agent's approval path. A guest's grants hold only
 * inside their `scope` (S6); `can` answers for the role, and the caller that
 * knows the resource applies the scope.
 *
 * `SpaceError` is the one error type of space operations; `spaceErrorStatus`
 * maps it to HTTP. Non-members get `not_found` — never `forbidden_role` — so a
 * space id cannot be probed (I3).
 */
import type { InvitableSpaceRole, SpaceRole } from '@/db/schema/organizations';

export type { InvitableSpaceRole, SpaceRole } from '@/db/schema/organizations';

export const SPACE_ROLES: readonly SpaceRole[] = ['owner', 'editor', 'commenter', 'viewer', 'guest'];
export const INVITABLE_SPACE_ROLES: readonly InvitableSpaceRole[] = ['editor', 'commenter', 'viewer', 'guest'];

export type SpaceAction =
  | 'read'
  /** Task comments; room posts from S2. */
  | 'comment'
  /** Notes, tasks, files, documents, artifacts; space memory from S2. */
  | 'write'
  /** Run the agent with read and comment tools. */
  | 'run_agent'
  /** Run the agent with write tools. */
  | 'run_agent_write'
  | 'manage_members'
  | 'manage_invites'
  | 'manage_space';

const GRANTS: Readonly<Record<SpaceRole, ReadonlySet<SpaceAction>>> = {
  owner: new Set<SpaceAction>(['read', 'comment', 'write', 'run_agent', 'run_agent_write', 'manage_members', 'manage_invites', 'manage_space']),
  editor: new Set<SpaceAction>(['read', 'comment', 'write', 'run_agent', 'run_agent_write']),
  commenter: new Set<SpaceAction>(['read', 'comment', 'run_agent']),
  viewer: new Set<SpaceAction>(['read']),
  // In scope only (S6): the caller checks the scope.
  guest: new Set<SpaceAction>(['read', 'comment', 'run_agent']),
};

/** Whether `role` may perform `action`. A null role (not a member) may do nothing. */
export function can(role: SpaceRole | null | undefined, action: SpaceAction): boolean {
  if (!role) return false;
  const grants = GRANTS[role];
  if (!grants) throw new Error(`Unknown space role: ${String(role)}`);
  return grants.has(action);
}

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

export function isInvitableRole(value: unknown): value is InvitableSpaceRole {
  return typeof value === 'string' && (INVITABLE_SPACE_ROLES as readonly string[]).includes(value);
}

export type SpaceErrorCode =
  | 'invalid_name'
  | 'invalid_role'
  | 'invalid_input'
  /** No such space, or the caller is not a member (the two are not told apart). */
  | 'not_found'
  /** A member whose role lacks the action, or a creation the policy refuses. */
  | 'forbidden_role'
  /** The last owner cannot be removed, demoted or leave. */
  | 'last_owner'
  | 'space_full'
  | 'archived'
  /** Purge asked before the space has been archived long enough. */
  | 'not_purgeable';

export class SpaceError extends Error {
  constructor(readonly code: SpaceErrorCode, message: string) {
    super(message);
    this.name = 'SpaceError';
  }
}

export function spaceErrorStatus(err: SpaceError): number {
  switch (err.code) {
    case 'invalid_name':
    case 'invalid_role':
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'forbidden_role':
      return 403;
    case 'last_owner':
    case 'space_full':
    case 'archived':
    case 'not_purgeable':
      return 409;
  }
}

/** A membership as `getMembership` returns it. */
export interface SpaceMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: SpaceRole;
  /** Guests only (S6). */
  readonly scope: Record<string, unknown> | null;
}

/**
 * Throws `not_found` for a non-member and `forbidden_role` for a member
 * whose role lacks `action`; returns the membership otherwise.
 */
export function requireCan(membership: SpaceMembership | null, action: SpaceAction): SpaceMembership {
  if (!membership) throw new SpaceError('not_found', 'Space not found');
  if (!can(membership.role, action)) {
    throw new SpaceError('forbidden_role', `Your role (${membership.role}) cannot ${action.replace(/_/g, ' ')} in this space`);
  }
  return membership;
}
