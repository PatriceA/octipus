import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { getNoteRepository, type NoteRepository } from '@/db/repositories/note-repository';
import { type EmbeddingService, getEmbeddingService } from '@/core/rag/embeddings';
import { SECURITY_PREAMBLE } from '@/core/orchestrator/roles';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { entityRefFromSourceId } from './graph';
import type { WikiLink } from './wikilink';

/**
 * Knowledge-graph Tier 2 — fuzzy resolution of ghost wikilinks.
 *
 * `[[Octipus Architecture]]` slugs to `octipus-architecture`. If the note the
 * author meant is titled "Octipus architecture overview" (slug
 * `octipus-architecture-overview`), exact-slug resolution never binds the edge
 * and the two ideas stay disconnected forever — the graph draws no line and
 * backlinks miss it.
 *
 * The shape here is standard entity resolution: cheap embedding *blocking* to
 * propose a handful of candidates, then a *pair resolver* (a small LLM) to
 * adjudicate, then a canonical policy. The policy is the safety rail:
 *
 *   - Existing notes are never merged, renamed, or rewritten. The only write is
 *     filling `to_id` on one edge.
 *   - `to_ref` is left untouched, so the authored intent survives verbatim.
 *   - A fuzzy binding is marked by a non-NULL `confidence` (the schema already
 *     reserves that column for non-authored edges), which is what lets
 *     `resolveTo` take the binding back when a note with the exact slug is
 *     later created. An exact match always outranks a guess.
 *
 * Degrades to a no-op (logged, never thrown) with no embedding model, no
 * background model, or no candidates — a note save must not fail because a
 * link could not be guessed.
 */

/** One ghost ref bound to an existing note. */
export interface GhostResolution {
  /** The authored ref (slug) — unchanged in the DB. */
  ref: string;
  /** Note the edge was bound to. */
  noteId: string;
  title: string;
  /** Retrieval score of the chosen candidate; stored as the edge's confidence. */
  similarity: number;
  /** Edges bound (every ghost edge carrying this ref, across the user's notes). */
  edges: number;
}

/**
 * Ghost refs looked at per save. A note that links twenty not-yet-written pages
 * is a normal outline, and each unresolved ref costs one search + one small LLM
 * call.
 * ponytail: fixed cap, refs beyond it stay ghosts until the next save touches
 * them — raise it (or move the whole pass to the background sweep) if outlines
 * routinely lose links.
 */
const MAX_REFS_PER_SAVE = 5;

/** Candidate notes shown to the pair resolver for one ref. */
const MAX_CANDIDATES = 3;

/**
 * Floor for the blocking step. Deliberately loose — the LLM is the real gate,
 * and a title-only match ("Architecture" vs "Octipus architecture overview")
 * scores lower than prose similarity would.
 */
const MIN_CANDIDATE_SIMILARITY = 0.35;

const RESOLVER_SYSTEM_PROMPT = `${SECURITY_PREAMBLE}

You resolve a wiki-style link to an existing note. You are given the LINK TEXT
an author wrote inside [[double brackets]], and a numbered list of CANDIDATE
note titles. Choose the candidate that refers to THE SAME THING the link text
names — a different wording, spelling, or pluralisation of the same subject.

Choose null when no candidate is the same thing. Being related, being about the
same broad topic, or being the obvious "parent" subject is NOT the same thing —
a wrong link is worse than no link, so prefer null when unsure.

Output ONLY valid JSON, no prose, no markdown fences:

{ "match": <candidate number> | null }`;

/** Pure parser — broken out for testing. Returns a 1-based candidate number, or null. */
export function parseResolverMatch(raw: string, candidateCount: number): number | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as { match?: unknown };
    const m = obj?.match;
    // Small models like to answer "1" as a string.
    const n = typeof m === 'number' ? m : typeof m === 'string' ? Number(m) : Number.NaN;
    if (Number.isInteger(n) && n >= 1 && n <= candidateCount) return n;
  } catch {
    /* fall through */
  }
  return null;
}

export interface ResolverCandidate {
  noteId: string;
  title: string;
  similarity: number;
}

/**
 * Pure blocking step: collapse note chunk hits into at most `MAX_CANDIDATES`
 * distinct notes, best score first, excluding the linking note itself and any
 * hit we can't name (a candidate with no title can't be adjudicated).
 */
export function selectCandidates(
  hits: Array<{ sourceId: string; similarity: number; metadata: { title?: string } }>,
  excludeNoteId: string,
): ResolverCandidate[] {
  const out: ResolverCandidate[] = [];
  const seen = new Set<string>([excludeNoteId]);
  for (const hit of hits) {
    const ref = entityRefFromSourceId(hit.sourceId);
    if (!ref || ref.type !== 'note' || seen.has(ref.id)) continue;
    const title = hit.metadata?.title;
    if (!title) continue;
    seen.add(ref.id);
    out.push({ noteId: ref.id, title, similarity: hit.similarity });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export class LinkResolverService {
  constructor(
    private readonly notes: NoteRepository = getNoteRepository(),
    private readonly links: KnowledgeLinkRepository = getKnowledgeLinkRepository(),
    private readonly embeddings: EmbeddingService = getEmbeddingService(),
  ) {}

  /**
   * Try to bind the ghost refs of a just-saved note to existing notes.
   * `wikilinks` is the parsed link set; refs that resolved exactly (a note with
   * that slug exists) are skipped by the caller-visible check below, so this is
   * only ever the leftovers.
   */
  async resolveGhostRefs(params: {
    userId: string;
    workspaceId: string | null;
    /** The saved note — never a candidate for its own links. */
    noteId: string;
    wikilinks: WikiLink[];
  }): Promise<GhostResolution[]> {
    const { userId, workspaceId, noteId } = params;

    // Dedup by ref, keeping the author's display text for the prompt: the
    // slug (`octipus-architecture`) is a worse query than what they typed.
    const byRef = new Map<string, string>();
    for (const link of params.wikilinks) {
      if (!byRef.has(link.ref)) byRef.set(link.ref, link.target);
    }

    const model = await getModelRegistry().getModelForTopic('background');
    if (!model) {
      coreLogger.debug(
        { component: 'link-resolver' },
        'No model bound to the "background" topic — ghost links left unresolved',
      );
      return [];
    }

    const out: GhostResolution[] = [];
    let examined = 0;
    for (const [ref, target] of byRef) {
      // Exact match wins and needs no guessing.
      if (await this.notes.getBySlug(userId, workspaceId, ref)) continue;
      if (examined >= MAX_REFS_PER_SAVE) {
        coreLogger.debug(
          { component: 'link-resolver', noteId, cap: MAX_REFS_PER_SAVE },
          'Ghost-link resolution cap reached — remaining refs left unresolved',
        );
        break;
      }
      examined++;

      try {
        const resolution = await this.resolveOne({ userId, workspaceId, noteId, ref, target, modelId: model.modelId });
        if (resolution) out.push(resolution);
      } catch (err) {
        // A guess that fails is not a save failure.
        coreLogger.warn({ err, component: 'link-resolver', noteId, ref }, 'Ghost-link resolution failed for one ref');
      }
    }
    return out;
  }

  private async resolveOne(params: {
    userId: string;
    workspaceId: string | null;
    noteId: string;
    ref: string;
    target: string;
    modelId: string;
  }): Promise<GhostResolution | null> {
    const { userId, workspaceId, noteId, ref, target, modelId } = params;

    // Blocking. Tenant-scoped to this user's notes, like link suggestions.
    const hits = await this.embeddings.hybridSearch(
      target,
      MAX_CANDIDATES * 4,
      'note',
      undefined,
      MIN_CANDIDATE_SIMILARITY,
      userId,
    );
    const blocked = selectCandidates(hits, noteId);
    if (blocked.length === 0) return null;

    // Workspace boundary. The exact path is scoped by `getBySlug(userId,
    // workspaceId, ref)`, so the guess path has to be too — otherwise a
    // `[[Roadmap 2027]]` written in one workspace can bind to a "Roadmap" note
    // that lives in another. The filter happens here rather than in the search
    // because note chunks in `embeddings` carry no workspace column; the
    // candidate notes themselves are the only authority.
    const rows = await this.notes.getByIds(userId, blocked.map((c) => c.noteId));
    const inScope = new Set(
      rows.filter((n) => (n.workspaceId ?? null) === workspaceId).map((n) => n.id),
    );
    const candidates = blocked.filter((c) => inScope.has(c.noteId));
    if (candidates.length === 0) return null;

    // Pair resolution.
    const list = candidates.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
    const result = await getLiteLLMClient().complete({
      model: modelId,
      messages: [
        { role: 'system', content: RESOLVER_SYSTEM_PROMPT, timestamp: new Date() },
        { role: 'user', content: `LINK TEXT:\n${target}\n\nCANDIDATES:\n${list}`, timestamp: new Date() },
      ],
      temperature: 0,
      maxTokens: 50,
      responseFormat: { type: 'json_object' },
      userId,
    });
    const match = parseResolverMatch(result.content ?? '', candidates.length);
    if (match === null) return null;

    const chosen = candidates[match - 1];
    const edges = await this.links.resolveTo({
      userId,
      toRef: ref,
      toType: 'note',
      toId: chosen.noteId,
      // Marks the binding as a guess — this is what lets an exact match take
      // it back later (see KnowledgeLinkRepository.resolveTo).
      confidence: chosen.similarity,
    });
    if (edges === 0) return null;

    coreLogger.info(
      { component: 'link-resolver', noteId, ref, boundTo: chosen.noteId, title: chosen.title, similarity: chosen.similarity, edges },
      'Bound ghost wikilink to an existing note by similarity',
    );
    return { ref, noteId: chosen.noteId, title: chosen.title, similarity: chosen.similarity, edges };
  }
}

let _instance: LinkResolverService | null = null;
export function getLinkResolverService(): LinkResolverService {
  if (!_instance) _instance = new LinkResolverService();
  return _instance;
}
