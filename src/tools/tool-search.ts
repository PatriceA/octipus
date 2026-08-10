/**
 * Semantic ranking for the `list_tools` discovery meta-tool (WS5 — tool_search).
 *
 * Lazy tool discovery already hides long-tail tool *schemas* behind `list_tools`
 * / `describe_tool` (see tool-discovery.ts). This adds the missing half: when a
 * role's long tail is large, `list_tools(query)` ranks it by embedding
 * similarity to the query so the model sees the RELEVANT tools first instead of
 * an undifferentiated dump.
 *
 * Reuses the existing embedding service (`getEmbeddingService`) — no new deps.
 * Degrades gracefully: any failure (no query, no embedding provider, error)
 * returns `null` so the caller falls back to the full unranked list.
 */
import { type EmbedSide, getEmbeddingService, sha256Hex } from '@/core/rag/embeddings';
import { toolLogger } from '@/utils/logger';

export interface ToolSummary {
  name: string;
  description: string;
}

/** `(text, side) => embedding`. Injectable so ranking is unit-testable without a live provider. */
export type Embedder = (text: string, side?: EmbedSide) => Promise<number[]>;

const defaultEmbedder: Embedder = (text, side) => getEmbeddingService().generateEmbedding(text, side);

/** In-memory cache of tool embeddings, keyed by a hash of `name\ndescription`. */
const toolEmbeddingCache = new Map<string, number[]>();

/** Test hook — clear the tool-embedding cache between cases. */
export function _clearToolEmbeddingCache(): void {
  toolEmbeddingCache.clear();
}

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toolText(t: ToolSummary): string {
  return `${t.name}\n${t.description}`;
}

/**
 * Rank `tools` by semantic similarity to `query`, returning the top `limit`.
 * Returns `null` (caller should fall back to the full list) when `query` is
 * empty or embedding fails. Tool embeddings are cached by content hash so a
 * given tool is embedded at most once per process.
 */
export async function rankToolsByQuery(
  tools: ToolSummary[],
  query: string,
  limit: number,
  embed: Embedder = defaultEmbedder,
): Promise<ToolSummary[] | null> {
  const q = query.trim();
  if (!q || tools.length === 0) return null;

  try {
    const queryVec = await embed(q, 'query');
    const scored = await Promise.all(
      tools.map(async (t) => {
        const key = sha256Hex(toolText(t));
        let vec = toolEmbeddingCache.get(key);
        if (!vec) {
          vec = await embed(toolText(t), 'document');
          toolEmbeddingCache.set(key, vec);
        }
        return { tool: t, score: cosineSimilarity(queryVec, vec) };
      }),
    );
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit)).map((s) => s.tool);
  } catch (err) {
    toolLogger.debug({ err }, 'tool_search: semantic ranking unavailable, falling back to full list');
    return null;
  }
}
