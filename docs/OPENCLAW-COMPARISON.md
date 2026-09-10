# Historical OpenClaw comparison — July 2026

Comparison with [OpenClaw](https://github.com/openclaw/openclaw) as of
July 2026 (OpenClaw `main` @ `fe261b0f`, version `2026.7.2`; Octipus
`main` @ `6cb0949`, v0.2 alpha). Both codebases were inventoried from
source, not from marketing pages. Goal: find gaps in both directions
and decide which are worth closing.

> **Archived comparison, not current guidance.** The external matrices below
> have not been reverified. Counts and feature labels are historical observations;
> use the linked current Octipus guides for present behavior.

## Legend

- **Yes** — reported present in the historical inventory; not a completeness or quality guarantee
- **Partial** — implemented with limitations
- **No** — not implemented
- **N/A** — not applicable to the project's architecture/positioning

## Historical positioning

The two projects overlap heavily in capability but aim at different
products, which reframes many "gaps" as deliberate scope choices:

| | OpenClaw | Octipus |
|---|---|---|
| Product | Personal, **single-user** AI assistant you run on your own devices | Self-hosted, **multi-user** agent orchestration platform |
| Center of gravity | Channels + devices ("the product is the assistant") | Root agent + swarm ("coordination, not replacement") |
| Trust model | One owner; pairing/allowlists for everyone else | Organizations, RBAC, RLS, SSO — many principals |
| State | Local-first: JSON5 config, SQLite, markdown memory files | DB-first: Postgres + pgvector (PGlite embedded mode), config in DB |
| Scale of codebase | ~993k LOC in `src/`, 152 bundled plugins, 21 workspace packages, native Swift/Kotlin apps | ~147k LOC in `src/` + ~38k web, single repo, small core |
| Maturity | CalVer `2026.7.2`, auto-update feed, 71 CI workflows | v0.1 alpha, semver-ish 0.x, 12 CI workflows |

## Core agent capabilities

| Capability | OpenClaw | Octipus | Notes |
|---|---|---|---|
| Multi-agent routing | Yes | Yes | OpenClaw: per-channel/peer isolated agents with own workspaces. Octipus: root agent + 16 specialist roles |
| Deterministic pre-LLM classification | No | Yes | Octipus classifies keyword-first, LLM only when ambiguous |
| Sub-agent spawning | Yes | Yes | OpenClaw: `subagents` tool + ACP runtime. Octipus: 3-level swarm via `spawn_child`, await/detach, `parallelGroup` |
| Spawn budgets (tokens/wall-clock/fan-out) | Partial | Yes | Octipus: per-node hard caps + cascade cancel + fingerprint cycle protection (`src/core/swarm/`) |
| Crash-resume of agent trees | No | Yes | Octipus swarm ledger (`swarm-ledger` schema) |
| Result verification/scoring | Partial | Yes | Octipus `scorers.ts` + receipts (docs/SWARM-RELIABILITY.md) |
| Sequential pipelines with approval gates | No | Yes | `pipeline-manager.ts`, approval-manager |
| Multiple external agent harnesses | Yes | Partial | OpenClaw runs Codex, GitHub Copilot CLI, OpenCode as engines. Octipus wraps CLIs as providers (`cli-provider`) |
| Mid-run steering queue | Yes | No | OpenClaw `steer` tool + steering queue |
| Topic → model config-driven routing | Partial | Yes | Octipus `ModelRegistry.getModelForTopic()`, fail-loud on unbound |
| Personas / identity | Yes | Yes | OpenClaw "soul"/identity; Octipus 6 root agent personas + 16 experts |

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
| Web UI | Yes (Lit, 27 pages, control-plane flavored) | Yes (React + Vite, ~44 routes, full product UI) |
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
| Security scanning in CI | Yes (CodeQL, semgrep/opengrep, zizmor, detect-private-key) | Yes (CodeQL, semgrep/opengrep, zizmor, blocking dependency audit w/ reviewable allowlist) |

## Deployment & operations

| Capability | OpenClaw | Octipus |
|---|---|---|
| One-shot installer | Yes (npm global + `onboard`) | Yes (curl installer + `octi setup`) |
| Non-interactive/CI setup | Yes | Yes (`--non-interactive`, env-driven) |
| Docker / compose | Yes | Yes (Postgres + app) |
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
| Skills | Yes (52 bundled, `SKILL.md`, Skill Workshop UI) | Yes (22 domain skills, DB + `SKILL.md` agentskills.io spec, proposal/curator lifecycle) |
| Eval framework | Partial (QA harness, maturity scorecard) | Yes (`src/eval/` + YAML suites + red-team) |
| Protocol client SDK | Yes (`gateway-client`, generated Swift models) | Partial (typed Zod protocol, no published client pkg) |
| OpenAI-compatible HTTP API | Yes | Yes (mounted at `/v1`) |

## Status after the historical inventory

The tables above preserve the July inventory's reported observations. Neither
OpenClaw's current implementation nor those external feature classifications was
revalidated in the September 2026 documentation review. They must not be read as
current compatibility claims, measured quality, or proof of missing capabilities
in another project.

Octipus has changed since that inventory: heartbeat hooks, mid-run steering,
local-runtime presets, a plugin contract package, and release/install workflows
have implementations in this repository. Current details belong in
[Heartbeat](HEARTBEAT.md), [Agent architecture](AGENT-ARCHITECTURE.md),
[Custom providers](CUSTOM-PROVIDERS.md), [Plugins](PLUGINS.md), and
[Testing](TESTING.md).

Several original conclusions were too strong and have been withdrawn:

- Source size, test-file ratios, TODO counts, and feature checkmarks do not
  establish relative engineering quality.
- A swarm ledger reconciles interrupted nodes; it does not resume arbitrary
  interrupted agent computation. Receipts record observed tool activity and
  explicitly do not certify correctness or security.
- Tenant scoping, vault encryption, and prompt guards are implemented controls,
  not evidence of “governance-grade security.” Red-team CI is a fixture-generation
  dry-run, not a measured adversarial success rate.
- No conclusion about one architecture's inability to support a feature follows
  from this inventory. No comparative performance or reliability benchmark was
  run for this document.

Use the [current consolidation plan](plans/product-consolidation-2026-09.md)
for improvement priorities instead of the original comparative ranking.
