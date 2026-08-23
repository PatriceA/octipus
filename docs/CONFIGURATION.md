# Configuration

Create a `.env` file or use `bun run setup` to generate one interactively.

## Ports

| Service | Port | Env Var |
|---------|------|---------|
| Backend API | 3005 | `API_PORT` (or `PORT`) |
| Web UI | 3007 | — (fixed in `web/package.json`) |

`.env.example` ships `PORT=3005`, so that is the port you get from a normal
install; with neither `API_PORT` nor `PORT` set, the code falls back to 3000
(`src/config/bootstrap-loader.ts`). The web dev server is pinned to 3007 by
`next dev -p 3007` and is not read from the environment — under Docker
Compose the host-side ports are `OCTIPUS_API_PORT` (default 3015) and
`OCTIPUS_WEB_PORT` (default 3017), mapped onto 3005/3007 in the container.

## Environment Variables

```env
# ─── Required ─────────────────────────────────────────────────
DATABASE_URL=postgres://user:password@localhost:5432/octipus

# Security keys (minimum 32 characters each, use `bun run setup` to generate)
MASTER_KEY=your-master-key-at-least-32-characters
JWT_SECRET=your-jwt-secret-at-least-32-characters
SESSION_SECRET=your-session-secret-at-least-32-chars

# ─── Server ───────────────────────────────────────────────────
API_PORT=3005
API_HOST=0.0.0.0
LOG_LEVEL=info
CORS_ORIGINS=http://localhost:3007   # your web origin; code default is http://localhost:3001

# ─── Models ───────────────────────────────────────────────────
LITELLM_URL=http://localhost:4000      # LiteLLM proxy (optional)
OLLAMA_URL=                            # Ollama URL (optional — set in Settings > Configuration or here)
# Default model is configured in the database via the Models page.
# Provider API keys (OpenAI, Anthropic, Gemini) are stored in the encrypted vault.

# ─── First-boot model bootstrap (consumed once, then ignored) ─
# Written by `bun run setup` / `octi init`. On first boot,
# `bootstrapDefaultModel` reads these, seeds a single default
# model_config row, stores the API key in the vault, and stops
# touching .env. Editing these after first boot has no effect —
# use the Models page instead. See CONFIGURATION-PRECEDENCE.md.
BOOTSTRAP_PROVIDER=                    # ollama | litellm | openai | anthropic | gemini | deepseek | mistral | zai | moonshot | openrouter | cli
BOOTSTRAP_MODEL=                       # e.g. llama3.2:3b, gpt-4o-mini, claude-haiku-4-5-20251001
BOOTSTRAP_API_KEY=                     # required for cloud providers
BOOTSTRAP_BASE_URL=                    # for litellm: the proxy URL

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

# ─── Agent Limits ────────────────────────────────────────────
AGENT_MAX_TOKEN_BUDGET=100000         # Per-agent token limit (0 = unlimited)
AGENT_DEFAULT_TIMEOUT=900000          # Per-agent timeout in ms (default: 15min)
AGENT_MAX_ITERATIONS=50               # Max iterations per agent loop

WORKSPACE_PATH=./workspace
SEARXNG_URL=http://localhost:8888         # SearXNG meta-search (optional)

# ─── Integrations (optional) ─────────────────────────────────
N8N_URL=http://localhost:5678
N8N_API_KEY=
MCP_SERVERS_CONFIG=./mcp-servers.json     # Path to MCP client server config (see MCP-INTEGRATION.md)

# ─── Migrations ──────────────────────────────────────────────
SKIP_MIGRATIONS=false                  # Set to true for production deploys

# ─── Voice (optional) ────────────────────────────────────────
WHISPER_MODEL_PATH=
PIPER_MODEL_PATH=

# ─── Observability / Opt-outs ────────────────────────────────
TRAJECTORY_LOGGING=true                # Record one JSONL line per handleMessage run (default on)
SKILL_AUTO_EXTENSION=true              # Pattern-detect recurring topic/tool sequences into skill_proposals (default on)
SPINNER_STYLE=classic                  # TUI spinner style: classic | kawaii
```

## Topic → Model Routing (Authoritative)

Model resolution for every agent runs through `ModelRegistry.getModelForTopic(role)`. **There are no hardcoded model defaults.** Each role has a matching topic, and the model bound to that topic in the DB (or via the **Models** page in the web UI) is used.

Resolution order inside the swarm spawner (`SwarmSpawner.resolveChildModelAndExpert`):

1. Expert `modelPreference` — if the matched expert has an explicit preference.
2. `ModelRegistry.getModelForTopic(childRole)` — otherwise the model bound to the child's topic.
3. Throw — if neither resolves, with a message pointing at the Models page. No silent fallback.

- Orchestrator, Agent and Subagent children all resolve their model the same way — **children inherit topic bindings, not the parent's model.**
- The embedding path (`litellm-client.ts:embed()`) and vision path (`visual/analyzer.ts`) resolve the `embedding` / `vision` topic bindings the same way, or throw.

Bind models to topics via the web UI (**Settings → Models → Edit → Topics**) or the API (`PATCH /api/models/:name`).

## Swarm Config

| Key | Default | Purpose |
|---|---|---|
| `swarm.perUserSpawnsPerMinute` | 30 | Per-user rate limit on `spawn_child` invocations. Enforced by `rate-limiter.ts`. |
| `swarm.orphanReaperIntervalMs` | 600000 | Interval for the orphan reaper sweep that flips long-running `swarm_nodes` to `cancelled` after process restart. |

Swarm node hard budgets (tokens, wall-clock, fan-out) are baked into `src/core/swarm/types.ts` as `LEVEL_DEFAULT`. Overriding them is not a documented config knob — change the file and rebuild.

## Pipeline Config

| Key | Default | Purpose |
|---|---|---|
| `orchestrator.pipelineTokenBudget` | 2_000_000 | Token pool for one pipeline RUN, summed over every node visit and checked at each node boundary. `0` disables it. Per-node caps (a template step's `maxTokens`) bound a single visit; this bounds the run, which is the only bound a `foreach` loop respects — plan items can be appended while it runs, so the number of visits is not known when the run starts. Env: `PIPELINE_TOKEN_BUDGET`. |
| `multiuser.unattendedDenyActions` | `[]` | Tool actions to REFUSE rather than auto-approve when the caller cannot reach a human (any spawned worker). Entries name a container (`shell`) or one action (`shell__run`). Empty means today's behaviour: an ASK-level action an unattended worker hits is auto-approved, because blocking it would hang the worker forever rather than protect anything. Env: `UNATTENDED_DENY_ACTIONS` (comma-separated). |

## Compaction Config

| Key | Default | Purpose |
|---|---|---|
| `compaction.minSavingsRatio` | 0.10 | Minimum compression ratio that clears the session stall flag. A compaction pass that saves less than this keeps the stall flag set. |
| `compaction.growthMultiplier` | 2.0 | Trigger compaction when current context grows by this multiple relative to the last compaction baseline. |
| `compaction.hardCeiling` | 1_000_000 | Hard ceiling in tokens — compaction always runs above this threshold regardless of other gates. |

## Docker Services

The project uses shared Docker services. These must be running before starting:

```bash
# Start required services
cd ~/docker-services
docker compose up -d db

# Start optional services
docker compose up -d ollama litellm searxng
```

| Service | Port | Image | Required |
|---------|------|-------|----------|
| PostgreSQL | 5432 | `pgvector/pgvector:pg16` | Yes |
| Ollama | 11434 | `ollama/ollama:rocm` | No |
| LiteLLM | 4000 | `ghcr.io/berriai/litellm:main-latest` | No |
| SearXNG | 8888 | `searxng/searxng:latest` | No |

## Artifacts hosting

Live artifacts (`docs/ARTIFACTS.md`) ship hosted HTML pages. Two modes:

### Recommended: subdomain isolation

1. Add a DNS record (A or CNAME) for `artifacts.<your-host>` pointing to
   the same origin as your main app. Cloudflare users: orange-cloud is
   fine; Universal SSL covers it. If you already have `*.<host>` wildcard
   DNS, no new record is needed.
2. Set `ARTIFACTS_HOST=artifacts.<your-host>` in your env.
3. Reverse-proxy any `Host: artifacts.<your-host>` traffic to the same
   octipus backend; the in-process router matches the host header.

This puts hosted user-influenced HTML on a different origin so it cannot
read app cookies, ride `localStorage`, or hit `/api/*` directly with
session credentials.

### No-DNS fallback

Leave `ARTIFACTS_HOST` unset. Artifacts are served at
`/__artifacts__/a/:slug` on the main host. The iframe still uses
`sandbox` (no `allow-same-origin`) but a CSP-escape bug becomes a
same-origin XSS against the app.

Acceptable for single-user / trusted-tenant deploys; **not recommended**
when untrusted users can author artifacts in your workspace.

### Other env vars

| Var                       | Purpose                                                   |
|---------------------------|-----------------------------------------------------------|
| `ARTIFACTS_HOST`          | Subdomain for hosted pages. Empty → path-prefix fallback. |
| `ARTIFACTS_PROTO`         | `https` (default) or `http` for local dev.                |
| `ARTIFACTS_GATEWAY_WSS`   | Gateway WS origin baked into the embed CSP `connect-src`. |
| `ARTIFACT_SDK_SHA256`     | sha256 of `octipus-artifact-client.js` — pinned in CSP.   |
| `ARTIFACT_TOKEN_SECRET`   | HMAC key for artifact-scoped JWT. Falls back to JWT_SECRET HKDF. |
| `ARTIFACT_BUNDLES_DIR`    | Filesystem root for custom JS bundles. Default `data/artifacts/`. |
