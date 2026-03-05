# Assistant

A multi-channel autonomous agent with tools, domain knowledge skills, expert personas, encrypted vault, and a web UI. Built with Bun, Elysia, Drizzle ORM, and Next.js.

## Features

- **Multi-agent orchestration** — classifies messages, spawns specialist workers (coding, research, design, devops, security, etc.), supports teams and pipelines
- **16 agent roles** with 15 pre-configured expert personas and 20 domain knowledge skills
- **10 built-in tools** — filesystem, shell, git, browser, websearch, docker, google workspace, microsoft 365, knowledge base, messaging
- **Multi-channel** — Telegram, Slack, Microsoft Teams, WebChat
- **Model routing** — Ollama, OpenAI, Anthropic, Gemini, LiteLLM, CLI models (Claude Code, Gemini CLI, Codex)
- **Security** — JWT sessions, WebAuthn/passkeys, TOTP 2FA, AES-256 encrypted vault, three-tier permissions
- **MCP server** — exposes assistant as MCP tools for CLI models
- **RAG pipeline** — vector search knowledge base with pgvector
- **Hooks & automation** — event triggers, cron scheduling, N8N workflows
- **Voice** — STT (Whisper), TTS (Piper, Edge TTS), wake word detection
- **Web UI** (Next.js) and **Terminal UI** (Ink)

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| [Bun](https://bun.sh) | >= 1.1.0 | Runtime |
| [Node.js](https://nodejs.org) | >= 18 | Next.js web UI |
| [Docker](https://docs.docker.com/get-docker/) | any | PostgreSQL, Redis, Ollama |
| PostgreSQL | 15 | Database (`pgvector/pgvector:pg15`) |
| Redis | any | Cache, sessions, pub/sub |

Optional: Ollama, LiteLLM, SearXNG, Telegram/Slack/Teams tokens, Playwright (`bunx playwright install`).

## Quick Start

```bash
# 1. Install and configure
cd assistant
bun install
cd web && bun install && cd ..
cp .env.example .env    # or: bun run setup

# 2. Create the database
docker exec <db-container> psql -U <superuser> -c "CREATE DATABASE assistant;"
docker exec <db-container> psql -U <superuser> -d assistant -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker exec <db-container> psql -U <superuser> -d assistant -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

# 3. Start
bin/assistant start
```

### CLI

```bash
assistant start          # Start backend + web UI
assistant start --dev    # Dev mode (hot reload)
assistant stop           # Stop all processes
assistant status         # Show running state
assistant logs           # Tail backend logs
```

Make globally available with `bun link`.

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
│ Telegram │Filesystem│ Sessions │ Ollama   │ MCP Bridge      │
│ Slack    │ Shell    │ Passkeys │ OpenAI   │ Hooks           │
│ Teams    │ Git      │ TOTP 2FA │Anthropic │ Voice           │
│ WebChat  │ Browser  │ Vault    │ Gemini   │ Pipelines       │
│          │ Docker   │Permissions│LiteLLM  │ Notifications   │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│  PostgreSQL + pgvector  ·  Redis  ·  Drizzle ORM           │
└─────────────────────────────────────────────────────────────┘
```

**Concepts:** Tools (executable capabilities) → Skills (domain knowledge) → Experts (pre-configured personas) → Agents (runtime workers). See [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md).

## Documentation

| Document | Contents |
|----------|----------|
| [Agent Architecture](docs/AGENT-ARCHITECTURE.md) | Tools, skills, experts, agents, orchestration flow |
| [API Reference](docs/API.md) | All REST endpoints |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, ports, Docker services |
| [MCP Server](docs/MCP-SERVER.md) | MCP tools, CLI model setup |
| [Development](docs/DEVELOPMENT.md) | Project structure, commands, tech stack |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common issues and fixes |
| [Changelog](docs/CHANGELOG.md) | Release history |

## License

MIT
