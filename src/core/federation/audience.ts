/**
 * Whether members of other installs read a room or a space
 * (docs/plans/federation-spec.md §7.5, FI5).
 *
 * A run is a **federated audience** when its trigger is `remote` or its
 * room has a remote member; a space whose content a remote member reads
 * (notes, files, memory, tasks) makes every write into it a write to
 * other installs. Both change while a run is going — a remote member joins
 * mid-turn — so the approval route and the room reply ask again instead
 * of trusting what the run was told at spawn.
 *
 * Each answer is one `EXISTS` read, cached under the space's membership
 * version (`spaceMembershipVersion`, bumped on every membership change of
 * anyone in the space and every change of who may enter one of its rooms)
 * and for at most `TTL_MS`, so a change made by another process is seen
 * within that. A remote row counts whatever the state of its install: a
 * blocked install still read what was there, and the stricter answer is
 * the safe one.
 */
import { queryRaw } from '@/db/postgres';
import { spaceMembershipVersion } from '@/core/spaces/membership';

/** How long a cached answer stands without a version change (another process may have changed it). */
const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

interface Cached { version: number; at: number; value: boolean }
const cache = new Map<string, Cached>();

async function cached(workspaceId: string, key: string, read: () => Promise<boolean>): Promise<boolean> {
  const version = spaceMembershipVersion(workspaceId);
  const hit = cache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await read();
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { version, at: Date.now(), value });
  return value;
}

/**
 * Whether a member of another install may enter room `roomId` of
 * `workspaceId`: a remote member of the space for an open room, a remote
 * `room_members` row for a private one, or a remote guest whose scope
 * names the room.
 */
export function roomHasRemoteMember(roomId: string, workspaceId: string): Promise<boolean> {
  return cached(workspaceId, `room:${workspaceId}:${roomId}`, async () => {
    const { rows } = await queryRaw(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_members m
         JOIN users u ON u.id = m.user_id AND u.kind = 'remote'
         JOIN sessions s ON s.id = $1 AND s.kind = 'room'
         WHERE m.workspace_id = $2
           AND CASE WHEN m.role = 'guest' THEN coalesce(m.scope->'rooms', '[]'::jsonb) ? $1::text
                    WHEN s.room_visibility = 'private' THEN EXISTS (SELECT 1 FROM room_members rm WHERE rm.session_id = s.id AND rm.user_id = m.user_id)
                    ELSE true END
       ) AS federated`,
      [roomId, workspaceId],
    );
    return (rows[0] as { federated: boolean } | undefined)?.federated === true;
  });
}

/** Whether `workspaceId` has any member of another install (guests included: they read their folders and rooms). */
export function spaceHasRemoteMember(workspaceId: string): Promise<boolean> {
  return cached(workspaceId, `space:${workspaceId}`, async () => {
    const { rows } = await queryRaw(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.kind = 'remote'
         WHERE m.workspace_id = $1
       ) AS federated`,
      [workspaceId],
    );
    return (rows[0] as { federated: boolean } | undefined)?.federated === true;
  });
}

/** Forget every cached answer (tests). */
export function _resetAudienceCacheForTests(): void {
  cache.clear();
}
