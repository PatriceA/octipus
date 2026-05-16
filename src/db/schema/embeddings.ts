import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// Note: pgvector extension must be installed
// CREATE EXTENSION IF NOT EXISTS vector;

// Custom type for pgvector's vector column
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // Parse "[0.1,0.2,...]" format from pgvector
    return value.replace(/^\[|\]$/g, '').split(',').map(Number);
  },
});

// Read-only tsvector type (auto-generated column — never insert/update directly)
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceType: text('source_type').notNull(), // message, document, code, agent_output
  sourceId: text('source_id').notNull(),
  /**
   * Owner of the indexed content. Nullable in Phase 0 — RAG queries still
   * span all rows for backwards compatibility. Phase 1 backfills, then
   * filters every retrieval by `userId` so one tenant's docs never surface
   * in another tenant's agent context.
   */
  userId: uuid('user_id'),
  /** Phase 4 follow-up — optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  content: text('content').notNull(),
  embedding: vector('embedding').notNull(),
  // Auto-generated tsvector for full-text search (GENERATED ALWAYS AS — read-only)
  contentTsv: tsvector('content_tsv'),
  model: text('model').notNull(),
  // Tiered content summaries (generated async by LLM)
  abstract: text('abstract'),   // L0: ~1-2 sentences, ~100 tokens
  overview: text('overview'),   // L1: ~1 paragraph, ~500 tokens
  metadata: jsonb('metadata').$type<EmbeddingMetadata>().default({}),
  /**
   * Memory-redesign Phase A. What the row is *for* — purpose-aware
   * cleanup and retrieval. See `.octipus/memory-redesign.md`.
   * Values: 'document' | 'code' | 'image_description' | 'knowledge_artifact'
   *       | 'message' | 'ephemeral'
   * Kept as plain text (not an enum) so future purposes can be added
   * without a migration; the retention_policies table (follow-up) is the
   * authoritative list of recognised values.
   */
  purpose: text('purpose').notNull(),
  /**
   * SHA-256 of `content`, computed app-side at insert time. Combined with
   * `(purpose, source_id)` as a unique index so the same payload can't be
   * inserted twice — replaces the old dedup-by-content cleanup pass.
   */
  contentSha256: text('content_sha256').notNull(),
  /**
   * Embedding model identity *and* dimension, e.g. "nomic-embed-text:v1.5/768".
   * Distinct from `model` (which is just the registry id) so a silent
   * provider swap can be detected and re-indexed instead of mixing vector
   * spaces in one search.
   */
  embeddingVersion: text('embedding_version').notNull(),
  /** LFU signal for cleanup. Incremented by EmbeddingService search hits. */
  accessCount: integer('access_count').notNull().default(0),
  /** Last time this row appeared in a search result. NULL = never queried. */
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sourceTypeIdx: index('embeddings_source_type_idx').on(table.sourceType),
  sourceIdIdx: index('embeddings_source_id_idx').on(table.sourceId),
  userIdIdx: index('embeddings_user_id_idx').on(table.userId),
  purposeIdx: index('embeddings_purpose_idx').on(table.purpose),
  embeddingVersionIdx: index('embeddings_embedding_version_idx').on(table.embeddingVersion),
  lastAccessedAtIdx: index('embeddings_last_accessed_at_idx').on(table.lastAccessedAt),
  dedupIdx: uniqueIndex('embeddings_dedup_idx').on(table.purpose, table.sourceId, table.contentSha256),
}));

export interface EmbeddingMetadata {
  chunkIndex?: number;
  totalChunks?: number;
  originalLength?: number;
  language?: string;
  filePath?: string;
}

export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;

// Validate that a vector array contains only finite numbers
function validateVector(vector: number[]): void {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Vector must be a non-empty array');
  }
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
      throw new Error(`Vector element at index ${i} is not a finite number`);
    }
  }
}

// Helper for vector similarity search (cosine distance)
export const cosineSimilarity = (column: any, vector: number[]) => {
  validateVector(vector);
  const vectorLiteral = `[${vector.join(',')}]`;
  return sql`1 - (${column} <=> ${vectorLiteral}::vector)`;
};

// Helper for vector distance search (L2 distance)
export const l2Distance = (column: any, vector: number[]) => {
  validateVector(vector);
  const vectorLiteral = `[${vector.join(',')}]`;
  return sql`${column} <-> ${vectorLiteral}::vector`;
};
