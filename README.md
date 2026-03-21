<p align="center">
  <img src="docs/images/logo.png" alt="Assistant" width="600">
</p>

# Assistant

Your own autonomous AI workforce. An orchestration platform that deploys specialized expert agents — each with their own tools, domain knowledge, and execution capabilities — to tackle complex tasks across coding, research, design, security, DevOps, and beyond.

Built for developers who want full control. Runs locally. No vendor lock-in. Every model provider, every channel, every skill — yours to configure.

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
- **CLI model access** — Claude Code, Gemini CLI, Codex CLI (free tier supported)
- **LiteLLM proxy** — unified gateway to 100+ model providers
- **Smart routing** — topic-based model selection, quota tracking, cost monitoring, health checks
- **Adaptive rate limiting** — per-provider concurrency semaphores, token bucket RPM, adaptive concurrency adjustment, priority request queuing, and exponential backoff. Circuit breaker per provider (closed/open/half-open) with automatic failover to LiteLLM. Redis-backed state

### Tools That Actually Do Things
- **Filesystem** — read, write, search, organize files and directories
- **Shell** — execute commands, run scripts, manage processes
- **Git** — full version control: commit, branch, push, pull, diff
- **Browser** — navigate, click, type, hover, drag, screenshot, PDF generation via Playwright
- **Web Search** — SearXNG meta-search with Playwright fallback
- **Docker** — manage containers, images, exec commands
- **Google Workspace** — Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks
- **Microsoft 365** — Outlook, Calendar, OneDrive, To Do, Contacts
- **Browser Extension** — control the user's real browser via Chrome extension with 24 commands: navigate, click, hover, scroll, drag, type, tabs, cookies, storage, console, network monitoring, dialog handling (existing cookies/auth, no bot detection)
- **Knowledge Base** — hybrid search (BM25 full-text + pgvector cosine similarity + Reciprocal Rank Fusion) with tiered content loading (L0 abstract / L1 overview / L2 full), automatic weekly cleanup of orphaned/stale/duplicate entries
- **Document Processing** — upload, dual-model OCR + vision analysis (deepseek-ocr for text extraction, vision model for image description), PDF text extraction via poppler, LLM categorization, and automatic knowledge base indexing
- **GitHub/GitLab** — repository management, issues, PRs, reviews, and webhook integration
- **Scheduling** — create and manage cron tasks, hooks, and event automations from within agent conversations
- **Cross-Channel Messaging** — send messages across any connected channel

### Reach Users Everywhere
- **Telegram** — full bot with slash commands and inline responses
- **Slack** — Socket Mode with slash commands and threading
- **Microsoft Teams** — bot mention-based interaction
- **WhatsApp** — Meta Cloud API with webhook-based messaging, media support, HMAC signature verification, and message deduplication
- **WebChat** — real-time WebSocket interface via the web UI

### Enterprise-Grade Security
- **Authentication** — JWT sessions, WebAuthn passkeys, TOTP two-factor, HttpOnly session cookies
- **Rate limiting** — Redis sliding-window rate limiter with account lockout (exponential backoff)
- **Three-tier permissions** — ALLOW / ASK / DENY per tool action with path patterns, rate limits, and time windows
- **Prompt injection defense** — three-layer defense-in-depth against adversarial inputs:
  - **System prompt hardening** — 8-rule security preamble prepended to every LLM system prompt (no admin modes, no credential fabrication, no destructive compliance, user messages treated as untrusted data)
  - **Input guard** (pre-LLM) — 39 regex patterns across 6 categories (prompt extraction, mode escalation, command injection, secret fishing, harmful requests, safety override). Destructive shell injections are blocked before reaching the model; other attacks append per-request security reminders to the system prompt
  - **Output guard** (post-LLM) — validates responses for system prompt leakage, fake admin mode activation, fabricated credentials, destructive compliance, and harmful content compliance. Compromised responses are replaced with safe canned messages
- **Input validation** — SSRF protection, command injection prevention, ReDoS-safe regex, WebSocket content sanitization
- **Encrypted vault** — AES-256-GCM credential storage with per-tool access control
- **Audit logging** — every action tracked with user, resource, and context
- **Hardened defaults** — HMAC webhook verification, generic error messages, restricted health endpoints, session limits

### Evaluation & Testing
- **Agent evaluation harness** — YAML-based test runner (`bun run eval`) for evaluating routing accuracy, tool usage, and response quality. 13 assertion types including `routes_to_role`, `classification`, `response_quality` (LLM-graded), `defense_held`, and `no_hallucination`. Supports unit and integration modes
- **Red-team testing** — 5 attack plugins with 49 test cases covering prompt injection, role confusion, tool misuse, data leakage, and off-topic drift. Severity levels and defense assertions per test. The three-layer defense system (system prompt hardening + input guard + output guard) is applied during evaluation, matching the real message processing pipeline
- **Model quality benchmarking** — results vary depending on the default orchestrator model. Use `bun run eval` and `bun run eval:red-team` to benchmark any model's quality and security resilience before deploying it. For example, `deepseek-chat` scores ~99% overall while local `qwen3.5:35b` scores ~92% — but both achieve 100% on red-team security tests thanks to the application-level defense layers
- **Eval UI** — web dashboard at `/eval` with summary cards, pass rate charts, assertion breakdowns, latency histograms, run comparison matrix with regression detection, and red-team results grouped by attack category. Supports triggering eval runs directly from the UI
- **112 E2E API tests** — 22 test modules covering health, auth, models, vault, sessions, agents, tools, MCP, pipelines, hooks, settings, experts, skills, recurring tasks, chat, documents, browser extension, messaging, knowledge, and channel webhooks

### Full Web UI and Terminal UI
- **Web dashboard** (Next.js) — editor-style 3-panel chat, agent monitoring, model management, pipeline builder, vault, hooks, eval dashboard, settings
- **Terminal UI** (Ink) — full-featured TUI with dashboard, agents, chat, logs, models, pipelines, secrets
- **MCP server** — expose all capabilities as MCP tools for Claude Code, Gemini CLI, and other MCP clients

### Automation and Extensibility
- **Event hooks** — trigger actions on messages, agent events, tool calls, schedules, and incoming webhooks with HMAC verification
- **Recurring tasks** — cron-based scheduling with full CRUD management
- **Webhook receiver** — accept events from GitHub, GitLab, Stripe, and any HMAC-signed service with auto-notification to channels
- **Channel progress feedback** — real-time status updates ("Got it, working on it", "Started coding agent") sent to Telegram/Slack/Teams during long-running tasks
- **N8N integration** — connect to workflow automation
- **Custom skills and experts** — create your own domain knowledge and expert personas via API
- **Voice interface** — STT (Whisper), TTS (Piper, Edge TTS), wake word detection

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
│ Teams    │ Git      │ TOTP 2FA │Anthropic │ Voice           │
│ WhatsApp │ Browser  │ Vault    │ Gemini   │ Pipelines       │
│ WebChat  │ Docker   │Permissions│LiteLLM  │ Notifications   │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│  PostgreSQL/PGlite + pgvector  ·  Redis/In-Memory  ·  ORM  │
└─────────────────────────────────────────────────────────────┘
```

**Hierarchy:** Tools (executable capabilities) → Skills (domain knowledge) → Experts (pre-configured personas) → Agents (runtime workers) → Teams & Pipelines (parallel/sequential execution)

## Documentation

| | |
|---|---|
| **[Agent Architecture](docs/AGENT-ARCHITECTURE.md)** | How tools, skills, experts, and agents work together |
| **[Channels](docs/CHANNELS.md)** | Telegram, Slack, Teams, WhatsApp, WebChat setup and configuration |
| **[Chat Commands](docs/CHAT-COMMANDS.md)** | Slash commands available in all channels (/help, /link, /status, /clear) |
| **[API Reference](docs/API.md)** | Complete REST API with all endpoints |
| **[Configuration](docs/CONFIGURATION.md)** | Environment variables, ports, Docker services |
| **[Browser Extension](docs/BROWSER-EXTENSION.md)** | Chrome extension for real browser control by AI agents |
| **[RAG / Knowledge Base](docs/RAG.md)** | Hybrid search (BM25 + vector), tiered content, auto-indexing |
| **[Capability Comparison](docs/CAPABILITY-COMPARISON.md)** | Feature-by-feature comparison with OpenClaw |
| **[MCP Server](docs/MCP-SERVER.md)** | Expose assistant as MCP tools for CLI models |
| **[MCP Integration](docs/MCP-INTEGRATION.md)** | Connect external MCP servers (n8n, Brave, custom) with lazy tool discovery |
| **[Development](docs/DEVELOPMENT.md)** | Project structure, commands, tech stack |
| **[Hooks & Automation](docs/HOOKS.md)** | Event hooks, webhooks, cron tasks, and execution control |
| **[Webhooks](docs/WEBHOOKS.md)** | Receive events from GitHub, GitLab, and external services |
| **[Troubleshooting](docs/TROUBLESHOOTING.md)** | Common issues and solutions |
| **[Changelog](docs/CHANGELOG.md)** | Release history |

## License

MIT
