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

The registry derives **direct dependency edges from manifests**. These help
agents identify declared consumers before making a change. They do not capture
HTTP APIs, shared databases, runtime configuration, or every import relationship.

Native navigation does **not require CocoIndex Code or an embedding model**.
Repo maps and symbol definitions are stored in the registry; optional semantic
code search through MCP complements them. Maps and symbols are scan-time
snapshots, so rescan after changing source files or manifests.

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

The scanner detects repos by a `.git` directory/worktree file or a project marker
(`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pubspec.yaml`, `pom.xml`, `build.gradle`, `build.gradle.kts`), parses supported manifests
for the package name + dependencies, reads the git remote/branch, and upserts a
registry row. Re-scanning refreshes rows in place.

## How agents use it

The General/root role and code-oriented roles (architecture, coding, review, research) get the
`repo_registry` tool:

| Tool | Purpose |
|---|---|
| `list_repos` | The map of the suite — call first to learn what exists. |
| `get_repo` | One repo's structural digest, a symbol outline (the busiest files and what they define) + its dependency neighbours. |
| `find_symbol` | Where a function, class, type, struct, trait or method (`Owner.method`) is defined — file and line — from the index built at scan time. |
| `repo_dependents` | Repos that depend on a given repo (impact of a change). |
| `repo_dependencies` | In-suite repos a given repo depends on. |
| `scan_repos` | Refresh the registry. |

When the registry is populated, the root agent injects the suite map (repos,
kinds, and dependency edges) into its own context and receives guidance to route workers by absolute repository path and consult
`AGENTS.md`. For cross-repo changes it is instructed to check declared dependents
and name affected repositories in worker tasks. These are agent instructions,
not a guarantee that every runtime connection will be discovered.

## Language coverage

Agents can read, search and edit source files beyond this table. This table
specifically describes native manifest parsing and symbol indexing.

| Language/ecosystem | Package/dependency manifests | Native symbols |
|---|---|---|
| JavaScript / TypeScript | `package.json` | JS, JSX, TS, TSX |
| Python | `pyproject.toml` | Yes |
| Go | `go.mod` | Yes |
| Rust | `Cargo.toml` | Yes |
| Dart / Flutter | `pubspec.yaml` | No; use text search |
| Java | `pom.xml`, `build.gradle`, `build.gradle.kts` | Yes |

Project markers such as `Gemfile`, `composer.json`, `requirements.txt` and
`setup.py` can identify repositories without providing native dependency parsing.
Manifest and companion settings reads are capped at 400,000 bytes per file.

## Java repositories

Java has native repository discovery, package/dependency matching and symbol
indexing. No CocoIndex connector is needed for these capabilities.

- **Maven:** `pom.xml` supplies a `groupId:artifactId` package identity and direct
  project dependencies. Local property references and the declared parent group
  are handled. Maven dependency management, plugins and inactive profiles are
  not treated as direct dependencies.
- **Gradle:** `build.gradle` and `build.gradle.kts` supply statically readable
  dependency declarations in common configurations (`implementation`, `api`,
  `testImplementation`, and similar). Arbitrarily named custom configurations
  are not inferred. Package identity uses the declared group and project
  name from local settings, with the directory name as the default project name.
- **Navigation:** `.java` files use the existing Java grammar for definition
  lookup, including records, constructors, annotations, enums and nested types.
  Compiler-generated members are not synthesized. Repository maps include Java
  source/test directories and Maven/Gradle
  build/test commands, preferring checked-in wrappers.

Scanning reads configuration; it does not run Maven, Gradle, plugins or build
scripts. Generated configuration, external parent POMs, conditional dependencies,
Gradle convention plugins/version catalogs and complete multi-module resolution
are outside this static parser. Dependency-analysis notes in repository maps
make these limits visible to agents. Build commands still require a suitable JDK
and Maven/Gradle (or project wrappers) in the execution environment.

The declaration formats follow the [Maven POM reference](https://maven.apache.org/pom.html)
and [Gradle dependency documentation](https://docs.gradle.org/current/userguide/declaring_dependencies_basics.html).

## Repo-scoped knowledge base

When embeddings are available, scanning a repo also indexes its **generated** content — the repo-map digest and
curated `AGENTS.md` — into the knowledge base tagged with the repo's id. Agents
can then scope a knowledge search to one repo or a subset:
`search_knowledge(query, repos: "core, web")`. **Raw source code is never
indexed into the general knowledge base**. Dedicated external code-search
indexes can be connected through MCP; they remain separate from document
retrieval. Code can also be navigated via the tools above and read on demand.
Full details, including the enforcement points,
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
  analysis. The symbol index (`workspace_repos.symbol_index`, built with
  tree-sitter at scan time for TypeScript/TSX/JS, Python, Go, Rust and Java)
  knows what each file defines, not what it imports; a scan rebuilds it
  whole. Bounded at 2,500 source files, 400,000 bytes per file, 100,000 candidate
  entries and 20,000 symbols per repo.
- **Git is required for symbol file enumeration**, including manifest-only
  projects. Git ignore rules apply; symlink files and directories are skipped.
  Missing Git, parse failures, unsupported extensions and limits are reported
  in index diagnostics. Unsupported extensions may include documentation;
  an empty or partial index does not prove a symbol is absent. Flutter manifests
  are supported, but Dart symbol extraction is not currently supported.
- **Duplicate names need an ID or absolute path.** If multiple repositories
  publish the same package, ambiguous dependency edges are omitted and reported
  in `ambiguousPackages`; the registry does not guess the intended provider.
- **Registry ownership is per user.** Discovery uses that user's workspace root
  plus operator-configured additional paths, which may be shared between users.
  Overlapping roots are deduplicated. Removed or no-longer-exposed repositories
  are hidden from registry reads; stored snapshots remain until deleted. Deregistering a repository also deletes
  its associated knowledge embeddings.
- **One package identity per repository.** Multi-manifest repositories are
  summarized, but this is not a full monorepo package/workspace graph.
- **No cross-repo fan-out yet** — a change spanning several repos is coordinated
  by the root agent routing workers per repo, not by automatic parallel
  worktrees.

See [`.octipus/multi-repo-design.md`](../.octipus/multi-repo-design.md) for the
full plan.
