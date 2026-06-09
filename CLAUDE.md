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
  channels/       Telegram, Slack, Teams, WhatsApp, WebChat (+ discovery, linking)
  config/         Zod-validated config, hot-reload
  core/
    gateway/      WS entry, command registry
    orchestrator/ classifier, router, roles, pipelines, meta-tools, guards
    swarm/        spawn_child, budgets, cancel, error mapping
    rag/          auto-indexer, hybrid search (BM25 + vector)
    errors/       FailoverReason / RecoveryAction / classifyError
    memory/       long-term memory; personas/ persona engine; reader/ ; research/
    artifacts/ documents/ trajectories/ work-stream/  agent output surfaces
    agent-worker.ts, cli-agent-worker.ts, tool-executor.ts, scheduler.ts
  db/             Drizzle schema, repositories, migrations, seeds (seed-*.ts)
  models/         provider clients, ModelRegistry, circuit-breaker, conformance
  security/       auth (JWT/passkeys/TOTP/SAML), vault (AES-256-GCM), permissions
  skills/         skill registry: DB-backed + filesystem (SKILL.md) discovery
  tools/          built-in tools (fs, shell, git, github, gitlab, browser,
                  docker, docs, knowledge, messaging, m365, google-workspace,
                  websearch, voice, visual, scheduling, tasks, artifacts…)
  mcp/            external MCP client bridge
  connectors/     OAuth connectors (e.g. Atlassian) + registry
  extensions/     extension API + loader (host-side plugin runtime)
  plugins/        plugin loader + plugin-as-tool wrapper
  hooks/          event hook manager (triggers, actions, suggestions)
  capabilities/   optional hardware/capability installers (hwfit)
  voice/          STT / TTS / wake-word / telephony
  visual/         screenshot capture + analysis
  tui-pi/         terminal chat client (pi-tui)
  tui-editor/     TUI code editor
  services/ shared/ setup/   org services, shared types/diff, setup probes
mcp-server/       standalone MCP server (59+ tools across ~20 groups)
web/              Next.js dashboard
browser-extension/  companion browser extension
bin/              octi launcher CLI (bin/octi start|stop)
personas/         persona YAML definitions
extensions/       installed plugins (example-plugin, github)
eval/             YAML eval scenarios
scripts/          migrate, setup, backup, doctor, e2e, integration, key rotation
docs/             feature & architecture docs (see README Documentation table)
.octipus/         design notes (swarm-design, audits, project-summary, plans)
```

## Commands (Bun)

| Task             | Command                          |
| ---------------- | -------------------------------- |
| Install          | `bun install && cd web && bun install && cd ../mcp-server && bun install && cd ..` |
| Dev (backend)    | `bun run dev`                    |
| Start full stack | `bin/octi start` (stop: `bin/octi stop`) |
| Type check       | `bun run typecheck`              |
| Lint             | `bun run lint` (fix: `bun run lint:fix`) |
| Unit tests       | `bun run test` (= `bun test src scripts`) |
| TUI tests        | `bun run test:tui`               |
| Integration      | `bun run test:integration` (Docker Postgres) |
| E2E (API/WS)     | `bun run test:e2e`               |
| Web E2E          | `bun run test:web`               |
| Eval suite       | `bun run eval` (`eval:routing`, `eval:quality`) |
| DB migrate       | `bun run db:migrate`             |
| DB generate      | `bun run db:generate`            |
| DB studio        | `bun run db:studio`              |
| Setup wizard     | `bun run setup`                  |
| TUI client       | `bun run tui` (edit: `bun run tui:edit`) |
| Doctor / preflight | `bun run scripts/doctor.ts`    |

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
- **Stacked PRs — mind the merge order.** When PR B's base is another feature
  branch A (not `main`), GitHub does **not** retarget B to `main` when A merges.
  If you merge A→`main` and then hit "merge" on B, B merges into A's (now
  orphaned) branch, **not** `main` — its content silently never lands on `main`.
  Two safe options: (a) retarget each child PR's base to `main` and merge the
  stack **bottom-up** (A, then B rebased on `main`, …); or (b) since the
  top-of-stack branch already contains the whole stack, merge `main` into it
  (so the diff is only the new work) and land that one branch into `main`.
  Either way, **verify it actually landed**: `git cat-file -e origin/main:<a
  file from each PR>` after merging. (This has bitten us more than once.)
- **Tests:** new code needs tests. Routing / prompt / tool-selection changes
  must pass `bun run eval`.
- **Before declaring done:** `bun run typecheck && bun run lint && bun test`
  all green locally. For UI changes, exercise the feature in a browser — type
  checks don't catch broken UX.
- **Don't reformat** files you aren't otherwise touching. Biome's formatter is
  off on purpose.

## Adding things (cheat sheet)

- **Role** → `src/core/orchestrator/roles/<name>/` (existing roles: ai,
  architecture, automation, coding, communication, data, design, devops,
  finance, general, pm, qa, research, review, security, writing, orchestrator).
  Auto-discovered via folder scan; no manual registration. Add classifier
  keywords in `src/core/orchestrator/classifier.ts` if it has a distinct topic.
- **Skill** → system skills are seeded in `src/db/seed-skills.ts` (DB-backed,
  with embeddings). Filesystem skills follow the agentskills.io spec: a
  `SKILL.md` (or flat `*.md`) under `.octipus/skills/`, `~/.octipus/agent/skills/`,
  `~/.claude/skills/`, `.agents/skills/`, etc. — auto-discovered by
  `src/skills/external-loader.ts`. (No more `skill.json`/`knowledge.md`.)
- **Tool (built-in)** → `src/tools/<name>/index.ts` extending `BaseTool`.
  Auto-discovered via `discovery.ts`; no need to register in `src/tools/index.ts`.
- **MCP tool** → `mcp-server/src/tools/<group>.ts` with Zod schema + `server.tool`
  registration. Inventory auto-discovers.
- **Channel** → `src/channels/<name>/`. Must speak the gateway protocol; no
  channel-specific orchestrator hooks. Auto-discovered via `discovery.ts`.
- **Plugin / extension** → a directory under `extensions/` (in OCTIPUS_HOME) with
  `plugin.json` + `index.ts`; loaded by `src/plugins/loader.ts`. See the
  `plugin-development` skill and `docs/PLUGINS.md`.
- **Persona** → a YAML file in `personas/`; loaded by `src/core/personas/`.
- **Connector** → `src/connectors/<name>/definition.ts`, register in the
  connector registry. OAuth via `oauth-http-transport.ts`.
- **Hook** → wire triggers/actions in `src/hooks/` (`triggers.ts`, `actions.ts`).
- **Expert / Profile** → seed in `src/db/seed-experts.ts` / `seed-presets.ts`,
  or POST via API.
- **DB schema change** → edit Drizzle schema in `src/db/schema/`, then
  `bun run db:generate` to produce a migration, then `bun run db:migrate`.

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
| Skills (DB + filesystem)              | `src/skills/`, `src/db/seed-skills.ts`    |
| Plugins / extensions                  | `src/plugins/`, `src/extensions/`, `docs/PLUGINS.md` |
| Personas                              | `src/core/personas/`, `personas/`         |
| RAG / knowledge base                  | `src/core/rag/`, `docs/RAG.md`            |
| Voice / TUI clients                   | `src/voice/`, `src/tui-pi/`, `src/tui-editor/` |
| Architecture deep dive                | `docs/AGENT-ARCHITECTURE.md`              |
| Full docs index                       | `README.md` → Documentation table         |

## When in doubt

1. Search `docs/` for an existing doc on the area.
2. Check `.octipus/` for design notes and audits.
3. Look at a sibling implementation (existing role, tool, channel) and follow
   the same shape.
4. If the answer still isn't obvious, ask in the PR / issue rather than
   guessing — wrong abstractions are expensive here.
