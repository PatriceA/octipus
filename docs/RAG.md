# RAG / Knowledge Base

## Overview

The assistant uses Retrieval-Augmented Generation (RAG) to store and retrieve knowledge. Text is chunked, embedded, and stored in PostgreSQL with pgvector. At query time, the system generates an embedding for the query and returns the most similar chunks by cosine distance.

- **Embedding model:** `nomic-embed-text` via Ollama, proxied through LiteLLM
- **Vector storage:** PostgreSQL with pgvector extension (`vector(768)` column, HNSW cosine index)
- **Chunk size:** 1000 characters per chunk, stored with metadata (filePath, chunkIndex, language)
- **Search:** Cosine similarity, returns top-K results with scores

## How Data Gets Indexed

### Automatic Indexing

Agent outputs are automatically indexed after completion when the output exceeds 100 characters. This is controlled by the `RAG_AUTO_INDEX` environment variable (default: `true`). Indexed with source type `agent_output` and metadata including agentId, role, and sessionId.

### Manual Indexing

1. **Research agents** -- system prompt instructs them to call `index_file` after research and check `search_knowledge` before starting new work.
2. **Knowledge tool** -- any agent with the `knowledge` tool can call `search_knowledge`, `index_file`, and `index_directory`.
3. **MCP tools** -- `assistant_index_file` and `assistant_search_knowledge` for external models (Claude Code, Gemini CLI).
4. **API** -- `POST /api/tools/knowledge/tools/{toolName}/execute` with Bearer token.

## How Data Gets Retrieved

Agents with the `knowledge` tool call `search_knowledge(query, limit?, source_type?)`. The service generates an embedding for the query, finds top-K chunks by cosine similarity, and returns content, similarity score, sourceType, and filePath.

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

## Schema

```sql
CREATE TABLE embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,      -- 'document', 'code', 'agent_output'
  source_id TEXT NOT NULL,        -- file path or agent ID
  content TEXT NOT NULL,          -- the text chunk
  embedding vector(768) NOT NULL, -- nomic-embed-text dimension
  model TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);
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

## Key Files

| File | Purpose |
|---|---|
| `src/core/rag/embeddings.ts` | EmbeddingService -- generate, store, search, delete |
| `src/core/rag/indexer.ts` | FileIndexer -- index files and directories |
| `src/core/rag/auto-indexer.ts` | AutoIndexer -- indexes agent outputs on completion |
| `src/tools/knowledge/index.ts` | KnowledgeTool -- search_knowledge, index_file, index_directory |
| `src/db/schema/embeddings.ts` | Drizzle schema with pgvector custom type |
| `src/db/migrations/0005_rag_setup.sql` | Migration for embeddings table |
| `mcp-server/src/tools/knowledge.ts` | MCP tools for external models |
