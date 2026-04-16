# Contributing to Assistant

> **Note.** Parts of this doc were drafted fast to get the public release out the door. If you have the time and taste to rewrite any of it more cleanly, a PR that improves the writing is as welcome as one that fixes a bug.

Thanks for even considering it. Assistant is opinionated, moves fast, and every external eye makes it better. This document covers setup, repo layout, and rules of engagement for pull requests.

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

- [Bun](https://bun.sh) ≥ 1.1 — backend + scripts runtime
- [Node.js](https://nodejs.org) ≥ 18 — required by Next.js web UI

### Clone and run

```bash
git clone https://github.com/YOUR_ORG/assistant.git
cd assistant

bun install
cd web && bun install && cd ..

bun run setup          # Interactive wizard — "Embedded" mode for zero-deps
bin/assistant start
```

Open http://localhost:3017. If anything crashes or refuses to start, that is a bug — file it.

### Useful commands

```bash
bun run dev            # Backend with hot reload
bun run web            # Frontend (Next.js)
bun run typecheck      # TS strict check (backend + web)
bun test               # Bun test runner (backend)
bun run eval           # Agent evaluation harness
bun run lint           # ESLint
```

---

## Repo layout

```
assistant/
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
├── web/                      # Next.js dashboard (chat, agents, eval, profiles)
├── docs/                     # Architecture + API docs
├── eval/                     # YAML test scenarios
├── DESIGN.md                 # Design principles
├── ROADMAP.md                # Directions
└── bin/assistant             # CLI entry point
```

Never duplicate config between backend and web. Shared types live in `src/types` or a dedicated package; import, don't copy-paste.

---

## How to add a role

Assistant roles follow a **node-folder pattern** inspired by [Weft](https://github.com/WeaveMindAI/weft). One folder per role under `src/core/orchestrator/roles/<name>/` with three files:

- `config.ts` — role metadata (model preferences, tool allowlist, complexity profile)
- `prompt.md` — system prompt (markdown, hot-reloadable)
- `tools.ts` — tool bindings (which MCP tools this role can call)

The registry auto-discovers everything in `roles/*` at startup. Adding a role is three files in one folder. No other code change needed.

Before opening the PR:

- [ ] Role works end-to-end: user message → classifier routes to new role → worker spawned → reply
- [ ] System prompt has a clear one-line description and deliverable template
- [ ] Tool allowlist is minimal (principle of least privilege)
- [ ] Classifier keywords added to `src/core/orchestrator/classifier.ts` if the role has a distinct topic
- [ ] `bun run typecheck`, `bun test`, `bun run eval` all pass

### Role design rules

These come from [DESIGN.md](./DESIGN.md) — do not skip them.

- **One job per role.** If a role is doing five unrelated things based on flags, it is five roles.
- **Tool allowlist is minimal.** A role should only have the tools it actually needs. No wildcarding.
- **Typed deliverable.** Every role has a documented output shape. No "returns a string, figure it out".
- **Fail loud.** No silent fallbacks. If a tool fails, surface the error to the user.

---

## How to add a skill

Skills inject domain knowledge into a role's system prompt.

Files under `src/core/skills/<skill-name>/`:

- `skill.json` — metadata (name, version, domain, applicable roles)
- `knowledge.md` — the prompt content (injected verbatim)

Skills are auto-loaded from `src/core/skills/*`. See existing skills for shape.

---

## How to add an MCP tool

The MCP server lives in `mcp-server/`. Each tool is one file in `mcp-server/src/tools/<group>/<tool>.ts` with:

- A Zod schema for input
- A handler function
- A `register` call at module load

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

`bun run lint` (Biome) is the gate. The advisory rules deliberately disabled:

- **`noExplicitAny`** — off in lint, but **no new `any` casts** in PRs (review enforced). Existing `any`s are tracked technical debt; clean as you touch.
- **`noEmptyBlockStatements`** — off; we have a stricter manual policy from `DESIGN.md` ("fail loud — log every catch").
- **`useAwait`** — off; abstract base methods are marked `async` for subclass uniformity.

Active rules that must pass:

- `noUnusedVariables`, `noUnusedImports` (warn) — auto-fixable with `bun run lint:fix`.
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

## Getting help

- **GitHub Issues:** bugs and concrete feature requests
- **GitHub Discussions:** longer-form proposals and design conversations
- **Security:** see [SECURITY.md](./SECURITY.md) — do not file security issues publicly

---

## Ground rules

This project runs on **constructive confrontation**. A 30-minute argument that ends in alignment beats three weeks of polite avoidance that ends in a shipped mess. Not a "nice" culture — a **respectful** one. Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

Thanks for showing up. The project is better because you did.
