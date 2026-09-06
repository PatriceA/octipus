# RAG / Knowledge Base

## Overview

Octipus uses four Postgres-backed surfaces to remember things across
turns and sessions, all sharing the same pgvector install:

| Surface | What it stores | Schema | Hot files |
|---|---|---|---|
| **Knowledge base** | Document chunks, message chunks, image captions, per-repo maps + `AGENTS.md`, agent-flagged knowledge artefacts. **Never raw source code** — see [Code-exclusion policy](#code-exclusion-policy-raw-code-is-never-indexed). | `embeddings` | `src/core/rag/embeddings.ts`, `src/core/rag/retention-service.ts` |
| **Long-term memory** | Atomic user-scoped facts (preference, profile, relationship, …) with supersession history; retrieval is scoped to the current workspace (rows written under another workspace never surface — a fact learned for one client stays with that client; user-level rows with no workspace surface everywhere) | `memories` (+ `memories_active` view) | `src/core/memory/*` |
| **Workflow state** | Typed sibling-agent outputs scoped to a session, with LISTEN/NOTIFY fan-out | `task_state` | `src/core/agent-task-recorder.ts`, `src/db/repositories/task-state-repository.ts`, `src/db/task-state-listener.ts` |
| **Knowledge graph** | Authored markdown notes and the explicit edges between knowledge entities (`[[wikilinks]]`, `#tags`) — see [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md) | `notes`, `knowledge_links` | `src/core/knowledge/*` |

The original RAG layer (this doc's subject) is the first row. The memory
and task-state surfaces shipped May 2026, the knowledge graph after them;
runtime behaviour lives in `src/core/memory/`, `src/core/knowledge/`, and
`src/db/schema/`.

The graph is the *authored* counterpart to this doc's *ingested* content:
the knowledge base stores what was uploaded or written to disk, the graph
stores what someone deliberately wrote down and connected. Notes are
indexed into `embeddings` (`purpose='note'`) so both are reachable from
one hybrid search.

- **Embedding model:** anything mapped to topic `embedding` in the
  model registry (defaults to `nomic-embed-text` via Ollama through
  LiteLLM). The dimension is auto-detected and pinned by migration
  0055 once the table has data — see [Vector indexing](#vector-indexing).
  If the model is asymmetric, configure its prefixes — see
  [Asymmetric retrieval prefixes](#asymmetric-retrieval-prefixes).
- **Vector storage:** PostgreSQL with pgvector. Column type is
  `vector` (dimensionless) until 0055 pins it at the prevailing
  dimension; index is HNSW with cosine ops once pinned.
- **Full-text search:** PostgreSQL `tsvector` column with GIN index,
  BM25 ranking via `ts_rank_cd`.
- **Hybrid search:** Reciprocal Rank Fusion (RRF, `k=60`,
  `alpha=0.6`) merges BM25 and vector result lists.
- **Chunk size:** 1000 characters per chunk for flat content; the
  structural Markdown chunker emits one chunk per heading + one per
  body block and threads the `section_path` so retrieval can pull
  the matching clause plus its ancestor headings.
- **Batched embedding:** chunks are embedded `EMBED_BATCH_SIZE` (64) at a
  time via `EmbeddingService.embedBatch`, not one HTTP call per chunk.
  Failures are still accounted per chunk: a failed batch marks only its
  own chunks, so partial indexing stores what worked and "every chunk
  failed" still throws. A provider that returns the wrong number of
  vectors fails the batch rather than misattributing them.
- **Tiered content:** Each chunk stores an `abstract` (L0, ~1-2
  sentences, generated async post-indexing), an `overview` (L1, key
  points), and full `content` (L2).
- **Per-purpose retention:** rows are tagged with a `purpose` and
  retention is driven by `retention_policies` (per-purpose age cap
  + optional LFU). See [Retention](#retention).

## The `purpose` column

Every embedding row carries a `purpose` field. This is the single
categorisation column (the legacy `source_type` was retired in
PR #28 / migration 0056). Valid values:

| Purpose | What writes it | Default retention |
|---|---|---|
| `document` | Document uploads via `/api/documents/upload`, `index_file(path, 'document')`, and the boot/cron product-docs auto-index (`metadata.source='octipus-docs'`, see [Product docs auto-index](#product-docs-auto-index-at-boot)) | Tied to the parent `documents` row (cascade delete via FK); the auto-indexed product docs carry no `doc_id` and are refreshed in place |
| `code` | **Retired.** Raw source code is never indexed (see [Code-exclusion policy](#code-exclusion-policy-raw-code-is-never-indexed)). The value is kept only so the indexer can reject it loudly. | n/a |
| `image_description` | Vision-LLM caption + OCR text written by `documents/processor.ts` for image uploads | Tied to the parent `documents` row |
| `knowledge_artifact` | Reserved for agent-flagged outputs worth long-term storage | 365 days, LFU prune below 1 access after 180 days |
| `message` | Conversation chunks indexed for recall (not currently auto-written; compaction handles long-term recall via `compaction_entries`) | 90 days |
| `note` | Note bodies chunked by `NoteService.save` (`source_id='note:<id>'`), including meeting notes written by `write_meeting_note` / `import_calendar_meetings` — see [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md) | **No policy row**: never age-reaped. Chunks are replaced on every save and deleted with the note |
| `ephemeral` | Health probes, transient observations | 7 days |

`agent_output` is no longer a value. Memory-redesign Phase B moved
sibling-agent results to the typed `task_state` table; specialists
discover each other's outputs via the `task_state` MCP tool
(`list_recent_session_tasks`, `read_task_state`), not via cosine
similarity over `embeddings`.

## How data gets indexed

### Filesystem auto-index

Writes to project files via the `filesystem` tool fire a
fire-and-forget index for the touched path — **prose only**:

- `.md`, `.txt`, `.rst`, `.csv`, `.log` → `purpose = 'document'`
- Everything else (including all source code) → **not indexed**
  (`autoIndexPurpose` returns `null`). Code is deliberately excluded; see
  [Code-exclusion policy](#code-exclusion-policy-raw-code-is-never-indexed).

### Document uploads

`src/core/documents/processor.ts` handles uploads end-to-end:
extraction (PDF text, OCR via Tesseract, structural Markdown
parsing), categorisation, summarisation, and indexing into
`embeddings` with the right `purpose`. PDFs and DOCX go in at
`purpose='document'`; standalone image uploads land as
`purpose='image_description'`. Both populate `doc_id` so the
ON DELETE CASCADE FK reaps the chunks with the parent.

### Manual indexing

- **Knowledge tool** — any agent with the `knowledge` tool can call
  `search_knowledge`, `read_knowledge`, `index_file`,
  `index_directory`, `cleanup_knowledge`, `knowledge_stats`.
  `index_file`/`index_directory` index prose only and **reject code files**
  (a `**/*.ts` directory glob is skipped per file).
- **API** — `POST /api/knowledge/index` with `{ path, type:
  'file'|'directory', patterns? }`. Everything indexable lands as
  `'document'`; a code-file path or `purpose: 'code'` is rejected with `400`.
- **MCP server** — `octipus_index_file` and `octipus_search_knowledge`
  for external models (Claude Code, Antigravity, …).

### Product docs auto-index at boot

`src/db/seed-docs.ts` (`indexProductDocs()`) indexes Octipus's own
documentation — top-level `docs/*.md` plus `docs/architecture/**` and
`docs/guides/**` — into `embeddings` as **global** rows
(`user_id = NULL`) tagged `metadata.source = 'octipus-docs'`, so users
can ask the assistant "how do I set up Telegram / a model provider /
X?" and get an answer grounded in the shipped manual. High-churn /
low-signal files are excluded (`*CHANGELOG*`, `WEEKLY-CHANGELOG-*`,
`QA.md`, and the `plans/`, `superpowers/`, `images/` trees).

- **When it runs:** once at boot (after tools are registered and the
  runtime config — hence the embedding provider's credentials — is
  loaded; gated on `isKBReady()`), and on a 6-hour cron refresh
  (`maybeReindexDocs()` in `src/core/cron-runner.ts`). The cron refresh
  also covers first-install, where the embedding model is bound *after*
  boot: the boot-time pass bails as KB-not-ready and the cron pass lands
  the docs once a model is assigned.
- **Idempotent:** every chunk is stamped with the source file's
  SHA-256 (`metadata.fileSha`); a re-run skips any unchanged file, so
  re-indexing is cheap. A changed file is deleted-by-source and
  re-indexed so shrinking edits don't strand orphan chunks.
- **In the image:** the Dockerfile `COPY docs/ docs/` ships the manual
  into the runtime stage — without it the indexer finds nothing in prod.
- **Consume it:** the `/docs <query>` chat command
  (`src/core/commands/docs.ts`) searches this corpus directly (no LLM
  call), and knowledge-tool worker roles are nudged to `search_knowledge`
  for "how do I set up X" questions before answering.

## How data gets retrieved

`search_knowledge(query, limit?, purpose?, mode?, min_similarity?, repos?)`
runs the chosen mode against the `embeddings` table. The `mode`
parameter:

| Mode | Description |
|---|---|
| `hybrid` (default) | BM25 + vector cosine via RRF. Best overall recall. |
| `semantic` | Vector cosine only. Best for conceptual / paraphrased queries. |
| `keyword` | BM25 only via `plainto_tsquery` + `ts_rank_cd`. Fast for exact-term queries. |

The `purpose` filter is optional — omit to search the whole base, or
pass a value (e.g. `'document'`) to narrow the result space.

`min_similarity` filters by raw cosine similarity. Defaults: 0.35
for `semantic`, 0.3 for `hybrid`, 0 for `keyword`. The hybrid mode
keeps an entry if either similarity passes the bar *or* it had an
FTS match (keyword presence is its own signal).

Results carry the section path when the structural chunker produced
them, so callers can render "you are reading under § A / § B"
context next to a hit without a second query. `getAncestorHeadings`
remains for callers that want the full ancestor chunk objects.

### Freshness

Every row carries `last_verified_at` (migration 0097): when the content was
written, or when someone last confirmed it is still true. It is stamped by
`store()` — writing content is confirming it — and refreshed when byte-identical
content is re-indexed, so a nightly re-crawl keeps unchanged facts current
without rewriting a row. It is deliberately NOT the same as `last_accessed_at`:
reading a stale fact does not make it fresher, and folding the two together
would make the most-retrieved wrong answer look like the most recently
confirmed one.

Retrieval multiplies a row's score by a freshness factor: a linear decay to a
floor of 0.6 at one year since verification (`MAX_STALENESS_PENALTY`,
`STALENESS_HORIZON_DAYS` in `src/db/schema/embeddings.ts`). The ceiling is the
point — a 40% penalty re-orders near-ties and lets a fresh answer win, but
never buries a chunk that is the only real match. Rows written before the
column existed have NULL there and fall back to `created_at`, so they rank
exactly as they did before.

The multiplier applies to the ordering only. The reported `similarity` stays
the raw cosine value, so `min_similarity` means what it always meant and an
old-but-exact match ranks lower rather than disappearing.

Search results report `ageDays` and `stale` so a model can say "this is two
years old" instead of quoting it as current fact. `verify_knowledge(ids)` is
how a fact that is still true gets its standing back — call it only for
entries actually checked against a current source, since verifying something
unchecked makes stale knowledge look fresh, which is worse than leaving it old.

`read_knowledge(id)` returns the full L2 content + metadata for a
specific entry.

The optional `repos` filter scopes a search to one or more repositories — see
[Repo-scoped knowledge](#repo-scoped-knowledge-multi-repo).

## Long-term memory retrieval

A different table (`memories`) and a different question. The knowledge base
answers "what do we have written down about this"; memory answers "what do I
know about the person I am talking to". Every turn injects a block of it into
the system prompt, bounded at 250 tokens (`DEFAULT_MEMORY_TOKEN_BUDGET`).

Two orderings feed that block, and the reason there are two is the whole of
this section.

`retrieveTop` ranks by `access_count` then `updated_at` — frequency and
recency. It is the right answer to "what is always worth knowing about this
user" and it never looks at the question. While the whole corpus fits the
budget that costs nothing, because every fact is injected either way. That is
the case for a new user, and it is why the ordering was fine for a year.

Once the corpus outgrows the budget, ranking by frequency alone measurably
loses facts. `src/core/memory/recall.test.ts` runs the number on a 40-fact
corpus — the size a daily user reaches in a few months — and asks twelve
questions each of which exactly one fact answers:

| Ordering | Answers that reached the model |
|---|---|
| `access_count` + recency | 50% |
| interleaved with relevance | 100% |

Half is not bad luck, it is the ceiling: a query-independent ordering returns
the *same* block for every question, so the answer is present only if it
happens to be one of the rows the budget admitted, and no phrasing of the
question can change that. Worse, the ordering is self-reinforcing —
`recordAccess` bumps exactly the rows it just returned, so a fact learned last
week starts at `access_count = 0` and can never climb past the incumbents. You
tell the assistant something, it agrees, and from the next turn the fact is
invisible.

So above the budget the corpus is asked a second question — `retrieveRelevant`,
nearest the turn by cosine — and the two lists are **interleaved**, not
concatenated. Alternating bounds each ordering's share of the block: the most
relevant fact is always in, and one topical question can never evict everything
the assistant always needs to know. There is no similarity floor; the rows are
the user's own facts, so the eight nearest the turn are the eight most related
things known about them, and a cosine threshold would be a model-specific
constant tuned on nothing.

The semantic pass is skipped entirely when it cannot help or cannot run:

- the corpus already fits the budget (the common case, and the cheap one — no
  embedding call is made at all),
- the caller passed no turn text,
- no model is bound to the `embedding` topic, or the embedding call fails.

Each of those falls back to exactly the pre-Phase-6 block, so the feature has
no configuration and no failure mode beyond "you get what you got before".

## Code-exclusion policy (raw code is never indexed)

**Raw source-code files are never stored in the knowledge base.** Indexing whole
code files bloats retrieval with low-signal chunks and crowds out the curated and
generated content that actually helps — it was tried before and hurt result
quality. Code is meant to be *navigated* (the `repo_registry` tool, `grep`, read
on demand), not retrieved as fuzzy vector chunks. What the KB stores for a repo
instead are **generated summaries** — repo-map digests and `AGENTS.md` (see
[Repo-scoped knowledge](#repo-scoped-knowledge-multi-repo)).

### What counts as "code"

`isCodeFile()` (`src/core/rag/code-detection.ts`) decides, by:

- **Extension** — `.ts/.tsx/.js/.go/.rs/.py/.java/.rb/.php/.c/.cpp/.cs/.swift/
  .kt/.scala/.sh/.lua/.vue/.svelte/…` (the full set is in `CODE_EXTENSIONS`).
- **Bare filename** — extension-less build/script files: `Dockerfile`,
  `Makefile`, `Rakefile`, `Gemfile`, `Jenkinsfile`, `Vagrantfile`, …

Prose and data stay indexable: `.md`, `.txt`, `.rst`, `.csv`, `.log`.

### Where it's enforced (defense in depth)

The guard lives at the indexer chokepoint so **no caller can bypass it**:

| Layer | Behaviour |
|---|---|
| `FileIndexer.indexFile` | Throws `CodeFileNotIndexableError` for a code file **regardless of the requested purpose** — this also closes the `index_directory --patterns '**/*.ts'` bypass (a glob that would otherwise index code under `'document'`). |
| `FileIndexer.indexDirectory` | Silently skips code files (debug-logged), so a mixed glob indexes the prose and ignores the code. |
| `EmbeddingService.indexText` | Throws on the retired `purpose='code'` — a backstop for any direct caller that doesn't go through `FileIndexer`. |
| Knowledge tool `index_file` | Returns a clear "not indexed" message for a code file before calling the indexer. |
| REST `POST /api/knowledge/index` | `400` for a code-file path or `purpose='code'` (fail-loud — no silent coercion to `'document'`). |

The shared explanation text is `CODE_NOT_INDEXED_MESSAGE`
(`src/core/rag/code-detection.ts`), reused everywhere so the message never drifts.

## Repo-scoped knowledge (multi-repo)

In a [multi-repo workspace](./MULTI-REPO.md), the knowledge base carries a
`repo_id` dimension so search can target one repo, a chosen subset, or span the
whole suite — instead of one undifferentiated per-user corpus.

### What gets indexed per repo

When the repo registry is scanned (`scan_repos` / `POST /workspace/repos/scan`),
each repo's **generated/curated** content is indexed into `embeddings`, tagged
with its `repo_id` — and **never any raw code**:

| Content | `purpose` | `source_id` |
|---|---|---|
| Repo-map digest (top-level dirs, entry points, build/test/lint commands) | `knowledge_artifact` | `repo:<repoId>:map` |
| Curated `AGENTS.md` (the project guide) | `document` | `repo:<repoId>:agents` |

Re-scanning is cheap: each item is stamped with a `fileSha` and an unchanged
repo-map/`AGENTS.md` is skipped (`isFileIndexed`), so a scan only re-embeds what
actually changed.

### Scoping a search

- **Agents** — `search_knowledge(query, …, repos: "core, web")`. `repos` is a
  comma-separated list of repo **names or ids** (get them from the
  `repo_registry` tool); it resolves to registry ids and filters
  `embeddings.repo_id`. Omit it to search everything (repo + non-repo content).
- **REST** — `POST /api/knowledge/search` with `repoIds: ["<uuid>", …]`.
- Every hit carries its `repoId`, so results are attributed to a source repo
  without parsing file paths.

Under the hood, `SearchScope.repoIds` adds a parameterized `repo_id IN (…)`
predicate to `search` / `ftsSearch` / `hybridSearch` (both RRF CTEs). Non-repo
surfaces (notes, the global `/docs` corpus) are unaffected.

## Roles with `knowledge` tool

Ten roles carry both `knowledge` and `task_state` as of the May
2026 memory-redesign cleanup. The pairing is intentional —
specialists that look up documents also look up sibling outputs.

| Role | `knowledge` | `task_state` | Rationale |
|---|:---:|:---:|---|
| research | ✓ | ✓ | Primary knowledge consumer/producer |
| coding | ✓ | ✓ | Look up past solutions, see peer review findings |
| review | ✓ | ✓ | Reference past decisions and standards |
| general | ✓ | ✓ | General-purpose needs broad access |
| ai | ✓ | ✓ | RAG / model integration work |
| writing | ✓ | ✓ | Reference existing docs |
| data | ✓ | ✓ | Look up schemas and patterns |
| security | ✓ | ✓ | Reference past audits and findings |
| qa | ✓ | ✓ | Cross-reference test reports |
| architecture | ✓ | ✓ | Reference design notes + audits |
| design, devops, finance, automation, pm, communication | ✗ | ✗ | Domain-bounded; lookups come via the root agent |

## Retention

Per-purpose retention lives in the `retention_policies` table
(seeded by migration 0051; editable in place). Each row carries an
age cap and an optional LFU axis:

| Purpose | Max age | LFU prune below | After (days) |
|---|---|---|---|
| `document` | none | none | (cascade with documents) |
| `code` | — | — | (retired — raw code is never indexed) |
| `image_description` | none | none | (cascade with documents) |
| `knowledge_artifact` | 365 | < 1 access | 180 |
| `message` | 90 | none | — |
| `ephemeral` | 7 | none | — |

The cleanup loop (`src/core/rag/retention-service.ts`) runs four
passes in order:

1. Per-purpose retention (the table above)
2. Orphaned `document` rows whose parent is missing
3. Legacy `ephemeral` sweep (rare; mostly catches probe rows)
4. Short / low-quality entries (`length(content) < minContentLength`)

A weekly run is wired into the cron runner with default thresholds.
The audit log lands in `cleanup_audit_log`.

### Manual cleanup

```bash
curl -X POST http://localhost:3005/api/knowledge/cleanup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

Agents can call `cleanup_knowledge(dry_run?, max_age_days?,
min_content_length?)` via the knowledge tool.

### Asymmetric retrieval prefixes

Many retrieval models are trained with a task instruction on each side
and lose recall without it: `nomic-embed-text` expects
`search_document: ` on stored chunks and `search_query: ` on the query;
instruct-style models want a preamble on the query only; most hosted
APIs (OpenAI, and anything symmetric) want neither.

Nothing is inferred from the model id — which model is bound to topic
`embedding` is a per-install choice, and the model may not even exist on
another machine. The prefixes live on the model row itself, in
`model_config.metadata`:

```json
{ "embedPrefixes": { "document": "search_document: ", "query": "search_query: " } }
```

Unset (the default) = no prefix on either side, which is correct for
symmetric models. Consult the model card of whatever you bind; a wrong
prefix is worse than none.

Every embedding call declares its side (`generateEmbedding(text, 'query')`);
storage paths default to `'document'`. When prefixes are configured, the
row's `embedding_version` gains a `+p<hash>` suffix, so switching schemes
on a populated table shows up as drift instead of silently degrading
similarity — re-index those rows.

### Embedding-drift check

Multiple `embedding_version` values in the same table mean cosine
similarity across them is meaningless. The startup path logs a
warning when drift is detected; the operator can get the breakdown
with:

```bash
npm run db:check-embedding-drift
```

The script exits 1 on drift so a CI gate can pick it up.

## Vector indexing

Migration 0047 made the embedding column dimensionless to support
embedding-model swaps; the cost was pgvector couldn't build HNSW on
a dimensionless column. Migration 0055 auto-restores HNSW when
it's safe:

- **Empty table** → leave dimensionless. HNSW arrives next time the
  migration runs after data lands.
- **Single distinct dimension** → `ALTER COLUMN TYPE vector(N)` +
  `CREATE INDEX USING hnsw (embedding vector_cosine_ops)`. One-time
  table rewrite, data preserved.
- **Multiple distinct dimensions** → `RAISE NOTICE` with the drift
  count and skip. Run the drift-check script for the breakdown.

Both `embeddings.embedding` and `memories.embedding` are handled.
Re-running the migration after a successful pin is a no-op.

## Dedup

A unique index on `(purpose, source_id, content_sha256)` makes
re-inserting the same content into the same source a no-op rather
than a duplicate row. The previous "find duplicates by content
match" cleanup pass was retired with the index in place.

## Schema

```sql
CREATE TABLE embeddings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          text NOT NULL,
  user_id            uuid,
  workspace_id       uuid,
  content            text NOT NULL,
  embedding          vector NOT NULL,     -- vector(N) once 0055 pins it
  content_tsv        tsvector,            -- auto-generated for BM25
  model              text NOT NULL,
  abstract           text,                -- L0 summary
  overview           text,                -- L1 key points
  metadata           jsonb DEFAULT '{}',
  purpose            text NOT NULL,       -- see "The purpose column"
  content_sha256     text NOT NULL,       -- dedup key
  embedding_version  text NOT NULL,       -- "<model>/<dim>" drift detection
  access_count       integer NOT NULL DEFAULT 0,
  last_accessed_at   timestamptz,
  parent_chunk_id    uuid REFERENCES embeddings(id) ON DELETE SET NULL,
  section_path       text[],              -- root → leaf heading titles
  heading_level      smallint,            -- 0=body, 1=H1, …
  doc_id             uuid REFERENCES documents(id) ON DELETE CASCADE,
  repo_id            uuid REFERENCES workspace_repos(id) ON DELETE SET NULL,
                                          -- multi-repo scope (0073); NULL = non-repo
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX embeddings_dedup_idx
  ON embeddings (purpose, source_id, content_sha256);
CREATE INDEX embeddings_repo_id_idx ON embeddings (repo_id);
-- HNSW + GIN indexes created by 0055 once dimension is homogeneous.
```

## Configuration

| Env / setting | Default | Description |
|---|---|---|
| `memory.extractionCadence` (config) | `per_turn` | When the memory extractor runs: `per_turn` (after every user turn), `on_compaction` (only on session compaction), or `off`. Knowledge-base indexing is unaffected. |
| `AGENT_TASK_RECORDING` (env) | `true` | Toggle whether completed agents record their outputs to `task_state`. |
| `RAG_AUTO_INDEX` (env) | `true` | Reserved — agent-output auto-index was removed in Phase B; this flag is now used only by tests. |

## Setup requirements

1. PostgreSQL with the `pgvector` extension installed.
2. An embedding model registered in the model registry under topic
   `embedding`. `ollama pull nomic-embed-text` then create the model
   row from the Models page is the path of least resistance.
3. `npm run db:migrate` to run every migration up to 0056.
4. Optionally bind a model to topic `memory_extraction` to enable
   the long-term memory pipeline (Phase D); the knowledge-base path
   is independent.

## Key files

| File | Purpose |
|---|---|
| `src/core/rag/embeddings.ts` | `EmbeddingService` — generate, store, `search()` / `ftsSearch()` / `hybridSearch()` (incl. `SearchScope.repoIds`) |
| `src/core/rag/retention-service.ts` | Per-purpose retention + cleanup audit |
| `src/core/rag/indexer.ts` | `FileIndexer` — single file + directory indexing (rejects code) |
| `src/core/rag/code-detection.ts` | `isCodeFile()` + the code-exclusion guard / message |
| `src/core/repos/registry-service.ts` | `indexRepoKnowledge()` — indexes each repo's map + `AGENTS.md` scoped to `repo_id` |
| `src/core/rag/markdown-chunker.ts` | Structural Markdown chunker (heading hierarchy) |
| `src/core/rag/health.ts` | Boot-time KB self-check (DB + embedding model + vector write round-trip) |
| `src/core/documents/processor.ts` | Document upload pipeline (extract → categorise → summarise → index) |
| `src/tools/knowledge/index.ts` | MCP-style tool — search, read, index, cleanup, stats |
| `src/tools/task-state/index.ts` | Sibling-agent output discovery (memory-redesign Phase B) |
| `src/db/schema/embeddings.ts` | Drizzle schema |
| `src/db/migrations/0049_embeddings_purpose_versioning.sql` | Added `purpose`, dedup unique index, access tracking |
| `src/db/migrations/0051_retention_policies.sql` | Seeded per-purpose retention defaults |
| `src/db/migrations/0052_embedding_hierarchy.sql` | Document hierarchy columns (`parent_chunk_id`, `section_path`, `doc_id`) |
| `src/db/migrations/0055_vector_hnsw_when_homogeneous.sql` | Auto-pin vector dimension + create HNSW |
| `src/db/migrations/0056_drop_source_type.sql` | Retired the legacy `source_type` column |
| `src/db/migrations/0073_cloudy_glorian.sql` | Added `embeddings.repo_id` (multi-repo scope) + index |
| `mcp-server/src/tools/knowledge.ts` | External-model MCP bridge |
| `src/core/memory/{extractor,judge,retrieval,repository}.ts` | Layer 1 — long-term user-fact memory (extract → judge → apply, turn-start retrieve, supersession chain) |
| `src/core/memory/recall.test.ts` | The recall benchmark behind the two-ordering design above |
| `src/db/task-state-listener.ts` | Layer 3 — LISTEN/NOTIFY subscriber for `task_state_<session_id>` fan-out (Postgres only) |
| `src/core/agent/meta-tools.ts` (`remember_this`) | Agent-callable memory write — only path the LLM uses to promote a fact |
| `src/api/routes/memory.ts` | Operator REST — list / chain / soft-delete user memories |
| `web/app/memory/page.tsx` | UI for the same — including supersession-chain view |
