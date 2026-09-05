# Octipus Documentation

The map for everything under `docs/`. Start with **Getting Started**, then jump to the area you need. For repo-wide context see the top-level [`README.md`](../README.md) and [`AGENT.md`](../AGENT.md).

## Getting Started

| Doc | What it covers |
|-----|----------------|
| [CONFIGURATION.md](CONFIGURATION.md) | Environment variables, ports, Docker services, and the settings you set before first boot. |
| [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) | How `.env` (first-boot seed), the DB `settings` table, and the vault interact — and why the DB wins at runtime. |
| [DOCKER.md](DOCKER.md) | Running Octipus and its services (Postgres, Ollama, LiteLLM) with Docker. |
| [SMALL-MODELS.md](SMALL-MODELS.md) | Running the whole stack on a single small local model. |

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
| [CHAT-COMMANDS.md](CHAT-COMMANDS.md) | The `/`-commands available in chat (expert, think, persona, compact, …). |
| [RAG.md](RAG.md) | The knowledge base: auto-indexing and hybrid (BM25 + vector) search. |
| [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md) | Notes, `[[wikilinks]]`, authored edges, graph traversal, Obsidian/Canvas interop. |
| [DOCUMENTS.md](DOCUMENTS.md) | Document ingestion, OCR, and management. |
| [ENRICHMENT.md](ENRICHMENT.md) | Reader, deep research, tasks, and email-triage enrichment features. |
| [ARTIFACTS.md](ARTIFACTS.md) | Live hosted HTML artifacts produced by agents. |
| [ARTIFACTS-COOKBOOK.md](ARTIFACTS-COOKBOOK.md) | Worked examples and recipes for building artifacts. |
| [HOOKS.md](HOOKS.md) | Event hooks and scheduled / recurring tasks. |
| [HEARTBEAT.md](HEARTBEAT.md) | Proactive periodic checks for due tasks and notifications, with per-user standing instructions. |
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
| [SWARM-RELIABILITY.md](SWARM-RELIABILITY.md) | Swarm receipts, scorer gates, and the crash-resume ledger. |
| [EXPERT-TOPIC-SKILL-ROUTING.md](EXPERT-TOPIC-SKILL-ROUTING.md) | How experts, topics, and skills are selected for a request. |
| [TOOL-ROUTING.md](TOOL-ROUTING.md) | How tools and experts are routed to agents. |
| [MULTI-REPO.md](MULTI-REPO.md) | Working across a suite of repos: the repo registry, dependency graph, and how agents navigate it. |
| [API.md](API.md) | REST + WebSocket API reference, and how to get an API token. |
| [architecture/gateway.md](architecture/gateway.md) | The gateway WS hub and command registry. |
| [architecture/MULTI-USER.md](architecture/MULTI-USER.md) | Multi-user model and per-user isolation. |
| [architecture/TUI-EDITOR.md](architecture/TUI-EDITOR.md) | The TUI code editor internals. |

## Development

| Doc | What it covers |
|-----|----------------|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Project layout, commands (`octi`, `npm run …`), and how to add tools / skills / experts. |
| [TESTING.md](TESTING.md) | Unit, integration, E2E, and web test suites. |
| [QA.md](QA.md) | Manual QA / feature-validation walkthroughs. |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Prometheus metrics, run correlation, and logging. |
| [guides/channel-adapter.md](guides/channel-adapter.md) | Guide: writing a new channel adapter. |
| [guides/tui.md](guides/tui.md) | Guide: the TUI client. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |

## Troubleshooting

| Doc | What it covers |
|-----|----------------|
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnosing connection, auth, model, and delivery issues; `octi doctor`. |
