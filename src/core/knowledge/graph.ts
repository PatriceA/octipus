import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import type { KnowledgeLink } from '@/db/schema/knowledge-links';

/**
 * Knowledge-graph Tier 1 — graph traversal as a retrieval primitive.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * This is the model-friendly half of retrieval: bounded BFS over the
 * authored `knowledge_links` edges. Composed with `EmbeddingService`
 * hybrid search (semantic entry → link BFS), it lets an agent reach
 * items the author *said* are related and explain *why* each item is in
 * context ("followed [[X]] → [[Y]]"), which cosine ranking never could.
 *
 * Bounded by `hops` and `maxNodes` — house rule 1 (no unbounded loops):
 * if a traversal would exceed `maxNodes`, it throws rather than silently
 * truncating.
 */

export interface EntityRef {
  type: string;
  id: string;
}

export type TraversalDirection = 'out' | 'in' | 'both';

export interface TraverseOptions {
  /** Max BFS depth. Default 2. */
  hops?: number;
  /** Edge direction to follow. Default 'both'. */
  direction?: TraversalDirection;
  /** Restrict to these link types (e.g. ['references']). Default: all. */
  linkTypes?: string[];
  /** Hard node cap — throws if exceeded. Default 200. */
  maxNodes?: number;
}

export interface ReachedNode {
  type: string;
  id: string;
  /** Hop distance from the nearest entry node (1 = direct neighbour). */
  depth: number;
  /** The edge id that first reached this node — lets callers reconstruct the path. */
  viaEdgeId: string;
  /** Direction the edge was traversed to reach this node. */
  viaDirection: 'out' | 'in';
}

export interface TraversalResult {
  nodes: ReachedNode[];
  edges: KnowledgeLink[];
}

function key(type: string, id: string): string {
  return `${type}:${id}`;
}

export class KnowledgeGraph {
  constructor(private readonly links: KnowledgeLinkRepository = getKnowledgeLinkRepository()) {}

  /**
   * Bounded BFS over resolved edges, scoped to one user. Seed nodes are
   * not included in the result; only reached neighbours are. Ghost edges
   * (`to_id IS NULL`) are not traversable — there is nothing to traverse
   * *to* — which is correct: an unresolved wikilink has no target yet.
   *
   * `userId` is mandatory: the traversal must never cross tenant
   * boundaries, even when handed an entry id that belongs to another
   * user (it simply finds no edges).
   */
  async traverse(userId: string, entry: EntityRef[], opts: TraverseOptions = {}): Promise<TraversalResult> {
    const hops = opts.hops ?? 2;
    const direction = opts.direction ?? 'both';
    const maxNodes = opts.maxNodes ?? 200;
    const linkTypeFilter = opts.linkTypes && opts.linkTypes.length > 0 ? new Set(opts.linkTypes) : null;

    const visited = new Set<string>(entry.map((e) => key(e.type, e.id)));
    const reached: ReachedNode[] = [];
    const edges: KnowledgeLink[] = [];
    const edgesSeen = new Set<string>();

    let frontier: EntityRef[] = entry;

    for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
      // Group the frontier by entity type so each level is a handful of
      // batched `IN (...)` queries rather than one query per node.
      const byType = new Map<string, string[]>();
      for (const node of frontier) {
        const list = byType.get(node.type) ?? [];
        list.push(node.id);
        byType.set(node.type, list);
      }

      const levelEdges: Array<{ edge: KnowledgeLink; dir: 'out' | 'in' }> = [];
      for (const [type, ids] of byType) {
        if (direction === 'out' || direction === 'both') {
          for (const edge of await this.links.outgoingForIds(userId, type, ids)) {
            levelEdges.push({ edge, dir: 'out' });
          }
        }
        if (direction === 'in' || direction === 'both') {
          for (const edge of await this.links.backlinksForIds(userId, type, ids)) {
            levelEdges.push({ edge, dir: 'in' });
          }
        }
      }

      const nextFrontier: EntityRef[] = [];
      for (const { edge, dir } of levelEdges) {
        if (linkTypeFilter && !linkTypeFilter.has(edge.linkType)) continue;

        const neighbor: EntityRef | null =
          dir === 'out'
            ? edge.toId && edge.toType
              ? { type: edge.toType, id: edge.toId }
              : null // ghost edge — not traversable
            : { type: edge.fromType, id: edge.fromId };
        if (!neighbor) continue;

        const k = key(neighbor.type, neighbor.id);
        if (visited.has(k)) continue;
        visited.add(k);

        reached.push({ type: neighbor.type, id: neighbor.id, depth: depth + 1, viaEdgeId: edge.id, viaDirection: dir });
        if (!edgesSeen.has(edge.id)) {
          edgesSeen.add(edge.id);
          edges.push(edge);
        }
        nextFrontier.push(neighbor);

        if (reached.length > maxNodes) {
          throw new Error(
            `Knowledge graph traversal exceeded maxNodes=${maxNodes} from ${entry.length} entry node(s) at depth ${depth + 1}. Narrow the traversal (fewer hops, a linkTypes filter) or raise maxNodes deliberately.`,
          );
        }
      }
      frontier = nextFrontier;
    }

    return { nodes: reached, edges };
  }
}

let _instance: KnowledgeGraph | null = null;
export function getKnowledgeGraph(): KnowledgeGraph {
  if (!_instance) _instance = new KnowledgeGraph();
  return _instance;
}

/**
 * Map an `embeddings.source_id` to a knowledge entity ref when it follows
 * the `<type>:<uuid>` convention (e.g. `note:<uuid>`). Returns null for
 * legacy source ids (file paths, etc.) that don't address an entity.
 * Lets `search mode='graph'` derive traversal entry points from hybrid
 * search hits.
 */
export function entityRefFromSourceId(sourceId: string): EntityRef | null {
  const m = /^(note|document|memory|artifact):([0-9a-fA-F-]{36})$/.exec(sourceId);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}
