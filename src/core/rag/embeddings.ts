import { createHash } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { cleanupAuditLog } from '@/db/schema/cleanup-log';
import { cosineSimilarity, type EmbeddingMetadata, embeddings } from '@/db/schema/embeddings';
import { getLiteLLMClient } from '@/models/litellm-client';
import { coreLogger } from '@/utils/logger';
import { chunkMarkdown, looksLikeMarkdown, type StructuralChunk } from './markdown-chunker';
import { type CleanupOptions, type CleanupResult, runCleanup } from './retention-service';

/**
 * Memory-redesign Phase A — `embeddings.purpose` values. Kept here so the
 * read path, write path, and retention_policies stay in sync.
 *
 * Migration 0056 dropped the legacy `source_type` column; `purpose` is
 * the single categorisation field on every row.
 */
export type EmbeddingPurpose =
  | 'document'
  | 'code'
  | 'image_description'
  | 'knowledge_artifact'
  | 'note'
  | 'message'
  | 'ephemeral';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Stable embedding identity: model id + vector dimension. */
export function buildEmbeddingVersion(model: string, dimension: number): string {
  return `${model}/${dimension}`;
}

export interface SearchResult {
  id: string;
  content: string;
  abstract?: string | null;
  purpose: EmbeddingPurpose;
  sourceId: string;
  similarity: number;
  metadata: EmbeddingMetadata;
  createdAt?: Date;
  /**
   * Memory-redesign Phase C — ancestor heading path of this chunk
   * (root → leaf). Populated for chunks produced by the structural
   * Markdown chunker; NULL for flat-chunked rows. Callers can render
   * it next to the hit to give the LLM the section context without a
   * second query (`getAncestorHeadings` is still available for the
   * full ancestor chunk objects, not just the titles).
   */
  sectionPath?: string[] | null;
  /** Heading depth for hierarchical filtering. 0=body, 1=H1, … */
  headingLevel?: number | null;
}

const MAX_CHUNK_SIZE = 1000; // chars per chunk

/**
 * Drizzle's `db.execute(sql\`…\`)` returns an opaque `unknown`-shaped result
 * across drivers (PG returns `QueryResult`, PGlite returns a different shape).
 * Treat it as a row array of records — callers pass the projected row shape
 * as the type parameter and the helper enforces the access path.
 */
function rows<T = Record<string, unknown>>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

export class EmbeddingService {
  /** Explicit override. Empty = resolve from registry topic='embedding' per-call. */
  private model: string;

  constructor(model?: string) {
    this.model = model || '';
  }

  private async resolveModel(): Promise<string> {
    if (this.model) return this.model;
    const { getModelRegistry } = await import('@/models/model-registry');
    const registry = getModelRegistry();
    const m = await registry.getModelForTopic('embedding');
    if (!m) {
      throw new Error('No model mapped to topic "embedding". Assign one in the Models page.');
    }
    return m.modelId;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const client = getLiteLLMClient();
    let modelId: string;
    try {
      modelId = await this.resolveModel();
    } catch (err) {
      coreLogger.error(
        { err, component: 'embeddings' },
        'Embedding failed: no model mapped to topic="embedding". Assign one in the Models page.',
      );
      throw err;
    }
    try {
      const [embedding] = await client.embed(text, modelId);
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(`Embedding provider returned empty vector for model ${modelId}`);
      }
      return embedding;
    } catch (err) {
      // Log at error level with full context (model + provider-surfaced message + stack)
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      coreLogger.error(
        { err, message, stack, model: modelId, textLength: text.length, component: 'embeddings' },
        'Embedding generation failed — provider/model unreachable or rejected the request',
      );
      throw err;
    }
  }

  /**
   * Memory-redesign Phase C — optional structural metadata. Threaded
   * through `store()` so the structural chunker can write hierarchy
   * fields without growing a parallel insert path.
   */
  async store(
    purpose: EmbeddingPurpose,
    sourceId: string,
    content: string,
    embedding: number[],
    metadata?: EmbeddingMetadata,
    structural?: {
      parentChunkId?: string | null;
      sectionPath?: string[] | null;
      headingLevel?: number | null;
      docId?: string | null;
    },
    /** Owner for tenant-scoped search (e.g. notes). NULL = unscoped/global. */
    ownerUserId?: string | null,
  ): Promise<string> {
    const db = getDb();
    const model = this.model || await this.resolveModel().catch(() => 'unknown');
    const result = await db.insert(embeddings).values({
      sourceId,
      content,
      embedding,
      model,
      userId: ownerUserId ?? null,
      metadata: metadata || {},
      purpose,
      contentSha256: sha256Hex(content),
      embeddingVersion: buildEmbeddingVersion(model, embedding.length),
      parentChunkId: structural?.parentChunkId ?? null,
      sectionPath: structural?.sectionPath ?? null,
      headingLevel: structural?.headingLevel ?? null,
      docId: structural?.docId ?? null,
    })
      // Dedup is enforced by the (purpose, source_id, content_sha256) unique
      // index. A re-index of unchanged content is a no-op rather than an
      // error — return the existing row id so callers can chain on it.
      .onConflictDoUpdate({
        target: [embeddings.purpose, embeddings.sourceId, embeddings.contentSha256],
        set: { lastAccessedAt: sql`now()` },
      })
      .returning({ id: embeddings.id });
    return result[0].id;
  }

  async indexText(
    purpose: EmbeddingPurpose,
    sourceId: string,
    content: string,
    metadata?: EmbeddingMetadata,
    documentId?: string,
    /** Owner for tenant-scoped search (e.g. notes). NULL = unscoped/global. */
    ownerUserId?: string | null,
  ): Promise<number> {
    // Memory-redesign Phase C — pick the structural chunker when the
    // content looks like Markdown (or the caller's filePath hint says
    // so). Other content types fall through to the flat chunker.
    if (looksLikeMarkdown(content, metadata?.filePath)) {
      return this.indexStructured(purpose, sourceId, content, metadata, documentId, ownerUserId);
    }
    const chunks = this.chunkText(content);
    if (chunks.length === 0) {
      // Not an error — caller passed empty/whitespace content.
      return 0;
    }

    let stored = 0;
    const storedIds: string[] = [];
    const errors: Array<{ chunk: number; message: string }> = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i]);
        const id = await this.store(
          purpose,
          sourceId,
          chunks[i],
          embedding,
          {
            ...metadata,
            chunkIndex: i,
            totalChunks: chunks.length,
            originalLength: content.length,
          },
          undefined,
          ownerUserId,
        );
        storedIds.push(id);
        stored++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        errors.push({ chunk: i, message });
        coreLogger.error(
          { err, message, stack, purpose, sourceId, chunk: i, totalChunks: chunks.length },
          'Failed to index chunk',
        );
      }
    }

    // FAIL LOUD: if every chunk failed, surface the error to the caller.
    // Previously this returned 0 silently — uploads appeared to succeed with
    // nothing written to the vector store.
    if (stored === 0 && errors.length > 0) {
      const first = errors[0];
      const err = new Error(
        `Indexing failed for all ${errors.length} chunk(s) of ${purpose}:${sourceId}. ` +
          `First error (chunk ${first.chunk}): ${first.message}`,
      );
      coreLogger.error(
        { purpose, sourceId, totalChunks: chunks.length, failedChunks: errors.length, errors },
        'Indexing failed for every chunk — nothing was written to the knowledge base',
      );
      throw err;
    }

    // Partial failure is still logged loudly but does not throw — some content made it.
    if (errors.length > 0 && stored > 0) {
      coreLogger.warn(
        { purpose, sourceId, stored, failed: errors.length, totalChunks: chunks.length },
        'Partial indexing: some chunks failed — see prior error logs for details',
      );
    }

    // Generate abstracts for stored chunks (fire-and-forget)
    if (storedIds.length > 0) {
      this.generateAbstracts(storedIds, chunks.slice(0, storedIds.length)).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in embeddings'));
    }

    return stored;
  }

  /**
   * Memory-redesign Phase C — index a Markdown document with its
   * heading hierarchy preserved. Chunks are inserted in array order
   * so each child can resolve its parent's UUID from the rows already
   * written.
   *
   * Failure model matches `indexText`: every chunk's embedding call
   * is independently try/caught; if every chunk fails we throw the
   * first error; partial failures log a warning and return the
   * count that did succeed.
   */
  private async indexStructured(
    purpose: EmbeddingPurpose,
    sourceId: string,
    content: string,
    metadata: EmbeddingMetadata | undefined,
    documentId: string | undefined,
    ownerUserId?: string | null,
  ): Promise<number> {
    const chunks: StructuralChunk[] = chunkMarkdown(content);
    if (chunks.length === 0) return 0;

    const insertedIds: (string | null)[] = new Array(chunks.length).fill(null);
    const errors: Array<{ chunk: number; message: string }> = [];
    const storedTexts: string[] = [];
    const storedIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const parentId = c.parentIndex != null ? insertedIds[c.parentIndex] : null;
      try {
        const embedding = await this.generateEmbedding(c.content);
        const id = await this.store(
          purpose,
          sourceId,
          c.content,
          embedding,
          {
            ...metadata,
            chunkIndex: i,
            totalChunks: chunks.length,
            originalLength: content.length,
          },
          {
            parentChunkId: parentId,
            sectionPath: c.sectionPath.length > 0 ? c.sectionPath : null,
            headingLevel: c.headingLevel,
            docId: documentId ?? null,
          },
          ownerUserId,
        );
        insertedIds[i] = id;
        storedTexts.push(c.content);
        storedIds.push(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ chunk: i, message });
        coreLogger.error(
          { err, purpose, sourceId, chunk: i, totalChunks: chunks.length },
          'Failed to index structural chunk',
        );
      }
    }

    if (storedIds.length === 0 && errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `Indexing failed for all ${errors.length} chunk(s) of ${purpose}:${sourceId}. ` +
          `First error (chunk ${first.chunk}): ${first.message}`,
      );
    }
    if (errors.length > 0) {
      coreLogger.warn(
        { purpose, sourceId, stored: storedIds.length, failed: errors.length, totalChunks: chunks.length },
        'Partial structural indexing: some chunks failed',
      );
    }

    if (storedIds.length > 0) {
      this.generateAbstracts(storedIds, storedTexts).catch((err: unknown) =>
        coreLogger.error({ err }, 'background task failed in embeddings'),
      );
    }
    return storedIds.length;
  }

  /**
   * Memory-redesign Phase C — walk the parent chain of a chunk and
   * return the ancestor heading chunks ordered root-first. Empty
   * array means the chunk is a top-level heading or has no structural
   * parent (e.g. a flat-chunked row). Use this to inject "you are
   * reading under § A / § B / § C" context next to a hit.
   */
  async getAncestorHeadings(chunkId: string): Promise<Array<{ id: string; content: string; headingLevel: number | null; sectionPath: string[] | null }>> {
    const db = getDb();
    const out: Array<{ id: string; content: string; headingLevel: number | null; sectionPath: string[] | null }> = [];
    let current: string | null = chunkId;
    // Defensive bound so a corrupt parent cycle (shouldn't happen
    // given the chunker emits a tree) can't loop forever.
    for (let depth = 0; depth < 32 && current !== null; depth++) {
      const cursor: string = current;
      const rowRes: Array<{
        id: string;
        parentChunkId: string | null;
        content: string;
        headingLevel: number | null;
        sectionPath: string[] | null;
      }> = await db
        .select({
          id: embeddings.id,
          parentChunkId: embeddings.parentChunkId,
          content: embeddings.content,
          headingLevel: embeddings.headingLevel,
          sectionPath: embeddings.sectionPath,
        })
        .from(embeddings)
        .where(eq(embeddings.id, cursor))
        .limit(1);
      const row = rowRes[0];
      if (!row) break;
      // Don't include the chunk itself, only ancestors.
      if (depth > 0) {
        out.unshift({
          id: row.id,
          content: row.content,
          headingLevel: row.headingLevel,
          sectionPath: row.sectionPath,
        });
      }
      current = row.parentChunkId;
    }
    return out;
  }

  // ── Search methods ────────────────────────────────────────────────

  /**
   * Vector-only semantic search.
   *
   * `minSimilarity` filters out results whose cosine similarity is below the
   * threshold. Without this, search always returns the top-N entries even when
   * nothing is actually relevant — useless for small knowledge bases where
   * every entry ranks "in the top N" by default.
   */
  async search(query: string, limit = 5, purpose?: EmbeddingPurpose, minSimilarity = 0, userId?: string): Promise<SearchResult[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.generateEmbedding(query);
    } catch (err) {
      coreLogger.error(
        { err, queryLength: query.length },
        'Semantic search unavailable — embedding provider failed. Returning empty results.',
      );
      return [];
    }
    const db = getDb();

    const similarityExpr = cosineSimilarity(embeddings.embedding, queryEmbedding);
    // Tenant scope: when `userId` is given, restrict to that owner's rows.
    // Used for per-user surfaces (notes); omitted for shared/global KB.
    const filters = [
      purpose ? eq(embeddings.purpose, purpose) : undefined,
      userId ? eq(embeddings.userId, userId) : undefined,
    ].filter(Boolean);
    const conditions = filters.length > 0 ? and(...filters) : undefined;

    const results = await db
      .select({
        id: embeddings.id,
        content: embeddings.content,
        abstract: embeddings.abstract,
        purpose: embeddings.purpose,
        sourceId: embeddings.sourceId,
        metadata: embeddings.metadata,
        sectionPath: embeddings.sectionPath,
        headingLevel: embeddings.headingLevel,
        similarity: similarityExpr,
      })
      .from(embeddings)
      .where(conditions)
      .orderBy(desc(similarityExpr))
      .limit(limit);

    const out = results
      .map(r => ({
        id: r.id,
        content: r.content,
        abstract: r.abstract,
        purpose: r.purpose as EmbeddingPurpose,
        sourceId: r.sourceId,
        similarity: Number(r.similarity) || 0,
        metadata: (r.metadata || {}) as EmbeddingMetadata,
        sectionPath: r.sectionPath,
        headingLevel: r.headingLevel,
      }))
      .filter(r => r.similarity >= minSimilarity);
    this.recordAccess(out.map((r) => r.id));
    return out;
  }

  /** Full-text search only (no embedding needed) */
  async ftsSearch(query: string, limit = 5, purpose?: EmbeddingPurpose, userId?: string): Promise<SearchResult[]> {
    const db = getDb();
    const purposeFilter = purpose ? sql`AND purpose = ${purpose}` : sql``;
    const userFilter = userId ? sql`AND user_id = ${userId}` : sql``;

    const results = await db.execute(sql`
      SELECT id, content, abstract, purpose, source_id, metadata,
             section_path, heading_level,
             ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) AS similarity
      FROM embeddings
      WHERE content_tsv @@ plainto_tsquery('english', ${query})
        ${purposeFilter}
        ${userFilter}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    const out = rows<{ id: string; content: string; abstract: string | null; purpose: string; source_id: string; similarity: number | string; metadata: unknown; section_path: string[] | null; heading_level: number | null }>(results).map(r => ({
      id: r.id,
      content: r.content,
      abstract: r.abstract,
      purpose: r.purpose as EmbeddingPurpose,
      sourceId: r.source_id,
      similarity: Number(r.similarity) || 0,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
      sectionPath: r.section_path,
      headingLevel: r.heading_level,
    }));
    this.recordAccess(out.map((r) => r.id));
    return out;
  }

  /**
   * Hybrid search combining BM25 full-text and vector cosine similarity.
   * Uses Reciprocal Rank Fusion (RRF) — simple, robust, no normalization needed.
   * alpha controls semantic weight: 0.6 = lean toward semantic, 0.4 = lean toward keyword.
   */
  /**
   * Hybrid search combining BM25 (FTS) and vector cosine similarity via RRF.
   *
   * Returns the raw cosine similarity as `similarity` (not the RRF score) so
   * callers can reason about relevance with a meaningful 0–1 number. The RRF
   * score is only used internally for ranking when both signals fire.
   *
   * `minSimilarity` filters by raw cosine similarity — entries below the
   * threshold are dropped UNLESS they have a strong FTS match (kept since the
   * keyword is literally present). For small KBs, this prevents the search
   * from returning every entry just because each one happens to be in the
   * top-N vector ranking.
   */
  async hybridSearch(
    query: string,
    limit = 5,
    purpose?: EmbeddingPurpose,
    alpha = 0.6,
    minSimilarity = 0,
    userId?: string,
  ): Promise<SearchResult[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.generateEmbedding(query);
    } catch (err) {
      coreLogger.warn(
        { err, queryLength: query.length },
        'Hybrid search: embedding failed, falling back to keyword-only (FTS)',
      );
      return this.ftsSearch(query, limit, purpose, userId);
    }

    const db = getDb();
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const purposeFilter = purpose ? sql`AND purpose = ${purpose}` : sql``;
    // Tenant scope (notes etc.); omitted for the shared/global KB.
    const userFilter = userId ? sql`AND user_id = ${userId}` : sql``;
    const k = 60; // RRF constant

    const results = await db.execute(sql`
      WITH fts AS (
        SELECT id,
               row_number() OVER (ORDER BY ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) DESC) AS rank_fts
        FROM embeddings
        WHERE content_tsv @@ plainto_tsquery('english', ${query})
          ${purposeFilter}
          ${userFilter}
        LIMIT 50
      ),
      vec AS (
        -- Parameterised vector literal (not sql.raw). The driver
        -- binds vecLiteral as a placeholder and pgvector casts it
        -- server-side. sql.raw splices the literal directly which
        -- defeats parameterisation.
        SELECT id,
               row_number() OVER (ORDER BY embedding <=> ${vecLiteral}::vector) AS rank_vec,
               1 - (embedding <=> ${vecLiteral}::vector) AS cosine_sim
        FROM embeddings
        WHERE 1=1 ${purposeFilter} ${userFilter}
        ORDER BY embedding <=> ${vecLiteral}::vector
        LIMIT 50
      ),
      combined AS (
        SELECT
          COALESCE(f.id, v.id) AS id,
          COALESCE(1.0 / (${k} + f.rank_fts), 0) * ${1 - alpha} +
          COALESCE(1.0 / (${k} + v.rank_vec), 0) * ${alpha} AS rrf_score,
          COALESCE(v.cosine_sim, 0) AS cosine_sim,
          f.rank_fts IS NOT NULL AS has_fts_match
        FROM fts f
        FULL OUTER JOIN vec v ON f.id = v.id
      )
      SELECT c.cosine_sim AS similarity, c.rrf_score, c.has_fts_match,
             e.id, e.content, e.abstract, e.purpose, e.source_id, e.metadata,
             e.section_path, e.heading_level
      FROM combined c
      JOIN embeddings e ON e.id = c.id
      ORDER BY c.rrf_score DESC
      LIMIT ${limit}
    `);

    const out = rows<{
      id: string;
      content: string;
      abstract: string | null;
      purpose: string;
      source_id: string;
      similarity: number | string;
      rrf_score: number | string;
      has_fts_match: boolean;
      metadata: unknown;
      section_path: string[] | null;
      heading_level: number | null;
    }>(results)
      .map(r => ({
        id: r.id,
        content: r.content,
        abstract: r.abstract,
        purpose: r.purpose as EmbeddingPurpose,
        sourceId: r.source_id,
        similarity: Number(r.similarity) || 0,
        hasFtsMatch: Boolean(r.has_fts_match),
        metadata: (r.metadata || {}) as EmbeddingMetadata,
        sectionPath: r.section_path,
        headingLevel: r.heading_level,
      }))
      // Keep when raw cosine similarity passes the bar, or when an exact
      // keyword (FTS) hit makes the entry relevant on lexical grounds alone.
      .filter(r => r.similarity >= minSimilarity || r.hasFtsMatch)
      .map(({ hasFtsMatch: _hasFtsMatch, ...rest }) => rest);
    this.recordAccess(out.map((r) => r.id));
    return out;
  }

  /**
   * Memory-redesign Phase A — LFU signal. Bumps `access_count` and stamps
   * `last_accessed_at` on the rows that were actually returned to a
   * caller. Fire-and-forget: a search returns to the caller before this
   * UPDATE lands, so a slow write never blocks retrieval. Errors are
   * logged but never thrown — access tracking is an optimisation, not a
   * correctness property.
   */
  private recordAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const db = getDb();
    db
      .update(embeddings)
      .set({ accessCount: sql`${embeddings.accessCount} + 1`, lastAccessedAt: sql`now()` })
      .where(inArray(embeddings.id, ids))
      .catch((err) => {
        coreLogger.warn({ err, count: ids.length }, 'embeddings.recordAccess failed (non-fatal)');
      });
  }

  // ── Read by ID ────────────────────────────────────────────────────

  async readById(id: string): Promise<SearchResult | null> {
    const db = getDb();
    const result = await db
      .select({
        id: embeddings.id,
        content: embeddings.content,
        abstract: embeddings.abstract,
        purpose: embeddings.purpose,
        sourceId: embeddings.sourceId,
        metadata: embeddings.metadata,
        createdAt: embeddings.createdAt,
      })
      .from(embeddings)
      .where(eq(embeddings.id, id))
      .limit(1);

    if (result.length === 0) return null;

    const r = result[0];
    return {
      id: r.id,
      content: r.content,
      abstract: r.abstract,
      purpose: r.purpose as EmbeddingPurpose,
      sourceId: r.sourceId,
      similarity: 1,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
      createdAt: r.createdAt,
    };
  }

  // ── Abstract generation ───────────────────────────────────────────

  /** Generate L0 abstracts for recently indexed chunks (fire-and-forget) */
  private async generateAbstracts(ids: string[], contents: string[]): Promise<void> {
    const client = getLiteLLMClient();
    const db = getDb();

    for (let i = 0; i < ids.length; i++) {
      try {
        // Skip very short content — it's its own abstract
        if (contents[i].length < 200) {
          await db.update(embeddings)
            .set({ abstract: contents[i].slice(0, 150) })
            .where(eq(embeddings.id, ids[i]));
          continue;
        }

        const { getModelRegistry } = await import('@/models/model-registry');
        const defaultModel = await getModelRegistry().getDefaultModel();
        if (!defaultModel) continue; // no model configured — skip abstract
        const modelName = defaultModel.modelId;
        const now = new Date();
        const response = await client.complete({
          model: modelName,
          messages: [
            { role: 'system' as const, content: 'Summarize the following text in 1-2 sentences. Be concise and factual. Output only the summary.', timestamp: now },
            { role: 'user' as const, content: contents[i].slice(0, 2000), timestamp: now },
          ],
          extraBody: { think: false },
        });

        const abstract = response.content || '';
        if (abstract) {
          await db.update(embeddings)
            .set({ abstract: abstract.slice(0, 500) })
            .where(eq(embeddings.id, ids[i]));
        }
      } catch (err) {
        // Non-critical — abstract generation is a nice-to-have. Log at debug
        // so it's available when troubleshooting but doesn't spam in normal use.
        coreLogger.debug({ err, id: ids[i] }, 'Abstract generation failed for chunk');
      }
    }
  }

  // ── Listing & Stats ──────────────────────────────────────────────

  /** Paginated listing (excludes embedding vector and full content for performance) */
  async listAll(limit = 50, offset = 0, purpose?: EmbeddingPurpose): Promise<{
    entries: Array<{
      id: string;
      purpose: EmbeddingPurpose;
      sourceId: string;
      abstract: string | null;
      metadata: EmbeddingMetadata;
      createdAt: Date | null;
    }>;
    total: number;
  }> {
    const db = getDb();
    const conditions = purpose ? eq(embeddings.purpose, purpose) : undefined;

    const [entries, countResult] = await Promise.all([
      db.select({
        id: embeddings.id,
        purpose: embeddings.purpose,
        sourceId: embeddings.sourceId,
        abstract: embeddings.abstract,
        metadata: embeddings.metadata,
        createdAt: embeddings.createdAt,
      })
        .from(embeddings)
        .where(conditions)
        .orderBy(desc(embeddings.createdAt))
        .limit(limit)
        .offset(offset),
      db.execute(sql`SELECT count(*)::int AS count FROM embeddings ${purpose ? sql`WHERE purpose = ${purpose}` : sql``}`),
    ]);

    return {
      entries: entries.map(e => ({
        ...e,
        purpose: e.purpose as EmbeddingPurpose,
        metadata: (e.metadata || {}) as EmbeddingMetadata,
      })),
      total: rows<{ count: number }>(countResult)[0]?.count || 0,
    };
  }

  /** Get stats grouped by purpose, with age distribution and storage metrics */
  async getStats(): Promise<{
    total: number;
    byPurpose: Record<string, number>;
    models: string[];
    avgContentLength: number;
    oldestEntry: string | null;
    newestEntry: string | null;
    ageDistribution: { last24h: number; last7d: number; last30d: number; older: number };
    abstractCoverage: { withAbstract: number; withoutAbstract: number };
  }> {
    const db = getDb();
    const [typeResults, modelResults, metaResults, ageResults, abstractResults] = await Promise.all([
      db.execute(sql`SELECT purpose, count(*)::int AS count FROM embeddings GROUP BY purpose`),
      db.execute(sql`SELECT DISTINCT model FROM embeddings WHERE model IS NOT NULL`),
      db.execute(sql`
        SELECT count(*)::int AS total,
               coalesce(avg(length(content)), 0)::int AS avg_len,
               min(created_at)::text AS oldest,
               max(created_at)::text AS newest
        FROM embeddings
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last_24h,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days' AND created_at < now() - interval '24 hours')::int AS last_7d,
          count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND created_at < now() - interval '7 days')::int AS last_30d,
          count(*) FILTER (WHERE created_at < now() - interval '30 days')::int AS older
        FROM embeddings
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE abstract IS NOT NULL)::int AS with_abstract,
          count(*) FILTER (WHERE abstract IS NULL)::int AS without_abstract
        FROM embeddings
      `),
    ]);

    const byPurpose: Record<string, number> = {};
    for (const row of rows<{ purpose: string; count: number }>(typeResults)) {
      byPurpose[row.purpose] = row.count;
    }

    const meta = rows<{ total: number; avg_len: number; oldest: string | null; newest: string | null }>(metaResults)[0] || {};
    const age = rows<{ last_24h: number; last_7d: number; last_30d: number; older: number }>(ageResults)[0] || {};
    const abs = rows<{ with_abstract: number; without_abstract: number }>(abstractResults)[0] || {};

    return {
      total: meta.total || 0,
      byPurpose,
      models: rows<{ model: string }>(modelResults).map(r => r.model),
      avgContentLength: meta.avg_len || 0,
      oldestEntry: meta.oldest || null,
      newestEntry: meta.newest || null,
      ageDistribution: {
        last24h: age.last_24h || 0,
        last7d: age.last_7d || 0,
        last30d: age.last_30d || 0,
        older: age.older || 0,
      },
      abstractCoverage: {
        withAbstract: abs.with_abstract || 0,
        withoutAbstract: abs.without_abstract || 0,
      },
    };
  }

  /** Number of stored chunks for a (purpose, sourceId). Cheap presence check. */
  async countBySource(purpose: EmbeddingPurpose, sourceId: string): Promise<number> {
    const db = getDb();
    const r = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(embeddings)
      .where(and(eq(embeddings.purpose, purpose), eq(embeddings.sourceId, sourceId)));
    return r[0]?.c ?? 0;
  }

  // ── Deletion ──────────────────────────────────────────────────────

  async deleteById(id: string): Promise<boolean> {
    const db = getDb();
    const result = await db.delete(embeddings).where(eq(embeddings.id, id)).returning({ id: embeddings.id });
    return result.length > 0;
  }

  async deleteBySource(purpose: EmbeddingPurpose, sourceId: string): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(embeddings)
      .where(and(eq(embeddings.purpose, purpose), eq(embeddings.sourceId, sourceId)))
      .returning({ id: embeddings.id });
    return result.length;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  /**
   * Clean up the knowledge base. Thin delegate to `runCleanup` in
   * `./retention-service.ts` — retention is a distinct concern from
   * embedding/indexing and now lives in its own module so this file
   * stays close to "search and store". Kept as a service method for
   * call-site stability (cron, knowledge API, knowledge tool).
   */
  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    return runCleanup(options);
  }

  // ── Cleanup History ───────────────────────────────────────────────

  /** Retrieve recent cleanup audit log entries */
  async getCleanupHistory(limit = 20): Promise<Array<{
    id: string;
    triggeredBy: string;
    dryRun: boolean;
    orphanedDocuments: number;
    staleAgentOutputs: number;
    shortEntries: number;
    duplicates: number;
    totalRemoved: number;
    totalBefore: number | null;
    totalAfter: number | null;
    durationMs: number | null;
    createdAt: Date;
  }>> {
    const db = getDb();
    const rows = await db
      .select()
      .from(cleanupAuditLog)
      .orderBy(desc(cleanupAuditLog.createdAt))
      .limit(limit);

    return rows;
  }

  // ── Chunking ──────────────────────────────────────────────────────

  chunkText(text: string, maxSize = MAX_CHUNK_SIZE): string[] {
    if (text.length <= maxSize) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxSize && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }
}

// Singleton
let instance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!instance) instance = new EmbeddingService();
  return instance;
}
