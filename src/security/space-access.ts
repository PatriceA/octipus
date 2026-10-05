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
import { z } from 'zod';
import type { GuestScope, InvitableSpaceRole, SpaceRole } from '@/db/schema/organizations';
import { slugify } from '@/core/knowledge/wikilink';
import { securityLogger } from '@/utils/logger';

export type { GuestScope, InvitableSpaceRole, SpaceRole } from '@/db/schema/organizations';

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
  | 'not_purgeable'
  /** Work the space's funding does not pay for: unprompted work without a sponsor (§9.1). */
  | 'funding_off';

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
    case 'funding_off':
      return 409;
  }
}

/** A membership as `getMembership` returns it. */
export interface SpaceMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: SpaceRole;
  /** Guests only (S6): what they reach (never null for a guest); null for every other role. */
  readonly scope: GuestScope | null;
}

// ─────────────────────────────────────────────────────────────────────
// Guest scopes (S6, docs/SPACES.md → Guests)
// ─────────────────────────────────────────────────────────────────────
//
// A guest reaches exactly:
//   - the rooms named in `rooms` (open or private, no `room_members` row
//     needed), their transcripts, and the members of those rooms;
//   - the space's files under a folder of `folders` (a path prefix relative
//     to the space's file root, matched by whole segments);
//   - the notes whose slug is, or lies under, a folder of `folders` (slugs
//     keep `/`, so `client/brief` is in the folder `client`; the folder is
//     compared in its slug form);
//   - the tasks raised from one of their rooms (`source_ref.sessionId`);
//   - the knowledge chunks of those notes and files.
// Everything without a room or a path — documents, artifacts, space memory,
// other members' private chats — is never in a guest's scope.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GUEST_SCOPE_MAX_ITEMS = 100;
const FOLDER_MAX_LENGTH = 512;

/**
 * A folder of a guest scope in its one spelling: `/`-separated segments, no
 * leading or trailing slash, no `.`/`..`/empty segment, no backslash or NUL.
 * Null when `raw` is not a folder.
 */
export function normalizeGuestFolder(raw: string): string | null {
  if (raw.includes('\\') || raw.includes('\0')) return null;
  const segments = raw.trim().split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..' || s.trim() !== s)) return null;
  // Notes are matched on the folder's slug form (`guestNoteFolders`): every
  // segment must keep a slug of its own, and the folder's slug must be those
  // slugs joined. Otherwise `日本/acme` would slug to `acme` and reach the
  // notes of an unrelated top-level folder.
  const slugs = segments.map((s) => slugify(s));
  if (slugs.some((s) => s.length === 0 || s.includes('/')) || slugify(segments.join('/')) !== slugs.join('/')) return null;
  const folder = segments.join('/');
  return folder.length <= FOLDER_MAX_LENGTH ? folder : null;
}

const guestScopeSchema = z.object({
  rooms: z.array(z.string().regex(UUID_RE, 'a room id is a uuid')).max(GUEST_SCOPE_MAX_ITEMS).default([]),
  folders: z.array(z.string().min(1).max(FOLDER_MAX_LENGTH)).max(GUEST_SCOPE_MAX_ITEMS).default([]),
}).strict();

/**
 * Validate a guest scope as written (invite create, member PATCH) and return
 * it normalized: folders in their one spelling, duplicates dropped, room
 * ids lowercased. `null`/`undefined` is the empty scope (the guest reaches
 * nothing until the owner gives them something). Throws
 * `SpaceError('invalid_input')` naming what is wrong. Whether the rooms are
 * rooms of the space is the caller's check (`assertGuestRooms`).
 */
export function parseGuestScope(input: unknown): GuestScope {
  if (input == null) return { rooms: [], folders: [] };
  const parsed = guestScopeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SpaceError('invalid_input', `Invalid guest scope${issue?.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'malformed'}`);
  }
  const folders: string[] = [];
  for (const raw of parsed.data.folders) {
    const folder = normalizeGuestFolder(raw);
    if (!folder) throw new SpaceError('invalid_input', `Invalid guest scope folder: ${JSON.stringify(raw)}`);
    if (!folders.includes(folder)) folders.push(folder);
  }
  return { rooms: [...new Set(parsed.data.rooms.map((r) => r.toLowerCase()))], folders };
}

/**
 * The scope a membership or invite row stores, read back: a guest's, null
 * for every other role. Rows are validated on write, and migration 0135
 * reset the malformed ones written before S6; one that still does not parse
 * (a hand edit, a later rule such as the slug check on folders) reads as the
 * empty scope — the least access, never a wider one — and is logged. It does
 * not throw: one bad row must not break every caller that walks the space's
 * guests (room member lists, presence, `task.changed`).
 */
export function storedGuestScope(role: SpaceRole, stored: unknown, row: { workspaceId?: string; userId?: string; inviteId?: string } = {}): GuestScope | null {
  if (role !== 'guest') return null;
  try {
    return parseGuestScope(stored);
  } catch (err) {
    if (!(err instanceof SpaceError)) throw err;
    securityLogger.error({ ...row, reason: err.message }, 'Stored guest scope is malformed; treating it as the empty scope');
    return { rooms: [], folders: [] };
  }
}

/**
 * Whether a task is in the scope: raised from one of its rooms
 * (`source_ref.sessionId`, the rule `guestTaskFilter` applies in SQL).
 */
export function taskInGuestScope(sourceRef: { sessionId?: string } | null | undefined, scope: GuestScope): boolean {
  return typeof sourceRef?.sessionId === 'string' && scope.rooms.includes(sourceRef.sessionId.toLowerCase());
}

/** Whether `relPath` (relative to the space's file root) is, or lies under, a folder of the scope. */
export function pathInGuestFolders(relPath: string, folders: readonly string[]): boolean {
  const path = relPath.split(/[\\/]+/).filter((s) => s && s !== '.').join('/');
  return folders.some((f) => path === f || path.startsWith(`${f}/`));
}

/** The folders of a scope in note-slug form (`slugify`), the spelling note slugs are compared in. */
export function guestNoteFolders(folders: readonly string[]): string[] {
  return [...new Set(folders.map((f) => slugify(f)).filter((f) => f.length > 0))];
}

/** Whether a note of `slug` is in the scope's folders. */
export function noteInGuestScope(slug: string, scope: GuestScope): boolean {
  return guestNoteFolders(scope.folders).some((f) => slug === f || slug.startsWith(`${f}/`));
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
