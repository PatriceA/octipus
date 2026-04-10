<p align="center">
  <img src="docs/images/logo.png" alt="Assistant" width="600">
</p>

# Assistant

Your own autonomous AI workforce. An orchestration platform that deploys specialized expert agents — each with their own tools, domain knowledge, and execution capabilities — to tackle complex tasks across coding, research, design, security, DevOps, and beyond.

Built for developers who want full control. Runs locally. No vendor lock-in. Every model provider, every channel, every skill — yours to configure.

**Website:** [https://the-assistant.io](https://the-assistant.io)

## What It Does

**You send a message. The system figures out the rest.**

The orchestrator analyzes your request, classifies it, and deploys the right specialist agents with the right tools and knowledge. A coding question spawns a Coder agent with filesystem, shell, and git access plus software architecture expertise. A security audit spawns a Security Analyst with OWASP knowledge and penetration testing tools. Complex tasks get broken into sub-tasks and distributed across parallel agent teams.

### Intelligent Agent Orchestration
- **16 specialist roles** — coding, research, review, QA, design, DevOps, security, data engineering, AI/ML, finance, automation, project management, technical writing, communication, and more
- **15 pre-built expert personas** — Coder, Reviewer, UI/UX Designer, DevOps Engineer, Security Analyst, Data Engineer, AI Engineer, Financial Analyst, and others — each pre-loaded with relevant domain knowledge. Every expert now includes **structured prompts**: critical rules (constraints), deliverable templates (expected output format), and success metrics (evaluation criteria)
- **20 domain knowledge skills** — software architecture, test automation, security practices, cloud platforms, database design, API design, machine learning, and more — injected into agent system prompts for grounded, expert-level responses
- **Dynamic teams and pipelines** — orchestrator spawns parallel agent teams or sequential multi-stage pipelines with approval gates. Pipelines support **QA retry loops** (failed QA stages automatically retry the previous implementation stage with feedback, up to 3 retries) and **handoff context documents** (structured summaries of completed work, decisions, open questions, and artifacts passed between stages)

### Every Model Provider, One Interface
- **Local models** via Ollama — complete privacy, zero cost
- **Cloud providers** — OpenAI, Anthropic, Google Gemini with automatic failover
- **OpenRouter** — direct access to 200+ models with credit tracking
- **CLI model access** — Claude Code, Gemini CLI, Codex CLI (free tier supported)
- **LiteLLM proxy** — unified gateway to 100+ model providers
- **Smart routing** — topic-based model selection, quota tracking, cost monitoring, health checks
- **Thinking/reasoning budgets** — auto-managed token budgets for reasoning models with level-based scaling
- **Cross-model message transform** — tool call ID normalization across providers for seamless model switching
- **Adaptive rate limiting** — per-provider concurrency semaphores, token bucket RPM, circuit breaker with automatic failover. Redis-backed state
- **Provider conformance testing** — automated test suite validates all providers with capability-gated skipping
- **Model evaluation** — 8 quality evaluators with standard datasets and cross-model comparison

### Tools That Actually Do Things
- **Filesystem** — read, write, search files with per-file mutation queue for concurrent write safety
- **Shell** — execute commands via abstract backends (local, SSH, Docker) — swappable at runtime
- **Git** — commit, branch, push, diff
- **Browser** — navigate, interact, screenshot via Playwright
- **Web Search** — SearXNG meta-search
- **Docker** — manage containers and images
- **Google Workspace** — Gmail, Calendar, Drive, Docs, Sheets
- **Microsoft 365** — Outlook, Calendar, OneDrive, To Do
- **Email Processor** — batch email classification and actions
- **Browser Extension** — control user's real Chrome browser
- **Knowledge Base** — hybrid RAG search (BM25 + vector)
- **Document Processing** — OCR, PDF extraction, auto-indexing
- **People & Profiles** — store facts about people and orgs
- **GitHub/GitLab** — repos, issues, PRs, webhooks
- **Scheduling** — cron tasks, hooks, automations
- **Voice & Phone** — STT (Whisper), TTS (Piper/Edge), wake word, phone calls
- **Cross-Channel Messaging** — send messages across channels

### Gateway Hub — Unified WebSocket Protocol
- **Single entry point** — all clients connect to `/gateway` with typed Zod-validated protocol
- **Multi-client auth** — session tokens, local file tokens, HMAC keys, API keys
- **Central event bus** — typed pub/sub with pattern matching and per-session replay
- **Steering messages** — mid-run corrections via WebSocket that inject guidance before the next LLM call
- **Context compaction** — LLM-based summarization preserving file operation metadata, replacing simple truncation
- **12 gateway commands** — `/help`, `/status`, `/expert`, `/abort`, `/clear`, `/think`, `/cost`, and more
- **Channel feedback** — real-time emoji reactions and typing indicators across all channels
- **Rate limiting & budgets** — sliding window per-connection, connection limits per user/IP
- **TUI** — Ink-based terminal interface with permission prompts, cost tracking, synchronized output, tool state machine, paste markers, and file path completion

### Reach Users Everywhere
- **Telegram** — full bot with emoji reactions, typing indicator, `/expert` switching, permission prompts with tool details
- **Slack** — Socket Mode with emoji reactions, `/expert` switching, permission prompts
- **Microsoft Teams** — bot mention-based interaction with typing indicators
- **WhatsApp** — Meta Cloud API with webhook-based messaging, media support, HMAC signature verification, and message deduplication
- **WebChat** — real-time WebSocket interface via the web UI
- **TUI** — terminal chat interface with gateway protocol, local auth, auto-reconnect

### Enterprise-Grade Security
- **Authentication** — JWT sessions, WebAuthn passkeys, TOTP 2FA, HttpOnly cookies
- **Rule-based permissions** — three-tier ALLOW / ASK / DENY with `tool(matcher)` syntax, pre/post hooks
- **Prompt injection defense** — three-layer defense: system prompt hardening, input guard (39 regex patterns), output guard. Blocks adversarial inputs before and after LLM
- **Input validation** — SSRF protection, command injection prevention, ReDoS-safe regex
- **Encrypted vault** — AES-256-GCM credential storage with per-tool access control
- **Audit logging** — every action tracked with user, resource, and context

### Evaluation & Testing
- **Model eval** — `/eval conformance`, `/eval quality <model>`, `/eval compare` from chat. CLI: `bun run src/models/testing/run.ts`
- **Agent eval harness** — YAML-based test runner (`bun run eval`) with 13 assertion types for routing accuracy, tool usage, and response quality
- **Red-team testing** — 5 attack plugins, 49 test cases covering prompt injection, role confusion, tool misuse, data leakage, and off-topic drift
- **Eval UI** — web dashboard at `/eval` with pass rate charts, run comparison, regression detection, and red-team results
- **112 E2E API tests** — 22 test modules covering all major subsystems

### Full Web UI
- **Web dashboard** (Next.js) — editor-style 3-panel chat, agent monitoring, model management, pipeline builder, vault, hooks, eval dashboard, profiles, settings
- **MCP server** — expose all capabilities as MCP tools for Claude Code, Gemini CLI, and other MCP clients

### Automation and Extensibility
- **Event hooks & webhooks** — trigger actions on messages, tool calls, schedules, and inbound webhooks (GitHub, Stripe, n8n, etc.)
- **Recurring tasks** — cron-based scheduling with full CRUD management
- **Plugin system** — drop TypeScript/JS plugins into `extensions/`, hot-loaded at startup
- **Skill sharing** — export/import skills as JSON or markdown
- **Custom skills and experts** — create domain knowledge and expert personas via API
- **N8N integration** — connect to workflow automation

## Requirements

| | |
|---|---|
| **[Bun](https://bun.sh)** >= 1.1 | Runtime for backend and scripts |
| **[Node.js](https://nodejs.org)** >= 18 | Required by Next.js web UI |

**Optional:** Docker, PostgreSQL, Redis, Ollama, LiteLLM, SearXNG, Chromium, Telegram/Slack/Teams tokens, Playwright

**For RAG (knowledge base):** Requires an embedding model. Pull `nomic-embed-text` on Ollama (`ollama pull nomic-embed-text`) and register it in LiteLLM with topic `embedding`. Enables hybrid search (BM25 + vector) across indexed documents and code via pgvector.

**For document OCR:** Pull `glm-ocr` on Ollama (`ollama pull glm-ocr`). Enables automatic text extraction from uploaded images, PDFs, and scanned documents.

### Model Recommendations by Role

Not all models handle every role well. Local models (e.g. qwen3:14b, qwen3.5:35b) are fast and free but may loop or ignore tool results in agentic roles. Cloud models (deepseek-chat, gpt-4o, claude) handle complex tool orchestration more reliably.

| Role | Recommended | Notes |
|------|-------------|-------|
| **orchestrator** | qwen3:14b, deepseek-chat | Must support tool calling. Routing-only, low complexity |
| **coding** | qwen3:14b, qwen3.5:35b | Local models work well — filesystem/shell/git tools |
| **research** | deepseek-chat, gpt-4o | Web search + browser requires good instruction following |
| **general** | deepseek-chat, gpt-4o | Browser-ext interaction — local models tend to loop instead of answering |
| **review** | qwen3:14b, qwen3.5:35b | Read-only analysis, local models handle it fine |
| **qa** | deepseek-chat | Browser testing needs reliable tool sequencing |
| **devops / security** | qwen3.5:35b, deepseek-chat | Shell-heavy, benefits from larger context |
| **embedding** | nomic-embed-text | Via Ollama, for RAG/knowledge base |

Configure per-topic model routing in the web UI under **Settings → Models** or via the API.

## Quick Start (Docker)

```bash
docker compose up -d
```

- API: http://localhost:3015
- Web UI: http://localhost:3017
- See `docker-compose.yml` for configuration (PostgreSQL, Redis, environment variables)

## Quick Start (Embedded — Zero Dependencies)

No PostgreSQL or Redis needed. Data is stored locally using PGlite (in-process WASM PostgreSQL) and in-memory cache.

```bash
cd assistant && bun install
cd web && bun install && cd ..

bun run setup              # Interactive wizard — choose "Embedded" mode
bin/assistant start
```

## Quick Start (External — Full Production)

For production deployments with PostgreSQL + Redis:

```bash
cd assistant && bun install
cd web && bun install && cd ..

bun run setup              # Interactive wizard — choose "External" mode
# Or manually: cp .env.example .env and edit

# Create database (if needed)
docker exec <db-container> psql -U <superuser> -c "CREATE DATABASE assistant;"
docker exec <db-container> psql -U <superuser> -d assistant \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

bin/assistant start
```

## Mobile App

Flutter/Dart Android app with full feature parity with the web UI. iOS support is planned.

- Pair your device via **Settings → Mobile App** — scan the QR code to connect over LAN
- Full chat, agent monitoring, and tool access
- Repo: [github.com/PatriceA/mobile-assistant](https://github.com/PatriceA/mobile-assistant)

## CLI

The CLI handles everything — checks services, starts the backend, waits for health, starts the web UI, and opens your browser.

```bash
assistant start          # Start backend + web UI, open browser
assistant start --dev    # Development mode with hot reload
assistant restart        # Kill everything, start fresh
assistant stop           # Stop all processes
assistant status         # Full service health dashboard
assistant logs           # Tail backend logs
```

Make globally available: `bun link`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Web UI (Next.js :3007)                    │
├─────────────────────────────────────────────────────────────┤
│                  API Server (Elysia :3005)                   │
│    REST API  ·  WebSocket  ·  Swagger  ·  Auth Guard        │
├─────────────────────────────────────────────────────────────┤
│                      Core Runtime                           │
│  Orchestrator · Agent Manager · Router · Scheduler · Eval   │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Channels │  Tools   │ Security │  Models  │  Integrations   │
│ Telegram │Filesystem│ Sessions │ Ollama   │ MCP Server      │
│ Slack    │ Shell    │ Passkeys │ OpenAI   │ Hooks           │
│ Teams    │ Git      │ TOTP 2FA │Anthropic │ Voice/Phone     │
│ WhatsApp │ Browser  │ Vault    │ Gemini   │ Pipelines       │
│ WebChat  │ Docker   │Permissions│OpenRouter│ Notifications   │
│          │          │          │ LiteLLM  │                 │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│  PostgreSQL/PGlite + pgvector  ·  Redis/In-Memory  ·  ORM  │
└─────────────────────────────────────────────────────────────┘
```

**Hierarchy:** Tools (executable capabilities) → Skills (domain knowledge) → Experts (pre-configured personas) → Agents (runtime workers) → Teams & Pipelines (parallel/sequential execution)

## Documentation

| | |
|---|---|
| **[Tool & Expert Routing](docs/TOOL-ROUTING.md)** | What triggers which tool, role, and expert — with prompt examples |
| **[Agent Architecture](docs/AGENT-ARCHITECTURE.md)** | How tools, skills, experts, and agents work together |
| **[Channels](docs/CHANNELS.md)** | Telegram, Slack, Teams, WhatsApp, WebChat setup and configuration |
| **[Chat Commands](docs/CHAT-COMMANDS.md)** | Slash commands available in all channels (/help, /link, /status, /clear) |
| **[API Reference](docs/API.md)** | Complete REST API with all endpoints |
| **[Configuration](docs/CONFIGURATION.md)** | Environment variables, ports, Docker services |
| **[Browser Extension](docs/BROWSER-EXTENSION.md)** | Chrome extension for real browser control by AI agents |
| **[RAG / Knowledge Base](docs/RAG.md)** | Hybrid search (BM25 + vector), tiered content, auto-indexing |
| **[Capability Comparison](docs/CAPABILITY-COMPARISON.md)** | Feature-by-feature comparison with competitor |
| **[MCP Server](docs/MCP-SERVER.md)** | Expose assistant as MCP tools for CLI models |
| **[MCP Integration](docs/MCP-INTEGRATION.md)** | Connect external MCP servers (n8n, Brave, custom) with lazy tool discovery |
| **[Development](docs/DEVELOPMENT.md)** | Project structure, commands, tech stack |
| **[Hooks & Automation](docs/HOOKS.md)** | Event hooks, webhooks, cron tasks, and execution control |
| **[Webhooks](docs/WEBHOOKS.md)** | Receive events from GitHub, GitLab, and external services |
| **[Troubleshooting](docs/TROUBLESHOOTING.md)** | Common issues and solutions |
| **[Changelog](docs/CHANGELOG.md)** | Release history |

## License

MIT
