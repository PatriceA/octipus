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
git clone https://github.com/YOUR_ORG/octipus.git
cd octipus

npm install
cd web && npm install && cd ..

npm run setup          # Interactive wizard — "Embedded" mode for zero-deps
bin/octi start
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
│   ├── api/                  # Elysia REST routes
│   ├── channels/             # telegram, slack, whatsapp, teams, webchat
│   ├── core/
│   │   ├── gateway/          # WebSocket entry + command registry
│   │   ├── orchestrator/     # Classifier, router, roles, pipelines, meta-tools
│   │   ├── agent-manager.ts  # Worker lifecycle
│   │   └── rag/              # Auto-indexer, hybrid search
│   ├── db/                   # Drizzle schema, repositories, migrations
│   ├── mcp/                  # MCP client bridge (external servers)
│   ├── models/               # LiteLLM client, provider conformance
│   └── tui/                  # Ink terminal UI
├── mcp-server/               # Standalone MCP server (59+ tools)
├── web/                      # Vite + React Router dashboard (chat, agents, eval, profiles)
├── docs/                     # Architecture + API docs
├── eval/                     # YAML test scenarios
├── DESIGN.md                 # Design principles
├── ROADMAP.md                # Directions
└── bin/octi             # CLI entry point
```

Never duplicate config between backend and web. Shared types live in `src/types` or a dedicated package; import, don't copy-paste.

---

## How to add a role

Octipus roles follow a **node-folder pattern** inspired by [Weft](https://github.com/WeaveMindAI/weft). One folder per role under `src/core/orchestrator/roles/<name>/` with two or three files:

- `config.ts` — role metadata (model preferences, tool allowlist via `toolIds` array, complexity profile)
- `prompt.md` — system prompt (markdown, hot-reloadable)
- `prompt.lite.md` — optional compact system prompt for low-context-window models

Register the folder in `src/core/orchestrator/roles/index.ts` — three static
import lines plus one row in the list. It used to be a runtime directory scan,
which returned an empty registry in the bundled artifact (`import.meta.url`
resolves inside `dist/`); static imports are what a bundler can see, and a
missing role is now a compile error instead of a role that silently vanishes in
production.

Before opening the PR:

- [ ] Role works end-to-end: user message → the root agent delegates to it via `spawn_child` → worker spawned → reply
- [ ] System prompt has a clear one-line description and deliverable template
- [ ] Tool allowlist is minimal (principle of least privilege)
- [ ] Classifier keywords added to `src/core/orchestrator/classifier.ts` if the role has a distinct topic
- [ ] `npm run typecheck`, `npm test`, `npm run eval` all pass

### Role design rules

These come from [DESIGN.md](./DESIGN.md) — do not skip them.

- **One job per role.** If a role is doing five unrelated things based on flags, it is five roles.
- **Tool allowlist is minimal.** A role should only have the tools it actually needs. No wildcarding.
- **Typed deliverable.** Every role has a documented output shape. No "returns a string, figure it out".
- **Fail loud.** No silent fallbacks. If a tool fails, surface the error to the user.

---

## How to add a skill

Skills inject domain knowledge into a role's system prompt. There are two types:

**System skills** (DB-backed, with embeddings):
- Seeded in `src/db/seed-skills.ts`
- Managed via the web UI at Settings > Skills

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

**Default: use a repository.** Every domain table has a class in
`src/db/repositories/<name>-repository.ts`. New domain code goes
through one. The repository owns the Drizzle calls; callers see typed
methods.

**Explicitly permitted exceptions** — these files reach `getDb()`
directly and are the only ones allowed to:

- `src/core/rag/embeddings.ts` + `src/core/rag/retention-service.ts`
  (RAG is its own service with its own query patterns; a repository
  here would be a one-call wrapper per query)
- `src/core/rag/health.ts` (single probe row, no shared shape)
- `src/core/notification-service.ts` (single-table service)
- `src/core/cron-runner.ts` (touches multiple tables for scheduling;
  not a single domain)
- `src/core/gateway/commands.ts` (expert lookup inline for a
  command-router; isolated)
- `src/core/orchestrator/templates.ts` (pipeline template lookups
  inline for the orchestrator hot path)
- Migration scripts in `scripts/`

If you're tempted to add to this list, write a one-line comment
explaining why a repository wouldn't help.

---

## Getting help

- **GitHub Issues:** bugs and concrete feature requests
- **GitHub Discussions:** longer-form proposals and design conversations
- **Security:** see [SECURITY.md](./SECURITY.md) — do not file security issues publicly

---

## Ground rules

This project runs on **constructive confrontation**. A 30-minute argument that ends in alignment beats three weeks of polite avoidance that ends in a shipped mess. Not a "nice" culture — a **respectful** one. Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

Thanks for showing up. The project is better because you did.
