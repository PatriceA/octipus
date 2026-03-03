# Assistant

A multi-channel autonomous development agent with an extensible skill system, encrypted vault, three-tier permissions, and a web UI. Built with Bun, Elysia, Drizzle ORM, and Next.js.

## Dependencies

### Required

| Dependency | Version | Purpose |
|------------|---------|---------|
| [Bun](https://bun.sh) | >= 1.1.0 | Runtime for backend, tests, scripts |
| [Node.js](https://nodejs.org) | >= 18 | Required by Next.js web UI |
| [Docker](https://docs.docker.com/get-docker/) | any | Runs PostgreSQL, Redis, Ollama |
| PostgreSQL | 15 | Database (via `pgvector/pgvector:pg15` Docker image) |
| Redis | any | Caching, sessions, pub/sub, queues |

### Optional

| Dependency | Purpose |
|------------|---------|
| [Ollama](https://ollama.ai) | Local LLM inference (runs via Docker) |
| [LiteLLM](https://litellm.ai) | Unified proxy for OpenAI, Anthropic, Ollama |
| [SearXNG](https://docs.searxng.org/) | Meta-search engine for web search skill |
| Telegram Bot Token | Telegram channel support |
| Slack App Tokens | Slack channel support |
| Teams App Credentials | Microsoft Teams channel support |
| Playwright browsers | Browser automation skill (`bunx playwright install`) |
| Claude Code / Gemini CLI / Codex | Free subscription-based CLI model providers |

### Docker Services

The project uses shared Docker services from a `docker-compose.yml`. These must be running before starting the assistant:

```bash
# Start required services
cd ~/docker-services
docker compose up -d db redis

# Start optional services
docker compose up -d ollama litellm searxng
```

| Service | Port | Image | Required |
|---------|------|-------|----------|
| PostgreSQL | 5432 | `pgvector/pgvector:pg15` | Yes |
| Redis | 6379 | `redis:alpine` | Yes |
| Ollama | 11434 | `ollama/ollama:rocm` | No |
| Ollama 2 | 11435 | `ollama/ollama:rocm` | No |
| LiteLLM | 4000 | `ghcr.io/berriai/litellm:main-latest` | No |
| SearXNG | 8888 | `searxng/searxng:latest` | No |
| N8N | 5678 | `n8nio/n8n` | No |
| Open WebUI | 3000 | `ghcr.io/open-webui/open-webui:main` | No |

## Quick Start

```bash
# 1. Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install
cd assistant
bun install
cd web && bun install && cd ..

# 3. Configure
cp .env.example .env
# Edit .env with your database password, security keys, etc.
# Or run the interactive setup wizard:
bun run setup

# 4. Create the database (if it doesn't exist)
docker exec <db-container> psql -U <superuser> -c "CREATE DATABASE assistant;"
docker exec <db-container> psql -U <superuser> -d assistant -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker exec <db-container> psql -U <superuser> -d assistant -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

# 5. Start everything
bin/assistant start
```

The `assistant start` command will:
- Check that PostgreSQL and Redis are reachable
- Start the backend API server
- Start the Next.js web UI
- Wait for the health check to pass
- Open your browser to the web UI

### CLI Management

```bash
assistant start          # Start backend + web UI, open browser
assistant start --dev    # Start in dev mode (hot reload)
assistant stop           # Stop all assistant processes
assistant restart        # Stop + start
assistant status         # Show running state and service health
assistant logs           # Tail backend logs
assistant logs --web     # Tail web UI logs
assistant open           # Open web UI in browser
```

To make the `assistant` command available globally:

```bash
bun link    # Creates global symlink
```

### Desktop App (Linux)

To add Assistant to your application menu:

```bash
cp assistant.desktop ~/.local/share/applications/
```

### Desktop App (macOS)

Create an Automator application or add to Dock. The CLI script auto-detects macOS and uses `open` for browser launch.

### Desktop App (Windows)

Use the `bin/assistant.cmd` batch script. Create a shortcut to `assistant.cmd start` on your desktop or pin to taskbar.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web UI (Next.js :3007)                   │
├─────────────────────────────────────────────────────────────────┤
│                     API Server (Elysia :3005)                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  REST API │ │WebSocket │ │  Swagger │ │Auth Guard│          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
├─────────────────────────────────────────────────────────────────┤
│                        Core Runtime                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  Agent   │ │  Agent   │ │  Router  │ │Scheduler │          │
│  │ Manager  │ │  Worker  │ │          │ │          │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
├──────────┬──────────┬──────────┬──────────┬────────────────────┤
│ Channels │  Skills  │ Security │  Models  │   Integrations     │
│──────────│──────────│──────────│──────────│────────────────────│
│ Telegram │Filesystem│ Sessions │ Ollama   │ MCP Bridge         │
│ Slack    │ Shell    │ Passkeys │ OpenAI   │ N8N Workflows      │
│ Teams    │ Git      │ TOTP 2FA │Anthropic │ Hooks/Automation   │
│ WebChat  │ Browser  │ Vault    │ Gemini   │ Voice (STT/TTS)    │
│          │          │Permissions│CLI Tools│ Pipelines          │
│          │          │ Notifs   │ LiteLLM  │ Notifications      │
├──────────┴──────────┴──────────┴──────────┴────────────────────┤
│                      Data Layer                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ PostgreSQL   │  │    Redis     │  │   Drizzle    │          │
│  │ + pgvector   │  │   Cache/PubSub│ │     ORM      │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Core Agent Runtime
- **Agent Manager**: Spawns and manages autonomous agents with concurrency control
- **Agent Worker**: Thought-Action-Observation loop with tool calling, context compaction (LLM-summarized), and event emission
- **Orchestrator**: Multi-agent orchestration — classifies messages, spawns role-specific workers, handles fallback routing
- **Router**: Topic-based model routing (keyword matching + optional LLM classification)
- **Scheduler**: Cron-based and priority task scheduling
- **Gateway**: System initialization, lifecycle management, graceful shutdown
- **Context Compaction**: Automatic LLM-summarized context window management when conversations exceed token limits
- **Token Budget**: Per-agent token limit (default: 100k, env `AGENT_MAX_TOKEN_BUDGET`) — stops runaway agents before they exhaust provider quotas
- **Agent Timeout**: Per-agent wall-clock timeout (default: 5min, env `AGENT_DEFAULT_TIMEOUT`)
- **Consecutive Failure Protection**: Tools are automatically disabled after 3 consecutive failures, forcing the model to respond with available information instead of looping

### API Server
- **Framework**: Elysia with Swagger/OpenAPI documentation at `/swagger`
- **REST API**: Full CRUD for agents, sessions, models, hooks, vault, users, permissions
- **WebSocket**: Real-time chat messages, typing indicators, session management
- **Agent Events**: REST polling API (`GET /agents/:id/events?after=<cursor>`) with sequential event IDs and ring buffer (max 200 events)
- **Auth Guard**: JWT-based middleware with public path whitelist
- **Health Checks**: Basic, detailed, readiness, and liveness probes

### Multi-Channel Support
- **Telegram**: Bot commands (`/start`, `/help`, `/new`, `/status`, `/agents`, `/stop`, `/link`)
- **Slack**: Socket Mode with slash commands and message threading
- **Microsoft Teams**: Bot mention-based commands
- **WebChat**: WebSocket-based web interface
- **User Linking**: Cross-channel identity binding with link codes

### Orchestrator
- **Message Classification**: Classifies incoming messages as casual/task/agent with confidence scoring
- **Automatic Orchestration**: Task messages spawn an orchestrator agent that breaks work into sub-tasks
- **Worker Agents**: Orchestrator spawns role-specific workers (research, coding, review, qa, communication, general)
- **Fallback Chain**: CLI models → default model → any local model with tool support
- **Reasoning Model Detection**: Automatically skips reasoning models (DeepSeek Reasoner, etc.) for orchestration since they're incompatible with the tool-calling agent loop
- **CLI Sub-Agent Fallback**: When CLI models fail (quota exhausted), retries with the default local model
- **Safe Fallback**: Only falls back to local (Ollama) models for tool-calling roles — never silently routes to paid API models

### Skills System
8 built-in skills with granular permissions:

| Skill | Tools | Permission Level |
|-------|-------|-----------------|
| **Filesystem** | read_file, write_file, append_file, list_directory, file_info, create_directory, delete_file, copy_file, move_file, search_files | read: ALLOW, write: ASK, delete: ASK |
| **Shell** | run, run_background, which, env | execute: ASK, elevated: DENY |
| **Git** | status, log, diff, add, commit, branch, checkout, pull, push, stash, reset, clone | read: ALLOW, write: ASK, push: ASK |
| **Browser** | open, navigate, click, type, screenshot, get_text, get_html, evaluate, wait_for, close, select, scroll | navigate: ASK, screenshot: ALLOW, execute: ASK |
| **Web Search** | search, fetch_page | search: ALLOW, fetch: ALLOW |
| **Docker** | list_containers, start_container, stop_container, container_logs, build_image, exec_command | read: ALLOW, manage: ASK |
| **Google Workspace** | gmail_list, gmail_search, gmail_read, gmail_send, gmail_reply, gmail_labels, gmail_label, gmail_delete, calendar_list, calendar_events, calendar_event_get/create/update/delete, drive_list, drive_search, drive_download/upload/delete, sheets_read/write/create/info, docs_read/create/update, contacts_list/search/get/create, tasks_lists/list/get/create/complete | read: ALLOW, send: ASK, delete: ASK |
| **Microsoft 365** | mail_list, mail_search, mail_read, mail_send, mail_reply, mail_folders, mail_delete, calendar_list, calendar_events, calendar_event_get/create/update/delete, drive_list, drive_search, drive_download/upload/delete, todo_lists/tasks/task_get/task_create/task_complete, contacts_list/search/get/create | read: ALLOW, send: ASK, delete: ASK |

### Orchestrator Roles

When a task message arrives, the orchestrator classifies it and spawns a specialist worker with the appropriate role. Each role has a set of skills (and their tools) attached to it.

| Role | Topic | Skills | Tools |
|------|-------|--------|-------|
| **orchestrator** | general | *(meta-tools only)* | `spawn_worker`, `create_pipeline`, `filter_pii`, `request_user_approval`, `send_status_update` |
| **research** | analysis | browser, websearch | `open`, `navigate`, `click`, `type`, `screenshot`, `get_text`, `get_html`, `evaluate`, `wait_for`, `close`, `select`, `scroll`, `search`, `fetch_page` |
| **coding** | coding | filesystem, shell, git | `read_file`, `write_file`, `append_file`, `list_directory`, `file_info`, `create_directory`, `delete_file`, `copy_file`, `move_file`, `search_files`, `run`, `run_background`, `which`, `env`, `status`, `log`, `diff`, `add`, `commit`, `branch`, `checkout`, `pull`, `push`, `stash`, `reset`, `clone` |
| **review** | analysis | filesystem, git | `read_file`, `write_file`, `append_file`, `list_directory`, `file_info`, `create_directory`, `delete_file`, `copy_file`, `move_file`, `search_files`, `status`, `log`, `diff`, `add`, `commit`, `branch`, `checkout`, `pull`, `push`, `stash`, `reset`, `clone` |
| **qa** | analysis | browser, shell, docker | `open`, `navigate`, `click`, `type`, `screenshot`, `get_text`, `get_html`, `evaluate`, `wait_for`, `close`, `select`, `scroll`, `run`, `run_background`, `which`, `env`, `list_containers`, `start_container`, `stop_container`, `container_logs`, `build_image`, `exec_command` |
| **communication** | general | google-workspace, microsoft365 | `gmail_list`, `gmail_search`, `gmail_read`, `gmail_send`, `gmail_reply`, `gmail_labels`, `gmail_label`, `gmail_delete`, `calendar_list`, `calendar_events`, `calendar_event_get`, `calendar_event_create`, `calendar_event_update`, `calendar_event_delete`, `drive_list`, `drive_search`, `drive_download`, `drive_upload`, `drive_delete`, `sheets_read`, `sheets_write`, `sheets_create`, `sheets_info`, `docs_read`, `docs_create`, `docs_update`, `contacts_list`, `contacts_search`, `contacts_get`, `contacts_create`, `tasks_lists`, `tasks_list`, `tasks_get`, `tasks_create`, `tasks_complete`, `mail_list`, `mail_search`, `mail_read`, `mail_send`, `mail_reply`, `mail_folders`, `mail_delete`, `todo_lists`, `todo_tasks`, `todo_task_get`, `todo_task_create`, `todo_task_complete` |
| **general** | general | filesystem, shell | `read_file`, `write_file`, `append_file`, `list_directory`, `file_info`, `create_directory`, `delete_file`, `copy_file`, `move_file`, `search_files`, `run`, `run_background`, `which`, `env` |

**Routing keywords** — the classifier uses these to suggest a role before the orchestrator decides:

| Category | Keywords |
|----------|----------|
| development | implement, build, create, develop, code, write, add, refactor, fix, debug, deploy, setup, configure, install, migrate, upgrade, integrate, api, endpoint, database, frontend, backend, component, feature, function, class, module, service, test, dockerfile, docker, ci/cd, pipeline, typescript, javascript, python, rust, go, java, sql, css, html, react, next.js, vue, angular, node, bun, npm, package |
| research | research, investigate, find out, look up, search for, compare, evaluate, analyze, what is, how does, why does, explain, summarize, review, assess, benchmark, survey, learn about, study, explore, alternatives, best practices, architecture, design pattern, pros and cons |
| communication | email, gmail, inbox, mail, send email, read email, calendar, schedule, meeting, appointment, event, contacts, address book, drive, docs, sheets, slides, google docs, outlook, office 365, microsoft 365, teams, compose, reply, forward, draft |
| general | run, execute, check, monitor, update, clean, organize, automate, schedule, notify, track, manage, generate, convert, transform, parse, process, extract, scrape |

### Security
- **Authentication**: JWT sessions, WebAuthn/Passkeys, TOTP 2FA
- **Authorization**: Three-tier permissions (ALLOW / ASK / DENY) with conditions (path patterns, command patterns, time windows, rate limits)
- **Encrypted Vault**: AES-256-GCM encrypted credential storage with per-skill/agent access control
- **Secret Injection**: Template-based secret substitution in tool arguments (`{{secret:name}}`)
- **Audit Logging**: All security events logged with user, action, resource tracking

### Model Management
- **Direct Providers**: Native integrations for Ollama, OpenAI, Anthropic, and Gemini (no proxy required)
- **LiteLLM Proxy**: Optional unified proxy as catch-all fallback
- **CLI Providers**: Free subscription-based models via Claude Code, Gemini CLI, Codex CLI
- **Provider Router**: Routes through CLI → Ollama → OpenAI → Anthropic → Gemini → LiteLLM (priority order)
- **Topic Roles**: Per-topic primary/backup model assignment for automatic failover
- **Quota Tracker**: Redis-backed daily usage tracking with auto-clearing exhaustion detection
- **Cost Tracker**: Per-model input/output token cost tracking and aggregation
- **Health Checker**: Periodic provider health monitoring with latency measurements
- **Model Registry**: Database-backed model configuration with default model stored in DB (not env vars)
- **Extra Body Parameters**: Per-model custom parameters via `metadata.extraBody` (e.g. `{ think: false }` for Qwen3 to fix LiteLLM tool-calling compatibility)
- **Model Test Endpoint**: Pre-registration connection test (`POST /api/models/test`) that validates via LiteLLM first, then direct Ollama, supporting namespaced model IDs

### MCP Integration
- **Stdio Transport**: Subprocess-based MCP servers
- **SSE Transport**: HTTP streaming for remote MCP servers
- **Tool/Resource/Prompt discovery**: Automatic enumeration from connected servers
- **MCP Server Bridge**: Standalone MCP server (`mcp-server/`) that exposes assistant capabilities as MCP tools for CLI models (Claude Code, Gemini CLI)

### MCP Server (assistant-mcp-server)

Exposes the assistant's capabilities as MCP tools for external CLI models.

| Tool | Description |
|------|-------------|
| `assistant_search` | Search the web via SearXNG |
| `assistant_fetch_page` | Fetch and extract text from a URL (browser-rendered) |
| `assistant_list_agents` | List running agents with status |
| `assistant_spawn_agent` | Spawn a new autonomous agent |
| `assistant_stop_agent` | Stop a running agent |
| `assistant_send_message` | Send a message to a running agent |
| `assistant_get_agent_events` | Get agent events (polling with cursor) |
| `assistant_list_sessions` | List recent chat sessions |
| `assistant_get_messages` | Get messages from a session |
| `assistant_list_models` | List available AI models |
| `assistant_model_health` | Get model health status |
| `assistant_chat` | Send a message through the orchestrator |
| `assistant_list_skills` | List available skills and tools |
| `assistant_execute_skill` | Execute any skill tool (filesystem, shell, git, docker, etc.) |

**Setup:**
```bash
cd mcp-server && npm install && npm run build
```

**Claude Code** (`.mcp.json` at project root):
```json
{
  "mcpServers": {
    "assistant": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "ASSISTANT_URL": "http://localhost:3005",
        "ASSISTANT_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

**Gemini CLI** (`.gemini/settings.json`):
```json
{
  "mcpServers": {
    "assistant": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "ASSISTANT_URL": "http://localhost:3005",
        "ASSISTANT_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

### Hooks & Automation
- **Triggers**: message_received, agent_started/completed/failed, tool_executed, permission_requested, schedule (cron), webhook
- **Actions**: notify, spawn_agent, webhook, n8n_workflow, execute_skill
- **Features**: Conditional execution, cooldowns, max execution limits, priority ordering

### Voice
- **STT**: Whisper.cpp (local), Faster-Whisper (Python)
- **TTS**: Piper (local neural), Edge TTS (Microsoft), Coqui (local neural)
- **Wake Word**: Sherpa-ONNX (local), Picovoice/Porcupine (cloud), VAD fallback

### Visual Debugger
- Playwright-based screenshot capture and element detection
- Vision model analysis for UI issue detection
- Accessibility compliance checking
- Interactive debug sessions with click/type/navigate
- Automated test code generation

### Pipelines
- **Multi-Stage Workflows**: Sequential stage execution with per-stage model routing
- **User Templates**: Create, edit, and reuse pipeline templates from the web UI
- **Approval Gates**: Optional approval checkpoints between stages (approve, skip, or stop)
- **Topic-Based Routing**: Each pipeline step specifies a topic; the best model for that topic is selected automatically
- **Real-Time Events**: Pipeline progress streamed via WebSocket

### Notifications
- **Persistent Storage**: All notifications stored in PostgreSQL
- **Real-Time Push**: WebSocket delivery for instant updates
- **Event Sources**: Agent completion/failure, pipeline completion/failure, approval requests
- **Notification Bell**: Unread count badge in header, mark read / mark all read

### Database
- **ORM**: Drizzle with PostgreSQL
- **Tables**: users, sessions, messages, model_config, cost_log, audit_log, vault, hooks, skill_permissions, permission_requests, embeddings, pipelines, pipeline_stages, pipeline_templates, notifications
- **pgvector**: Optional extension for vector similarity search on embeddings
- **Migrations**: Auto-run on startup (skip with `SKIP_MIGRATIONS=true`)

### Web UI (Next.js)

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | System status, health, agent overview |
| Login | `/login` | Authentication with password / passkey / TOTP |
| Chat | `/chat` | Interactive chat with agents, persistent sessions, voice input |
| Agents | `/agents` | List all agents (including orchestrators), 2s polling refresh |
| Agent Detail | `/agents/:id` | Real-time event timeline (thought/action/observation), 1.5s polling |
| Models | `/models` | Model configuration with provider dropdowns, topic roles, LiteLLM/Ollama auto-detect |
| Pipelines | `/pipelines` | Create and manage pipeline templates |
| Skills | `/skills` | Skill management |
| MCP | `/mcp` | MCP server connections |
| Hooks | `/hooks` | Create and manage automation hooks |
| Secrets | `/secrets` | Vault credential management |
| Settings | `/settings` | Provider API keys, 2FA setup, notification preferences |

**Chat Persistence**: Chat sessions are persisted across page reloads. The session ID is stored in localStorage and messages are restored from the backend on page load. All messages (including casual conversations) are persisted to the database.

### Terminal UI (Ink)
- 8 views: Dashboard, Agents, Chat, Logs, Models, Pipelines, Secrets, Settings
- Keyboard navigation: `[1]`-`[8]` for views, arrows, Tab, `[q]` quit
- Log filtering by level (all/info/warn/error)
- Model management (set default, toggle enable/disable)
- Pipeline template browsing with step detail

## Commands

### Core

| Command | Description |
|---------|-------------|
| `assistant start` | Start backend + web UI, open browser |
| `assistant start --dev` | Start with hot reload |
| `assistant stop` | Stop all processes |
| `assistant status` | Show running state |
| `assistant logs` | Tail backend logs |
| `assistant open` | Open web UI in browser |

### Package Scripts

| Command | Description |
|---------|-------------|
| `bun run start` | Start backend only |
| `bun run dev` | Start backend with hot reload |
| `bun run build` | Build for production |
| `bun run start:all` | Start everything (alias for `bin/assistant start`) |
| `bun run stop:all` | Stop everything (alias for `bin/assistant stop`) |

### Database

| Command | Description |
|---------|-------------|
| `bun run db:migrate` | Run database migrations |
| `bun run db:generate` | Generate migrations from schema changes |
| `bun run db:studio` | Open Drizzle Studio (database GUI) |

### Development

| Command | Description |
|---------|-------------|
| `bun test` | Run unit tests |
| `bun run test:e2e` | Run E2E API test suite |
| `bun run typecheck` | Type check without emitting |
| `bun run tui` | Start terminal UI |
| `bun run setup` | Interactive setup wizard |
| `bun run backup` | Backup database, Redis, config, vault |

## Configuration

Create a `.env` file or use `bun run setup` to generate one.

### Ports

| Service | Default Port | Env Var |
|---------|-------------|---------|
| Backend API | 3005 | `API_PORT` |
| WebChat | 3006 | `WEBCHAT_PORT` |
| Web UI | 3007 | `WEB_PORT` |

### Environment Variables

```env
# ─── Required ─────────────────────────────────────────────────
DATABASE_URL=postgres://user:password@localhost:5432/assistant
REDIS_URL=redis://localhost:6379

# Security keys (minimum 32 characters each, use `bun run setup` to generate)
MASTER_KEY=your-master-key-at-least-32-characters
JWT_SECRET=your-jwt-secret-at-least-32-characters
SESSION_SECRET=your-session-secret-at-least-32-chars

# ─── Server ───────────────────────────────────────────────────
API_PORT=3005
API_HOST=0.0.0.0
LOG_LEVEL=info
CORS_ORIGINS=http://localhost:3006,http://localhost:3007

# ─── Models ───────────────────────────────────────────────────
LITELLM_URL=http://localhost:4000      # LiteLLM proxy (optional)
OLLAMA_URL=http://localhost:11434      # Local Ollama (optional)
# Default model is configured in the database via the Models page.
# Provider API keys (OpenAI, Anthropic, Gemini) are stored in the encrypted vault.

# ─── Channels (optional) ─────────────────────────────────────
TELEGRAM_BOT_TOKEN=                    # From @BotFather
SLACK_BOT_TOKEN=                       # xoxb-...
SLACK_APP_TOKEN=                       # xapp-...
TEAMS_APP_ID=
TEAMS_APP_PASSWORD=
WEBCHAT_PORT=3006

# ─── Skills ───────────────────────────────────────────────────
AGENT_MAX_TOKEN_BUDGET=100000         # Per-agent token limit (0 = unlimited)
AGENT_DEFAULT_TIMEOUT=300000          # Per-agent timeout in ms (default: 5min)
AGENT_MAX_ITERATIONS=50               # Max iterations per agent loop

ENABLED_SKILLS=filesystem,shell,git,browser,websearch,docker
WORKSPACE_PATH=./workspace
SEARXNG_URL=http://localhost:8888         # SearXNG meta-search (optional)

# ─── Integrations (optional) ─────────────────────────────────
N8N_URL=http://localhost:5678
N8N_API_KEY=
MCP_GATEWAY_URL=http://localhost:8811

# ─── Migrations ──────────────────────────────────────────────
SKIP_MIGRATIONS=false                  # Set to true for production deploys

# ─── Voice (optional) ────────────────────────────────────────
WHISPER_MODEL_PATH=
PIPER_MODEL_PATH=
```

## API Reference

All API endpoints are under `/api` with JWT Bearer authentication (except health and auth).

Interactive documentation available at `http://localhost:3005/swagger`.

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Basic health check |
| GET | `/health/detailed` | No | Service status with latencies |
| GET | `/health/ready` | No | Readiness probe |
| GET | `/health/live` | No | Liveness probe |

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register new user |
| POST | `/api/auth/login` | No | Login with credentials (+ optional TOTP) |
| POST | `/api/auth/logout` | Yes | Logout and invalidate session |
| GET | `/api/auth/me` | Yes | Get current user info |
| POST | `/api/auth/passkey/register` | Yes | Register WebAuthn passkey |
| POST | `/api/auth/passkey/authenticate` | No | Authenticate with passkey |
| POST | `/api/auth/totp/setup` | Yes | Setup TOTP 2FA |
| POST | `/api/auth/totp/enable` | Yes | Enable TOTP after verification |
| POST | `/api/auth/totp/disable` | Yes | Disable TOTP 2FA |
| POST | `/api/auth/totp/verify` | Yes | Verify TOTP code |
| POST | `/api/auth/link` | Yes | Redeem channel link code |

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Spawn new agent |
| GET | `/api/agents/:id` | Get agent details |
| DELETE | `/api/agents/:id` | Stop and remove agent |
| POST | `/api/agents/:id/message` | Send message to agent |
| POST | `/api/agents/:id/pause` | Pause agent |
| POST | `/api/agents/:id/resume` | Resume paused agent |
| GET | `/api/agents/:id/events` | Get agent events (cursor-based: `?after=<seq>`) |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/messages` | Get session messages |

### Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List all models |
| POST | `/api/models` | Register new model |
| GET | `/api/models/:name` | Get model details |
| PATCH | `/api/models/:name` | Update model config |
| DELETE | `/api/models/:name` | Delete model |
| POST | `/api/models/:id/default` | Set as default model |
| GET | `/api/models/routing` | Get topic routing |
| GET | `/api/models/health` | Check provider health |
| GET | `/api/models/cli/status` | CLI tool availability |
| GET | `/api/models/cli/quota` | CLI quota status |
| GET | `/api/models/providers/ollama/models` | List available Ollama models |
| GET | `/api/models/providers/litellm/models` | List LiteLLM models |
| GET | `/api/models/providers/:provider/known` | Known models for a provider |

### Hooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hooks` | List all hooks |
| POST | `/api/hooks` | Create hook |
| GET | `/api/hooks/:id` | Get hook details |
| PUT | `/api/hooks/:id` | Update hook |
| DELETE | `/api/hooks/:id` | Delete hook |
| POST | `/api/hooks/:id/enable` | Enable hook |
| POST | `/api/hooks/:id/disable` | Disable hook |

### Vault

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/vault` | List credentials |
| POST | `/api/vault` | Store credential |
| PATCH | `/api/vault/:id` | Update credential |
| DELETE | `/api/vault/:id` | Delete credential |
| POST | `/api/vault/:id/rotate` | Rotate credential |

### Pipelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/pipelines` | List user's pipeline runs |
| GET | `/api/pipelines/:id` | Get pipeline detail with stages |
| POST | `/api/pipelines/:id/stop` | Stop a running pipeline |
| GET | `/api/pipelines/templates` | List pipeline templates |
| POST | `/api/pipelines/templates` | Create pipeline template |
| PUT | `/api/pipelines/templates/:id` | Update pipeline template |
| DELETE | `/api/pipelines/templates/:id` | Delete pipeline template |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List notifications (paginated) |
| POST | `/api/notifications/:id/read` | Mark notification as read |
| POST | `/api/notifications/read-all` | Mark all notifications read |

### Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio (base64) to text |

### Skills

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List registered skills |
| GET | `/api/skills/:id` | Get skill details |
| GET | `/api/skills/tools/all` | All tools (skills + MCP combined) |
| GET | `/api/skills/permissions` | User permission overrides |
| PUT | `/api/skills/permissions` | Set permission level |
| DELETE | `/api/skills/permissions/:skillId/:action` | Reset permission |
| POST | `/api/skills/:skillId/tools/:toolName/execute` | Execute a skill tool (MCP bridge) |

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a chat message |
| POST | `/api/chat/approve` | Respond to an approval request |

### WebSocket

Connect to `/ws?token=<jwt>` for real-time events:
- `subscribe` / `unsubscribe` — manage event subscriptions
- `message` — send chat message
- `agent.status` — agent status changes
- `agent.message` — agent responses
- `agent.tool_call` — tool execution events

## Troubleshooting

### pgvector Extension Requires Superuser

**Problem**: `CREATE EXTENSION vector` fails with "permission denied to create extension".

**Cause**: The `assistant` database user is not a superuser. PostgreSQL extensions must be created by a superuser.

**Solution**: Install the extension using the database superuser:
```bash
# Find your superuser name (check POSTGRES_USER in docker-services/.env)
docker exec <db-container> psql -U <superuser> -d assistant \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
After that, the non-superuser `assistant` role can use the extension normally. The migration code handles this gracefully — if the extension can't be created, it logs a warning and continues without vector search.

### Migration Error: "Can't find meta/_journal.json"

**Problem**: Drizzle ORM migrations fail because the metadata journal file is missing.

**Cause**: The migration SQL file exists but the Drizzle metadata directory (`src/db/migrations/meta/`) was not created.

**Solution**: Ensure the meta directory and journal exist:
```bash
mkdir -p src/db/migrations/meta
```
Create `src/db/migrations/meta/_journal.json`:
```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1708000000000,
      "tag": "0000_initial",
      "breakpoints": true
    }
  ]
}
```

### Collation Version Mismatch Warning

**Problem**: PostgreSQL warns about collation version mismatch on every query.

**Cause**: The database was created with a different OS/glibc version than the current container. This is harmless.

**Solution** (optional): Run inside the database container:
```sql
ALTER DATABASE assistant REFRESH COLLATION VERSION;
```

### Model Registry Duplicate Key on Restart

**Problem**: Server crashes with `Key (name)=(cli/codex-cli) already exists` on restart.

**Cause**: This was a bug where disabled models weren't found during the existence check, causing duplicate INSERT attempts. **Fixed** — the model registry now checks existence regardless of `isEnabled` status.

### Database Connection Failed

**Problem**: Server fails to start with PostgreSQL connection error.

**Solution**:
```bash
# Check PostgreSQL is running
cd ~/docker-services && docker compose ps db

# Start it if stopped
docker compose up -d db

# Verify connection
docker exec <db-container> psql -U <user> -d assistant -c "SELECT 1;"

# Check DATABASE_URL in .env matches your docker-services credentials
```

### Redis Connection Failed

**Problem**: Server fails to start with Redis connection error.

**Solution**:
```bash
# Check Redis is running
cd ~/docker-services && docker compose ps redis

# Start it if stopped
docker compose up -d redis

# Test connection
docker exec <redis-container> redis-cli ping
```

### LiteLLM Not Running

**Problem**: Model health checks fail, no LLM responses.

**Solution**:
```bash
cd ~/docker-services
docker compose up -d litellm

# Check logs
docker compose logs litellm

# Verify it's reachable
curl http://localhost:4000/health
```

### Port Conflicts

**Problem**: "Address already in use" on startup.

**Solution**: Check what's using the port and either stop it or change the port in `.env`:
```bash
# Check what's using a port
lsof -i :3005   # Backend
lsof -i :3007   # Web UI

# Or change ports in .env
API_PORT=3008
WEB_PORT=3009
```

### Browser Skill: Playwright Not Installed

**Problem**: Browser skill fails with "Executable doesn't exist".

**Solution**:
```bash
bunx playwright install chromium
```

## Development

### Project Structure

```
assistant/
├── bin/                  # CLI scripts (assistant start/stop)
├── src/
│   ├── api/              # REST API & WebSocket
│   │   ├── routes/       # Endpoint handlers
│   │   ├── middleware/    # Auth guard
│   │   ├── context.ts     # Elysia context plugin
│   │   ├── server.ts      # Server setup
│   │   └── websocket.ts   # WebSocket handler
│   ├── channels/          # Messaging channels
│   │   ├── telegram/      # grammY bot
│   │   ├── slack/         # Bolt.js integration
│   │   ├── teams/         # Bot Framework
│   │   ├── webchat/       # WebSocket chat
│   │   └── linking.ts     # Cross-channel user linking
│   ├── config/            # Zod-validated configuration
│   ├── core/              # Agent runtime
│   │   ├── agent-manager.ts
│   │   ├── agent-worker.ts
│   │   ├── gateway.ts
│   │   ├── router.ts
│   │   ├── scheduler.ts
│   │   ├── notification-service.ts  # Persistent notifications
│   │   ├── orchestrator/   # Orchestrator, pipeline manager, roles
│   │   └── types.ts
│   ├── db/                # Database layer
│   │   ├── schema/        # Drizzle table definitions
│   │   ├── repositories/  # Data access layer
│   │   ├── migrations/    # SQL migrations
│   │   ├── postgres.ts    # Connection management
│   │   └── redis.ts       # Redis cache wrapper
│   ├── hooks/             # Event-driven automation
│   ├── mcp/               # Model Context Protocol
│   │   ├── bridge.ts      # Server connection manager
│   │   ├── protocol.ts    # MCP message handling
│   │   └── transports/    # Stdio & SSE transports
│   ├── models/            # LLM management
│   │   ├── providers/     # Direct (Ollama, OpenAI, Anthropic, Gemini), CLI, LiteLLM
│   │   ├── litellm-client.ts
│   │   ├── model-registry.ts  # Topic roles (primary/backup), default model
│   │   ├── cost-tracker.ts
│   │   ├── quota-tracker.ts
│   │   └── health-checker.ts
│   ├── security/          # Auth & encryption
│   │   ├── auth/          # Session, passkey, TOTP
│   │   ├── vault.ts       # AES-256-GCM encrypted storage
│   │   ├── permissions.ts # Three-tier permission system
│   │   └── secret-injector.ts
│   ├── skills/            # Built-in tool implementations
│   │   ├── filesystem/
│   │   ├── shell/
│   │   ├── git/
│   │   ├── browser/
│   │   ├── websearch/     # SearXNG + Playwright fallback (Google, DuckDuckGo)
│   │   └── docker/
│   ├── utils/             # Crypto, logger, sanitize, context compaction
│   ├── visual/            # Playwright visual debugger
│   ├── voice/             # STT, TTS, wake word
│   └── index.ts           # Entry point
├── mcp-server/            # MCP server bridge for CLI models
│   ├── src/
│   │   ├── index.ts       # Entry point (stdio/HTTP transport)
│   │   ├── server.ts      # McpServer setup, tool registration
│   │   ├── client.ts      # HTTP client for assistant API
│   │   ├── auth.ts        # API key / JWT auth helper
│   │   └── tools/         # Tool definitions (search, agents, sessions, models, chat, skills)
│   ├── package.json
│   └── tsconfig.json
├── web/                   # Next.js 14 web UI
│   ├── app/               # App Router pages
│   ├── components/        # React components
│   └── lib/               # API client, stores
├── tui/                   # Ink terminal UI
│   └── views/             # Dashboard, Agents, Chat, Logs, Models, Pipelines, Secrets, Settings
├── scripts/               # Setup wizard, backup, E2E tests
├── assistant.desktop      # Linux desktop entry
├── .mcp.json              # Claude Code MCP server config
├── package.json
├── tsconfig.json
└── drizzle.config.ts
```

### Running Tests

```bash
# Unit tests
bun test

# Specific file
bun test src/utils/crypto.test.ts

# With coverage
bun test --coverage

# E2E tests (requires running server)
bun run test:e2e
```

### Adding a New Skill

1. Create `src/skills/myskill/index.ts`
2. Implement the skill with tool definitions, parameter schemas, and permission levels
3. Register it in the skill registry

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Backend Framework | Elysia |
| Database ORM | Drizzle |
| Database | PostgreSQL + pgvector |
| Cache | Redis (ioredis) |
| Web UI | Next.js 14, React 18, Tailwind CSS, Zustand, TanStack Query |
| Terminal UI | Ink (React for CLI) |
| LLM Client | OpenAI SDK (via LiteLLM proxy) |
| Telegram | grammY |
| Slack | Bolt.js |
| Teams | Bot Framework |
| Auth | argon2, @simplewebauthn/server, otplib |
| Browser | Playwright |
| Logging | Pino |
| Validation | Zod |

## Changelog

### 2026-03-03

#### Agent Lifecycle & Runtime Limits
- **Agent stop/kill**: Agents can now be fully stopped (not just paused) — new `stopped` status with dedicated UI controls (Stop for running, Remove for finished agents)
- **Token budget**: Per-agent token limit (default: 100k, env `AGENT_MAX_TOKEN_BUDGET`) prevents runaway agents from exhausting provider quotas
- **Agent timeout enforcement**: Wall-clock timeout checked before each LLM call in the agent loop
- **CLI fallback safety**: User-initiated stops no longer trigger fallback to the default model — only genuine failures (quota, crash) do

#### Communication Role & Skill Routing
- **Communication role**: New `communication` worker role with Google Workspace and Microsoft 365 skills — email, calendar, contacts, drive, docs, sheets, and tasks
- **Classifier keywords**: Email/gmail/calendar/drive/outlook keywords now route to the `communication` role instead of falling through to `research` (web search)
- **Orchestrator prompt**: Updated to include `communication` in the role picker hints

#### MCP Authentication
- **MASTER_KEY auth**: Backend now accepts the `MASTER_KEY` as a Bearer token for API access, enabling MCP server and external integrations without session-based auth
- **MCP config**: `.mcp.json` configured with MASTER_KEY for out-of-the-box MCP tool access

#### Web UI Modernization
- **Card design**: Standardized all cards to `ring-1 ring-gray-200/60 dark:ring-gray-700/60` with `rounded-xl` and `dark:bg-gray-800/90`
- **Page headers**: All pages now use icon accent block pattern for consistent header design
- **Color tokens**: Replaced hard-coded `bg-blue-600` with `bg-primary-600` across all pages
- **Cursor pointer**: Added `cursor-pointer` to all interactive buttons
- **Settings fixes**: Fixed CLI integration detection (GitHub/GitLab) — matches on skill `id` and `isInitialized` field
- **Vault dedup**: Managed secrets (OAuth credentials) no longer appear twice in the vault table

### 2026-03-02

#### MCP Server Bridge
- **MCP server package**: New `mcp-server/` package — exposes 14 assistant tools as MCP tools for CLI models (Claude Code, Gemini CLI) via stdio or HTTP transport
- **Tool categories**: Search (SearXNG), agents (spawn/list/stop/message/events), sessions, models, chat (orchestrator), and generic skill execution
- **Auth support**: API key (Bearer token) or username/password auto-login with JWT caching
- **Skill execution API**: New `POST /api/skills/:skillId/tools/:toolName/execute` endpoint bridges MCP tool calls to the assistant's skill system

#### E2E Test Suite
- **Extended to 56 tests** (from ~22): Added comprehensive coverage for skills, skill execution, MCP endpoints, hooks, agent spawning/events/routing, session CRUD/messages/pagination, model health/CLI status/usage, health (database, redis), and chat session continuity

### 2026-03-01

#### Orchestrator & Agent Runtime
- **Orchestrator**: Full multi-agent orchestration — classifies messages (casual/task), spawns role-specific workers (research, coding, analysis), manages worker lifecycle
- **Worker isolation**: Worker agents no longer load session history — they receive their task from the orchestrator and work only on that task. Fixes stale-message bugs with persistent sessions (Telegram)
- **Consecutive failure protection**: After 3 consecutive tool failures, tools are disabled (stripped from LLM request) and the model is forced to respond with available information instead of looping indefinitely
- **Empty response fix**: Agent loop no longer spins when model returns empty content without tool calls — immediately returns instead of hitting max iterations
- **Reasoning model detection**: Orchestrator auto-skips reasoning models (DeepSeek Reasoner, etc.) for orchestration since they're incompatible with tool-calling agent loops
- **Safe fallback routing**: Only falls back to local (Ollama) models for tool-calling roles — never silently routes to paid API models that could incur unexpected costs
- **CLI sub-agent fallback**: When CLI models fail (e.g., Gemini quota exhausted), automatically retries with the default local model using standard tool calling
- **Orchestrator max iterations**: Increased from 3 to 10 to accommodate slower models

#### Chat & Session Persistence
- **Chat session persistence**: Chat sessions survive page reloads — session ID stored in localStorage, messages restored from backend via `GET /sessions/:id/messages`
- **Casual message persistence**: All messages (including casual conversations) now persisted to the database. Previously, casual messages bypassed session creation entirely
- **Proper session resolution**: `resolveSession()` called for all message types (not just tasks), ensuring proper UUID session IDs instead of ephemeral WebSocket IDs

#### Web Search Skill
- **SearXNG integration**: Added SearXNG as primary search engine (meta-search, no bot blocking)
- **Multi-tier fallback**: SearXNG → Google (Playwright) → DuckDuckGo (Playwright)
- **Page fetching**: Playwright-based page content extraction with JS rendering, cookie banner removal, and main content detection

#### Model Management
- **Extra body parameters**: Per-model `metadata.extraBody` for custom provider parameters (e.g., `{ think: false }` for Qwen3 via Ollama)
- **Qwen3 tool-calling fix**: LiteLLM strips `tool_calls` when Ollama returns a `thinking` field (known bug). Fixed by passing `think: false` through both LiteLLM config and model metadata
- **Model test via LiteLLM**: Pre-registration test endpoint now checks LiteLLM first before testing Ollama directly — supports namespaced model IDs (e.g., `danielsheep/gpt-oss-20b-Unsloth`)
- **gpt-oss OpenAI endpoint**: gpt-oss models routed through Ollama's OpenAI-compatible `/v1` endpoint for better tool-calling compatibility
- **Model metadata in PATCH API**: `metadata` field now accepted in the model update endpoint

#### Agent Events & Web UI
- **Agent event polling**: REST polling API (`GET /agents/:id/events?after=<cursor>`) with sequential event IDs and ring buffer (max 200 events)
- **Event deduplication**: React Strict Mode no longer causes duplicate events in the timeline — deduplicated by event ID
- **Agent page refresh**: Polling interval reduced from 5s to 2s, all agent types visible (including orchestrators)
- **Agent detail timeline**: Real-time event timeline showing thought/action/observation/error events with 1.5s polling

#### Session History & DeepSeek Compatibility
- **History filtering**: Tool messages filtered from session history to prevent "tool must follow tool_calls" errors with strict models (DeepSeek)
- **Telegram session fix**: Persistent Telegram sessions no longer accumulate stale tool messages across agent runs

#### Infrastructure
- **SearXNG**: Added `searxng/searxng:latest` Docker container on port 8888
- **LiteLLM config**: Added qwen3:14b (with `think: false`), gpt-oss-20b-Unsloth (via openai/ prefix)

### 2026-02-28

#### Web UI Improvements
- **Add Model dialog**: Provider-aware model ID selection — Ollama models auto-detected, LiteLLM models listed, known models for cloud providers shown
- **Pipeline templates**: Template creation from web UI with multi-stage configuration
- **Notification bell**: Unread count badge, mark read / mark all read
- **Dashboard**: System health overview with agent status cards

## License

MIT
