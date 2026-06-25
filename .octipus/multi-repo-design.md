# Multi-Repo Working — Design Note

**Status:** Design — proposal. Phase 0 (per-repo `AGENTS.md` awareness) shipped in
the same change that introduced this note; everything else is unbuilt.
**Created:** 2026-06-25
**Scope:** Make Octipus effective in a *suite* of interconnected repos (products +
shared libraries that depend on each other), so agents can analyze and integrate
across them without re-reading the world every session.

---

## The problem

A real product company is not one repo. It's a **suite**: a handful of products,
several shared libraries, maybe some infra/tooling repos — all depending on each
other (`product-a` and `product-b` both consume `lib-core`; `lib-core` consumes
`lib-utils`; …). The questions agents must answer there are inherently
cross-repo:

- "If I change this function in `lib-core`, what breaks?" (reverse dependency)
- "Implement feature X" — which spans an API change in `lib-core` **and** call-site
  updates in `product-a` and `product-b`.
- "Why is `product-a` on an old version of `lib-core`?" (version drift across repos)
- "Where is auth handled across the suite?" (cross-repo search)

The hard constraint is **efficiency**: a suite is large. You cannot read it all.
A senior engineer doesn't — they carry a *mental model* and navigate by it. Our
job is to give agents that same model cheaply, in tokens, and keep it fresh.

---

## How a senior dev / architect actually works in a suite

Worth being explicit, because the design falls out of it. A senior person:

1. **Builds a map once, not per-task.** They know the repos, what each one is for,
   which are libraries vs. products, and the dependency edges between them. This
   is a small, durable artifact in their head — not a re-read of every file.
2. **Navigates by structure, not by scanning.** "Auth lives in `lib-core/auth`,
   `product-a` calls it via `@core/auth`." They jump to the symbol; they don't
   grep the universe.
3. **Reasons about edges before code.** Before touching `lib-core` they ask "who
   consumes this?" and look at the dependency graph, not the files.
4. **Reads tightly.** When they finally open a file, it's *the* file, with a
   reason. They don't open the directory.
5. **Writes the map down for the next person** — READMEs, ADRs, an `AGENTS.md`.

So the design goal is four cheap primitives that reproduce this: a **map of the
suite** (registry), a **map inside each repo** (per-repo guide + structure), the
**edges between repos** (dependency graph), and **scoped recall** (repo-aware
RAG) so search is targeted, not global. Each is built to spend tokens like the
senior dev does — a little, deliberately.

---

## Current state (what exists today)

Octipus is architected around a **single working root per session**. The
multi-repo support that exists is incidental, not designed.

- **No repo registry.** "Workspace" means *tenancy* (per-user data isolation),
  not a code repo — `src/db/schema/organizations.ts` `workspaces` table is
  `user_id`/`slug`/`name`. The actual repo anchor is a single optional string,
  `SessionContext.projectPath` (`src/db/schema/sessions.ts`), admin-only to set
  (`src/security/devmode.ts`) and immutable for the session's life. No array of
  roots, no stored repo entity.
- **Single-root filesystem sandbox.** `WorkspaceFS` computes exactly one `root`
  per (user, workspace) and `forAgent()` returns one instance, never a set
  (`src/security/workspace-fs.ts`). The only multi-directory knob is
  `config.workspace.additionalPaths` — a flat global allow-list of prefixes with
  no identity/metadata (`src/config/schema.ts`).
- **RAG has no repo dimension.** `embeddings` is scoped by `user_id`,
  `workspace_id`, `purpose` — **no `repo_id`/`project_id`** (`src/db/schema/embeddings.ts`).
  Two repos indexed by one user land in one corpus, distinguishable only by
  parsing `metadata.filePath`. `hybridSearch` (RRF over BM25 + vector) has no
  repo filter (`src/core/rag/embeddings.ts`). You cannot scope a query to one
  repo, span a chosen subset, or tell which repo a hit came from.
- **No cross-repo dependency graph.** Nothing parses package manifests or import
  edges. The orchestrator's only suite-awareness is a flat name list: it
  `readdirSync`s the workspace root and lists ≤30 sibling dirs
  (`src/core/orchestrator/service.ts`). Zero edges.
- **No repo map for agents.** No AST/ctags/symbol index/file-tree is generated
  or injected. The coding role is explicitly told *not* to do broad recon
  (`roles/coding/prompt.md`). Per session, the agent rediscovers structure.

Honest summary: an agent *can* touch any repo if handed an absolute path (git,
shell, fs tools are path-parameterized), and sibling repos under one root are
tolerated — but the four primitives that make suite work efficient (registry,
repo-scoped RAG, dependency graph, repo map) **do not exist**.

---

## Proposed architecture

Four primitives, ordered by leverage. Each is independently shippable and each
directly serves token efficiency.

### 1. Repo registry — a first-class repo entity

Replace the single `projectPath` string with a stored set of repos.

- **New table `workspace_repos`**: `id`, `workspace_id`, `name`, `root_path`,
  `remote_url`, `default_branch`, `kind` (`product` | `library` | `infra` |
  `app`), `languages` (jsonb), `manifests` (jsonb: detected `package.json`,
  `Cargo.toml`, `go.mod`, …), `last_indexed_at`, `agents_md_present` (bool).
- **Registration**: extend the existing `/workspace/repositories` enumeration
  (`src/api/routes/workspace.ts`, today a `readdirSync` + `.git` check) into a
  proper scan that *upserts* registry rows: detect markers, language, manifests,
  remote. Also allow explicit add (point at an external path, like a richer
  `additionalPaths`).
- **Session binding**: `SessionContext` gains `repoIds: string[]` (or
  `activeRepoId` + `availableRepoIds`) alongside the legacy `projectPath`, so a
  session can be bound to a *suite*, not one path. Keep `projectPath` working as
  a single-repo shorthand.

Why it matters: this is the senior dev's "I know the repos" — a small, queryable
fact the orchestrator injects instead of `readdirSync`-ing live every turn.

### 2. Repo-scoped RAG — `repo_id` on embeddings

Add a `repo_id` column (nullable, FK → `workspace_repos`) to `embeddings`, set at
index time. Then:

- `hybridSearch`/`ftsSearch`/`search` take an optional `repoIds?: string[]`
  filter → search **one** repo, a **subset**, or (omit) **span** the suite.
- Every hit carries its `repo_id` so the agent (and the UI) knows the source repo
  without path-parsing.
- The auto-indexer keys chunks by `(repo_id, file_path)` so re-index is per-repo
  and incremental.

This turns "search the world" into "search `lib-core`" or "search `lib-core` +
`product-a`" — the single biggest token win, because irrelevant repos never
enter context.

### 3. Cross-repo dependency graph

Build edges between registry entries from two cheap sources:

- **Manifest edges** (fast, exact): parse `package.json` deps, `Cargo.toml`,
  `go.mod`, `pyproject.toml`, etc. Map declared deps to registry repos by
  name/remote → "`product-a` → `lib-core@^2.1`". Captures version drift for free.
- **Import edges** (optional, deeper): a lightweight import scan (tree-sitter /
  regex per language) resolving cross-repo imports to symbols. Gated behind an
  on-demand "deep map" so it's not paid every session.

Store as `repo_edges(from_repo, to_repo, kind, version_constraint, evidence)`.
Expose a `repo_graph` tool: `dependents_of(repo)`, `dependencies_of(repo)`,
`path_between(a, b)`. This is "who consumes this?" answered in one tool call
instead of grepping N repos.

### 4. Per-repo `AGENTS.md` + structural repo map  *(Phase 0 — partly shipped)*

Each repo carries a curated **`AGENTS.md`** at its root (the universal
[agents.md](https://agents.md) convention — see the project-summary → AGENTS.md
migration in the same change as this note). Agents read it on entering a repo and
maintain it deliberately. **This is already wired** (see "What shipped" below).

To complement the *curated* guide with a *generated* one, add an optional
**repo map**: a compact, auto-generated structural digest per repo — top-level
dirs with one-line roles, entry points, exported public symbols (from
manifests + a tree-sitter outline), and the build/test/lint commands. Cache it
keyed by repo + commit; regenerate on drift. Inject the map (not the files) when
an agent enters a repo. This is the "mental model" made cheap: a few hundred
tokens that replace thousands of recon reads.

### 5. Orchestrator navigation & cross-repo fan-out

With the above, the orchestrator can:

- Inject the **registry + edges** (not a live `readdirSync`) as suite context:
  repos, kinds, and "`lib-core` is consumed by `product-a`, `product-b`".
- **Route** a task to the right repo(s) by name/registry, passing absolute paths
  and telling the worker to read that repo's `AGENTS.md`/map first (already done
  for the AGENTS.md hint — see service.ts change below).
- **Fan out** a cross-repo change: spawn a worker per affected repo (one per
  `dependents_of(changed_repo)`), each scoped to its repo, with a typed
  contract — fits the existing swarm model (`src/core/swarm/`). Worktree
  isolation per repo avoids write conflicts.

### 6. UX & observability

The user must see what's happening across repos:

- **Settings → Repositories**: the registry — list, kind, languages, last
  indexed, dependency edges (a small graph view), add/remove.
- **In-chat repo attribution**: each worker badge shows which repo it's in;
  search results show source repo; cross-repo tasks render as a per-repo
  checklist.
- **Drift surfacing**: "`product-a` uses `lib-core@2.1`, latest is `2.4`" from
  the manifest edges, shown proactively.

---

## Token-efficiency principles (the whole point)

1. **Map before files.** Inject registry + repo map + edges (hundreds of tokens),
   never directory dumps. The agent reads a file only with a reason.
2. **Scope, don't span by default.** RAG and tools default to the active repo;
   spanning the suite is an explicit, justified choice.
3. **Cache the durable, recompute the volatile.** Repo map + dependency graph are
   cached per commit; only changed repos re-index. No re-derivation per session.
4. **One curated guide per repo, read by everyone.** `AGENTS.md` is shared across
   Octipus *and* other agent tools (Codex/Cursor/Vibe), so the curation cost is
   paid once and amortized everywhere.
5. **Edges answer "what breaks" in one call** — replacing an N-repo grep with a
   `repo_graph.dependents_of()` lookup.

---

## What shipped

**Phase 0 — per-repo `AGENTS.md` awareness** (with the AGENTS.md migration):
- Per-repo `AGENTS.md` is the curated guide (`src/core/orchestrator/agents-md.ts`),
  replacing the dev-mode-only `.octipus/project-summary.md` auto-log.
- Workers are instructed to read each repo's `AGENTS.md` on entry.

**Phases 1, 3, 4, 5 (foundational slice)** — the registry backbone:
- **Repo registry** (#1): `workspace_repos` table (`src/db/schema/workspace-repos.ts`,
  migration `0072`), `RepoRegistryRepository`, and a scanner
  (`src/core/repos/scanner.ts`) that walks the workspace roots, detects
  manifests/languages/git remote/`AGENTS.md`, and upserts. `SessionContext` gains
  an optional `repoIds`.
- **Manifest dependency graph** (#3): `src/core/repos/manifests.ts` parses
  package.json / Cargo.toml / go.mod / pyproject.toml; `src/core/repos/graph.ts`
  derives consumer→provider edges by matching declared deps to other repos'
  published `packageName`. No second table — edges are computed over the rows.
- **Generated repo map** (#4, basic): the scanner builds a compact structural
  digest (top-level dirs, entry points, build/test/lint commands) stored on the
  row. (Tree-sitter symbol outline is the deeper follow-up.)
- **`repo_registry` agent tool** (#5): `src/tools/repo-registry/` —
  `list_repos`, `get_repo`, `repo_dependents`, `repo_dependencies`, `scan_repos`;
  allowlisted to architecture/coding/review/research roles.
- **Orchestrator suite injection** (#5): when the registry is populated,
  `service.ts` injects the suite map (repos, kinds, dependency edges) and routes
  workers by absolute path + AGENTS.md, instead of a bare directory listing.
- **API**: `GET /workspace/repos`, `POST /workspace/repos/scan`,
  `GET/DELETE /workspace/repos/:id`.

## Remaining

| Phase | Item | Effort | Depends on |
|---|---|---|---|
| 2 | Repo-scoped RAG (`embeddings.repo_id` + scoped/multi-repo search) | ~2-3 days | done #1 |
| 4+ | Deeper repo map (tree-sitter symbol outline + commit-keyed cache) | ~3-4 days | done #1 |
| 5+ | Cross-repo fan-out (worker per affected repo, worktree isolation) | ~3-4 days | done #1,#3 |
| 6 | UX (Settings → Repositories, in-chat attribution, version-drift) | ~1 week | done #1,#3 |

Repo-scoped RAG is the highest-value next step: add `repo_id` to `embeddings`
and thread a `repoIds` filter through `hybridSearch` so search targets or spans
chosen repos instead of one undifferentiated per-user corpus.

---

## Open questions

1. Registry scope — per **workspace** (tenancy) or a new **suite** entity
   grouping repos across workspaces? (Lean: per workspace; add `suite` later.)
2. `additionalPaths` — fold into the registry as explicitly-added repos, or keep
   as a separate global allow-list? (Lean: registry rows supersede it.)
3. Import-edge depth — ship manifest edges only first; gate the tree-sitter
   import scan behind an on-demand "deep map"? (Lean: yes.)
4. Worktree isolation for cross-repo fan-out — default on per repo, or only when
   writes are expected? (Lean: on for write tasks, per `src/core/swarm/`.)
5. Repo-map staleness — regenerate on commit hash change, on a timer, or lazily
   on entry? (Lean: on-entry-if-stale, keyed by commit.)
