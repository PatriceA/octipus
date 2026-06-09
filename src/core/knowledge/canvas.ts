import { getKnowledgeGraph, type KnowledgeGraph } from './graph';
import { getNoteRepository, type NoteRepository } from '@/db/repositories/note-repository';

/**
 * Knowledge-graph Tier 3 — JSON Canvas projection.
 * See `docs/KNOWLEDGE-GRAPH.md` and https://jsoncanvas.org/ (spec 1.0, MIT).
 *
 * A canvas is the open `{ nodes, edges }` format Obsidian uses for its
 * spatial view. We project the neighbourhood of a note (Tier 1 graph
 * traversal) into a canvas so it opens natively in Obsidian. The spec is
 * extensible — unknown fields are ignored by other tools — so we carry an
 * `octipus:entityRef` on each node without breaking interop.
 *
 * No new storage: callers persist the returned document as an artifact
 * (`type='canvas'`) or write it to the vault as a `.canvas` file.
 */

export interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  /** `file` node: vault-relative path. */
  file?: string;
  /** `text` node: inline markdown. */
  text?: string;
  /** Extension field — not part of the 1.0 spec; other tools ignore it. */
  'octipus:entityRef'?: { type: string; id: string };
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  toEnd?: 'none' | 'arrow';
  label?: string;
  color?: string;
}

export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const NODE_W = 240;
const NODE_H = 80;
const RING = 360;

export class CanvasBuilder {
  constructor(
    private readonly graph: KnowledgeGraph = getKnowledgeGraph(),
    private readonly notes: NoteRepository = getNoteRepository(),
  ) {}

  /**
   * Build a JSON Canvas of the neighbourhood around an entry note: the
   * entry at the centre, reached entities on a ring, edges between them.
   */
  async fromNeighbourhood(
    userId: string,
    entry: { type: string; id: string },
    hops = 1,
  ): Promise<JsonCanvas> {
    const traversal = await this.graph.traverse(userId, [entry], { hops, direction: 'both' });

    // Collect entity refs: entry + reached.
    const refs = [entry, ...traversal.nodes.map((n) => ({ type: n.type, id: n.id }))];
    const labelFor = await this.labels(userId, refs);

    const nodes: CanvasNode[] = [];
    const nodeIdByEntity = new Map<string, string>();
    refs.forEach((ref, i) => {
      const key = `${ref.type}:${ref.id}`;
      const nodeId = `n${i}`;
      nodeIdByEntity.set(key, nodeId);
      const angle = i === 0 ? 0 : (2 * Math.PI * (i - 1)) / Math.max(1, refs.length - 1);
      const x = i === 0 ? 0 : Math.round(RING * Math.cos(angle));
      const y = i === 0 ? 0 : Math.round(RING * Math.sin(angle));
      const meta = labelFor.get(key);
      nodes.push({
        id: nodeId,
        type: meta?.slug ? 'file' : 'text',
        x, y, width: NODE_W, height: NODE_H,
        ...(meta?.slug ? { file: `${meta.slug}.md` } : { text: meta?.label ?? key }),
        color: i === 0 ? '5' : undefined,
        'octipus:entityRef': ref,
      });
    });

    const edges: CanvasEdge[] = [];
    for (const e of traversal.edges) {
      const from = nodeIdByEntity.get(`${e.fromType}:${e.fromId}`);
      const to = e.toId && e.toType ? nodeIdByEntity.get(`${e.toType}:${e.toId}`) : undefined;
      if (!from || !to) continue;
      edges.push({ id: `e${edges.length}`, fromNode: from, toNode: to, toEnd: 'arrow', label: e.linkType === 'references' ? undefined : e.linkType });
    }

    return { nodes, edges };
  }

  /** Resolve display labels/slugs for note refs (other types fall back to id). */
  private async labels(userId: string, refs: Array<{ type: string; id: string }>): Promise<Map<string, { label: string; slug?: string }>> {
    const out = new Map<string, { label: string; slug?: string }>();
    for (const ref of refs) {
      const key = `${ref.type}:${ref.id}`;
      if (out.has(key)) continue;
      if (ref.type === 'note') {
        const note = await this.notes.getById(userId, ref.id);
        out.set(key, note ? { label: note.title, slug: note.slug } : { label: key });
      } else {
        out.set(key, { label: key });
      }
    }
    return out;
  }
}

let _instance: CanvasBuilder | null = null;
export function getCanvasBuilder(): CanvasBuilder {
  if (!_instance) _instance = new CanvasBuilder();
  return _instance;
}
