# Octipus Documentation

The map for everything under `docs/`. Start with **Getting Started**, then jump to the area you need. For repo-wide context see the top-level [`README.md`](../README.md) and [`AGENT.md`](../AGENT.md).

Current improvement sequence: [Product consolidation](plans/product-consolidation-2026-09.md).
Phases 1–4 are implemented; live-provider measurements and the broader execution
review remain open in the [status report](reports/consolidation-2026-09-10.md).
The current execution reference is [Agent Architecture](AGENT-ARCHITECTURE.md).

## Getting Started

| Doc | What it covers |
|-----|----------------|
| [INSTALLATION.md](INSTALLATION.md) | Supported runtime, installer, manual setup, upgrades, and desktop prerequisites. |
| [CONFIGURATION.md](CONFIGURATION.md) | Environment variables, ports, Docker services, and the settings you set before first boot. |
| [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) | How `.env` (first-boot seed), the DB `settings` table, and the vault interact — and why the DB wins at runtime. |
| [DOCKER.md](DOCKER.md) | Running Octipus and its services (Postgres, Ollama, LiteLLM) with Docker. |
| [SMALL-MODELS.md](SMALL-MODELS.md) | Local text-model setup, embedding requirements, and capability limits. |

## Channels

| Doc | What it covers |
|-----|----------------|
| [CHANNELS.md](CHANNELS.md) | Telegram, Slack, Teams, WhatsApp, and WebChat setup — where each setting lives (vault / DB / `.env`-seed), account linking, and troubleshooting. |
| [WEBHOOKS.md](WEBHOOKS.md) | Receiving inbound events (GitHub, GitLab, generic) via HMAC-verified webhooks and reacting with agents. |
| [VOICE.md](VOICE.md) | Local STT/TTS/wake-word and phone calls via Twilio / Telnyx / Plivo. |
| [BROWSER-EXTENSION.md](BROWSER-EXTENSION.md) | The companion browser extension for real-browser control. |

## Providers & Models

| Doc | What it covers |
|-----|----------------|
| [DIRECT-PROVIDERS.md](DIRECT-PROVIDERS.md) | Native provider connections and credentials. |
| [CLI-AGENTS.md](CLI-AGENTS.md) | External CLI workers, sessions, permissions, and failure behavior. |
| [MODEL-ROUTING.md](MODEL-ROUTING.md) | Per-topic primary/backup/executor model bindings, resolution order, and the planner→executor cost split. |
| [LITELLM.md](LITELLM.md) | Routing every model call through a LiteLLM proxy; authentication and the "401 unreachable" fix. |
| [OLLAMA.md](OLLAMA.md) | Running Octipus on Ollama: model sizing, tool support, context length, iGPU, and lazy tool discovery. |
| [CUSTOM-PROVIDERS.md](CUSTOM-PROVIDERS.md) | Custom OpenAI-, Gemini-, and Anthropic-compatible endpoints that aren't backed by a first-party provider. |
| [EVALUATIONS.md](EVALUATIONS.md) | Model evaluation and provider conformance testing. |
| [CAPABILITY-COMPARISON.md](CAPABILITY-COMPARISON.md) | Feature-by-feature comparison against other platforms. |
| [OPENCLAW-COMPARISON.md](OPENCLAW-COMPARISON.md) | Feature, quality, and architecture comparison vs OpenClaw, with gap analysis. |

## Features

| Doc | What it covers |
|-----|----------------|
| [SPACES.md](SPACES.md) | Personal and shared spaces, access, registration, and personal models. |
| [MONITORS.md](MONITORS.md) | Scheduled checks and their delivery behavior. |
| [WORK-PLANS.md](WORK-PLANS.md) | Visible execution plans, proposals, and feedback in web and terminal clients. |
| [CHAT-COMMANDS.md](CHAT-COMMANDS.md) | The `/`-commands available in chat (skills, think, persona, compact, …). |
| [RAG.md](RAG.md) | The knowledge base: auto-indexing and hybrid (BM25 + vector) search. Also long-term memory retrieval — what goes in the block of user facts every turn, and how it is ordered. |
| [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md) | Notes, `[[wikilinks]]`, authored edges, graph traversal, Obsidian/Canvas interop. |
| [DOCUMENTS.md](DOCUMENTS.md) | Document ingestion, OCR, management, and exporting a deliverable as .docx / .xlsx. |
| [DATA-TOOLS.md](DATA-TOOLS.md) | Read-only SQL against a registered database or a workspace CSV, and how a connection is registered. |
| [ENRICHMENT.md](ENRICHMENT.md) | Reader, deep research, tasks, and email-triage enrichment features. |
| [INLINE-UI.md](INLINE-UI.md) | Interactive answers: small widgets inside a reply in the web chat and rooms — how they are written, isolated, saved as artifacts and switched off. |
| [ARTIFACTS.md](ARTIFACTS.md) | Live hosted HTML artifacts produced by agents. |
| [ARTIFACTS-COOKBOOK.md](ARTIFACTS-COOKBOOK.md) | Worked examples and recipes for building artifacts. |
| [HOOKS.md](HOOKS.md) | Event hooks and scheduled / recurring tasks. |
| [ONBOARDING.md](ONBOARDING.md) | The setup guide on the home page: use cases, questions, what it sets up and how. |
| [HEARTBEAT.md](HEARTBEAT.md) | Proactive periodic checks for due tasks and notifications, with per-user standing instructions. |
| [CASES.md](CASES.md) | Cases ("Vorgänge"), contacts and follow-ups: the shared records business modules build on, who sees them in a space, the `cases` tool and the API. |
| [TASK-BOARD.md](TASK-BOARD.md) | The work board on the tasks page: assignees, checkout leases, comments, dependency wakeups, the audit trail, and role agents that work their tasks. |
| [SPEND-BUDGETS.md](SPEND-BUDGETS.md) | Dollar spend budgets per user, role or workspace: warn and pause, what users see, and the admin screen. |
| [PLUGINS.md](PLUGINS.md) | Installing and building host-side plugins / extensions. |
| [MCP-INTEGRATION.md](MCP-INTEGRATION.md) | Connecting external MCP servers (client side) with lazy tool discovery. |
| [MCP-SERVER.md](MCP-SERVER.md) | The standalone MCP server Octipus exposes to CLI models. |
| [PROFILES.md](PROFILES.md) | People & profiles. |
| [PROMPTING.md](PROMPTING.md) | Prompting guidance, including the root agent persona. |
| [DESKTOP.md](DESKTOP.md) | The native desktop client (Tauri): thin-client connection to any backend, installation, and configuration. |

## Architecture

| Doc | What it covers |
|-----|----------------|
| [AGENT-ARCHITECTURE.md](AGENT-ARCHITECTURE.md) | The root agent → agent → subagent swarm model and how a message becomes work. |
| [EXECUTION-RELIABILITY.md](EXECUTION-RELIABILITY.md) | Execution outcomes, persistence, and reliability boundaries. |
| [ACTION-RECOVERY.md](ACTION-RECOVERY.md) | Failed actions and recovery controls. |
| [CHAT-CONTINUITY.md](CHAT-CONTINUITY.md) | Conversation continuity across turns and clients. |
| [SESSION-LEARNING.md](SESSION-LEARNING.md) | Session learning and review of reusable guidance. |
| [FLOW-GUARD.md](FLOW-GUARD.md) | Execution flow checks and their limits. |
| [SWARM-RELIABILITY.md](SWARM-RELIABILITY.md) | Swarm receipts, scorer gates, and the crash-resume ledger. |
| [LANE-ROLE-SKILL-ROUTING.md](LANE-ROLE-SKILL-ROUTING.md) | How a request picks a role, a model lane, and its skills. |
| [TOOL-ROUTING.md](TOOL-ROUTING.md) | How roles expose tools and resolve models for agents. |
| [MULTI-REPO.md](MULTI-REPO.md) | Working across a suite of repos: the repo registry, dependency graph, and how agents navigate it. |
| [API.md](API.md) | REST + WebSocket API reference, and how to get an API token. |
| [architecture/gateway.md](architecture/gateway.md) | The gateway WS hub and command registry. |
| [architecture/MULTI-USER.md](architecture/MULTI-USER.md) | Multi-user model and per-user isolation. |
| [architecture/TUI-EDITOR.md](architecture/TUI-EDITOR.md) | The TUI code editor internals. |

## Development

| Doc | What it covers |
|-----|----------------|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Project layout, commands (`octi`, `npm run …`), and how to add tools, skills, and roles. |
| [TESTING.md](TESTING.md) | Unit, integration, E2E, and web test suites. |
| [QA.md](QA.md) | Manual QA / feature-validation walkthroughs. |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Prometheus metrics, run correlation, and logging. |
| [guides/channel-adapter.md](guides/channel-adapter.md) | Guide: writing a new channel adapter. |
| [guides/tui.md](guides/tui.md) | Guide: the TUI client. |
| [guides/small-business.md](guides/small-business.md) | Guide: a small company's inbox, ideas and approvals on autopilot (heartbeat, inbox watch, role agents, pipelines). |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |

## Troubleshooting

| Doc | What it covers |
|-----|----------------|
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnosing connection, auth, model, and delivery issues; `octi doctor`. |

## Keeping the website aligned

Shared reference pages are published from this repository with
`scripts/sync-website-docs.mjs`. Edit the
repository guide, then sync it into the Astro website checkout:

```bash
node scripts/sync-website-docs.mjs /path/to/octipus-website
node scripts/sync-website-docs.mjs /path/to/octipus-website --check
npm --prefix /path/to/octipus-website run build
```

The page map (`scripts/website-docs-map.json`) preserves existing website URLs
and adds missing feature guides. The sync rewrites relative documentation links
to website routes; source and historical references link back to GitHub. Generated
pages use Markdown rather than MDX so code examples remain literal. Do not edit
the generated website copies directly. Website-only quick-start, runtime, security,
pipeline, tools, and web UI guides still need a code review when behavior changes.
Release notes and historical plans remain snapshots, not current feature references.

A successful sync check proves the shared text matches; it does not verify the
implementation or publish the website. Build and deploy the website separately.
