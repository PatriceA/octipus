import { getLiteLLMClient } from '@/models/litellm-client';
import { getDb } from '@/db/postgres';
import { embeddings, cosineSimilarity, type EmbeddingMetadata } from '@/db/schema/embeddings';
import { desc, eq, and, sql } from 'drizzle-orm';
import { coreLogger } from '@/utils/logger';

export interface SearchResult {
  id: string;
  content: string;
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
    const [embedding] = await client.embed(text, this.model);
    return embedding;
  }

  async store(
    sourceType: string,
    sourceId: string,
    content: string,
    embedding: number[],
    metadata?: EmbeddingMetadata,
  ): Promise<void> {
    const db = getDb();
    await db.insert(embeddings).values({
      sourceType,
      sourceId,
      content,
      embedding,
      model: this.model,
      metadata: metadata || {},
    });
  }

  async indexText(
    sourceType: string,
    sourceId: string,
    content: string,
    metadata?: EmbeddingMetadata,
  ): Promise<number> {
    const chunks = this.chunkText(content);
    let stored = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i]);
        await this.store(sourceType, sourceId, chunks[i], embedding, {
          ...metadata,
          chunkIndex: i,
          totalChunks: chunks.length,
          originalLength: content.length,
        });
        stored++;
      } catch (err) {
        coreLogger.error({ err, sourceId, chunk: i }, 'Failed to index chunk');
      }
    }

    return stored;
  }

  async search(query: string, limit = 5, sourceType?: string): Promise<SearchResult[]> {
    const queryEmbedding = await this.generateEmbedding(query);
    const db = getDb();

    const similarityExpr = cosineSimilarity(embeddings.embedding, queryEmbedding);
    const conditions = sourceType
      ? and(eq(embeddings.sourceType, sourceType))
      : undefined;

    const results = await db
      .select({
        id: embeddings.id,
        content: embeddings.content,
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
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      similarity: Number(r.similarity) || 0,
      metadata: (r.metadata || {}) as EmbeddingMetadata,
    }));
  }

  async deleteBySource(sourceType: string, sourceId: string): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(embeddings)
      .where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)))
      .returning({ id: embeddings.id });
    return result.length;
  }

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
