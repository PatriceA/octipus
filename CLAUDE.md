# CLAUDE.md

Guidance for AI coding agents (Claude Code, Cursor, etc.) working in this repo.
This file is committed so it travels with the codebase — no per-machine setup.

> Read [DESIGN.md](./DESIGN.md) and [CONTRIBUTING.md](./CONTRIBUTING.md) before
> making non-trivial changes. The principles in those documents override
> anything ambiguous here.

---

## What this repo is

**Octipus** — an open-source, self-hosted AI platform. An orchestrator routes
user messages to a swarm of specialist agents (3-level: Orchestrator → Agent →
Subagent) that use typed tools, skills, and experts. Multi-channel
(Telegram / Slack / Teams / WhatsApp / Web / TUI / Voice / MCP), multi-provider
(Ollama, OpenAI, Anthropic, Gemini, OpenRouter, …), Postgres + pgvector backed
with a PGlite embedded mode.

Architecture in one line:
`Channels → Gateway (WS) → Orchestrator → Agents → Tools/Skills/Experts → Models → DB`

## Stack

- **Runtime:** Bun ≥ 1.1 end-to-end (tests, scripts, server). Node ≥ 18 only
  for the Next.js web UI.
- **Backend:** Elysia (HTTP + WS), Drizzle ORM, Postgres + pgvector (PGlite in
  embedded mode), Valkey (Redis-compatible) via `ioredis`.
- **Web:** Next.js 14 + React 18 + Tailwind in `web/`.
- **Validation:** Zod everywhere at boundaries.
- **Lint/format:** Biome (`bun run lint`). Formatter is **off** — don't
  reformat untouched code.
- **TS:** strict mode, `noImplicitOverride`. Path aliases: `@/`, `@db/`,
  `@core/`, `@models/`, `@security/`, `@skills/`, `@channels/`, `@api/`,
  `@utils/`. Use them instead of long relative paths.

## Repo layout

```
src/
  api/            REST routes + WS (Elysia)
  channels/       Telegram, Slack, Teams, WhatsApp, WebChat
  config/         Zod-validated config, hot-reload
  core/
    gateway/      WS entry, command registry
    orchestrator/ classifier, router, roles, pipelines, meta-tools
    swarm/        spawn_child, budgets, cancel, error mapping
    rag/          auto-indexer, hybrid search (BM25 + vector)
    errors/       FailoverReason / RecoveryAction / classifyError
    agent-worker.ts, cli-agent-worker.ts, tool-executor.ts
  db/             Drizzle schema, repositories, migrations, seeds
  mcp/            external MCP client bridge
  models/         provider clients, ModelRegistry, conformance
  security/       auth (JWT/passkeys/TOTP), vault (AES-256-GCM), permissions
  skills/         domain knowledge registry
  tools/          built-in tools (fs, shell, git, browser, docs, etc.)
mcp-server/       standalone MCP server (59+ tools)
web/              Next.js dashboard
eval/             YAML eval scenarios
scripts/          migrate, setup, backup, e2e, integration
docs/             feature & architecture docs
.octipus/         design notes (swarm-design, audits, project-summary)
```

## Commands (Bun)

| Task             | Command                          |
| ---------------- | -------------------------------- |
| Install          | `bun install && cd web && bun install && cd ../mcp-server && bun install && cd ..` |
| Dev (backend)    | `bun run dev`                    |
| Start full stack | `bin/octi start` (stop: `bin/octi stop`) |
| Type check       | `bun run typecheck`              |
| Lint             | `bun run lint` (fix: `bun run lint:fix`) |
| Unit tests       | `bun test`                       |
| E2E (API/WS)     | `bun run test:e2e`               |
| Web E2E          | `bun run test:web`               |
| Eval suite       | `bun run eval`                   |
| DB migrate       | `bun run db:migrate`             |
| DB generate      | `bun run db:generate`            |
| Setup wizard     | `bun run setup`                  |

Default ports: backend `3005`, web `3007`. Use `bin/octi` rather than raw
`bun run` when starting the full stack so channels, web, and workers come up
together.

## House rules (must follow)

These come from `DESIGN.md`. They are not negotiable on a normal PR — if you
think you need to break one, open an issue first.

1. **Fail loud.** No silent fallbacks. If a tool errors, surface it. No
   `try { … } catch { /* swallow */ }`. If you must catch, log the reason.
2. **No hardcoded models.** Never write `model: 'gpt-4o'` in source. Bind to
   a topic and resolve via `ModelRegistry.getModelForTopic(role)`. Unbound
   topic ⇒ throw at spawn time (fail-loud). Default fallback applies ONLY
   to the orchestrator, never to worker topics.
3. **One job per role.** A role branching on flags to do five things is five
   roles. Tool allowlists are minimal — no wildcards.
4. **Typed contracts at handoffs.** Every role has an input shape and a
   typed deliverable. Pipeline stages: stage N output = stage N+1 input.
5. **Channels are adapters.** New per-channel logic that can't go through
   the gateway is wrong — fix the gateway. Available channels: Telegram,
   Slack, Teams, WhatsApp, WebChat, TUI, Voice, MCP. NO Discord.
6. **Don't edit the `SECURITY_PREAMBLE`** without an issue and an argument.
7. **No duplicated types** between `src/` and `web/`. Import shared
   definitions; don't copy-paste.
8. **No `any` in new code.** Existing `any`s are tech debt — clean as you
   touch, don't add more. (`noExplicitAny` is off in lint but enforced in
   review.)
9. **No feature flags** for work you'll finish next week. Ship it or don't.
10. **No `.env` / secrets in commits.** Ever. `git diff --cached` before push.

## Workflow expectations

- **Branches:** `fix/...`, `feat/...`, `docs/...`, `refactor/...`. One logical
  change per branch.
- **Commits:** imperative summary (`fix classifier crash`, not `fixed`), blank
  line, body explaining the *why*.
- **One thing per PR.** Refactor + feature in the same PR = two PRs.
- **Tests:** new code needs tests. Routing / prompt / tool-selection changes
  must pass `bun run eval`.
- **Before declaring done:** `bun run typecheck && bun run lint && bun test`
  all green locally. For UI changes, exercise the feature in a browser — type
  checks don't catch broken UX.
- **Don't reformat** files you aren't otherwise touching. Biome's formatter is
  off on purpose.

## Adding things (cheat sheet)

- **Role** → `src/core/orchestrator/roles/<name>/{config.ts,prompt.md,tools.ts}`.
  Auto-discovered via folder scan; no manual registration. Add classifier keywords
  in `src/core/orchestrator/classifier.ts` if it has a distinct topic.
- **Skill** → `src/core/skills/<name>/{skill.json,knowledge.md}`. Auto-loaded.
- **Tool (built-in)** → `src/tools/<name>/index.ts` extending `BaseTool`.
  Auto-discovered via `discovery.ts`; no need to register in `src/tools/index.ts`.
- **MCP tool** → `mcp-server/src/tools/<group>/<tool>.ts` with Zod schema +
  handler + `register` call. Inventory auto-discovers.
- **Channel** → `src/channels/<name>/`. Must speak the gateway protocol; no
  channel-specific orchestrator hooks.
- **Expert / Profile** → seed in `src/db/seed-experts.ts` or POST via API.
- **DB schema change** → edit Drizzle schema, then `bun run db:generate` to
  produce a migration, then `bun run db:migrate`.

## Things to avoid

- Adding a dependency for something doable in ~20 lines.
- Catch blocks without logging.
- New `// TODO` / `// FIXME` without a linked issue number.
- Commented-out code (delete it — git remembers).
- Silent error coercion at boundaries; reject malformed input with a specific
  message.
- Bypassing the permission system "just for now". Fail loud, surface the ask.

## Where to look first

| Question                              | File / dir                                |
| ------------------------------------- | ----------------------------------------- |
| How does a message become a worker?   | `src/core/orchestrator/`, `src/core/router.ts` |
| Swarm semantics, budgets, cancel      | `src/core/swarm/`, `.octipus/swarm-design.md` |
| Model routing & failover              | `src/models/`, `src/core/errors/classification.ts` |
| Permission model                      | `src/security/`, `src/core/tool-executor.ts` |
| DB schema                             | `src/db/schema/`                          |
| WS protocol                           | `src/core/gateway/`, `src/api/websocket.ts` |
| Architecture deep dive                | `docs/AGENT-ARCHITECTURE.md`              |
| Full docs index                       | `README.md` → Documentation table         |

## When in doubt

1. Search `docs/` for an existing doc on the area.
2. Check `.octipus/` for design notes and audits.
3. Look at a sibling implementation (existing role, tool, channel) and follow
   the same shape.
4. If the answer still isn't obvious, ask in the PR / issue rather than
   guessing — wrong abstractions are expensive here.
