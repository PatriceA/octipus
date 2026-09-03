# AGENT.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, etc.) working in
this repo. This is the canonical agent-instructions file (the `AGENT.md`
convention) — committed so it travels with the codebase, no per-machine setup.
It replaces the former `CLAUDE.md`; put agent guidance here going forward.
Note: Claude Code auto-loads `CLAUDE.md`, not `AGENT.md` — to auto-inject this
file there, add a one-line `CLAUDE.md` containing `@AGENT.md`.

> Read [DESIGN.md](./DESIGN.md) and [CONTRIBUTING.md](./CONTRIBUTING.md) before
> making non-trivial changes. The principles in those documents override
> anything ambiguous here.

---

## What this repo is

**Octipus** — an open-source, self-hosted AI platform. One root agent answers
the user with its own tools and delegates to a swarm of specialist agents when a
task needs one (3-level: root → Agent → Subagent), all using typed tools, skills,
and experts. There is no separate "root agent" that only routes: the root runs
as the `general` role marked `AgentContext.root` (see `ROOT_ROLE`), and the
routing hop that used to sit in front of it was deleted in Phase 9 of
`docs/plans/rebuild-execution-plan.md`. Multi-channel
(Telegram / Slack / Teams / WhatsApp / Web / TUI / Voice / MCP), multi-provider
(Ollama, OpenAI, Anthropic, Gemini, OpenRouter, …), Postgres + pgvector backed
with a PGlite embedded mode.

Architecture in one line:
`Channels → Gateway (WS) → Root agent → (spawn_child) Agents → Tools/Skills/Experts → Models → DB`

## Stack

- **Runtime:** Node ≥ 24 end-to-end (server, tests, scripts, TUI, web build).
  `npm run build` bundles `dist/index.js`; `npm start` runs that artifact, not
  the source.
- **Backend:** Hono + `ws` behind the application in `src/api/http/` (which
  keeps the route surface the routes were written against), Drizzle ORM,
  Postgres + pgvector (PGlite in embedded mode). Cache, queue and pub/sub are
  Postgres too — `kv_store`, `kv_queue`, `LISTEN`/`NOTIFY`.
- **Web:** Vite + React Router + React 19 + Tailwind in `web/`, served as
  static files by `web/serve.mjs`.
- **Tests:** Vitest, two projects — `unit` at full width, `database` at one
  worker. See `vitest.config.ts` for why that split is not optional.
- **Validation:** Zod everywhere at boundaries.
- **Lint/format:** Biome (`npm run lint`). Formatter is **off** — don't
  reformat untouched code.
- **TS:** strict mode, `noImplicitOverride`. Path aliases: `@/`, `@db/`,
  `@core/`, `@models/`, `@security/`, `@skills/`, `@channels/`, `@api/`,
  `@utils/`. Use them instead of long relative paths.

## Repo layout

```
src/
  api/            REST routes + WS (`api/http/` is the application layer)
  channels/       Telegram, Slack, Teams, WhatsApp, WebChat (+ discovery, linking)
  config/         Zod-validated config, hot-reload
  core/
    gateway/      WS entry, command registry
    root agent/ root-agent turn (runner + service), roles, pipelines,
                  meta-tools, classifier (topic hint only), guards
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
mcp-server/       standalone MCP server (88 tools across 26 groups)
web/              Vite + React Router dashboard
browser-extension/  companion browser extension
bin/              octi launcher CLI (bin/octi start|stop)
personas/         persona YAML definitions
extensions/       installed plugins (example-plugin, github)
eval/             YAML eval scenarios
scripts/          migrate, setup, backup, doctor, e2e, integration, key rotation
docs/             feature & architecture docs (see README Documentation table)
.octipus/         design notes (swarm-design, audits, plans)
AGENTS.md         per-repo curated project guide (universal agents.md convention)
```

## Commands

| Task             | Command                          |
| ---------------- | -------------------------------- |
| Install          | `npm install && cd web && npm install && cd ../mcp-server && npm install && cd ..` |
| Install (desktop)| `scripts/install-desktop-deps.sh` (Rust + Tauri system libs; optional) |
| Dev (backend)    | `npm run dev`                    |
| Start full stack | `bin/octi start` (stop: `bin/octi stop`) |
| Type check       | `npm run typecheck`              |
| Lint             | `npm run lint` (fix: `npm run lint:fix`) |
| Unit tests       | `npm run test` (Vitest; `-- --coverage` for the ratchet) |
| TUI tests        | `npm run test:tui`               |
| Integration      | `npm run test:integration` (Docker Postgres) |
| E2E (API/WS)     | `npm run test:e2e`               |
| Web E2E          | `npm run test:web`               |
| Eval suite       | `npm run eval` (`eval:routing`, `eval:quality`) |
| Architecture catalog | `npm run catalog` (check: `npm run catalog:check`) |
| DB migrate       | `npm run db:migrate`             |
| DB generate      | `npm run db:generate`            |
| DB studio        | `npm run db:studio`              |
| Setup wizard     | `npm run setup`                  |
| TUI client       | `npm run tui` (edit: `npm run tui:edit`) |
| Doctor / preflight | `npm run scripts/doctor.ts`    |

Default ports: backend `3005`, web `3007`. Use `bin/octi` rather than raw
`npm run` when starting the full stack so channels, web, and workers come up
together.

`catalog:check` runs in CI and fails when `docs/architecture/generated/CATALOG.md`
no longer matches the source. If a route, a module edge, or a gateway event type
changed, run `npm run catalog` and commit the result — the file is generated, so
never hand-edit it.

The integration lane binds Postgres on `5443`. If something else already holds
that port, pass your own: `TEST_POSTGRES_PORT=5453 npm run test:integration`.
(It really does collide — an unrelated local Postgres held 5443 on 2026-08-23.)

## House rules (must follow)

These come from `DESIGN.md`. They are not negotiable on a normal PR — if you
think you need to break one, open an issue first.

1. **Fail loud.** No silent fallbacks. If a tool errors, surface it. No
   `try { … } catch { /* swallow */ }`. If you must catch, log the reason.
2. **No hardcoded models.** Never write `model: 'gpt-4o'` in source. Bind to
   a topic and resolve via `ModelRegistry.getModelForTopic(role)`. Unbound
   topic ⇒ throw at spawn time (fail-loud). Default fallback applies ONLY
   to the root agent, never to worker topics.
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
  must pass `npm run eval`.
- **Before declaring done:** `npm run typecheck && npm run lint && npm test`
  all green locally. For UI changes, exercise the feature in a browser — type
  checks don't catch broken UX.
- **Don't reformat** files you aren't otherwise touching. Biome's formatter is
  off on purpose.

## Adding things (cheat sheet)

- **Role** → `src/core/agent/roles/<name>/` (existing roles: ai,
  architecture, automation, coding, communication, data, design, devops,
  finance, general, pm, qa, research, review, security, writing). `general` is
  also what the ROOT agent of a turn runs as. Registered by three lines in
  `roles/index.ts` (static imports — a folder scan breaks in the bundle). Add classifier
  keywords in `src/core/agent/classifier.ts` if it has a distinct topic.
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
  channel-specific root agent hooks. Auto-discovered via `discovery.ts`.
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
  `npm run db:generate` to produce a migration, then `npm run db:migrate`.

## Voice Integration Architecture

Octipus features a comprehensive voice subsystem (`src/voice/`) divided into three distinct execution paths:

1. **Batch Processing (REST API)**
   - **Endpoints:** `/api/voice/transcribe` and `/api/voice/speak` (in `src/api/routes/voice.ts`).
   - **Engines:** Supports cloud providers (OpenAI Whisper, Mistral Voxtral) and local engines (Whisper.cpp, Piper, Edge TTS, Coqui) interchangeably.
   - **Usage:** Standard HTTP requests for one-off transcription or synthesis. Implements strict limits (e.g., max 5000 chars for TTS) to prevent billing abuse.

2. **Live Voice (Push-to-Talk & Wake Word)**
   - **Implementation:** `VoiceService` (`src/voice/index.ts`).
   - **Features:** Supports wake-word detection (Sherpa, Picovoice Porcupine, VAD) via `startListening()`.
   - **Limitations:** Push-to-Talk (`startRecording()`) currently hardcodes the `arecord` binary, restricting mic capture strictly to Linux/ALSA environments.
   - **Streaming:** Supports `streamTranscribe()` and `streamSpeak()` generators for real-time WebSocket clients.

3. **Telephony (Phone Calls)**
   - **Providers:** Twilio, Telnyx, Plivo (`src/voice/telephony/`).
   - **Standard Path:** Turn-based conversation using webhooks (`/api/voice/webhook/:provider`) and TwiML `<Gather>`.
   - **Fast Path:** Bypasses the standard multi-agent Root agent routing to ensure low-latency responses (direct LiteLLM call with a short-response expert prompt).
   - **Media Stream Path (Phase 4d):** For Twilio, an optional WebSocket media bridge (`/api/voice-media-ws.ts`) handles bidirectional `<Connect><Stream>` payload (8kHz μ-law ↔ 16kHz PCM), enabling real-time streaming STT, VAD turn-taking, and caller barge-in.

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
| How does a message become a worker?   | `src/core/agent/`, `src/core/router.ts` |
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
| Every route, module edge, event type  | `docs/architecture/generated/CATALOG.md` (generated, CI-gated) |
| **Where the work stands right now**   | `docs/plans/rebuild-execution-plan.md` → *Where this stands* |
| Full docs index                       | `README.md` → Documentation table         |

## When in doubt

0. Read *Where this stands* in `docs/plans/rebuild-execution-plan.md` before
   starting anything structural. It carries what is done, what is deliberately
   NOT being built and why, and what the next step actually is.
1. Search `docs/` for an existing doc on the area.
2. Check `.octipus/` for design notes and audits.
3. Look at a sibling implementation (existing role, tool, channel) and follow
   the same shape.
4. If the answer still isn't obvious, ask in the PR / issue rather than
   guessing — wrong abstractions are expensive here.
