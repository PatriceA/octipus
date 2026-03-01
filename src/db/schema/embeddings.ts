import { pgTable, text, timestamp, uuid, jsonb, index, real } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Note: pgvector extension must be installed
// CREATE EXTENSION IF NOT EXISTS vector;

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceType: text('source_type').notNull(), // message, document, code
  sourceId: uuid('source_id').notNull(),
  content: text('content').notNull(),
  // Vector is stored as array of floats (1536 dimensions for OpenAI embeddings)
  // In actual usage, you'd use the vector type from pgvector
  embedding: real('embedding').array().notNull(),
  model: text('model').notNull(), // text-embedding-3-small, etc.
  metadata: jsonb('metadata').$type<EmbeddingMetadata>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  sourceTypeIdx: index('embeddings_source_type_idx').on(table.sourceType),
  sourceIdIdx: index('embeddings_source_id_idx').on(table.sourceId),
  // Note: For actual vector search, you'd create an HNSW or IVFFlat index:
  // CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops);
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

// Helper for vector similarity search (cosine distance)
export const cosineSimilarity = (column: any, vector: number[]) =>
  sql`1 - (${column} <=> ${JSON.stringify(vector)}::vector)`;

// Helper for vector distance search (L2 distance)
export const l2Distance = (column: any, vector: number[]) =>
  sql`${column} <-> ${JSON.stringify(vector)}::vector`;
