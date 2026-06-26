import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type NewWorkspaceRepo, type WorkspaceRepo, workspaceRepos } from '../schema/workspace-repos';

/**
 * Repo registry persistence. Every method is owner-scoped by an explicit
 * `userId` (the agent/route already holds the authenticated user), mirroring
 * the unscoped repository pattern (`profile-repository`).
 *
 * See `.octipus/multi-repo-design.md`.
 */
export class RepoRegistryRepository {
  private get db() { return getDb(); }

  /** All repos owned by the user, newest-scanned first. */
  async listByUser(userId: string): Promise<WorkspaceRepo[]> {
    return this.db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.userId, userId))
      .orderBy(desc(workspaceRepos.updatedAt));
  }

  async getById(userId: string, id: string): Promise<WorkspaceRepo | null> {
    const rows = await this.db
      .select()
      .from(workspaceRepos)
      .where(and(eq(workspaceRepos.userId, userId), eq(workspaceRepos.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert or refresh a repo by its (user, root_path) identity. Re-scanning a
   * known repo updates the row in place rather than creating duplicates.
   */
  async upsert(rec: NewWorkspaceRepo): Promise<WorkspaceRepo> {
    const result = await this.db
      .insert(workspaceRepos)
      .values(rec)
      .onConflictDoUpdate({
        target: [workspaceRepos.userId, workspaceRepos.rootPath],
        set: {
          name: rec.name,
          workspaceId: rec.workspaceId ?? null,
          remoteUrl: rec.remoteUrl ?? null,
          defaultBranch: rec.defaultBranch ?? null,
          kind: rec.kind,
          languages: rec.languages,
          packageName: rec.packageName ?? null,
          dependencies: rec.dependencies,
          repoMap: rec.repoMap ?? null,
          hasAgentsMd: rec.hasAgentsMd,
          lastScannedAt: rec.lastScannedAt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  async deleteById(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(workspaceRepos)
      .where(and(eq(workspaceRepos.userId, userId), eq(workspaceRepos.id, id)))
      .returning();
    return result.length > 0;
  }
}

export const repoRegistryRepository = new RepoRegistryRepository();
