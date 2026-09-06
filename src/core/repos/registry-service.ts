import type { WorkspaceRepo } from '@db/schema/workspace-repos';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { getConfig } from '@/config';
import { repoRegistryRepository } from '@/db/repositories/repo-registry-repository';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import { buildRepoEdges, type RepoEdge, type RepoGraphNode } from './graph';
import { scanRoots } from './scanner';
import { indexRepoSymbols } from './symbols';

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
    // The symbol index is the slow part of a scan (tree-sitter over every
    // source file) and the part most likely to be unavailable (no WASM
    // runtime, no grammar for the language). Bounded by its own caps and
    // never allowed to fail the scan: a repo without symbols is still a repo.
    const symbolIndex = await indexRepoSymbols(r.rootPath).catch((err) => {
      coreLogger.warn({ err, repo: r.name }, 'repo symbol indexing failed (non-fatal)');
      return null;
    });
    const row = await repoRegistryRepository.upsert({
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
      symbolIndex: symbolIndex && symbolIndex.fileCount > 0 ? symbolIndex : null,
      hasAgentsMd: r.hasAgentsMd,
      lastScannedAt: new Date(),
    });
    // Best-effort: index the repo's generated/curated content (NOT raw code)
    // into RAG, scoped to repo_id. Never let an indexing failure (e.g. no
    // embedding model) abort the scan.
    await indexRepoKnowledge(row, userId).catch((err) =>
      coreLogger.warn({ err, repo: row.name }, 'repo knowledge indexing failed (non-fatal)'),
    );
  }
  coreLogger.info({ userId, scanned: scanned.length, roots: roots.length }, 'repo registry scan complete');
  return repoRegistryRepository.listByUser(userId);
}

/**
 * Index a repo's GENERATED/CURATED content into RAG, scoped to its `repoId`:
 * the structural repo-map digest and the curated `AGENTS.md`. Raw source code
 * is deliberately never indexed (see `src/core/rag/code-detection.ts`) — these
 * summaries are what repo-scoped search retrieves instead.
 */
export async function indexRepoKnowledge(repo: WorkspaceRepo, userId: string): Promise<void> {
  const { getEmbeddingService, sha256Hex } = await import('@/core/rag/embeddings');
  const service = getEmbeddingService();

  // The generated/curated content to index — never raw code.
  const items: Array<{
    purpose: 'knowledge_artifact' | 'document';
    sourceId: string;
    content: string;
    metadata: { source: string; title: string; filePath?: string };
  }> = [];

  if (repo.repoMap?.trim()) {
    items.push({
      purpose: 'knowledge_artifact',
      sourceId: `repo:${repo.id}:map`,
      content: `# ${repo.name} — repo map\n\n${repo.repoMap}`,
      metadata: { source: 'repo-map', title: `${repo.name} repo map` },
    });
  }
  const agentsPath = join(repo.rootPath, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, 'utf-8');
    if (content.trim()) {
      items.push({
        purpose: 'document',
        sourceId: `repo:${repo.id}:agents`,
        content,
        metadata: { source: 'repo-agents', title: `${repo.name} AGENTS.md`, filePath: agentsPath },
      });
    }
  }

  for (const item of items) {
    // Skip the expensive re-embed when the content is byte-for-byte unchanged
    // since the last scan (fileSha stamped on the chunks).
    if (await service.isFileIndexed(item.purpose, item.sourceId, item.content)) continue;
    await service.deleteBySource(item.purpose, item.sourceId);
    await service.indexText(
      item.purpose,
      item.sourceId,
      item.content,
      { ...item.metadata, fileSha: sha256Hex(item.content) },
      undefined,
      userId,
      repo.id,
    );
  }
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
