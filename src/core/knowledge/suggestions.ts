import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { getNoteRepository, type NoteRepository, type NoteScope, noteStoreFor } from '@/db/repositories/note-repository';
import { noteKnowledgeScope } from '@/core/rag/knowledge-scope';
import { type EmbeddingService, getEmbeddingService } from '@/core/rag/embeddings';
import { coreLogger } from '@/utils/logger';
import { entityRefFromSourceId } from './graph';

/**
 * Knowledge-graph Tier 2 — link suggestions.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * The inversion that makes embeddings and the graph complementary:
 * embeddings stop pretending to *be* the graph and instead *propose*
 * edges. For a note, find semantically similar entities that are NOT
 * already linked, and surface them as candidates ("you wrote about X
 * here and here — link them?"). Accepting one writes a real edge with
 * origin='user'; this service only computes, it does not persist.
 *
 * Reuses embeddings already computed by the note save pipeline — no new
 * model call beyond the query embedding. Degrades to an empty list
 * (logged) when no embedding model is configured.
 */

export interface LinkSuggestion {
  type: string;
  id: string;
  title?: string;
  similarity: number;
}

export class SuggestionService {
  constructor(
    private readonly notes: NoteRepository = getNoteRepository(),
    private readonly links: KnowledgeLinkRepository = getKnowledgeLinkRepository(),
    private readonly embeddings: EmbeddingService = getEmbeddingService(),
  ) {}

  /**
   * Suggestions stay inside the note's scope: a personal note of
   * `scope.workspaceId` (with `null`, the user level) is offered the notes
   * of that workspace and user-level notes — never notes of the user's other
   * workspaces, never a space's; a space note only the space's.
   */
  async suggestForNote(scope: NoteScope, noteId: string, limit = 5): Promise<LinkSuggestion[]> {
    const ws = scope.kind === 'personal' ? scope.workspaceId ?? undefined : undefined;
    const note = await noteStoreFor(scope, this.notes).getById(noteId);
    if (!note) throw new Error(`Note ${noteId} not found for this user`);

    // Already-linked targets (by resolved id) to exclude.
    const existing = await this.links.getOutgoing(scope, 'note', noteId, ws);
    const linkedIds = new Set(existing.filter((e) => e.toId).map((e) => e.toId as string));
    linkedIds.add(noteId); // never suggest self

    const query = `${note.title}\n${note.body}`.slice(0, 2000);
    let hits: Awaited<ReturnType<EmbeddingService['hybridSearch']>>;
    try {
      // Pull a buffer beyond `limit` because we filter self/linked below.
      // Scoped: only the scope's note embeddings are candidates.
      hits = await this.embeddings.hybridSearch(scope.kind === 'personal' ? { kind: 'personal', userId: scope.userId, workspaceId: scope.workspaceId } : noteKnowledgeScope(scope), query, limit * 4, 'note', undefined, 0.3);
    } catch (err) {
      coreLogger.warn({ err, component: 'suggestions', noteId }, 'Link suggestions unavailable (no embedding model?)');
      return [];
    }

    // An embedding's own workspace stamp is not what decides: the note's
    // row is. Keep only notes readable in this workspace.
    const refs = hits.map((hit) => ({ hit, ref: entityRefFromSourceId(hit.sourceId) }));
    const noteIds = refs.flatMap(({ ref }) => (ref?.type === 'note' ? [ref.id] : []));
    const visible = new Set((await noteStoreFor(scope, this.notes).getByIds(noteIds)).map((n) => n.id));

    const out: LinkSuggestion[] = [];
    const seen = new Set<string>();
    for (const { hit, ref } of refs) {
      if (!ref || ref.type !== 'note' || !visible.has(ref.id)) continue;
      if (linkedIds.has(ref.id) || seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push({ type: ref.type, id: ref.id, title: hit.metadata.title, similarity: Number(hit.similarity.toFixed(3)) });
      if (out.length >= limit) break;
    }
    return out;
  }
}

let _instance: SuggestionService | null = null;
export function getSuggestionService(): SuggestionService {
  if (!_instance) _instance = new SuggestionService();
  return _instance;
}
