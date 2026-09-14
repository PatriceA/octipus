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

/** Package keys that cannot be linked because more than one repo provides them. */
export function findAmbiguousPackages(nodes: RepoGraphNode[]): string[] {
  const exact = new Map<string, Set<string>>();
  const python = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!node.packageName) continue;
    addProvider(exact, node.packageName, node.id);
    addProvider(python, normalizePythonPackage(node.packageName), node.id);
  }
  const ambiguous = new Set<string>();
  for (const [packageName, providers] of exact) {
    if (providers.size > 1) ambiguous.add(packageName);
  }
  // A Python dependency can spell `foo_bar`, `foo-bar`, and `Foo.Bar`
  // interchangeably, so collisions after PEP normalization are ambiguous too.
  for (const [packageName, providers] of python) {
    if (providers.size > 1) ambiguous.add(packageName);
  }
  return [...ambiguous].sort();
}

/** Build all in-registry dependency edges (consumer → provider). */
export function buildRepoEdges(nodes: RepoGraphNode[]): RepoEdge[] {
  // Keep every claimant. Linking an ambiguous package to whichever row happened
  // to be visited last produces a false graph, so ambiguous names stay unlinked.
  const byPackage = new Map<string, Set<string>>();
  const byPythonPackage = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!node.packageName) continue;
    addProvider(byPackage, node.packageName, node.id);
    addProvider(byPythonPackage, normalizePythonPackage(node.packageName), node.id);
  }
  const edges: RepoEdge[] = [];
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const dep of node.dependencies) {
      const providerId = dep.manifest === 'pyproject.toml'
        ? uniqueProvider(byPythonPackage.get(normalizePythonPackage(dep.name)))
        : uniqueProvider(byPackage.get(dep.name));
      if (!providerId || providerId === node.id) continue;
      // A graph edge is between repositories. Multiple declarations or aliases
      // that resolve to the same provider remain one edge.
      if (seen.has(providerId)) continue;
      seen.add(providerId);
      edges.push({ from: node.id, to: providerId, via: dep.name, version: dep.version });
    }
  }
  return edges;
}

function addProvider(index: Map<string, Set<string>>, packageName: string, repoId: string): void {
  const providers = index.get(packageName) ?? new Set<string>();
  providers.add(repoId);
  index.set(packageName, providers);
}

function uniqueProvider(providers: Set<string> | undefined): string | undefined {
  return providers?.size === 1 ? providers.values().next().value : undefined;
}

/** PEP 503: Python project names are case-insensitive and `-_.` are equivalent. */
function normalizePythonPackage(packageName: string): string {
  return packageName.toLowerCase().replace(/[-_.]+/g, '-');
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
