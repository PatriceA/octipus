# Assistant

Your own autonomous AI workforce. An orchestration platform that deploys specialized expert agents — each with their own tools, domain knowledge, and execution capabilities — to tackle complex tasks across coding, research, design, security, DevOps, and beyond.

Built for developers who want full control. Runs locally. No vendor lock-in. Every model provider, every channel, every skill — yours to configure.

## What It Does

**You send a message. The system figures out the rest.**

The orchestrator analyzes your request, classifies it, and deploys the right specialist agents with the right tools and knowledge. A coding question spawns a Coder agent with filesystem, shell, and git access plus software architecture expertise. A security audit spawns a Security Analyst with OWASP knowledge and penetration testing tools. Complex tasks get broken into sub-tasks and distributed across parallel agent teams.

### Intelligent Agent Orchestration
- **16 specialist roles** — coding, research, review, QA, design, DevOps, security, data engineering, AI/ML, finance, automation, project management, technical writing, communication, and more
- **15 pre-built expert personas** — Coder, Reviewer, UI/UX Designer, DevOps Engineer, Security Analyst, Data Engineer, AI Engineer, Financial Analyst, and others — each pre-loaded with relevant domain knowledge
- **20 domain knowledge skills** — software architecture, test automation, security practices, cloud platforms, database design, API design, machine learning, and more — injected into agent system prompts for grounded, expert-level responses
- **Dynamic teams and pipelines** — orchestrator spawns parallel agent teams or sequential multi-stage pipelines with approval gates

### Every Model Provider, One Interface
- **Local models** via Ollama — complete privacy, zero cost
- **Cloud providers** — OpenAI, Anthropic, Google Gemini with automatic failover
- **CLI model access** — Claude Code, Gemini CLI, Codex CLI (free tier supported)
- **LiteLLM proxy** — unified gateway to 100+ model providers
- **Smart routing** — topic-based model selection, quota tracking, cost monitoring, health checks

### Tools That Actually Do Things
- **Filesystem** — read, write, search, organize files and directories
- **Shell** — execute commands, run scripts, manage processes
- **Git** — full version control: commit, branch, push, pull, diff
- **Browser** — navigate, click, type, screenshot, extract content via Playwright
- **Web Search** — SearXNG meta-search with Playwright fallback
- **Docker** — manage containers, images, exec commands
- **Google Workspace** — Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks
- **Microsoft 365** — Outlook, Calendar, OneDrive, To Do, Contacts
- **Knowledge Base** — RAG pipeline with pgvector for semantic search
- **Cross-Channel Messaging** — send messages across any connected channel

### Reach Users Everywhere
- **Telegram** — full bot with slash commands and inline responses
- **Slack** — Socket Mode with slash commands and threading
- **Microsoft Teams** — bot mention-based interaction
- **WebChat** — real-time WebSocket interface via the web UI

### Enterprise-Grade Security
- **Authentication** — JWT sessions, WebAuthn passkeys, TOTP two-factor, HttpOnly session cookies
- **Rate limiting** — Redis sliding-window rate limiter with account lockout (exponential backoff)
- **Three-tier permissions** — ALLOW / ASK / DENY per tool action with path patterns, rate limits, and time windows
- **Input validation** — SSRF protection, command injection prevention, ReDoS-safe regex, WebSocket content sanitization
- **Encrypted vault** — AES-256-GCM credential storage with per-tool access control
- **Audit logging** — every action tracked with user, resource, and context
- **Hardened defaults** — HMAC webhook verification, generic error messages, restricted health endpoints, session limits

### Full Web UI and Terminal UI
- **Web dashboard** (Next.js) — editor-style 3-panel chat, agent monitoring, model management, pipeline builder, vault, hooks, settings
- **Terminal UI** (Ink) — full-featured TUI with dashboard, agents, chat, logs, models, pipelines, secrets
- **MCP server** — expose all capabilities as MCP tools for Claude Code, Gemini CLI, and other MCP clients

### Automation and Extensibility
- **Event hooks** — trigger actions on messages, agent events, tool calls, schedules, webhooks
- **Recurring tasks** — cron-based scheduling with full CRUD management
- **N8N integration** — connect to workflow automation
- **Custom skills and experts** — create your own domain knowledge and expert personas via API
- **Voice interface** — STT (Whisper), TTS (Piper, Edge TTS), wake word detection

## Requirements

| | |
|---|---|
| **[Bun](https://bun.sh)** >= 1.1 | Runtime for backend and scripts |
| **[Node.js](https://nodejs.org)** >= 18 | Required by Next.js web UI |

**Optional:** Docker, PostgreSQL, Redis, Ollama, LiteLLM, SearXNG, Telegram/Slack/Teams tokens, Playwright

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
│  Orchestrator  ·  Agent Manager  ·  Router  ·  Scheduler    │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Channels │  Tools   │ Security │  Models  │  Integrations   │
│ Telegram │Filesystem│ Sessions │ Ollama   │ MCP Server      │
│ Slack    │ Shell    │ Passkeys │ OpenAI   │ Hooks           │
│ Teams    │ Git      │ TOTP 2FA │Anthropic │ Voice           │
│ WebChat  │ Browser  │ Vault    │ Gemini   │ Pipelines       │
│          │ Docker   │Permissions│LiteLLM  │ Notifications   │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│  PostgreSQL/PGlite + pgvector  ·  Redis/In-Memory  ·  ORM  │
└─────────────────────────────────────────────────────────────┘
```

**Hierarchy:** Tools (executable capabilities) → Skills (domain knowledge) → Experts (pre-configured personas) → Agents (runtime workers) → Teams & Pipelines (parallel/sequential execution)

## Documentation

| | |
|---|---|
| **[Agent Architecture](docs/AGENT-ARCHITECTURE.md)** | How tools, skills, experts, and agents work together |
| **[API Reference](docs/API.md)** | Complete REST API with all endpoints |
| **[Configuration](docs/CONFIGURATION.md)** | Environment variables, ports, Docker services |
| **[MCP Server](docs/MCP-SERVER.md)** | Expose assistant as MCP tools for CLI models |
| **[Development](docs/DEVELOPMENT.md)** | Project structure, commands, tech stack |
| **[Troubleshooting](docs/TROUBLESHOOTING.md)** | Common issues and solutions |
| **[Changelog](docs/CHANGELOG.md)** | Release history |

## License

MIT
