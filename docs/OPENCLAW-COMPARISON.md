# Octipus vs OpenClaw — Feature, Quality & Architecture Comparison

Comparison with [OpenClaw](https://github.com/openclaw/openclaw) as of
July 2026 (OpenClaw `main` @ `fe261b0f`, version `2026.7.2`; Octipus
`main` @ `6cb0949`, v0.2 alpha). Both codebases were inventoried from
source, not from marketing pages. Goal: find gaps in both directions
and decide which are worth closing.

## Legend

- **Yes** — fully implemented
- **Partial** — implemented with limitations
- **No** — not implemented
- **N/A** — not applicable to the project's architecture/positioning

## Positioning — read this first

The two projects overlap heavily in capability but aim at different
products, which reframes many "gaps" as deliberate scope choices:

| | OpenClaw | Octipus |
|---|---|---|
| Product | Personal, **single-user** AI assistant you run on your own devices | Self-hosted, **multi-user** agent orchestration platform |
| Center of gravity | Channels + devices ("the product is the assistant") | Orchestrator + swarm ("coordination, not replacement") |
| Trust model | One owner; pairing/allowlists for everyone else | Organizations, RBAC, RLS, SSO — many principals |
| State | Local-first: JSON5 config, SQLite, markdown memory files | DB-first: Postgres + pgvector (PGlite embedded mode), config in DB |
| Scale of codebase | ~993k LOC in `src/`, 152 bundled plugins, 21 workspace packages, native Swift/Kotlin apps | ~166k LOC in `src/` + ~36k web, single repo, small core |
| Maturity | CalVer `2026.7.2`, auto-update feed, 71 CI workflows | v0.2 alpha, semver-ish 0.x, 1 CI workflow |

OpenClaw is roughly 6× the codebase and several times the surface
area. A line-by-line feature race is unwinnable and undesirable; the
useful question is which OpenClaw capabilities matter for a
multi-user orchestration platform, and which Octipus capabilities
OpenClaw structurally cannot match.

## Core agent capabilities

| Capability | OpenClaw | Octipus | Notes |
|---|---|---|---|
| Multi-agent routing | Yes | Yes | OpenClaw: per-channel/peer isolated agents with own workspaces. Octipus: orchestrator + 16 specialist roles |
| Deterministic pre-LLM classification | No | Yes | Octipus classifies keyword-first, LLM only when ambiguous |
| Sub-agent spawning | Yes | Yes | OpenClaw: `subagents` tool + ACP runtime. Octipus: 3-level swarm via `spawn_child`, await/detach, `parallelGroup` |
| Spawn budgets (tokens/wall-clock/fan-out) | Partial | Yes | Octipus: per-node hard caps + cascade cancel + fingerprint cycle protection (`src/core/swarm/`) |
| Crash-resume of agent trees | No | Yes | Octipus swarm ledger (`swarm-ledger` schema) |
| Result verification/scoring | Partial | Yes | Octipus `scorers.ts` + receipts (docs/SWARM-RELIABILITY.md) |
| Sequential pipelines with approval gates | No | Yes | `pipeline-manager.ts`, approval-manager |
| Multiple external agent harnesses | Yes | Partial | OpenClaw runs Codex, GitHub Copilot CLI, OpenCode as engines. Octipus wraps CLIs as providers (`cli-provider`) |
| Mid-run steering queue | Yes | No | OpenClaw `steer` tool + steering queue |
| Topic → model config-driven routing | Partial | Yes | Octipus `ModelRegistry.getModelForTopic()`, fail-loud on unbound |
| Personas / identity | Yes | Yes | OpenClaw "soul"/identity; Octipus 6 orchestrator personas + 15 experts |

## Channels

OpenClaw ships ~25 channel plugins; Octipus ships 5 adapters + telephony.

| Channel | OpenClaw | Octipus |
|---|---|---|
| WebChat | Yes | Yes |
| Telegram | Yes | Yes |
| Slack | Yes | Yes |
| WhatsApp | Yes (Baileys, personal account) | Yes (Cloud API) |
| Microsoft Teams | Yes | Yes |
| Voice calls (Twilio/Telnyx/Plivo) | Yes | Yes |
| Discord | Yes | No (explicitly not planned, AGENT.md) |
| Signal | Yes | No |
| iMessage / BlueBubbles | Yes | No |
| Matrix | Yes | No |
| IRC, Mattermost, Nextcloud Talk | Yes | No |
| Google Chat, Feishu/Lark, LINE, WeChat, QQ, Zalo, DingTalk-class regional | Yes | No |
| SMS (Twilio) | Yes | No |
| Twitch, Nostr, Urbit | Yes | No |
| Google Meet participant | Yes | No |
| Email as a channel | Partial (Gmail Pub/Sub trigger) | Partial (email triage/enrichment, no inbound channel adapter) |

Note the WhatsApp difference in kind: OpenClaw drives a *personal*
WhatsApp account via Baileys (reverse-engineered), Octipus uses the
official Cloud Business API. Octipus's choice is safer for a
multi-user platform; OpenClaw's is better for a personal assistant.

## Model / LLM providers

| Capability | OpenClaw | Octipus | Notes |
|---|---|---|---|
| Provider count | ~60+ plugins | 11 native + custom endpoints | Octipus covers the long tail via LiteLLM bridge + OpenAI/Gemini-compatible `custom` providers |
| Anthropic / OpenAI / Google / Mistral / DeepSeek / OpenRouter | Yes | Yes | |
| AWS Bedrock, Vertex, Azure | Yes | Via LiteLLM only | |
| Groq, Fireworks, Together, Cerebras, xAI…(long tail) | Yes | Via LiteLLM/custom only | |
| Local: Ollama | Yes | Yes | First-class in both |
| Local: llama.cpp, LM Studio, vLLM, SGLang direct | Yes | Via custom endpoint | |
| Consumer-subscription OAuth (ChatGPT/Codex, Qwen, MiniMax) | Yes | No | Reuse of paid consumer plans instead of API keys |
| CLI harness providers (Claude Code, Gemini CLI, Codex CLI…) | Yes | Yes | Both wrap coding CLIs |
| Failover | Yes (auth-profile rotation, cooldowns) | Yes (circuit breaker, health checker, retry) | Different mechanics, similar outcome |
| Cost & quota tracking | Partial (usage page) | Yes (`cost-tracker`, `quota-tracker`, per-user quotas) | |
| Tool-calling shim for weak models | Partial (tool-call-repair pkg) | Yes (`toolshim.ts`, capability gate) | |
| Provider conformance test suite | Yes (contract shards) | Yes (`conformance.test.ts`) | |

## Tools

| Tool area | OpenClaw | Octipus | Notes |
|---|---|---|---|
| Shell/exec (sandboxed) | Yes (Docker/SSH sandbox, exec approvals) | Yes (local/SSH/Docker, permission ALLOW/ASK/DENY) | |
| Files, git | Yes | Yes | Octipus adds GitHub *and* GitLab tools, repo registry |
| Browser automation | Yes (CDP control) | Yes (Playwright) | |
| Browser extension (user's real browser) | Yes | Yes | |
| Web search | Yes (8+ backends: brave, exa, tavily, perplexity, searxng…) | Yes (websearch group) | OpenClaw broader backend choice |
| MCP client | Yes | Yes | Both with lifecycle mgmt; Octipus adds MCP circuit breaker |
| MCP server (expose itself) | Yes | Yes | |
| Knowledge/RAG tools | Partial (plugin memory backends) | Yes (hybrid BM25+vector, indexer, retention) | Octipus built-in |
| Office suites (M365, Google Workspace) | Partial (skills, gmail-ops hooks) | Yes (dedicated tool groups + OAuth connectors) | |
| Media generation (image/music/video) | Yes (fal, comfy, runway…) | No | |
| Media understanding (audio/vision pipelines) | Yes | Partial (visual screenshots, Whisper STT) | |
| Canvas / visual workspace | Yes (Canvas + A2UI on nodes) | Partial (Live Artifacts BETA, hosted app artifacts) | Different shape, similar intent |
| Device commands (camera, screen record, location) | Yes (via device nodes) | No | Requires OpenClaw's node fleet |
| Tool catalog search (`tool_search`) | Yes (experimental) | No | Matters as tool count grows |
| Scheduling/task tools | Yes (cron, goals) | Yes (scheduling, tasks, task-state) | |
| Documents/notes | Partial (skills) | Yes (documents, notes tool groups + UI) | |

## Memory & persistence

| Capability | OpenClaw | Octipus |
|---|---|---|
| Long-term memory | Markdown files (`MEMORY.md`, daily notes) + LanceDB/wiki plugins | Fact store with extractor/judge/retrieval (`src/core/memory/`) |
| Vector search | Plugin (LanceDB) | Built-in (pgvector, hybrid BM25+vector) |
| Conversation history | JSONL transcripts + SQLite state | Postgres schemas (sessions, messages, agent-events) |
| Context compaction | Yes (docs/concepts/compaction) | Yes (session + context compaction with ≥15% savings gate) |
| Trajectory/audit logging | Partial (run logs) | Yes (JSONL trajectory runs + audit schema) |
| Proactive memory ("dreaming", commitments) | Yes | No |

## Automation

| Capability | OpenClaw | Octipus |
|---|---|---|
| Cron / recurring tasks | Yes (~130 files, isolated-agent runs) | Yes (scheduler, cron-runner, recurring-tasks) |
| Heartbeat (periodic proactive agent turn) | Yes | No |
| Webhooks (inbound) | Yes | Yes (GitHub/GitLab ingestion) |
| Hooks (event-triggered actions) | Yes | Yes |
| Gmail push (Pub/Sub) | Yes | No |
| Standing orders / goals | Yes | Partial (To-Do, tasks) |

## UI surfaces

| Surface | OpenClaw | Octipus |
|---|---|---|
| Web UI | Yes (Lit, 27 pages, control-plane flavored) | Yes (Next.js 16, ~30 routes, full product UI) |
| CLI | Yes | Yes |
| TUI chat | No | Yes (+ TUI editor, push-to-talk voice) |
| Desktop app | Yes (native macOS menu-bar app) | Yes (Tauri, cross-platform) |
| iOS / Android | Yes (native node apps) | No (roadmap) |
| Windows companion | Yes (Windows Hub) | Partial (Tauri desktop runs on Windows) |
| Voice wake / talk mode | Yes (on-device on 3 platforms) | Yes (server-side wake-word, STT/TTS, telephony) |
| Live visual canvas | Yes | Partial (Live Artifacts BETA) |

## Auth, multi-user, security

| Capability | OpenClaw | Octipus |
|---|---|---|
| Multi-user / multi-tenant | No (single user by design) | Yes (organizations, per-org SSO) |
| RBAC / permissions | Partial (tool allow/deny policy layers) | Yes (three-tier ALLOW/ASK/DENY, principals, quotas) |
| Row-level security | N/A | Yes (Postgres RLS) |
| SSO (SAML), SCIM | No | Yes |
| Passkeys / TOTP 2FA | No | Yes |
| API tokens | Partial (gateway token modes) | Yes |
| DM pairing / allowlists for untrusted inbound | Yes | Partial (account linking; less formalized pairing flow) |
| Device pairing (challenge-nonce) | Yes | N/A (no device nodes) |
| Secrets management | SecretRef + HashiCorp Vault plugin | Built-in AES-256-GCM vault, DEK/master-key, rotation scripts |
| Sandboxing | Yes (Docker default for non-main sessions, SSH/cloud backends) | Yes (shell sandbox, Docker isolation, workspace FS) |
| Exec approvals (human-in-the-loop) | Yes | Yes (ASK permission tier) |
| Prompt-injection defense | Partial (untrusted-input gating at channel edge) | Yes (3 layers: preamble, 39-pattern input guard, LLM output guard) |
| Red-team eval suite in repo | No | Yes (49 cases, 5 attack plugins) |
| Security scanning in CI | Yes (CodeQL, semgrep/opengrep, zizmor, detect-private-key) | Partial (`bun audit` continue-on-error only) |

## Deployment & operations

| Capability | OpenClaw | Octipus |
|---|---|---|
| One-shot installer | Yes (npm global + `onboard`) | Yes (curl installer + `octi setup`) |
| Non-interactive/CI setup | Yes | Yes (`--non-interactive`, env-driven) |
| Docker / compose | Yes | Yes (Postgres + Valkey + app) |
| Managed-cloud recipes (Fly, Render, Nix) | Yes | No |
| OS service install (launchd/systemd) | Yes | No |
| Auto-update (Sparkle feed for macOS app) | Yes | No |
| Health/doctor command | Yes | Yes |
| Observability exporters (OTel, Prometheus) | Yes (plugins) | No (pino logs, metrics route only) |
| i18n | Yes (core + apps + docs) | No |

## Extensibility

| Capability | OpenClaw | Octipus |
|---|---|---|
| Plugin system | Yes — SDK package, package contract, 152 bundled plugins; plugins can add tools/providers/channels/speech | Partial — loader + plugin-as-tool, one example plugin |
| Plugin distribution | Yes (ClawHub registry, npm, git, archive) | No (local `extensions/` dir only) |
| Plugin contract tests | Yes (sharded in CI) | No |
| Skills | Yes (52 bundled, `SKILL.md`, Skill Workshop UI) | Yes (20 domain skills, DB + `SKILL.md` agentskills.io spec, proposal/curator lifecycle) |
| Eval framework | Partial (QA harness, maturity scorecard) | Yes (`src/eval/` + YAML suites + red-team) |
| Protocol client SDK | Yes (`gateway-client`, generated Swift models) | Partial (typed Zod protocol, no published client pkg) |
| OpenAI-compatible HTTP API | Yes | No |

## Quality comparison

| Signal | OpenClaw | Octipus |
|---|---|---|
| Source size | ~993k LOC `src/` + 105k packages + native apps | ~166k LOC `src/` + 36k web + 3k mcp-server |
| Test files | 7,240 (incl. 105 e2e, live tests, contract shards) | 337 (unit, integration vs Docker Postgres, 26 API/WS e2e modules, 24 Playwright web specs, TUI e2e, a11y) |
| Test:source ratio (src) | ~0.43 (4,042 / 9,475 files) | ~0.31 (310 / 989 files) |
| CI | 71 workflows: sharded matrices, macOS/iOS/Android/Windows lanes, perf regression, install smoke, release validation | 1 workflow, 3 jobs (backend, web+Tauri, mcp-server) |
| Security CI | CodeQL, semgrep/opengrep, zizmor, dependency guard | `bun audit` (continue-on-error) |
| Type strictness | strict TS everywhere, tsgo lanes | strict TS everywhere |
| Lint/format | oxlint + oxfmt + knip + markdownlint + shellcheck + swiftlint + ktlint, pre-commit | Biome (curated rules, formatter deliberately off), ESLint on web |
| Docs | 708 markdown files, Mintlify site, i18n | ~45 files in `docs/`, thorough for size |
| Release engineering | CalVer, changelog 15k lines w/ PR credits, appcast auto-update, RELEASING.md, maturity scorecard | 0.x alpha, Keep-a-Changelog (51KB), no release automation |
| Error handling | logger pkg, retry/failover docs, tool-call repair, loop detection, watchdogs, restart-recovery | centralized error taxonomy (`FailoverReason`/`RecoveryAction`), fail-loud doctrine, typed swarm errors |
| TODO debt | n/a (not measured) | 3 TODO/FIXME in all of `src/` (policy-enforced) |

Read fairly: OpenClaw's numbers reflect a ~3-year-old project with a
large contributor base and sponsors; Octipus is a young alpha with
unusually good hygiene for its stage (strict TS, error taxonomy,
red-team evals, near-zero TODO debt). The per-file test ratio is in
the same league. The real quality gaps are in *infrastructure around
the code* — CI breadth, security scanning, release automation — not
in code discipline.

## Architecture comparison

**Shared shape.** Both converge on the same macro-architecture:
channel adapters → a long-lived gateway speaking a typed WebSocket
protocol → an agent runtime with tool policy and sandboxing → model
providers with failover. Both treat channels as thin adapters and
keep one authoritative daemon.

**Where they diverge:**

- **State.** Octipus is database-centric: Postgres + pgvector behind
  Drizzle, 77 migrations, 55+ schemas, runtime config stored in the DB
  and editable via API/UI; `.env` holds only secrets. OpenClaw is
  file-centric: JSON5 config with `$include`, SQLite side-stores,
  markdown memory in a workspace directory. Octipus's model gives
  transactional multi-user state, RLS, and auditability; OpenClaw's
  gives greppable, syncable, human-editable local state. Each is
  correct for its product.
- **Protocol toolchain.** Octipus: Zod-typed WS protocol + ~90 REST
  routes with Swagger. OpenClaw: TypeBox → JSON Schema → generated
  Swift models, versioned frames, idempotency keys on side-effecting
  methods, published `gateway-client`. OpenClaw's pipeline is the more
  industrialized pattern and is what makes its native apps cheap to
  keep in sync — directly relevant to Octipus's mobile roadmap.
- **Extensibility boundary.** OpenClaw pushes almost everything —
  channels, providers, tools, speech, even memory — behind a plugin
  SDK with a package contract and contract tests in CI; the core is a
  kernel. Octipus keeps a small curated core ("small core, large
  catalog" per DESIGN.md) with plugins as a side door. OpenClaw's
  approach scales contribution (152 plugins) but yields a huge
  maintenance surface; Octipus's keeps quality but concentrates all
  work on the core team.
- **Orchestration.** This is Octipus's structural lead: deterministic
  classification, config-driven topic→model binding, budgeted
  3-level swarm with cascade cancel, ledger crash-resume, and
  verification receipts. OpenClaw's multi-agent story (routing +
  subagents + external harnesses) is broader but shallower — no spawn
  budgets, no crash-resume of agent trees, no verification layer.
- **Runtime bet.** Octipus: Bun + Elysia (fast, younger ecosystem).
  OpenClaw: Node 22+ (boring, maximally compatible — likely one
  reason its plugin ecosystem grew).

## Gap analysis — Octipus gaps vs OpenClaw

Ordered by recommended priority, filtered through Octipus's
positioning (multi-user orchestration platform — not a personal
assistant, so device nodes, personal-account WhatsApp, and 25
channels are *not* automatically goals).

**High value, aligned with positioning:**

1. **CI & security engineering.** Add CodeQL/semgrep, make `bun audit`
   blocking, add release automation and cross-OS install smoke tests.
   Cheapest credibility gap to close.
2. **Heartbeat / proactive loop.** OpenClaw's heartbeat + standing
   orders make the assistant *initiate*. Octipus has cron and hooks
   but no periodic "look at your goals and act" turn. Natural fit for
   the existing scheduler + swarm.
3. **Plugin SDK maturity.** Publish a plugin contract package +
   contract tests and support install-from-npm/git. The
   proposal/curator skill lifecycle is already better than OpenClaw's;
   plugins need the same rigor before a marketplace (roadmap) is viable.
4. **Observability exporters.** OTel traces + Prometheus metrics.
   Table stakes for a self-hosted multi-user platform; OpenClaw ships
   both as plugins.
5. **Tool catalog search.** With 59+ tools and MCP fan-in, prompt-side
   tool selection will hit context limits; OpenClaw's `tool_search`
   pattern (experimental there) is the right shape.
6. **OpenAI-compatible HTTP API.** Lets any existing client/SDK treat
   Octipus as a backend. Low effort given ~90 REST routes already exist.

**Medium value:**

7. **Channel breadth — selectively.** Discord is explicitly out; but
   Signal, Matrix, and SMS are common in Octipus's self-hosted
   audience and each fits the existing adapter interface. Email as a
   first-class inbound channel (the triage enrichment already exists)
   may be worth more than any chat network.
8. **Provider breadth — mostly solved via LiteLLM**, but two real
   gaps: consumer-subscription OAuth (ChatGPT/Codex plans) and
   first-class llama.cpp/LM Studio/vLLM endpoints (today: manual
   custom-provider config).
9. **Mobile.** Already on the roadmap via the gateway protocol. Steal
   OpenClaw's schema-generation trick (protocol schema → generated
   client models) rather than hand-writing clients.
10. **Mid-run steering.** A queue to inject user guidance into a
    running swarm without cancelling it.

**Lower priority / conscious non-goals:**

11. Media generation (image/music/video) — plugin territory.
12. Device nodes (camera/screen/location) — belongs to OpenClaw's
    personal-device product, not a server platform.
13. i18n — revisit when user base warrants.
14. Personal-account WhatsApp (Baileys) — ToS-risky; Cloud API is the
    right call for a platform.

## Gap analysis — OpenClaw gaps (Octipus advantages)

Where Octipus is ahead and should press, because OpenClaw's
architecture makes these hard to retrofit:

1. **True multi-tenancy** — orgs, RLS, SAML/SCIM, passkeys, quotas,
   impersonation. OpenClaw is single-user by design; its file/SQLite
   state model cannot express this.
2. **Orchestration rigor** — spawn budgets, cascade cancel,
   crash-resume ledger, verification receipts, approval-gated
   pipelines. Differentiator vs both OpenClaw and Claude-Code-class
   harnesses; SWARM-RELIABILITY.md is unique material.
3. **Built-in hybrid RAG/knowledge base** (pgvector BM25+vector with
   retention) vs plugin-optional memory.
4. **Governance-grade security** — encrypted vault with key rotation,
   3-layer injection defense, in-repo red-team suite, isolation tests.
5. **DB-backed runtime configuration** editable via API/UI vs
   restart-and-edit-JSON5.
6. **Eval framework as part of the build** (YAML suites + red-team)
   vs post-hoc QA harness.

## Bottom line

OpenClaw wins on breadth (channels, providers, devices, plugins) and
on engineering infrastructure (CI, release, protocol toolchain,
docs volume). Octipus wins on depth where it has chosen to compete:
multi-user trust model, orchestration reliability, built-in
knowledge/memory, and security governance. The gaps most worth
closing are infrastructure gaps (security CI, observability, plugin
SDK, protocol-driven client generation), plus two product gaps that
fit the positioning: a proactive heartbeat loop and selective channel
additions (email, Signal/Matrix). The breadth race — 25 channels, 60
providers, device fleets — is OpenClaw's game and not worth playing.
