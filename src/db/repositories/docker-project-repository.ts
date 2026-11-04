import { eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { dockerProjectOwners } from '../schema/docker-project-owners';
/** Reserve a daemon/project identity. Explicit lifecycle approval can adopt an unregistered project; registered ownership never transfers. */
export async function claimDockerProject(identity: string, repoPath: string, caller: { userId: string; workspaceId?: string | null }, create: boolean, hasResources: boolean, adoptApprovedExisting = false): Promise<void> {
  await getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`docker-project:${identity}`}))`);
    const [owner] = await tx.select().from(dockerProjectOwners).where(eq(dockerProjectOwners.identity, identity));
    if (owner) {
      if (owner.repoPath !== repoPath || owner.userId !== caller.userId || owner.workspaceId !== (caller.workspaceId ?? null)) throw new Error('Compose project belongs to another repository or execution scope');
      return;
    }
    if (!create || hasResources && !adoptApprovedExisting) throw new Error('Compose project ownership is unknown; existing resources require an approved Compose lifecycle call for this repository and project.');
    await tx.insert(dockerProjectOwners).values({ identity, repoPath, userId: caller.userId, workspaceId: caller.workspaceId ?? null });
  });
}
