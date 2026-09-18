For supported runtime requirements and the complete user setup, see [Installation](docs/INSTALLATION.md).

# Contributing to Octipus

> **Note.** Parts of this doc were drafted fast to get the public release out the door. If you have the time and taste to rewrite any of it more cleanly, a PR that improves the writing is as welcome as one that fixes a bug.

Thanks for even considering it. Octipus is opinionated, moves fast, and every external eye makes it better. This document covers setup, repo layout, and rules of engagement for pull requests.

If anything in here is wrong, unclear, or out of date, that is itself a bug — open an issue.

---

## Before you start

- **Read [DESIGN.md](./DESIGN.md).** Design principles are not decoration. Every PR runs through them. If a change fights one, it gets reshaped or dropped.
- **Check the [roadmap](./ROADMAP.md) and open issues.** Someone may already be working on it. Ask first for large changes.
- **Small changes: open a PR.** Typos, doc fixes, obvious bugs, missing error messages. Go.
- **Medium / large changes: open an issue first.** Describe what and why. Wait for a thumbs up. Protects your time — no one likes closing a 500-line PR because the approach doesn't fit.

---

## Getting set up

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 24 — the whole stack: backend, scripts, tests,
  TUI and the web build. (Bun was the backend runtime until the 2026-08-23
  rebuild; it is gone from the image, the CI, the installer and the launcher.)
- _Desktop app only:_ [Rust](https://rustup.rs) + Tauri system libs — installed
  for you by `scripts/install-desktop-deps.sh` (see below)

### Clone and run

```bash
git clone https://github.com/PatriceA/octipus.git
cd octipus

npm ci
cd web && npm ci && cd ..
# Optional, only when changing the standalone MCP server:
cd mcp-server && npm ci && cd ..

npm run setup          # Interactive wizard — "Embedded" mode for zero-deps
bin/octi start web
```

Open http://localhost:3007. If anything crashes or refuses to start, that is a bug — file it.

Working on the **desktop app** (`octi desktop`)? Install its extra deps once —
the Rust toolchain plus Tauri's per-distro system libraries — with:

```bash
scripts/install-desktop-deps.sh    # Arch, Debian/Ubuntu, Fedora, openSUSE, macOS
```

### Useful commands

```bash
npm run dev            # Backend with hot reload (tsx watch)
npm run dev --prefix web  # Frontend (Vite + React Router)
npm run typecheck      # TS strict check (backend)
npm test               # Vitest (backend)
npm run eval           # Agent evaluation harness
npm run lint           # Biome
```

---

## Repo layout

```
octipus/
├── src/
│   ├── api/                  # Hono REST routes
│   ├── channels/             # telegram, slack, whatsapp, teams, webchat
│   ├── core/
│   │   ├── gateway/          # WebSocket entry + command registry
│   │   ├── agent/            # Root turn, roles, pipelines, meta-tools
│   │   ├── agent-manager.ts  # Worker lifecycle
│   │   └── rag/              # Auto-indexer, hybrid search
│   ├── db/                   # Drizzle schema, repositories, migrations
│   ├── mcp/                  # MCP client bridge (external servers)
│   ├── models/               # Provider clients, model registry, conformance
│   └── tui-pi/               # Terminal chat (pi-tui); editor in tui-editor/
├── mcp-server/               # Standalone MCP server
├── web/                      # Vite + React Router dashboard (chat, agents, eval, profiles)
├── docs/                     # Architecture + API docs
├── eval/                     # YAML test scenarios
├── DESIGN.md                 # Design principles
├── ROADMAP.md                # Directions
└── bin/octi                  # CLI entry point
```

Never duplicate config between backend and web. Shared definitions live in `src/shared/` and their owning backend modules; import, don't copy-paste.

---

## How to add a role

Octipus roles follow a **node-folder pattern** inspired by [Weft](https://github.com/WeaveMindAI/weft). One folder per role under `src/core/agent/roles/<name>/` with two or three files:

- `config.ts` — role metadata (role identity, tool allowlist via `toolIds`, and default topic)
- `prompt.md` — system prompt (markdown, bundled at build time)
- `prompt.lite.md` — optional compact system prompt for low-context-window models

Register the folder in `src/core/agent/roles/index.ts` — three static
import lines plus one row in the list. It used to be a runtime directory scan,
which returned an empty registry in the bundled artifact (`import.meta.url`
resolves inside `dist/`); static imports are what a bundler can see, and a
missing role is now a compile error instead of a role that silently vanishes in
production.

Before opening the PR:

- [ ] Role works end-to-end: user message → the root agent delegates to it via `spawn_child` → worker spawned → reply
- [ ] System prompt has a clear one-line description and deliverable template
- [ ] Tool allowlist is minimal (principle of least privilege)
- [ ] Classifier keywords added to `src/core/agent/classifier.ts` if the role has a distinct topic
- [ ] `npm run typecheck`, `npm test`, `npm run eval` all pass

### Role design rules

These come from [DESIGN.md](./DESIGN.md) — do not skip them.

- **Focused specialists.** Add a role for a distinct responsibility. The general root role covers broader work.
- **Tool allowlist is minimal.** A role should only have the tools it actually needs. No wildcarding.
- **Explicit deliverable.** Describe the expected output and how it will be verified. Prompt instructions are not runtime output-schema validation.
- **Fail loud.** No silent fallbacks. If a tool fails, surface the error to the user.

---

## How to add a skill

Skills inject domain knowledge into a role's system prompt. There are two types:

**System skills** (DB-backed, with embeddings):
- Seeded in `src/db/seed-skills.ts`
- Managed via the web UI at Skills (`/skills`)

**Filesystem skills** (agentskills.io spec):
- Create a `SKILL.md` (or flat `*.md`) file in one of these locations:
  - `.octipus/skills/` (project-level)
  - `~/.octipus/agent/skills/` (user-level)
  - `~/.claude/skills/` (Claude Code convention)
  - `.agents/skills/` or `~/.agents/skills/` (agents.io spec)
  - Any custom directory in `skills.externalDirectories` config
- Auto-discovered by `src/skills/external-loader.ts` at startup
- No registration needed; external skills get synthetic IDs prefixed `external:`

---

## How to add an MCP tool

The MCP server lives in `mcp-server/`. Each tool is one file in `mcp-server/src/tools/<tool>.ts` with:

- A Zod schema for input
- A handler function
- A `server.tool()` registration call

The server's `inventory` auto-discovers all tool modules at startup.

---

## Commit, branch, PR

- **Branch naming:** `fix/short-desc`, `feat/short-desc`, `docs/short-desc`, `refactor/short-desc`. One branch per logical change.
- **Commit messages:** short summary line 1 (imperative — "fix classifier crash" not "fixed"), blank line, body explaining the *why*.
- **One thing per PR.** A refactor and a feature in the same PR is two PRs.
- **Link the issue.** `Closes #123` in the PR body if applicable.
- **No AI-generated slop.** If an AI wrote your PR, read it yourself first. Unreviewed AI output wastes reviewer time.

### PR checklist

- [ ] Code compiles and all tests pass locally
- [ ] New code has tests
- [ ] Public functions/types have one-line docs where useful (no essays)
- [ ] No unrelated formatting churn
- [ ] No commented-out code
- [ ] No `TODO` / `FIXME` without a linked issue
- [ ] No secrets in commits (scan with `git diff --cached` before pushing)

---

## Cutting a release

A release is a `v*` tag. `.github/workflows/release.yml` does the rest: it runs
the gate (typecheck, lint, the backend suite, and the MCP server's own suite),
creates the GitHub Release with notes pulled from `CHANGELOG.md`, attaches the
packed `mcp-server` tarball, and publishes that package to npm when `NPM_TOKEN`
is configured.

Three things happen *before* the tag, in this order:

1. **Write the notes.** Add a `## v<x.y> — <title> (<date>)` section at the top
   of `CHANGELOG.md`. `scripts/changelog-extract.ts` publishes the first `##`
   section whose heading contains the version — and falls back to `##
   Unreleased` when none does, which is how v0.4 shipped 1,175 lines of
   accumulated history as its release notes. A section that names the version is
   what stops that.
2. **Bump the version.** One command rewrites all six files that declare it:

   ```sh
   npx tsx scripts/sync-version.ts v0.5
   npm install --package-lock-only          # and the same in mcp-server/ and web/
   (cd web/src-tauri && cargo update -p octipus)
   ```

   The release gate fails if the committed version does not match the tag. It
   rewrites the runner's copy so the published artifact is right, but it has
   never written back to the repository — which is why the committed version sat
   at `0.1.0` through four releases while nothing complained.
3. **Commit, push, and let CI go green on `main`.** The tag's gate is a subset
   of what `main` runs; the integration suite and the web E2E job are not in it.

Then:

```sh
git tag -a v0.5 -m "v0.5 — <title>"
git push origin v0.5
```

To re-run a release for an existing tag without moving it — a workflow fix, a
token that was missing the first time — use the `workflow_dispatch` input rather
than deleting and re-pushing the tag.

Two suites are **not** in `npm test` and are the ones that break after a
refactor lands:

```sh
npm run test:integration        # DB-backed; brings up Postgres and tears it down
(cd mcp-server && npm test)     # the published package's own suite
```

---

## Lint policy

`npm run lint` (Biome) is the gate. The advisory rules deliberately disabled:

- **`noExplicitAny`** — off in lint, but **no new `any` casts** in PRs (review enforced). Existing `any`s are tracked technical debt; clean as you touch.
- **`noEmptyBlockStatements`** — off; we have a stricter manual policy from `DESIGN.md` ("fail loud — log every catch").
- **`useAwait`** — off; abstract base methods are marked `async` for subclass uniformity.

Active rules that must pass:

- `noUnusedVariables`, `noUnusedImports` (warn) — auto-fixable with `npm run lint:fix`.
- `noUselessCatch` (error).
- `useConst`, `useImportType` (style hygiene).

If you disagree with any of these, open an issue — don't silently re-enable.

## What not to do

- Do not bypass the permission system with a "quick fix". Fail loud, surface the ask.
- Do not add libraries for things doable in 20 lines.
- Do not add silent fallbacks. If the world is broken, say so.
- Do not duplicate types between backend and web. Import shared definitions.
- Do not add feature flags for work you plan to finish next week — ship it or don't.
- Do not check in `.env`, credentials, or private tokens. Ever.

---

## Database access pattern

**Default: use a repository.** Shared domain queries belong in a typed class in
`src/db/repositories/`. Some services and API routes currently use `getDb()`
directly for local, cross-table, or performance-sensitive queries. Treat those
as existing design choices rather than a closed allowlist. Before adding another
direct query, check whether a repository already owns the table and explain why
the query should remain with its caller.

---

## Getting help

- **GitHub Issues:** bugs and concrete feature requests
- **GitHub Discussions:** longer-form proposals and design conversations
- **Security:** see [SECURITY.md](./SECURITY.md) — do not file security issues publicly

---

## Ground rules

This project runs on **constructive confrontation**. A 30-minute argument that ends in alignment beats three weeks of polite avoidance that ends in a shipped mess. Not a "nice" culture — a **respectful** one. Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

Thanks for showing up. The project is better because you did.
