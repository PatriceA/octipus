import { resolve } from 'path';
import { getConfig } from '@/config';
import { repoRegistryRepository } from '@/db/repositories/repo-registry-repository';
import type { WorkspaceRepo } from '@db/schema/workspace-repos';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import { type RepoEdge, type RepoGraphNode, buildRepoEdges } from './graph';
import { scanRoots } from './scanner';

/**
 * Registry service — orchestrates scanner + persistence + graph for a user.
 * Shared by the `repo_registry` tool and the workspace API route so the
 * scan/scope logic lives in one place. See `.octipus/multi-repo-design.md`.
 */

/** The workspace roots a user's repos can live under. */
export function userScanRoots(userId: string): string[] {
  const fs = WorkspaceFS.forAgent({ userId });
  fs.ensureRootSync();
  const additional = getConfig().workspace.additionalPaths?.map((p) => resolve(p)) ?? [];
  return [fs.root, ...additional];
}

/** Scan every repo under the user's workspace roots and upsert the registry. */
export async function scanUserRepos(userId: string, workspaceId?: string | null): Promise<WorkspaceRepo[]> {
  const roots = userScanRoots(userId);
  const scanned = scanRoots(roots);
  for (const r of scanned) {
    await repoRegistryRepository.upsert({
      userId,
      workspaceId: workspaceId ?? null,
      name: r.name,
      rootPath: r.rootPath,
      remoteUrl: r.remoteUrl,
      defaultBranch: r.defaultBranch,
      kind: r.kind,
      languages: r.languages,
      packageName: r.packageName,
      dependencies: r.dependencies,
      repoMap: r.repoMap,
      hasAgentsMd: r.hasAgentsMd,
      lastScannedAt: new Date(),
    });
  }
  coreLogger.info({ userId, scanned: scanned.length, roots: roots.length }, 'repo registry scan complete');
  return repoRegistryRepository.listByUser(userId);
}

export interface RepoSummary {
  id: string;
  name: string;
  kind: string;
  languages: string[];
  path: string;
  packageName?: string;
  hasAgentsMd: boolean;
  dependents: number;
  dependencies: number;
}

/** Public, display-safe projection of a repo + its edge counts. */
export function toRepoSummary(repo: WorkspaceRepo, edges: RepoEdge[]): RepoSummary {
  return {
    id: repo.id,
    name: repo.name,
    kind: repo.kind,
    languages: repo.languages,
    path: repo.rootPath,
    packageName: repo.packageName ?? undefined,
    hasAgentsMd: repo.hasAgentsMd,
    dependents: edges.filter((e) => e.to === repo.id).length,
    dependencies: edges.filter((e) => e.from === repo.id).length,
  };
}

export function repoToGraphNode(repo: WorkspaceRepo): RepoGraphNode {
  return {
    id: repo.id,
    name: repo.name,
    packageName: repo.packageName,
    dependencies: repo.dependencies,
  };
}

/** Load the user's registry as graph nodes + derived edges. */
export async function loadRepoGraph(userId: string): Promise<{ repos: WorkspaceRepo[]; nodes: RepoGraphNode[]; edges: RepoEdge[] }> {
  const repos = await repoRegistryRepository.listByUser(userId);
  const nodes = repos.map(repoToGraphNode);
  return { repos, nodes, edges: buildRepoEdges(nodes) };
}
