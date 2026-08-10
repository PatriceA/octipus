# Knowledge Graph

## Overview

The knowledge graph is the *authored* half of Octipus's memory: ideas the
user (or an agent, deliberately) wrote down and connected on purpose.
Everything else in the platform is passive — `memories` are extracted from
conversation, `embeddings` are ingested from uploads and file writes, and
similarity is recomputed at query time and never persisted. `knowledge_links`
is the first place two knowledge items are connected by an explicit,
explainable edge, and `notes` is the surface that authors them.

Four Postgres-backed surfaces make up the platform's memory, all sharing the
same pgvector install:

| Surface | What it stores | Schema | Hot files |
|---|---|---|---|
| **Knowledge base** | Chunked documents, captions, per-repo maps, agent artefacts. Never raw source code. | `embeddings` | `src/core/rag/*` — see [RAG.md](RAG.md) |
| **Long-term memory** | Atomic user-scoped facts with supersession history | `memories` | `src/core/memory/*` |
| **Workflow state** | Typed sibling-agent outputs scoped to a session | `task_state` | `src/db/repositories/task-state-repository.ts` |
| **Knowledge graph** | Authored notes and the edges between knowledge entities | `notes`, `knowledge_links` | `src/core/knowledge/*` |

The code is organised in three tiers, and the source files name their tier in
their header comment:

| Tier | What | Files |
|---|---|---|
| **Tier 1 — edges** | The `knowledge_links` table, `[[wikilink]]`/`#tag` parsing, bounded graph traversal | `wikilink.ts`, `graph.ts`, `db/schema/knowledge-links.ts` |
| **Tier 2 — authoring** | Notes, the save pipeline, link resolution, suggestions, weekly review | `notes.ts`, `link-resolver.ts`, `suggestions.ts`, `weekly-review.ts` |
| **Tier 3 — interop** | JSON Canvas projection, two-way Obsidian vault sync | `canvas.ts`, `vault.ts` |

All paths below are relative to `src/core/knowledge/` unless stated.

---

## Tier 1 — edges

### The `knowledge_links` table

One row per directed edge. Backlinks ("what links to X") query the `to_*`
side; outgoing edges query the `from_*` side. There is no reverse-row
duplication.

| Column | Meaning |
|---|---|
| `user_id`, `workspace_id` | Owner. Every query filters on `user_id`; workspace NULL = user-level. |
| `from_type` / `from_id` | Source endpoint. |
| `to_type` / `to_id` | Target endpoint — **NULL until resolved** (see [ghost edges](#ghost-edges)). |
| `to_ref` | Canonical target reference (slug/tag). Always present; the dedup key. |
| `link_type` | `references` \| `derived_from` \| `contradicts` \| `mentions` \| `child_of` \| `tagged` (free text — a new kind needs no migration). |
| `label` | Edge label / wikilink alias. |
| `origin` | `user` \| `agent` \| `wikilink` \| `suggestion`. |
| `confidence` | Set for non-authored edges, and for a *guessed* binding (see [fuzzy resolution](#fuzzy-resolution-of-ghost-links)). NULL for exact/authored edges. |
| `created_by_agent_id` | NULL = user-authored. |

The edge is **polymorphic by design**: endpoints address `note`, `document`,
`memory`, `artifact`, or `tag` rows, so there is no real FK on
`from_id`/`to_id`. Referential cleanup is app-side in
`KnowledgeLinkRepository` (see [Lifecycle](#lifecycle-and-retention)).

**Edge identity** is `(user_id, from_type, from_id, to_ref, link_type)` —
keyed on the *authored target*, not the resolved id, so dedup works before and
after resolution. Consequence: `[[A#Intro]]` and `[[A#Risks]]` from the same
note collapse to one `references` edge to `a`. The heading is parsed and kept
for display but is deliberately not part of edge identity.

Indexes cover the four real access patterns: backlinks
`(user_id, to_type, to_id)`, outgoing `(user_id, from_type, from_id)`,
by-ref `(user_id, to_ref)`, and a partial index over ghost rows only
(`WHERE to_id IS NULL`).

### Wikilink syntax

`wikilink.ts` is the only place `[[ ]]` / `#tag` syntax is interpreted. It's a
dependency-free parser of pure functions — no DB, no I/O.

```
[[Target]]                 → ref = slug(Target)
[[Target|Alias]]           → ref = slug(Target), alias = "Alias"
[[Target#Heading]]         → ref = slug(Target), heading = "Heading"
[[Target#Heading|Alias]]   → all of the above
#tag, #nested/tag          → tag = "tag" / "nested/tag"
```

- `slugify()` lowercases, turns whitespace into `-`, **preserves `/`** (so
  `daily/2026-06-09` stays a path), strips everything else, and is idempotent.
- Wikilinks and tags inside fenced code blocks and inline code spans are
  ignored — a code sample mentioning `[[x]]` is not an authored edge.
- `#123` is not a tag (an issue reference), and `# Heading` is not a tag (the
  space disqualifies it). A tag must contain at least one non-digit.

### Ghost edges

A `[[Target]]` may point at something that doesn't exist yet. The edge is
stored with `to_id`/`to_type` NULL and `to_ref` holding the slug — Obsidian's
"ghost" target. This is why `to_ref` is the dedup key rather than `to_id`.

Ghost edges are **not traversable** (there is nothing to traverse *to*) and
are **not drawn** in the graph view. They still appear in backlink lists.

### Resolution

Resolution binds `to_id`/`to_type` on a ghost edge. It never rewrites
`to_ref`, so the authored intent survives verbatim.

Three passes, all in `NoteService.save` (`notes.ts`) except where noted:

1. **Incoming** — when a note is created or renamed, ghost edges whose
   `to_ref` equals its slug bind to it. ("B linked to [[Target]] before Target
   existed.")
2. **Outgoing** — each of the saved note's own refs that matches an existing
   note's slug binds immediately. Without this pass, linking A→B when B
   already exists left the edge a ghost until B was next saved, and the graph
   drew no line between two freshly-linked notes.
3. **Fuzzy** — refs that matched nothing exactly get one similarity guess (see
   below).

`tagged` edges are intentionally never resolved to an id: a tag is a
pseudo-entity, not a row.

### Fuzzy resolution of ghost links

`link-resolver.ts`. `[[Octipus Architecture]]` slugs to
`octipus-architecture`; if the note the author meant is titled "Octipus
architecture overview", exact resolution never binds it and the two ideas stay
disconnected forever.

The shape is standard entity resolution — cheap embedding **blocking** to
propose candidates, then a **pair resolver** to adjudicate, then a canonical
policy:

1. Hybrid-search the author's *display text* (not the slug — `[[Octipus
   Architecture]]` is a better query than `octipus-architecture`) over that
   user's notes, floor 0.35 similarity.
2. Collapse chunk hits into at most 3 distinct, titled notes, excluding the
   linking note itself.
3. A small model on topic `background` answers `{"match": <n>|null}`. The
   prompt insists that related, same-topic, or "parent subject" is **not** a
   match — a wrong link is worse than no link.
4. Bind the edge with `confidence` = the candidate's retrieval score.

The policy is the safety rail:

- **Notes are never merged, renamed, or rewritten.** The only write is filling
  `to_id` on one edge.
- A guess only ever fills an empty slot on a `wikilink` edge. It cannot
  displace an exact binding, churn a previous guess, or touch an
  agent/suggestion edge (whose `confidence` means something else).
- **An exact match reclaims what a guess bound** and clears the score. Create
  the note the ref actually names and the edge moves to it.

Cost is one search plus one small LLM call per *unresolved* ref, capped at 5
refs per save. With no embedding model or no model bound to `background` the
whole pass is a logged no-op — a link that can't be guessed must never fail a
note save.

### Traversal

`graph.ts` — bounded BFS over resolved edges, the model-friendly half of
retrieval. Composed with hybrid search (semantic entry → link BFS), it reaches
items the author *said* are related and can explain *why* something is in
context ("followed [[X]] → [[Y]]"), which cosine ranking cannot.

```ts
getKnowledgeGraph().traverse(userId, [{ type: 'note', id }], {
  hops: 2,            // default 2
  direction: 'both',  // 'out' | 'in' | 'both'
  linkTypes: ['references'],  // default: all
  maxNodes: 200,      // default 200 — EXCEEDING THIS THROWS
});
```

- `userId` is mandatory; a traversal never crosses tenant boundaries even when
  handed another user's entry id (it simply finds no edges).
- Seed nodes are excluded from the result; only reached neighbours are
  returned, each with `depth`, `viaEdgeId`, and `viaDirection` so callers can
  reconstruct the path.
- Each BFS level batches its queries by entity type — a handful of `IN (...)`
  queries per level, not one query per node.
- Exceeding `maxNodes` **throws** rather than silently truncating (house rule:
  no unbounded loops, no silent caps).

---

## Tier 2 — notes

### The `notes` table

Postgres is the source of truth — that keeps multi-user scoping, retention,
and hybrid search consistent with the rest of the platform — but the body is
plain markdown, so it stays human- and model-readable and exports to a real
Obsidian vault.

| Column | Meaning |
|---|---|
| `slug` | Wikilink target + URL slug. Unique per owner scope. |
| `title`, `body` | Markdown; the `[[wikilinks]]` live in the body. |
| `body_sha256` | Change detection — an unchanged save is a no-op. |
| `frontmatter` | Obsidian-style properties (jsonb). |
| `tags` | Denormalised from `#tags` for cheap filtering (GIN index). |
| `note_kind` | `note` \| `daily` \| `moc` \| `literature` (free text). |
| `note_date` | The calendar day a daily note covers. |
| `pinned`, `archived_at` | Archive is a soft delete; notes don't hard-delete by default. |
| `created_by_agent_id` | NULL = user-authored. |

Slug uniqueness uses **two partial unique indexes** (workspace NULL and
workspace NOT NULL). A single unique index over `(user, workspace, slug)`
would let duplicate user-level slugs through, because Postgres treats NULL
workspace values as distinct.

### The save pipeline

`NoteService.save()` is the single entry point for creating and updating a
note. Every other surface — API, tools, chat command, vault import, weekly
review — goes through it, so links and search stay consistent by construction.

1. **Change-detect** via body SHA. An unchanged body refreshes metadata and
   skips re-link and re-index entirely. It reports the *actual* index state
   (a prior save may have failed to index) rather than assuming success.
2. **Re-link** — parse `[[wikilinks]]`/`#tags`, sync `knowledge_links` (a
   diff: edges the body no longer contains are removed), run the three
   resolution passes.
3. **Re-index** — chunk the body into `embeddings` with `purpose='note'` and
   `source_id='note:<id>'`, so notes are first-class hybrid-search hits with
   no new retrieval code.

**Degradation contract:** indexing needs an embedding model; the note and its
links do not. With no model configured, the note still saves and the result
carries `indexed: false` — logged loudly, never swallowed.

### Daily notes and capture

`getOrCreateDaily(userId, workspaceId, day)` lazily creates `daily/YYYY-MM-DD`
from a minimal template. `capture()` appends a timestamped bullet to today's
daily note through the same `save()` pipeline, so links and tags in captured
text are wired immediately. `/capture <text>` is the chat command; it works on
every channel because commands go through the gateway.

> **Timezone caveat:** day normalisation is UTC. A capture made late in the
> day in a UTC− timezone lands on the next day's note. Callers that need
> local-day behaviour must pass an explicit `day`.

### Link suggestions

`suggestions.ts` — the inversion that makes embeddings and the graph
complementary: embeddings stop pretending to *be* the graph and instead
*propose* edges. For a note, it hybrid-searches that user's notes, excludes
self and already-linked targets, and returns candidates with similarity.

It **computes only — it never persists.** Accepting a suggestion is what
writes a real edge (with `origin='user'`). Reachable via
`GET /api/notes/:id/suggestions` and the notes tool's `suggest_links`.

### Weekly review

`weekly-review.ts` assembles the week's daily notes, completed `task_state`
rows, and new memories, then asks the model bound to the `background`
topic to write a review note that `[[wikilinks]]` what it references — so the
review connects into the graph instead of dead-ending. The model comes from
the registry topic; an unbound topic throws (never a hardcoded model).

> **Status:** built and unit-tested, but `generateWeeklyReview()` has no
> production caller yet — no cron, command, or route invokes it.

---

## Tier 3 — interop

### JSON Canvas

`canvas.ts` projects a note's neighbourhood (a Tier 1 traversal) into the open
[JSON Canvas](https://jsoncanvas.org/) `{ nodes, edges }` format Obsidian uses
for its spatial view. The spec ignores unknown fields, so each node carries an
`octipus:entityRef` extension without breaking interop.

No new storage: callers persist the result as an artifact or write it to the
vault as a `.canvas` file. Available as `GET /api/graph/canvas` and the notes
tool's `export_canvas`.

### Obsidian vault sync

`vault.ts` — two-way sync where Postgres stays authoritative and the vault is
a projection plus a read-back path.

- **Export** materialises notes as `.md` with a frontmatter block; the
  `[[wikilinks]]` are already in the body.
- **Import** runs each file through `NoteService.save`, so an externally
  edited file lands in the graph identically to a UI edit.
- **Conflict policy: DB authoritative.** On import, a note whose body differs
  from the file is *reported and skipped*, never merged — unless `force`,
  which lets the file win.

Exposed through the notes tool's `sync_vault` action.

---

## Surfaces

### HTTP API

| Route | What |
|---|---|
| `GET /api/notes` | List (filter by `kind`, `tag`, `includeArchived`; max 500) |
| `POST /api/notes` | Create/update via the save pipeline |
| `POST /api/notes/query` | Bases-style property query (kind, tag, frontmatter, sort) |
| `GET /api/notes/index` | Lightweight `{id,title,slug,kind}` — the source for `[[` autocomplete |
| `GET /api/notes/tags` | Tag → count across active notes; powers the tag tree and `#tag` autocomplete |
| `POST /api/notes/capture` | Append to today's daily note |
| `GET /api/notes/:id` | Read with backlinks |
| `GET /api/notes/:id/suggestions` | Computed link suggestions |
| `PATCH /api/notes/:id/pin` | Pin/unpin |
| `DELETE /api/notes/:id` | Archive; `?hard=true` removes the note, its chunks, and its edges |
| `GET /api/graph` | Global mode: active notes + resolved edges (capped 2000 nodes / 5000 edges). With `entryType`+`entryId`: local neighbourhood via traversal, `hops` clamped 1–5 |
| `GET /api/graph/canvas` | JSON Canvas of a neighbourhood, `hops` clamped 1–5 |

Only **resolved** edges are returned by the graph route — a ghost edge has no
target to draw a line to.

### Agent tools

- **`notes` tool** — `write_note`, `read_note`, `list_notes`, `search_notes`,
  `capture_note`, `suggest_links`, `archive_note`, `query_notes`,
  `export_canvas`, `sync_vault`.
- **`knowledge` tool** — `link_knowledge` (create an edge, including a ghost
  by `to_ref`; lands with `origin='agent'`), `get_backlinks`,
  `traverse_knowledge` (bounded BFS), plus
  `search_knowledge` with **`mode='graph'`**: hybrid search finds entry
  points, then the graph is followed one hop in both directions (max 25
  nodes), returning `linked` alongside the ranked hits. Entry points come from
  hits whose `source_id` matches `<type>:<uuid>`; a hit keyed by file path
  addresses no entity and is skipped.

### Web UI

The graph lives *inside* the notes workspace as a view mode — notes and the
graph are the same thing. `/notes` renders the workspace
(`web/app/notes/notes-workspace.tsx`, `knowledge-graph.tsx`); `/graph`
redirects to `/notes?view=graph` so old links keep working.

---

## Lifecycle and retention

| Event | What happens |
|---|---|
| Note body changes | Chunks are deleted by source and re-indexed; edges are diffed (added/removed) |
| Note archived | Soft delete — row, chunks, and edges all stay |
| Note hard-removed | Chunks deleted by source, then `deleteForEntity`: outbound edges **dropped**, inbound edges **reverted to ghost** (`to_id`/`to_type` cleared) so the authored backlink isn't silently lost and re-resolves if the note is recreated |
| Cleanup sweep | See below |

Retention for `embeddings` is per-purpose and driven by `retention_policies`.
**There is no policy row for `note`**, so note chunks are never age-reaped —
they are replaced on save and deleted with the note.

Two caveats worth knowing:

- The KB cleanup's short-content pass (`length(content) < min_content_length`,
  default 50) is **purpose-agnostic**. A very short note can lose its
  embedding chunks to it and drop out of semantic search; the note row itself
  is untouched.
- `reapUnacceptedSuggestions(cutoff)` exists on the repository to drop
  suggestion edges the user never accepted (accepted ones are rewritten to
  `origin='user'`), but **nothing calls it** — no cron, route, or service. It
  is currently a no-op in practice, and harmless because nothing persists
  suggestion edges yet either.

---

## Invariants

- **Tenant scoping is not optional.** Every graph query takes `userId` and
  every index leads with it. Traversal cannot cross tenants.
- **Bounded, never silently truncated.** Traversal throws past `maxNodes`; the
  graph route caps and the fuzzy resolver caps, and both say so in the code.
- **No hardcoded models.** The weekly review and fuzzy resolver both bind to
  the `background` topic; embedding comes from the `embedding` topic.
  Unbound = throw or degrade, never a silent default.
- **One parser, one save path.** `[[ ]]` is interpreted only in
  `wikilink.ts`; every write goes through `NoteService.save`.
- **Exact beats guessed.** A similarity-bound edge is always reclaimable by
  the note the ref actually names.

## Related

- [RAG.md](RAG.md) — the knowledge base, chunking, hybrid search, retention
- [MULTI-USER.md](architecture/MULTI-USER.md) — tenant scoping model
