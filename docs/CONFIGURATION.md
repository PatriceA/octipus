# Configuration

Create a `.env` file or use `bun run setup` to generate one interactively.

## Ports

| Service | Default Port | Env Var |
|---------|-------------|---------|
| Backend API | 3005 | `API_PORT` |
| WebChat | 3006 | `WEBCHAT_PORT` |
| Web UI | 3007 | `WEB_PORT` |

## Environment Variables

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
WHATSAPP_ACCESS_TOKEN=                 # Meta Cloud API token
WHATSAPP_PHONE_NUMBER_ID=             # From Meta dashboard
WHATSAPP_VERIFY_TOKEN=                 # Webhook verify token
WHATSAPP_APP_SECRET=                   # Meta App Secret
WEBCHAT_PORT=3006

# ─── Agent Limits ────────────────────────────────────────────
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

## Docker Services

The project uses shared Docker services. These must be running before starting:

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
| LiteLLM | 4000 | `ghcr.io/berriai/litellm:main-latest` | No |
| SearXNG | 8888 | `searxng/searxng:latest` | No |
