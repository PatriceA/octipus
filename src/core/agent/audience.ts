/**
 * Who reads a session's replies (docs/plans/coworking-spec.md §5.6, D10, I7).
 *
 * One answer for every path that decides whether the requester's personal
 * memories, learning and profile may enter a turn: the root turn, plan
 * execution, compaction, the learning processor and the child-worker
 * prompt. A group-channel thread and a room are posted where others read
 * them; a private session inside a space is not, but its work lands in
 * shared content — personal memories and profile facts stay out of all
 * three.
 */
import { isKnownSharedWorkspace, noteSharedWorkspace } from '@/security/workspace-fs';

export type AudienceKind = 'personal' | 'group' | 'space' | 'room';

export interface SessionAudience {
  /** Replies are read by people other than the requester (group thread, room). */
  readonly shared: boolean;
  /** Personal memories are neither loaded nor learned from (group, space, room). */
  readonly personalMemoryOff: boolean;
  /** The requester's profile facts and relationship search are not injected (space, room). */
  readonly personalProfileOff: boolean;
  readonly kind: AudienceKind;
}

export interface AudienceSession {
  groupChannelId?: string | null;
  workspaceId?: string | null;
  /** `'room'` from S2 (rooms are sessions in a shared workspace). */
  kind?: string | null;
}

const AUDIENCES: Readonly<Record<AudienceKind, SessionAudience>> = {
  personal: { shared: false, personalMemoryOff: false, personalProfileOff: false, kind: 'personal' },
  group: { shared: true, personalMemoryOff: true, personalProfileOff: false, kind: 'group' },
  space: { shared: false, personalMemoryOff: true, personalProfileOff: true, kind: 'space' },
  room: { shared: true, personalMemoryOff: true, personalProfileOff: true, kind: 'room' },
};

/**
 * The audience of `session`. Reads the workspace kind from the database
 * when this process has not seen the workspace as a space yet; a failed
 * read throws (a turn never guesses "personal").
 */
export async function sessionAudience(session: AudienceSession | null | undefined): Promise<SessionAudience> {
  if (!session) return AUDIENCES.personal;
  if (session.kind === 'room') return AUDIENCES.room;
  if (session.groupChannelId) return AUDIENCES.group;
  if (await isSharedWorkspace(session.workspaceId)) return AUDIENCES.space;
  return AUDIENCES.personal;
}

/** The audience of a known kind (tests, and callers that already resolved it). */
export function audienceOf(kind: AudienceKind): SessionAudience {
  return AUDIENCES[kind];
}

async function isSharedWorkspace(workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  if (isKnownSharedWorkspace(workspaceId)) return true;
  const { isUuid } = await import('@/db/repositories/scoped');
  if (!isUuid(workspaceId)) return false;
  const [{ getDb }, { workspaces }, { eq }] = await Promise.all([
    import('@/db/postgres'), import('@/db/schema/organizations'), import('drizzle-orm'),
  ]);
  const [row] = await getDb().select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (row?.kind === 'shared') {
    noteSharedWorkspace(workspaceId);
    return true;
  }
  return false;
}
