import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { documents } from './documents';
import { workspaceRepos } from './workspace-repos';

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
  sourceId: text('source_id').notNull(),
  /**
   * Owner of the indexed content. Multi-user is default-on
   * (commit 8877d5e); new rows are required to carry a user_id at
   * write time and retrieval scopes by it. Column remains nullable
   * for now because old rows pre-date multi-user and a few service-
   * level probes (rag/health.ts) intentionally write null.
   */
  userId: uuid('user_id'),
  /**
   * Optional workspace scope. NULL = user-level (or workspace
   * feature off). Threaded from `AgentContext.workspaceId` so chunks
   * land in the same workspace as the agent that produced them.
   */
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
  /**
   * Memory-redesign Phase C — document hierarchy. The chunker that
   * structures a document into heading + body chunks links each chunk
   * to its nearest enclosing heading via `parent_chunk_id`. Retrieval
   * walks the parent chain to inject ancestor headings into the prompt.
   *
   * NULL `parentChunkId` = this row is either a top-level chunk
   * (e.g. an H1) or comes from a flat (non-structural) source like
   * `code` or `message`.
   */
  parentChunkId: uuid('parent_chunk_id').references((): AnyPgColumn => embeddings.id, { onDelete: 'set null' }),
  /**
   * Heading path from root to this chunk, e.g. ['Article IV', 'Clause 4.2'].
   * NULL on non-structural chunks.
   */
  sectionPath: text('section_path').array(),
  /**
   * 0 = body chunk, 1 = H1, 2 = H2, … Lets queries cheaply find "give
   * me all the H2s in this document".
   */
  headingLevel: smallint('heading_level'),
  /**
   * FK to the documents row this chunk came from. Cascade delete with
   * the document so chunks never outlive their source. NULL for
   * non-document sources (code, message, …). The FK is declared via
   * migration 0054 so older deployments backfill orphan rows before
   * the constraint lands.
   */
  docId: uuid('doc_id').references((): AnyPgColumn => documents.id, { onDelete: 'cascade' }),
  /**
   * Multi-repo scoping (see `.octipus/multi-repo-design.md`). When the chunk
   * comes from a registered repository's generated/curated content (repo map,
   * AGENTS.md, …) this points at the `workspace_repos` row, so search can be
   * scoped to one repo, a subset, or span the suite. NULL for non-repo content.
   * `set null` on delete: the embedding outlives a deregistered repo (it just
   * loses its scope) rather than being cascade-deleted.
   *
   * Note: raw source-code files are intentionally NEVER indexed (only
   * summaries/generated artifacts carry a repoId) — see `code-detection.ts`.
   */
  repoId: uuid('repo_id').references((): AnyPgColumn => workspaceRepos.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sourceIdIdx: index('embeddings_source_id_idx').on(table.sourceId),
  userIdIdx: index('embeddings_user_id_idx').on(table.userId),
  purposeIdx: index('embeddings_purpose_idx').on(table.purpose),
  embeddingVersionIdx: index('embeddings_embedding_version_idx').on(table.embeddingVersion),
  lastAccessedAtIdx: index('embeddings_last_accessed_at_idx').on(table.lastAccessedAt),
  parentChunkIdx: index('embeddings_parent_chunk_idx').on(table.parentChunkId),
  docIdIdx: index('embeddings_doc_id_idx').on(table.docId),
  repoIdIdx: index('embeddings_repo_id_idx').on(table.repoId),
  dedupIdx: uniqueIndex('embeddings_dedup_idx').on(table.purpose, table.sourceId, table.contentSha256),
}));

export interface EmbeddingMetadata {
  chunkIndex?: number;
  totalChunks?: number;
  originalLength?: number;
  language?: string;
  filePath?: string;
  /** Human title of the source (e.g. a note's title) for result display. */
  title?: string;
  /**
   * Provenance tag for rows that were not user-supplied. Lets a surface
   * scope retrieval/display to a known corpus — e.g. `'octipus-docs'` for
   * the product documentation auto-indexed at boot (see `src/db/seed-docs.ts`).
   */
  source?: string;
  /**
   * SHA-256 of the FULL source file this chunk came from (distinct from the
   * row's `content_sha256`, which hashes only the chunk). Stamped on every
   * chunk by an idempotent re-indexer so it can detect "file unchanged since
   * last index" with one query and skip re-embedding. See `src/db/seed-docs.ts`.
   */
  fileSha?: string;
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
export const cosineSimilarity = (column: AnyPgColumn, vector: number[]) => {
  validateVector(vector);
  const vectorLiteral = `[${vector.join(',')}]`;
  return sql`1 - (${column} <=> ${vectorLiteral}::vector)`;
};

// Helper for vector distance search (L2 distance)
export const l2Distance = (column: AnyPgColumn, vector: number[]) => {
  validateVector(vector);
  const vectorLiteral = `[${vector.join(',')}]`;
  return sql`${column} <-> ${vectorLiteral}::vector`;
};
