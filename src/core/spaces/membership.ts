/**
 * What a membership change does at once (docs/plans/coworking-spec.md §5.9,
 * I5): removal and downgrade take effect on the next request, the next tool
 * decision and the next socket frame — and running work of that member in
 * the space stops now.
 *
 * - `membershipVersion` is the in-process counter (D5, D16) that paths too
 *   hot to read the database on every event (document updates, S3) compare
 *   against; every change bumps it.
 * - `onMembershipChanged` runs for a removal, a downgrade or a guest scope
 *   change: stops the member's agents in the space, expires their pending
 *   permission and approval requests there, and pauses the data sources
 *   they own on the space's artifacts. (Room, document and presence
 *   subscriptions join it in S2/S3.)
 * - `onMembershipGranted` runs for a join or an upgrade: bumps the version
 *   and resumes the member's data sources if they may write again.
 * - `stopSpaceAgents` stops every agent of a space (archive).
 *
 * Each step runs even when another fails; failures are logged and thrown
 * together at the end, so the caller (and the person) hears about them.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { artifactDataSources } from '@/db/schema/artifact-data-sources';
import { artifacts } from '@/db/schema/artifacts';
import { sessions } from '@/db/schema/sessions';
import { can } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { getMembership } from './service';

const versions = new Map<string, number>();
const versionKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

/** The in-process version of `userId`'s membership of `workspaceId`; changes on every membership change. */
export function membershipVersion(workspaceId: string, userId: string): number {
  return versions.get(versionKey(workspaceId, userId)) ?? 0;
}

function bumpVersion(workspaceId: string, userId: string): void {
  const key = versionKey(workspaceId, userId);
  versions.set(key, (versions.get(key) ?? 0) + 1);
}

/** Why a data source is paused when its principal lost write access to the space. */
export const MEMBERSHIP_PAUSE_REASON = 'membership';

const REMOVED_MESSAGE = 'Your access to this space changed.';

async function runSteps(
  what: string,
  context: Record<string, unknown>,
  steps: Array<[string, () => Promise<unknown> | unknown]>,
): Promise<void> {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      coreLogger.error({ err, ...context, step: name }, `${what} step failed`);
      failed.push(name);
    }
  }
  if (failed.length > 0) throw new Error(`${what}: ${failed.join(', ')} failed`);
}

/** Session ids of `userId` in `workspaceId` (their private chats there). */
async function sessionIdsIn(workspaceId: string, userId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.userId, userId)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Pause the data sources `userId` owns on the space's artifacts when they may
 * no longer write there; resume the ones this module paused when they may.
 * Returns how many rows changed.
 */
export async function syncDataSources(workspaceId: string, userId: string): Promise<number> {
  const membership = await getMembership(userId, workspaceId);
  const mayWrite = can(membership?.role, 'write');
  const inSpace = inArray(
    artifactDataSources.artifactId,
    getDb().select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId)),
  );
  const owned = and(eq(artifactDataSources.principalId, userId), inSpace);
  const changed = mayWrite
    ? await getDb()
      .update(artifactDataSources)
      .set({ pausedAt: null, pausedReason: null, updatedAt: new Date() })
      .where(and(owned, isNotNull(artifactDataSources.pausedAt), eq(artifactDataSources.pausedReason, MEMBERSHIP_PAUSE_REASON)))
      .returning({ id: artifactDataSources.id })
    : await getDb()
      .update(artifactDataSources)
      .set({ pausedAt: sql`now()`, pausedReason: MEMBERSHIP_PAUSE_REASON, updatedAt: new Date() })
      .where(and(owned, isNull(artifactDataSources.pausedAt)))
      .returning({ id: artifactDataSources.id });
  if (changed.length > 0) {
    coreLogger.info({ workspaceId, userId, count: changed.length, paused: !mayWrite }, 'Space data sources follow a membership change');
  }
  return changed.length;
}

/**
 * A member was removed from `workspaceId`, downgraded, or had their guest
 * scope changed. Throws (after running every step) when a step failed.
 */
export async function onMembershipChanged(workspaceId: string, userId: string): Promise<void> {
  bumpVersion(workspaceId, userId);
  const { getAgentManager } = await import('@/core/agent-manager');
  const { getPermissionManager } = await import('@/security/permissions');
  const { getAgentService } = await import('@/core/agent');
  await runSteps('Membership change', { workspaceId, userId }, [
    ['stop agents', () => getAgentManager().stopWorkspace(workspaceId, userId)],
    ['expire permission requests', () => getPermissionManager().expireForUserInWorkspace(userId, workspaceId)],
    ['expire approvals', async () => getAgentService().expireApprovalsForUser(userId, REMOVED_MESSAGE, await sessionIdsIn(workspaceId, userId))],
    ['pause data sources', () => syncDataSources(workspaceId, userId)],
  ]);
}

/** A member joined `workspaceId` or was upgraded. */
export async function onMembershipGranted(workspaceId: string, userId: string): Promise<void> {
  bumpVersion(workspaceId, userId);
  await syncDataSources(workspaceId, userId);
}

/** Stop every agent running in the space (archive). Returns how many were stopped. */
export async function stopSpaceAgents(workspaceId: string): Promise<number> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const stopped = getAgentManager().stopWorkspace(workspaceId);
  if (stopped > 0) coreLogger.info({ workspaceId, stopped }, 'Space agents stopped');
  return stopped;
}

/** Test hook. */
export function _resetMembershipVersionsForTests(): void {
  versions.clear();
}
