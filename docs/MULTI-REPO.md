# Multi-Repo Workspaces

Octipus can work across a **suite** of interconnected repositories — products
and the shared libraries they depend on — instead of a single project. This
page covers the repo registry, how agents navigate the suite, and the setup.

> Design and roadmap: [`.octipus/multi-repo-design.md`](../.octipus/multi-repo-design.md).

## Concept

A **repo registry** records each repository in your workspace as a first-class
entity: its path, kind (product / library / app / infra), languages, the
package it publishes, its manifest dependencies, whether it has a curated
[`AGENTS.md`](https://agents.md), and a compact **repo map** (top-level layout,
entry points, and build/test/lint commands).

From the dependencies of each repo, Octipus derives a **dependency graph** —
which products consume which libraries — so an agent can answer "what breaks if
I change this library?" without grepping every repo.

This is built once and navigated by, rather than rediscovered every session —
the way a senior engineer carries a mental model of the suite. It keeps token
use low: agents read a repo's map before its files, and search/edit are scoped
to the repos that matter.

## Setup

1. Put your repos under your workspace root (or add their parent paths via
   `workspace.additionalPaths` in config — see [CONFIGURATION.md](./CONFIGURATION.md)).
   Sibling repos under one root are detected automatically.
2. Scan to build the registry — either ask an agent to "scan the workspace
   repos", or call the API:

   ```bash
   curl -X POST localhost:3005/api/workspace/repos/scan -H "Authorization: Bearer $TOKEN"
   ```

3. Give each repo a curated `AGENTS.md` at its root. Agents read it on entry and
   keep it updated; the same file is honoured by other agent tools (Codex,
   Cursor, Mistral Vibe).

The scanner detects repos by a `.git` directory or a manifest
(`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`), parses that manifest
for the package name + dependencies, reads the git remote/branch, and upserts a
registry row. Re-scanning refreshes rows in place.

## How agents use it

Code-oriented roles (architecture, coding, review, research) get the
`repo_registry` tool:

| Tool | Purpose |
|---|---|
| `list_repos` | The map of the suite — call first to learn what exists. |
| `get_repo` | One repo's structural digest + its dependency neighbours. |
| `repo_dependents` | Repos that depend on a given repo (impact of a change). |
| `repo_dependencies` | In-suite repos a given repo depends on. |
| `scan_repos` | Refresh the registry. |

When the registry is populated, the orchestrator injects the suite map (repos,
kinds, and dependency edges) into its own context and routes each worker to a
repo by absolute path, telling it to read that repo's `AGENTS.md` first. For a
cross-repo change it checks `repo_dependents` on a library before editing it and
names every affected repo in the worker tasks.

## Repo-scoped knowledge base

Scanning a repo also indexes its **generated** content — the repo-map digest and
curated `AGENTS.md` — into the knowledge base tagged with the repo's id. Agents
can then scope a knowledge search to one repo or a subset:
`search_knowledge(query, repos: "core, web")`. **Raw source code is never
indexed** (it bloats retrieval and hurts quality) — code is navigated via the
tools above and read on demand. Full details, including the enforcement points,
are in [RAG.md → Repo-scoped knowledge](./RAG.md#repo-scoped-knowledge-multi-repo)
and [→ Code-exclusion policy](./RAG.md#code-exclusion-policy-raw-code-is-never-indexed).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/workspace/repos` | List registry repos + derived dependency edges. |
| POST | `/api/workspace/repos/scan` | Scan the workspace and refresh the registry. |
| GET | `/api/workspace/repos/:id` | One repo with its dependencies/dependents. |
| DELETE | `/api/workspace/repos/:id` | Remove a repo from the registry. |

## Limitations / roadmap

- **Dependency edges come from manifests** (declared deps), not yet from import
  analysis. A deeper, symbol-level repo map is planned.
- **No cross-repo fan-out yet** — a change spanning several repos is coordinated
  by the orchestrator routing workers per repo, not by automatic parallel
  worktrees.

See [`.octipus/multi-repo-design.md`](../.octipus/multi-repo-design.md) for the
full plan.
