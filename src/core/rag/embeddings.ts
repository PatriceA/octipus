import { getLiteLLMClient } from '@/models/litellm-client';
import { getDb } from '@/db/postgres';
import { embeddings, cosineSimilarity, type EmbeddingMetadata } from '@/db/schema/embeddings';
import { desc, eq, and, sql, inArray } from 'drizzle-orm';
import { coreLogger } from '@/utils/logger';

export interface SearchResult {
  id: string;
  content: string;
  abstract?: string | null;
  sourceType: string;
  sourceId: string;
  similarity: number;
  metadata: EmbeddingMetadata;
}

const DEFAULT_MODEL = 'nomic-embed-text';
const MAX_CHUNK_SIZE = 1000; // chars per chunk

export class EmbeddingService {
  private model: string;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const client = getLiteLLMClient();
    try {
      const [embedding] = await client.embed(text, this.model);
      return embedding;
    } catch (err) {
      coreLogger.warn({ err, model: this.model }, 'Embedding generation failed — model may not be available');
      throw err;
    }
  }

  async store(
    sourceType: string,
    sourceId: string,
    content: string,
    embedding: number[],
    metadata?: EmbeddingMetadata,
  ): Promise<string> {
    const db = getDb();
    const result = await db.insert(embeddings).values({
      sourceType,
      sourceId,
      content,
      embedding,
      model: this.model,
      metadata: metadata || {},
    }).returning({ id: embeddings.id });
    return result[0].id;
  }

  async indexText(
    sourceType: string,
    sourceId: string,
    content: string,
    metadata?: EmbeddingMetadata,
  ): Promise<number> {
    const chunks = this.chunkText(content);
    let stored = 0;
    const storedIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i]);
        const id = await this.store(sourceType, sourceId, chunks[i], embedding, {
          ...metadata,
          chunkIndex: i,
          totalChunks: chunks.length,
          originalLength: content.length,
        });
        storedIds.push(id);
        stored++;
      } catch (err) {
        coreLogger.error({ err, sourceId, chunk: i }, 'Failed to index chunk');
      }
    }

    // Generate abstracts for stored chunks (fire-and-forget)
    if (storedIds.length > 0) {
      this.generateAbstracts(storedIds, chunks.slice(0, storedIds.length)).catch(() => {});
    }

    return stored;
  }

  // ── Search methods ────────────────────────────────────────────────

  /** Original vector-only search (kept as fallback) */
  async search(query: string, limit = 5, sourceType?: string): Promise<SearchResult[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.generateEmbedding(query);
    } catch {
      coreLogger.warn('Embedding search unavailable — returning empty results');
      return [];
    }
    const db = getDb();

    const similarityExpr = cosineSimilarity(embeddings.embedding, queryEmbedding);
    const conditions = sourceType
      ? and(eq(embeddings.sourceType, sourceType))
      : undefined;

    const results = await db
      .select({
        id: embeddings.id,
        content: embeddings.content,
        abstract: embeddings.abstract,
        sourceType: embeddings.sourceType,
        sourceId: embeddings.sourceId,
        metadata: embeddings.metadata,
        similarity: similarityExpr,
      })
      .from(embeddings)
      .where(conditions)
      .orderBy(desc(similarityExpr))
      .limit(limit);

    return results.map(r => ({
      id: r.id,
      content: r.content,
      abstract: r.abstract,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      similarity: Number(r.similarity) || 0,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
    }));
  }

  /** Full-text search only (no embedding needed) */
  async ftsSearch(query: string, limit = 5, sourceType?: string): Promise<SearchResult[]> {
    const db = getDb();
    const sourceFilter = sourceType ? sql`AND source_type = ${sourceType}` : sql``;

    const results = await db.execute(sql`
      SELECT id, content, abstract, source_type, source_id, metadata,
             ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) AS similarity
      FROM embeddings
      WHERE content_tsv @@ plainto_tsquery('english', ${query})
        ${sourceFilter}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    return (results as any[]).map(r => ({
      id: r.id,
      content: r.content,
      abstract: r.abstract,
      sourceType: r.source_type,
      sourceId: r.source_id,
      similarity: Number(r.similarity) || 0,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
    }));
  }

  /**
   * Hybrid search combining BM25 full-text and vector cosine similarity.
   * Uses Reciprocal Rank Fusion (RRF) — simple, robust, no normalization needed.
   * alpha controls semantic weight: 0.6 = lean toward semantic, 0.4 = lean toward keyword.
   */
  async hybridSearch(
    query: string,
    limit = 5,
    sourceType?: string,
    alpha = 0.6,
  ): Promise<SearchResult[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.generateEmbedding(query);
    } catch {
      // Fall back to FTS-only if embedding unavailable
      return this.ftsSearch(query, limit, sourceType);
    }

    const db = getDb();
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const sourceFilter = sourceType ? sql`AND source_type = ${sourceType}` : sql``;
    const k = 60; // RRF constant

    const results = await db.execute(sql`
      WITH fts AS (
        SELECT id,
               row_number() OVER (ORDER BY ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) DESC) AS rank_fts
        FROM embeddings
        WHERE content_tsv @@ plainto_tsquery('english', ${query})
          ${sourceFilter}
        LIMIT 50
      ),
      vec AS (
        SELECT id,
               row_number() OVER (ORDER BY embedding <=> ${sql.raw(`'${vecLiteral}'`)}::vector) AS rank_vec
        FROM embeddings
        WHERE 1=1 ${sourceFilter}
        ORDER BY embedding <=> ${sql.raw(`'${vecLiteral}'`)}::vector
        LIMIT 50
      ),
      combined AS (
        SELECT
          COALESCE(f.id, v.id) AS id,
          COALESCE(1.0 / (${k} + f.rank_fts), 0) * ${1 - alpha} +
          COALESCE(1.0 / (${k} + v.rank_vec), 0) * ${alpha} AS rrf_score
        FROM fts f
        FULL OUTER JOIN vec v ON f.id = v.id
      )
      SELECT c.rrf_score AS similarity, e.id, e.content, e.abstract, e.source_type, e.source_id, e.metadata
      FROM combined c
      JOIN embeddings e ON e.id = c.id
      ORDER BY c.rrf_score DESC
      LIMIT ${limit}
    `);

    return (results as any[]).map(r => ({
      id: r.id,
      content: r.content,
      abstract: r.abstract,
      sourceType: r.source_type,
      sourceId: r.source_id,
      similarity: Number(r.similarity) || 0,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
    }));
  }

  // ── Read by ID ────────────────────────────────────────────────────

  async readById(id: string): Promise<SearchResult | null> {
    const db = getDb();
    const result = await db
      .select({
        id: embeddings.id,
        content: embeddings.content,
        abstract: embeddings.abstract,
        sourceType: embeddings.sourceType,
        sourceId: embeddings.sourceId,
        metadata: embeddings.metadata,
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
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      similarity: 1,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
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
        const modelName = defaultModel?.modelId || 'qwen3:14b';
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
      } catch {
        // Non-critical — skip silently
      }
    }
  }

  // ── Listing & Stats ──────────────────────────────────────────────

  /** Paginated listing (excludes embedding vector and full content for performance) */
  async listAll(limit = 50, offset = 0, sourceType?: string): Promise<{
    entries: Array<{
      id: string;
      sourceType: string;
      sourceId: string;
      abstract: string | null;
      metadata: EmbeddingMetadata;
      createdAt: Date | null;
    }>;
    total: number;
  }> {
    const db = getDb();
    const conditions = sourceType ? eq(embeddings.sourceType, sourceType) : undefined;

    const [entries, countResult] = await Promise.all([
      db.select({
        id: embeddings.id,
        sourceType: embeddings.sourceType,
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
      db.execute(sql`SELECT count(*)::int AS count FROM embeddings ${sourceType ? sql`WHERE source_type = ${sourceType}` : sql``}`),
    ]);

    return {
      entries: entries.map(e => ({
        ...e,
        metadata: (e.metadata || {}) as EmbeddingMetadata,
      })),
      total: (countResult as any[])[0]?.count || 0,
    };
  }

  /** Get stats grouped by source type */
  async getStats(): Promise<{
    total: number;
    bySourceType: Record<string, number>;
    models: string[];
  }> {
    const db = getDb();
    const [typeResults, modelResults] = await Promise.all([
      db.execute(sql`SELECT source_type, count(*)::int AS count FROM embeddings GROUP BY source_type`),
      db.execute(sql`SELECT DISTINCT model FROM embeddings WHERE model IS NOT NULL`),
    ]);

    const bySourceType: Record<string, number> = {};
    let total = 0;
    for (const row of typeResults as any[]) {
      bySourceType[row.source_type] = row.count;
      total += row.count;
    }

    return {
      total,
      bySourceType,
      models: (modelResults as any[]).map(r => r.model),
    };
  }

  // ── Deletion ──────────────────────────────────────────────────────

  async deleteById(id: string): Promise<boolean> {
    const db = getDb();
    const result = await db.delete(embeddings).where(eq(embeddings.id, id)).returning({ id: embeddings.id });
    return result.length > 0;
  }

  async deleteBySource(sourceType: string, sourceId: string): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(embeddings)
      .where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)))
      .returning({ id: embeddings.id });
    return result.length;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  /**
   * Clean up the knowledge base by removing:
   * 1. Orphaned document embeddings (documents deleted from DB)
   * 2. Old agent output embeddings (older than maxAgeDays)
   * 3. Very short/low-quality entries (content < minContentLength chars)
   * 4. Near-duplicate entries (same sourceId, same content hash)
   *
   * Returns a summary of what was removed.
   */
  async cleanup(options: {
    maxAgeDays?: number;
    minContentLength?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    orphanedDocuments: number;
    staleAgentOutputs: number;
    shortEntries: number;
    duplicates: number;
    total: number;
  }> {
    const maxAgeDays = options.maxAgeDays ?? 30;
    const minContentLength = options.minContentLength ?? 50;
    const dryRun = options.dryRun ?? false;
    const db = getDb();

    const results = {
      orphanedDocuments: 0,
      staleAgentOutputs: 0,
      shortEntries: 0,
      duplicates: 0,
      total: 0,
    };

    // 1. Orphaned document embeddings — documents table record no longer exists
    const orphanedRes = await db.execute(sql`
      SELECT e.id FROM embeddings e
      WHERE e.source_type = 'document'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE CAST(d.id AS text) = e.source_id)
    `);
    const orphaned = Array.isArray(orphanedRes) ? orphanedRes : (orphanedRes as any).rows || [];

    results.orphanedDocuments = orphaned.length;
    if (!dryRun && orphaned.length > 0) {
      const ids = orphaned.map((r: any) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await db.delete(embeddings).where(inArray(embeddings.id, batch));
      }
    }

    // 2. Old agent output embeddings
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const staleRes = await db.execute(sql`
      SELECT id FROM embeddings
      WHERE source_type = 'agent_output'
        AND created_at < ${cutoffDate.toISOString()}
    `);
    const stale = Array.isArray(staleRes) ? staleRes : (staleRes as any).rows || [];

    results.staleAgentOutputs = stale.length;
    if (!dryRun && stale.length > 0) {
      const ids = stale.map((r: any) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await db.delete(embeddings).where(inArray(embeddings.id, batch));
      }
    }

    // 3. Very short/low-quality entries
    const shortRes = await db.execute(sql`
      SELECT id FROM embeddings
      WHERE length(content) < ${minContentLength}
        AND content NOT LIKE '[%'
    `);
    const short = Array.isArray(shortRes) ? shortRes : (shortRes as any).rows || [];

    results.shortEntries = short.length;
    if (!dryRun && short.length > 0) {
      const ids = short.map((r: any) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await db.delete(embeddings).where(inArray(embeddings.id, batch));
      }
    }

    // 4. Duplicates — same source_type + source_id + content, keep newest
    const dupesRes = await db.execute(sql`
      SELECT id FROM embeddings e
      WHERE EXISTS (
        SELECT 1 FROM embeddings e2
        WHERE e2.source_type = e.source_type
          AND e2.source_id = e.source_id
          AND e2.content = e.content
          AND e2.id != e.id
          AND e2.created_at > e.created_at
      )
    `);
    const dupes = Array.isArray(dupesRes) ? dupesRes : (dupesRes as any).rows || [];

    results.duplicates = dupes.length;
    if (!dryRun && dupes.length > 0) {
      const ids = dupes.map((r: any) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await db.delete(embeddings).where(inArray(embeddings.id, batch));
      }
    }

    results.total = results.orphanedDocuments + results.staleAgentOutputs + results.shortEntries + results.duplicates;

    coreLogger.info({
      ...results,
      dryRun,
      maxAgeDays,
      minContentLength,
    }, 'Knowledge base cleanup completed');

    return results;
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
