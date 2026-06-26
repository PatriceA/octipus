import type { RepoDependency } from '@db/schema/workspace-repos';

/**
 * Cross-repo dependency graph. Pure functions over registry rows — no I/O.
 *
 * Edges are derived, not stored: a repo A depends on repo B when one of A's
 * manifest dependencies names B's published `packageName`. This answers the
 * questions that matter in a suite ("if I change B, what breaks?") in one
 * pass over the registry, instead of grepping every repo.
 */

export interface RepoGraphNode {
  id: string;
  name: string;
  /** The package name this repo publishes (matched against others' deps). */
  packageName: string | null;
  dependencies: RepoDependency[];
}

export interface RepoEdge {
  /** Consumer repo id (depends on `to`). */
  from: string;
  /** Provider repo id (depended upon). */
  to: string;
  /** The package name that links them. */
  via: string;
  /** Version constraint the consumer declared. */
  version: string;
}

/** Build all in-registry dependency edges (consumer → provider). */
export function buildRepoEdges(nodes: RepoGraphNode[]): RepoEdge[] {
  // packageName → providing repo id. A package name should be unique across a
  // suite; if two repos claim it, last-writer-wins (logged by the caller).
  const byPackage = new Map<string, string>();
  for (const node of nodes) {
    if (node.packageName) byPackage.set(node.packageName, node.id);
  }
  const edges: RepoEdge[] = [];
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const dep of node.dependencies) {
      const providerId = byPackage.get(dep.name);
      if (!providerId || providerId === node.id) continue;
      // Collapse dependency + devDependency duplicates to one edge.
      const key = `${providerId}:${dep.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: node.id, to: providerId, via: dep.name, version: dep.version });
    }
  }
  return edges;
}

/** Repos that depend on `repoId` (reverse edges) — "what breaks if I change this". */
export function dependentsOf(repoId: string, nodes: RepoGraphNode[], edges?: RepoEdge[]): RepoGraphNode[] {
  const e = edges ?? buildRepoEdges(nodes);
  const ids = new Set(e.filter((edge) => edge.to === repoId).map((edge) => edge.from));
  return nodes.filter((n) => ids.has(n.id));
}

/** Repos that `repoId` depends on, restricted to repos in the registry. */
export function dependenciesOf(repoId: string, nodes: RepoGraphNode[], edges?: RepoEdge[]): RepoGraphNode[] {
  const e = edges ?? buildRepoEdges(nodes);
  const ids = new Set(e.filter((edge) => edge.from === repoId).map((edge) => edge.to));
  return nodes.filter((n) => ids.has(n.id));
}
