# RAG / Knowledge Base

## Overview

The assistant uses Retrieval-Augmented Generation (RAG) to store and retrieve knowledge. Text is chunked, embedded, and stored in PostgreSQL with pgvector. At query time the system supports hybrid search combining BM25 full-text search with vector cosine similarity, or either mode independently.

- **Embedding model:** `nomic-embed-text` via Ollama, proxied through LiteLLM
- **Vector storage:** PostgreSQL with pgvector extension (`vector(768)` column, HNSW cosine index)
- **Full-text search:** PostgreSQL `tsvector` column with GIN index, BM25 ranking via `ts_rank`
- **Hybrid search:** Reciprocal Rank Fusion (RRF) merges BM25 and cosine similarity result lists (default)
- **Chunk size:** 1000 characters per chunk, stored with metadata (filePath, chunkIndex, language)
- **Tiered content:** Each chunk stores an `abstract` (L0 summary), an `overview` (L1 key points), and full `content` (L2)

## How Data Gets Indexed

### Automatic Indexing

Agent outputs are automatically indexed after completion when the output exceeds 100 characters. This is controlled by the `RAG_AUTO_INDEX` environment variable (default: `true`). Indexed with source type `agent_output` and metadata including agentId, role, and sessionId.

### Manual Indexing

1. **Research agents** -- system prompt instructs them to call `index_file` after research and check `search_knowledge` before starting new work.
2. **Knowledge tool** -- any agent with the `knowledge` tool can call `search_knowledge`, `index_file`, and `index_directory`.
3. **MCP tools** -- `assistant_index_file` and `assistant_search_knowledge` for external models (Claude Code, Gemini CLI).
4. **API** -- `POST /api/tools/knowledge/tools/{toolName}/execute` with Bearer token.

## How Data Gets Retrieved

Agents with the `knowledge` tool call `search_knowledge(query, limit?, source_type?, mode?)`. The `mode` parameter controls the search strategy:

| Mode | Description |
|---|---|
| `hybrid` | **(default)** Runs BM25 full-text search and vector cosine similarity independently, then merges the ranked lists using Reciprocal Rank Fusion (RRF). Best overall recall. |
| `fts` | BM25 full-text search only, using PostgreSQL `tsvector` + GIN index. Fast for keyword-heavy queries. |
| `vector` | Cosine similarity only against the `embedding` column. Original behavior; best for semantic/conceptual queries. |

Results include content, score, sourceType, and filePath. By default only the `abstract` (L0) or `overview` (L1) tiers are returned in search results to keep context concise. To load the full text of a specific entry use the `read_knowledge` tool, which returns the complete `content` (L2).

## Roles with Knowledge Tool Access

| Role | Has Knowledge | Rationale |
|------|:---:|---|
| research | Yes | Primary knowledge consumer/producer |
| coding | Yes | Look up past solutions and patterns |
| review | Yes | Reference past decisions and standards |
| general | Yes | General-purpose needs broad access |
| ai | Yes | RAG system builder, needs access |
| writing | Yes | Reference existing docs |
| data | Yes | Look up schemas and patterns |
| security | Yes | Reference past audits and findings |
| design | No | Primarily visual, less text-knowledge-dependent |
| devops | No | Infrastructure-focused |
| qa | No | Testing-focused |
| finance | No | Analysis-focused |
| automation | No | Workflow-focused |
| pm | No | Planning-focused |
| communication | No | Messaging-focused |

## Knowledge Base Cleanup

The knowledge base accumulates entries over time. A cleanup system removes low-value entries automatically and on demand.

### Cleanup Strategies

| Strategy | What it removes |
|---|---|
| **Orphaned documents** | Embeddings where the source document has been deleted from the database |
| **Stale agent outputs** | Agent output embeddings older than a configurable threshold (default: 30 days) |
| **Short entries** | Entries with content shorter than a minimum length (default: 50 chars), excluding structured content starting with `[` |
| **Duplicates** | Entries with identical source_type + source_id + content, keeping only the newest |

### Automatic Cleanup

A weekly cleanup runs automatically via the cron runner alongside session cleanup. It uses the default settings (30-day agent output cutoff, 50-char minimum content length).

### Manual Cleanup

**Via API:**
```bash
# Dry run — preview what would be removed
curl -X POST http://localhost:3005/api/knowledge/cleanup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Execute cleanup with custom settings
curl -X POST http://localhost:3005/api/knowledge/cleanup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"maxAgeDays": 14, "minContentLength": 100}'
```

**Via Agent Tool:**

Agents with the `knowledge` tool can call `cleanup_knowledge(dry_run?, max_age_days?, min_content_length?)`. This is useful for automation workers or scheduled cleanup hooks.

### Response Format

```json
{
  "orphanedDocuments": 3,
  "staleAgentOutputs": 12,
  "shortEntries": 5,
  "duplicates": 2,
  "total": 22
}
```

## Schema

```sql
CREATE TABLE embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,      -- 'document', 'code', 'agent_output'
  source_id TEXT NOT NULL,        -- file path or agent ID
  content TEXT NOT NULL,          -- L2: full text chunk
  abstract TEXT,                  -- L0: 2-3 sentence summary
  overview TEXT,                  -- L1: key points overview
  embedding vector(768) NOT NULL, -- nomic-embed-text dimension
  content_tsv TSVECTOR,           -- auto-populated from content, used for BM25 FTS
  model TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops); -- vector search
CREATE INDEX ON embeddings USING gin (content_tsv);                   -- full-text search
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `RAG_AUTO_INDEX` | `true` | Auto-index agent outputs on completion |

## Setup Requirements

1. PostgreSQL with the `pgvector` extension installed.
2. Pull the embedding model on Ollama: `ollama pull nomic-embed-text`.
3. Register the model in LiteLLM config with topic `embedding`.
4. Run migration `0005_rag_setup.sql` to create the embeddings table.
5. Run migration `0015_hybrid_search.sql` to add the `content_tsv`, `abstract`, and `overview` columns and their indexes.

## Key Files

| File | Purpose |
|---|---|
| `src/core/rag/embeddings.ts` | EmbeddingService -- generate, store, `search()` (vector), `ftsSearch()` (BM25), `hybridSearch()` (RRF) |
| `src/core/rag/indexer.ts` | FileIndexer -- index files and directories |
| `src/core/rag/auto-indexer.ts` | AutoIndexer -- indexes agent outputs on completion |
| `src/tools/knowledge/index.ts` | KnowledgeTool -- search_knowledge, index_file, index_directory, cleanup_knowledge |
| `src/db/schema/embeddings.ts` | Drizzle schema with pgvector custom type |
| `src/db/migrations/0005_rag_setup.sql` | Migration for embeddings table |
| `src/db/migrations/0015_hybrid_search.sql` | Migration adding `content_tsv`, `abstract`, `overview` columns and indexes |
| `mcp-server/src/tools/knowledge.ts` | MCP tools for external models |
