import { eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { dockerProjectOwners } from '../schema/docker-project-owners';
/** Reserve a daemon/project identity without adopting unknown pre-existing resources. */
export async function claimDockerProject(identity: string, repoPath: string, caller: { userId: string; workspaceId?: string | null }, create: boolean, hasResources: boolean): Promise<void> {
  await getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`docker-project:${identity}`}))`);
    const [owner] = await tx.select().from(dockerProjectOwners).where(eq(dockerProjectOwners.identity, identity));
    if (owner) {
      if (owner.repoPath !== repoPath || owner.userId !== caller.userId || owner.workspaceId !== (caller.workspaceId ?? null)) throw new Error('Compose project belongs to another repository or execution scope');
      return;
    }
    if (!create || hasResources) throw new Error('Compose project ownership is unknown; existing containers, volumes or networks cannot be adopted by this tool. Use a distinct approved project name.');
    await tx.insert(dockerProjectOwners).values({ identity, repoPath, userId: caller.userId, workspaceId: caller.workspaceId ?? null });
  });
}
