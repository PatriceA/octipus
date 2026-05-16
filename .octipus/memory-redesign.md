# Memory & Knowledge System Redesign

**Status:** Shipped. All five phases (A → E) landed in commits `b8c9300..56b4262` on main; post-implementation review cleanup landed in `e55a314..901b3c4` on `claude/redesign-memory-system-Pftvt`. This document is now a historical reference for the design and migration order — runtime behaviour is in `src/core/memory/`, `src/db/schema/{memories,task-state,retention-policies}.ts`, and migrations 0049–0054.
**Constraint:** Max two storage systems. Postgres+pgvector is system 1, Valkey/Redis is system 2 (hot cache only). No new database.

## Problem

The current RAG layer (`src/db/schema/embeddings.ts`, `src/core/rag/*`) treats every persistent piece of state as a 1000-char chunk in one flat table — user preferences, agent debug outputs, contract clauses, and code snippets are all ranked against each other by cosine similarity. Four concrete failure modes:

1. **No update path.** `EmbeddingService.indexText()` and `auto-indexer.ts` only append. A preference said three months apart exists three times; the cleanup job in `src/core/rag/embeddings.ts` only removes by age, length, and exact-content dedup — never by semantic conflict.
2. **Cleanup is purpose-blind.** It cannot distinguish "user said they prefer Slack" from "agent dumped 4 KB of trace output". Both age out identically. The user's intuition that cleanup is inaccurate because it doesn't know what matters is correct: the data was never tagged with what it is.
3. **Documents lose structure.** `src/core/documents/processor.ts` extracts text and chunks at 1000 chars. Section / clause / heading relationships are gone. "Clause 4.2 modifies Section 1" is unrecoverable post-ingest.
4. **Workflow state is in the wrong store.** `src/core/rag/auto-indexer.ts` writes every >100-char agent output into the vector store. Sibling agents discover each other's results via cosine similarity instead of typed lookup. `swarm_nodes.result` already holds the typed version — the RAG copy is noise.

A fifth issue is implicit: there is no notion of "long-term memory" distinct from RAG. Recall depends on retrieving message-chunks. The skills table (`src/db/schema/skills.ts`) already demonstrates the right pattern — embedding plus `description_hash` for staleness — but no other surface uses it.

## Design principle

**One database, multiple disciplined schemas.** The data layers the user enumerated (preferences, documents, workflow state, images) do not each need their own store; they need their own *table shape* and their own *retrieval primitive*. Postgres is sufficient for all of them when each layer uses the primitive that fits:

| User-named layer | Primitive | Storage |
|---|---|---|
| User-specific data & preferences | LLM-extracted atomic facts with ADD/UPDATE/DELETE | `memories` table, pgvector |
| Document data (contracts, forms) | Hierarchical chunks with parent pointers | `embeddings` + `document_sections` |
| Agent output & workflow state | Typed relational rows + LISTEN/NOTIFY | `task_state` table, no embeddings |
| Image data | Vision-LLM caption + OCR text, indexed as text | `embeddings` with `purpose='image_description'` |

The memory layer is implemented inline in octipus. No external dependency: extraction prompts live next to the existing role prompts in `src/core/orchestrator/roles/`, use the existing `ModelRegistry` topic binding, and inherit the `SECURITY_PREAMBLE`. The shape is informed by published patterns for LLM-mediated extract-merge-dedup, but the code, prompts, and data model are ours and remain under the same DESIGN.md rules (fail loud, typed contracts, minimal deps) as the rest of the codebase.

## Target schema

### 1. `memories` (new) — Layer 1: preferences & long-term facts

```
memories (
  id              uuid pk
  user_id         uuid not null
  workspace_id    uuid                                   -- org scope, NULL = user-level
  agent_scope     text                                   -- NULL = global, else role id
  fact_type       text not null                          -- preference | profile | relationship | skill_observation | workflow_note
  content         text not null                          -- the atomic fact, one sentence
  embedding       vector not null
  source_message_id uuid                                 -- provenance, FK to messages
  confidence      real default 1.0                       -- LLM-extractor's confidence
  valid_until     timestamptz                            -- soft TTL; NULL = persistent
  superseded_by   uuid                                   -- FK self; non-null = "this fact was updated, here's the new row"
  access_count    int default 0
  last_accessed_at timestamptz
  created_at      timestamptz default now()
  updated_at      timestamptz default now()
)
```

Write path: after each user turn, an `extract_memories` worker runs (LLM call with the SECURITY_PREAMBLE + a small extraction prompt). For each candidate fact:

1. Vector-search the user's existing memories for the same `fact_type`, top-k=5.
2. LLM judge decides `ADD | UPDATE | DELETE | NOOP` against each match.
3. UPDATE = insert new row + set `superseded_by` on the old. We never destructively edit, so audit is preserved.

Read path: at orchestrator turn-start, fetch top-N memories for `(user_id, agent_scope ∈ {NULL, current_role})`, inject into system context. This replaces "vector-search the message history".

### 2. `embeddings` (modified) — Layer 2 & 4: documents, code, image descriptions

Add columns:

```
purpose          text not null    -- document | code | image_description | knowledge_artifact
content_sha256   text not null    -- upsert key; unique per (purpose, source_id, content_sha256)
embedding_model  text not null    -- already exists as `model`; rename normalised
embedding_version text not null   -- model + dim, e.g. "nomic-embed-text:v1.5/768"
parent_chunk_id  uuid             -- FK self; document hierarchy
section_path     text[]           -- e.g. ['Article IV', 'Clause 4.2']
heading_level    smallint
doc_id           uuid             -- FK documents
access_count     int default 0
last_accessed_at timestamptz
```

Drop the catch-all `source_type` ENUM and replace with `purpose`. Anything that used `source_type='agent_output'` moves out of this table entirely (see Layer 3).

`content_sha256` unique constraint kills the duplicate-cleanup pass entirely — duplicates can't be inserted. Hierarchical retrieval: when a document chunk hits, the retriever also walks `parent_chunk_id` and includes the chain of ancestor headings in the context. Solves the "Clause 4.2 modifies Section 1" problem without extracting a knowledge graph.

### 3. `task_state` (new) — Layer 3: workflow & agent output

```
task_state (
  id               uuid pk
  session_id       uuid not null
  swarm_node_id    uuid                                  -- FK swarm_nodes
  owner_agent      text not null                         -- role id
  task_kind        text not null                         -- e.g. 'assignment' | 'review' | 'finding'
  status           text not null                         -- pending | in_progress | done | cancelled | failed
  inputs           jsonb
  outputs          jsonb
  depends_on       uuid[]                                -- task ids this task waits on
  created_at       timestamptz
  updated_at       timestamptz
)
```

Postgres `LISTEN/NOTIFY` on `task_state_changed` for fan-out. Sibling agents poll or subscribe — no cosine search. `auto-indexer.ts` stops writing agent outputs to `embeddings`; outputs flow into `task_state.outputs`. Agents may *explicitly* mark an output as worth remembering long-term, in which case the orchestrator runs it through the same extractor that feeds `memories`.

### 4. Image data — no new storage

Vision-LLM caption + OCR text already produced by `src/core/documents/processor.ts:218-356` becomes a row in `embeddings` with `purpose='image_description'`. No CLIP, no ColPali, no second vector space. If a future workload genuinely needs image-similarity search we revisit, but the existing vision model produces a better caption for retrieval than CLIP embeddings would for our use cases.

## Retention, driven by purpose

Cleanup stops being a global age sweep and becomes per-purpose policy, configured in `src/db/schema/cleanup-log.ts` neighbours:

| Layer | Signal | Default |
|---|---|---|
| `memories` fact_type=preference | Never | persistent |
| `memories` fact_type=workflow_note | `valid_until` or LFU | 90 days |
| `embeddings` purpose=document | Tied to document lifecycle | delete with doc |
| `embeddings` purpose=code | Re-index on file change | hash-driven |
| `embeddings` purpose=image_description | Tied to document | delete with doc |
| `task_state` status=done | Age | 30 days |
| `task_state` status=in_progress | Never | persistent |

`access_count` and `last_accessed_at` open LFU pruning where age alone is wrong (a 2-year-old preference still matters; a 2-day-old debug observation does not).

## Migration plan

Five phases, each shippable independently.

**Phase A — Tag and version what's already there** (low risk, no behaviour change)
- Add `purpose`, `content_sha256`, `embedding_version`, `access_count`, `last_accessed_at` to `embeddings`.
- Knowledge base is disposable in this install — `TRUNCATE embeddings` in the migration instead of backfilling. Re-indexing happens on next document upload / agent activity.
- Add unique index on `(purpose, source_id, content_sha256)`.
- Wire `access_count` + `last_accessed_at` increment into `EmbeddingService.search()`/`ftsSearch()`/`hybridSearch()`.
- App-side SHA-256 of `content` at insert time (no `pgcrypto` dependency on the hot path).
- `retention_policies` table from `memory-redesign-schema.sql` deferred to a follow-up after Phase B so retention policy lands together with purpose-aware cleanup.

**Phase B — Workflow state out of RAG**
- Add `task_state` table + LISTEN/NOTIFY trigger.
- Stop the agent-output auto-indexing path in `src/core/rag/auto-indexer.ts`.
- Migrate readers that did similarity-search against agent outputs to query `task_state`.
- Mark all existing `purpose='ephemeral'` rows for accelerated cleanup (7-day window).

**Phase C — Document structure**
- Add `parent_chunk_id`, `section_path`, `heading_level`, `doc_id` to `embeddings`.
- Replace the flat chunker in `processor.ts` with a structural extractor (start with `unstructured` for PDFs, `mammoth` for docx, both already in the npm ecosystem and small). On heading detection, set `heading_level` and write `parent_chunk_id` to the nearest enclosing heading chunk.
- Update the retriever to walk the parent chain and inject ancestor headings into the prompt.

**Phase D — Memories layer**
- Add `memories` table.
- Build extraction module `src/core/memory/`:
  - `extractor.ts` — LLM call with extraction prompt, returns candidate facts `{ fact_type, content, confidence }[]`.
  - `judge.ts` — for each candidate, vector-search top-k existing memories for same `(user_id, fact_type)`, LLM decides `ADD | UPDATE | DELETE | NOOP`.
  - `retrieval.ts` — turn-start fetch: top-N by cosine similarity to current user message, filtered to active memories (`superseded_by IS NULL`, not expired), scoped to `(user_id, agent_scope ∈ {NULL, current_role})`.
- New model registry topic `memory_extraction` — extractor and judge bind to it (small/cheap model is fine, this runs per turn).
- Wire `OrchestratorService.handleMessage()` to inject memory retrieval into the system context, fire-and-forget extraction after the user turn completes.
- New tool none — the memory module is internal to the orchestrator pipeline, not exposed to agents as a tool.

**Phase E — Images, optional**
- Today: vision caption already lands in `embeddings`. Just tag with `purpose='image_description'` at write time.
- If retrieval quality is poor: revisit, do not jump to CLIP yet — try chain-of-vision (caption + key entities + OCR) as separate rows linked by `parent_chunk_id` to the page.

## What this is not

- Not a graph DB. The "graph" relationships the user enumerated — clause→section, task→dependency, fact→supersession — fit in SQL with `parent_chunk_id`, `depends_on uuid[]`, and `superseded_by`. Apache AGE is available as a future-proof escape hatch inside the same Postgres if we ever need true Cypher queries; we are not adopting it now.
- Not a second vector store. pgvector handles all four data layers when each layer has the right table shape.
- Not a third-party memory service. No mem0, no Letta, no hosted memory API. The memory layer is octipus code on octipus tables; the extraction prompts ship in this repo and are auditable like every other prompt.
- Not a feature flag rollout. Each phase is an irreversible migration that lands or doesn't.

## Open questions

1. **Extraction cadence.** Run after every user turn (cheap, granular, more LLM calls) or only on session compaction (batched, fewer calls, late updates). Lean: every turn, with a short-circuit when the turn contains no first-person statements.
2. **Workspace vs user memories.** Org-shared facts (company holidays, escalation paths) belong on `workspace_id`. Conflict resolution when user and workspace facts disagree — user wins, but flag for review. Needs UI surface.
3. **PII in memories.** The extractor sees raw conversations. SECURITY_PREAMBLE must be in its prompt. Open: do we also run `filter_pii` on extracted facts before persistence, and how do we handle "the user wants me to remember their phone number" vs "the user mentioned their phone number in passing"?
4. **Eval coverage.** New `eval/` scenarios for: preference recall across sessions, preference update (old fact superseded), workflow handoff between sibling agents via task_state, hierarchical document retrieval (clause + ancestor headings). Required for sign-off on each phase.

## Files touched (preview)

| Phase | Files |
|---|---|
| A | `src/db/schema/embeddings.ts`, migration `0049_embeddings_purpose_versioning.sql`, `src/core/rag/embeddings.ts` (search hook) |
| B | new `src/db/schema/task-state.ts`, migration `0050_task_state.sql`, `src/core/rag/auto-indexer.ts` (delete agent-output write), `src/core/swarm/*` (write task_state on result) |
| C | `src/db/schema/embeddings.ts` (hierarchy cols), migration `0051_embedding_hierarchy.sql`, `src/core/documents/processor.ts` (structural extractor), `src/core/rag/embeddings.ts` (ancestor injection) |
| D | new `src/db/schema/memories.ts`, migration `0052_memories.sql`, new `src/core/memory/{extractor.ts,judge.ts,retrieval.ts}`, `src/core/orchestrator/handler.ts` (turn-start injection) |
| E | `src/core/documents/processor.ts` (purpose tag), no schema change |

## Sketches

Draft SQL for the schema additions lives at `.octipus/memory-redesign-schema.sql`. It is a design artifact, not a runnable migration — real migrations get split per phase and generated through `bun run db:generate` from the Drizzle schema once each phase is approved.
