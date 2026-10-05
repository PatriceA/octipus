# Configuration

Create a `.env` file or use `npm run setup` to generate one interactively. Runtime settings migrate to the database on first boot; later changes belong in Settings or the API. Bootstrap fields remain environment-backed. See [Configuration precedence](CONFIGURATION-PRECEDENCE.md).

## Ports

| Service | Port | Env Var |
|---------|------|---------|
| Backend API | 3005 | `API_PORT` (or `PORT`) |
| Web UI | 3007 | `WEB_PORT` (Vite development server and production server) |

`.env.example` ships `PORT=3005`, so that is the port you get from a normal
install; with neither `API_PORT` nor `PORT` set, the code falls back to 3000
(`src/config/bootstrap-loader.ts`). The Vite development server defaults to 3007 and accepts `WEB_PORT` — under Docker
Compose the host-side ports are `OCTIPUS_API_PORT` (default 3015) and
`OCTIPUS_WEB_PORT` (default 3017), mapped onto 3005/3007 in the container.

## Environment Variables

```env
# ─── Storage (choose embedded or external) ────────────────────
STORAGE_MODE=external                 # embedded uses PGlite; no PostgreSQL service needed
# DATA_DIR=~/.octipus/data             # embedded database directory
DATABASE_URL=postgres://user:password@localhost:5432/octipus

# Security keys (minimum 32 characters each, use `npm run setup` to generate)
MASTER_KEY=your-master-key-at-least-32-characters
JWT_SECRET=your-jwt-secret-at-least-32-characters
SESSION_SECRET=your-session-secret-at-least-32-chars

# ─── Server ───────────────────────────────────────────────────
API_PORT=3005
API_HOST=0.0.0.0
LOG_LEVEL=info
LOG_STDERR=0                           # 1 = write logs to stderr instead of stdout
GATEWAY_STDIO=0                        # 1 = also serve the gateway protocol over this process's stdin/stdout as JSON lines (same as `--stdio`); logs move to stderr
CORS_ORIGINS=http://localhost:3007   # your web origin; code default is http://localhost:3001
TRUSTED_PROXIES=                       # reverse proxies whose X-Forwarded-For is believed; see "Reverse proxy" below
REGISTRATION_MODE=open                 # who may register: open | invite_only (with a space invite link) | closed; the first account always may (docs/SPACES.md → Guests)

# ─── Models ───────────────────────────────────────────────────
LITELLM_URL=http://localhost:4000      # LiteLLM proxy (optional)
OLLAMA_URL=                            # Ollama URL (optional — set in Settings > Configuration or here)
# Default model is configured in the database via the Models page.
# Provider API keys (OpenAI, Anthropic, Gemini) are stored in the encrypted vault.

# ─── First-boot model bootstrap (consumed once, then ignored) ─
# Written by `npm run setup` / `octi init`. On first boot,
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
SLACK_USER_TOKEN=                      # xoxp-... optional; only channel_search needs it
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

# ─── Sessions ────────────────────────────────────────────────
SESSION_RETENTION_DAYS=14             # Delete sessions idle this many days (0 = never); "keep"-marked sessions are exempt

# ─── Group channels ──────────────────────────────────────────
GROUP_CHANNELS_UNPROMPTED_ENABLED=false  # Let channels in listen/proactive mode post unprompted (docs/CHANNELS.md)

# ─── Shared spaces (docs/SPACES.md) ──────────────────────────
SPACES_CREATION=any_user              # Who may create a space: any_user | admins
SPACES_MAX_MEMBERS=50                 # Most members per space
SPACES_INVITE_MAX_TTL_HOURS=720       # Longest invite-link lifetime (hours); longer requests are clamped
SPACES_PURGE_AFTER_ARCHIVE_DAYS=7     # Days a space stays archived before its owner can delete it
SPACES_NOTE_MAX_BYTES=114688          # Largest space note (bytes); at most half of GATEWAY_MAX_FRAME_BYTES or startup fails
SPACES_DOC_MAX_UPDATES_PER_SECOND=30  # Live-note edits one tab may send per second
SPACES_DOC_PERSIST_DEBOUNCE_MS=2000   # Idle time before a live note is saved (also saved when the last editor leaves)
SPACES_DOC_REINDEX_MINUTES=10         # Most a live note's links/search index may lag its text
SPACES_DOC_BASE_TTL_MINUTES=30        # How long a read of a live note stays a valid merge base for a write
SPACES_FILE_LEASE_TTL_SECONDS=180     # "Someone is editing" lease on a space file, without renewal
SPACES_MEMORY_MAX_ITEMS=50            # Space-memory entries given to one turn of a space session
ROOMS_MAX_QUEUED_PER_MEMBER=3         # Requests one member may have waiting in a room
ROOMS_APPROVAL_TIMEOUT_MINUTES=30     # A room turn waiting this long on an approval gives up
ROOMS_TRANSCRIPT_WINDOW_CHARS=6000    # Room transcript after the summary before the room is compacted

WORKSPACE_PATH=./workspace
SEARXNG_URL=http://localhost:8888         # SearXNG meta-search (optional)

# ─── Integrations (optional) ─────────────────────────────────
N8N_URL=http://localhost:5678
N8N_API_KEY=
MCP_SERVERS_CONFIG=./mcp-servers.json     # Path to MCP client server config (see MCP-INTEGRATION.md)

# ─── Several server processes on one PostgreSQL (optional) ───
# Task wakeups reach every process over LISTEN/NOTIFY, and a role heartbeat
# runs one turn per hook across all processes (a lease on the hook row that
# lapses after the agent timeout + 10 min if its process died). These only
# decide which leases a process may clear at startup:
# OCTIPUS_INSTANCE_ID=node-a           # Unique per process AND stable across its restarts (e.g. a StatefulSet
#                                      # pod name, never a random or shared value). When set, a restarted process
#                                      # clears the leases its previous boots left. Unset: nothing is cleared at
#                                      # startup and a crashed process's leases lapse by TTL. Two processes must
#                                      # never share one id: each would clear the other's live leases.
# OCTIPUS_SINGLE_PROCESS=0             # 1 = exactly one server process uses this database: clear every lease at
#                                      # startup. Never set it when several processes share the database.
#                                      # (Embedded PGlite always behaves this way.)

# ─── Migrations ──────────────────────────────────────────────
SKIP_MIGRATIONS=false                  # Use true only if migrations are applied separately before deployment

# ─── Voice (optional) ────────────────────────────────────────
WHISPER_MODEL_PATH=
PIPER_MODEL_PATH=

# ─── Observability / Opt-outs ────────────────────────────────
TRAJECTORY_LOGGING=true                # Record one JSONL line per handleMessage run (default on)
SKILL_AUTO_EXTENSION=true              # Pattern-detect recurring topic/tool sequences into skill_proposals (default on)
SPINNER_STYLE=classic                  # TUI spinner style: classic | kawaii
```

## Topic → Model Routing (Authoritative)

Specialist model resolution uses topic bindings through `ModelRegistry.getModelForTopic(role)`, with expert preferences and executor/backup bindings where configured. The general root can use the configured default model. See [Model routing](MODEL-ROUTING.md) for planner/executor selection.

Resolution order inside the swarm spawner (`SwarmSpawner.resolveChildModelAndExpert`):

1. Expert `modelPreference` — if the matched expert has an explicit preference.
2. `ModelRegistry.getModelForTopic(childRole)` — otherwise the model bound to the child's topic.
3. Throw — if neither resolves, with a message pointing at the Models page. No silent fallback.

- Agent and Subagent children resolve their own topic bindings, not the parent's model. The root alone can fall back to the configured default.
- The embedding path (`litellm-client.ts:embed()`) and vision path (`visual/analyzer.ts`) resolve the `embedding` / `vision` topic bindings the same way, or throw.

Bind models to topics via the web UI (**Settings → Models → Edit → Topics**) or the API (`PATCH /api/models/:name`).

## Swarm Config

| Key | Default | Purpose |
|---|---|---|
| `swarm.perUserSpawnsPerMinute` | 30 | Per-user rate limit on `spawn_child` invocations. Enforced by `rate-limiter.ts`. |
| `swarm.orphanReaperIntervalMs` | 600000 | Interval for the orphan reaper sweep that flips long-running `swarm_nodes` to `cancelled` after process restart. |

Swarm level budgets are configurable under `swarm.levelDefaults.root`, `.agent`, and `.subagent` (`tokens`, `wallMs`, `fanOut`, `maxPendingDetached`). `getLevelDefault` in `src/core/swarm/types.ts` reads them, falling back to `LEVEL_DEFAULT`. These are execution bounds, not exact billing limits. `swarm.contractRetries` defaults to `1` (range 0–5) for retryable failed scorer gates.

`swarm.worktreeIsolation` (default `false`, env `SWARM_WORKTREE_ISOLATION`) gives each coding-role child running on a CLI adapter (Claude Code, Codex, or any other CLI model) its own git worktree under `~/.octipus/worktrees/<id>` on a branch `octipus/<id>`. It applies only to dev-mode sessions whose project directory is itself a git repository root (never the per-user sandbox), and only when that project has no uncommitted tracked changes at spawn time: a worktree starts at `HEAD` and would not see them, and its merge would be skipped anyway, so such a child runs on the shared tree. Retries of the same child reuse its worktree. On completion the framework commits any uncommitted work on that branch and reports `{branch, headSha, diffStat, filesChanged, merge}` on the child's receipt. It merges the branch into the project's current branch (`git merge --no-ff`) only when the child finished `ok` from an attempt that ran in the worktree (not a native backup-model attempt, `skipped_other_attempt`), and the project is on a branch, has no uncommitted tracked changes or merge in progress (`skipped_dirty`), and still contains the commit the worktree started from (`skipped_moved`). A conflict is aborted and the branch kept. Unmerged branches are never deleted, and a worktree whose `HEAD` is on no branch (a detached commit) is removed only after that commit is kept by fast-forwarding `octipus/<id>` or by a `octipus/<id>-detached` ref. Every server-side git call runs with repository hooks and fsmonitor disabled. Agents spawned by a worktree child (and their own children) inherit its worktree instead of creating another: a CLI descendant runs there, a native descendant's file and shell tools resolve against it (its `projectPath`), and their evidence gates measure it; their work is captured by the worktree child's own commit and merge. A fresh worktree has no dependencies installed, so when the repo root has `node_modules`, the worktree's `node_modules` is a single symlink to it, and `/node_modules` is added once, with a comment, to the repository's `.git/info/exclude` (git keeps that file in the shared git directory, so the line also applies to the main tree, where it only affects an untracked root `node_modules`). That `node_modules` is shared, not isolated: an install or delete inside a worktree changes the project's real dependencies. `swarm.worktreeLinkNodeModules` (default `true`, env `SWARM_WORKTREE_LINK_NODE_MODULES`) turns the symlink off, leaving worktrees without `node_modules`. While the flag is on, the orphan reaper removes an abandoned worktree only when it is clean and its `HEAD` and branch are merged into the project, and reports the rest; a worktree whose owning process is still alive (`<id>.pid`) is left alone. If a worktree cannot be created, the child runs on the shared tree as before.

Both this `tokens` cap and `AGENT_MAX_TOKEN_BUDGET` (`agent.maxTokenBudget`, per-agent) are spend proxies, not context-fill meters. `AgentWorker`'s own budget gate (`src/core/agent-worker.ts:973`) checks `this.billableTokensUsed` directly — fresh input plus paid cache writes plus output, cache reads excluded (`billableTokens` in `src/models/billable-tokens.ts`) — a field the worker always owns, so there's no fallback there. `checkSpawnBudget`'s `syncParentTokenUsage` (`src/core/swarm/spawn-budget.ts:68`) reads the same billable figure off the worker via `getBillableTokens?.()`, but falls back to `getTotalTokens?.()` — the grand total — for a worker reference with no billable method. `getTotalTokens()` itself, and `sessions.token_count`, stay on the grand total including cache reads; a well-cached run can show a large token count there while staying cheap and nowhere near its budget.

## Pipeline Config

| Key | Default | Purpose |
|---|---|---|
| `agent.pipelineTokenBudget` | 2_000_000 | Token pool for one pipeline RUN, summed over every node visit and checked at each node boundary. `0` disables it. Per-node caps (a template step's `maxTokens`) bound a single visit; this bounds the run, which is the only bound a `foreach` loop respects — plan items can be appended while it runs, so the number of visits is not known when the run starts. Env: `PIPELINE_TOKEN_BUDGET`. |
| `multiuser.unattendedDenyActions` | `[]` | Legacy additional deny list for unattended calls; entries name a container (`shell`) or action (`shell__run`). ASK is blocked for unattended calls even when this list is empty. Attended children inherit their session approval surface. Use reviewed, scoped, expiring grants for permitted automation. Env: `UNATTENDED_DENY_ACTIONS` (comma-separated). |

## Compaction Config

| Key | Default | Purpose |
|---|---|---|
| `compaction.minSavingsRatio` | 0.10 | Minimum compression ratio that clears the session stall flag. A compaction pass that saves less than this keeps the stall flag set. |
| `compaction.growthMultiplier` | 2.0 | Trigger compaction when current context grows by this multiple relative to the last compaction baseline. |
| `compaction.hardCeiling` | 1_000_000 | Hard ceiling in tokens — compaction always runs above this threshold regardless of other gates. |

## Gateway Config

| Key | Default | Purpose |
|---|---|---|
| `gateway.maxConnectionsPerUser` | 20 | Signed-in `/gateway` connections one user may hold (each browser tab holds one, each TUI one). The one over the cap is refused; the web shows "Too many open tabs". Env: `GATEWAY_MAX_CONNECTIONS_PER_USER`. |
| `gateway.maxFrameBytes` | 262144 | Largest frame a gateway client may send, in bytes — the socket's `maxPayload`, read at server start. A bigger frame closes the connection (1009). Raise it for large TUI image attachments. Env: `GATEWAY_MAX_FRAME_BYTES`. |
| `gateway.replayMaxSessions` | 500 | Sessions whose recent events stay in memory so a reconnecting tab can `replay` what it missed; the least recently active is dropped first. Env: `GATEWAY_REPLAY_MAX_SESSIONS`. |

## Reverse proxy

Octipus takes a client's address from the TCP connection. The
`X-Forwarded-For` and `X-Real-IP` headers are ignored — anyone can send them —
unless the connection comes from a proxy listed in `security.trustedProxies`
(env `TRUSTED_PROXIES`, comma-separated; addresses or CIDR ranges, IPv4 or
IPv6). The address is used for the per-address REST rate limits, the login
and passkey lockouts, the gateway's cap on unauthenticated connections, and
the audit log. It never grants anything: there is no "local" trust, so a
request from loopback is treated like any other.

Behind nginx, Caddy or a load balancer, list the proxy, or every client
shares the proxy's address for those limits:

```env
# nginx / Caddy on the same host
TRUSTED_PROXIES=127.0.0.1,::1
# a load balancer subnet
TRUSTED_PROXIES=10.0.0.0/8
```

The proxy must set (not append to a client-supplied) `X-Forwarded-For`, or
append the peer address as nginx's `$proxy_add_x_forwarded_for` does: the
header is read right to left, skipping trusted proxies, and the first other
hop is the client. An entry that is not an address or CIDR range is rejected
when the configuration loads.

The bundled web server (`web/serve.mjs`: port 3007 in the image, published as
3017 by `docker-compose.yml`) proxies `/api`, `/a` and `/__artifacts__` to the
backend over loopback and appends its peer address to `X-Forwarded-For`. In
that setup, set `TRUSTED_PROXIES=127.0.0.1,::1` so the backend sees each
browser's address instead of one shared one; a client that forges the header
only adds hops left of the real one, which are ignored. If nginx or a load
balancer sits in front of port 3017, list it too, and have it set or append
`X-Forwarded-For` as above (a front proxy that sends only `X-Real-IP` is not
enough here, because the bundled server always sends `X-Forwarded-For`).

## Docker Services

Embedded mode requires no external database service. For external mode, provide PostgreSQL with pgvector. The following is an example for operators who maintain a separate `~/docker-services` Compose project; that directory is not shipped by Octipus:

```bash
# Start required services
cd ~/docker-services
docker compose up -d db

# Start optional services
docker compose up -d ollama litellm searxng
```

| Service | Port | Image | Required |
|---------|------|-------|----------|
| PostgreSQL | 5432 | `pgvector/pgvector:pg16` | External storage mode only |
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
