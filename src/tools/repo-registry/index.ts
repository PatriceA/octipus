import type { ToolManifest } from '@/core/types';
import { buildRepoEdges, dependenciesOf, dependentsOf } from '@/core/repos/graph';
import { loadRepoGraph, repoToGraphNode, scanUserRepos, toRepoSummary } from '@/core/repos/registry-service';
import type { WorkspaceRepo } from '@db/schema/workspace-repos';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * repo_registry — the agent's map of a multi-repo suite.
 *
 * Lets a worker see which repositories exist, what each is for, read a repo's
 * structural digest (instead of re-reading the tree), and query the cross-repo
 * dependency graph ("what breaks if I change this library?"). Backed by
 * `workspace_repos`; see `.octipus/multi-repo-design.md`.
 */
export class RepoRegistryTool extends BaseTool {
  readonly id = 'repo_registry';
  readonly name = 'Repo Registry';
  readonly version = '1.0.0';
  readonly description = 'Navigate a multi-repo suite: list repos, read a repo map, and query cross-repo dependencies.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read the repo registry and dependency graph', defaultLevel: 'ALLOW' },
        { action: 'scan', description: 'Scan the workspace to refresh the repo registry', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'list_repos', description: 'List repositories in the workspace with kind, languages, and dependency counts.', parameters: {}, returns: 'Array of repo summaries' },
        { name: 'get_repo', description: 'Get one repo: structural map, languages, commands, and its in-registry dependencies/dependents.', parameters: { repo: { type: 'string', description: 'Repo name or id', required: true } }, returns: 'Full repo detail + graph neighbours' },
        { name: 'repo_dependents', description: 'Repos that depend on the given repo (what breaks if you change it).', parameters: { repo: { type: 'string', description: 'Repo name or id', required: true } }, returns: 'Array of dependent repos' },
        { name: 'repo_dependencies', description: 'In-registry repos the given repo depends on.', parameters: { repo: { type: 'string', description: 'Repo name or id', required: true } }, returns: 'Array of dependency repos' },
        { name: 'scan_repos', description: 'Re-scan the workspace to refresh the registry (detect new repos, manifests, AGENTS.md).', parameters: {}, returns: 'Count of repos found' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_repos',
      'List the repositories in this workspace — the map of the suite. Use this FIRST in a multi-repo workspace to learn what exists before reading any files. Each entry shows kind (product/library/app/infra), languages, whether it has a curated AGENTS.md, and how many in-suite dependents/dependencies it has. Returns [] if nothing has been scanned yet — call scan_repos then.',
      createParameterSchema({}),
      async (_args, context) => {
        const userId = requireUserId(context);
        const { repos, edges } = await loadRepoGraph(userId);
        return { count: repos.length, repos: repos.map((r) => toRepoSummary(r, edges)) };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'get_repo',
      'Read one repository: its structural digest (top-level dirs, entry points, build/test/lint commands), languages, and its in-suite dependency neighbours. This is the cheap "mental model" — prefer it over reading the directory tree.',
      createParameterSchema({ repo: { type: 'string', description: 'Repo name or id', required: true } }),
      async (args, context) => {
        const userId = requireUserId(context);
        const { repos, nodes, edges } = await loadRepoGraph(userId);
        const repo = resolveRepo(repos, String(args.repo));
        if (!repo) return { error: `No repo matching "${args.repo}". Call list_repos.` };
        return {
          id: repo.id,
          name: repo.name,
          kind: repo.kind,
          path: repo.rootPath,
          languages: repo.languages,
          packageName: repo.packageName ?? undefined,
          remoteUrl: repo.remoteUrl ?? undefined,
          defaultBranch: repo.defaultBranch ?? undefined,
          hasAgentsMd: repo.hasAgentsMd,
          repoMap: repo.repoMap ?? undefined,
          dependencies: dependenciesOf(repo.id, nodes, edges).map((n) => n.name),
          dependents: dependentsOf(repo.id, nodes, edges).map((n) => n.name),
          lastScannedAt: repo.lastScannedAt ?? undefined,
        };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'repo_dependents',
      'List the repositories that depend on the given repo — i.e. what may break if you change it. Use before editing a shared library.',
      createParameterSchema({ repo: { type: 'string', description: 'Repo name or id', required: true } }),
      async (args, context) => {
        const userId = requireUserId(context);
        const { repos, nodes, edges } = await loadRepoGraph(userId);
        const repo = resolveRepo(repos, String(args.repo));
        if (!repo) return { error: `No repo matching "${args.repo}". Call list_repos.` };
        const dependents = dependentsOf(repo.id, nodes, edges);
        return { repo: repo.name, count: dependents.length, dependents: dependents.map((n) => ({ name: n.name, id: n.id })) };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'repo_dependencies',
      'List the in-suite repositories the given repo depends on (only repos present in the registry, not external packages).',
      createParameterSchema({ repo: { type: 'string', description: 'Repo name or id', required: true } }),
      async (args, context) => {
        const userId = requireUserId(context);
        const { repos, nodes, edges } = await loadRepoGraph(userId);
        const repo = resolveRepo(repos, String(args.repo));
        if (!repo) return { error: `No repo matching "${args.repo}". Call list_repos.` };
        const deps = dependenciesOf(repo.id, nodes, edges);
        return { repo: repo.name, count: deps.length, dependencies: deps.map((n) => ({ name: n.name, id: n.id })) };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'scan_repos',
      'Scan the workspace to (re)build the repo registry — detects repositories, their manifests, languages, AGENTS.md, and dependency edges. Run this once at the start of multi-repo work, or after repos are added.',
      createParameterSchema({}),
      async (_args, context) => {
        const userId = requireUserId(context);
        const workspaceId = (context as { workspaceId?: string }).workspaceId;
        const repos = await scanUserRepos(userId, workspaceId ?? null);
        const edges = buildRepoEdges(repos.map(repoToGraphNode));
        return {
          scanned: repos.length,
          edges: edges.length,
          repos: repos.map((r) => ({ name: r.name, kind: r.kind, languages: r.languages })),
        };
      },
      { permissionAction: 'scan' },
    );
  }
}

function requireUserId(context: { userId?: string }): string {
  if (!context.userId) throw new Error('repo_registry requires an authenticated user context');
  return context.userId;
}

/** Resolve a repo by exact id, exact name, then case-insensitive name. */
function resolveRepo(repos: WorkspaceRepo[], ref: string): WorkspaceRepo | undefined {
  return (
    repos.find((r) => r.id === ref) ||
    repos.find((r) => r.name === ref) ||
    repos.find((r) => r.name.toLowerCase() === ref.toLowerCase())
  );
}

export const repoRegistryTool = new RepoRegistryTool();
