# API Reference

All endpoints are under `/api` with JWT Bearer authentication (except health and auth).

Interactive documentation available at `http://localhost:3005/swagger`.

## Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Basic health check |
| GET | `/health/detailed` | No | Service status with latencies |
| GET | `/health/ready` | No | Readiness probe |
| GET | `/health/live` | No | Liveness probe |

## Authentication

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

## Agents

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

## Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/messages` | Get session messages |

## Models

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

## Hooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hooks` | List all hooks |
| POST | `/api/hooks` | Create hook |
| GET | `/api/hooks/:id` | Get hook details |
| PUT | `/api/hooks/:id` | Update hook |
| DELETE | `/api/hooks/:id` | Delete hook |
| POST | `/api/hooks/:id/enable` | Enable hook |
| POST | `/api/hooks/:id/disable` | Disable hook |

## Vault

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/vault` | List credentials |
| POST | `/api/vault` | Store credential |
| PATCH | `/api/vault/:id` | Update credential |
| DELETE | `/api/vault/:id` | Delete credential |
| POST | `/api/vault/:id/rotate` | Rotate credential |

## Pipelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/pipelines` | List user's pipeline runs |
| GET | `/api/pipelines/:id` | Get pipeline detail with stages |
| POST | `/api/pipelines/:id/stop` | Stop a running pipeline |
| GET | `/api/pipelines/templates` | List pipeline templates |
| POST | `/api/pipelines/templates` | Create pipeline template |
| PUT | `/api/pipelines/templates/:id` | Update pipeline template |
| DELETE | `/api/pipelines/templates/:id` | Delete pipeline template |

## Experts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/experts` | List experts |
| GET | `/api/experts/:id` | Get expert details |
| POST | `/api/experts` | Create custom expert |
| PATCH | `/api/experts/:id` | Update expert |
| DELETE | `/api/experts/:id` | Delete custom expert |

## Skills

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List domain knowledge skills |
| GET | `/api/skills/:id` | Get skill details |
| POST | `/api/skills` | Create custom skill |
| PATCH | `/api/skills/:id` | Update skill |
| DELETE | `/api/skills/:id` | Delete custom skill |

## Persona

Per-user orchestrator persona — name, tone, narration volume, free-form self-facts. Same controls as the `/persona` slash command (see [CHAT-COMMANDS.md](CHAT-COMMANDS.md#personas-orchestrator-identity)) and the web `/persona` page. Writes delegate to `handlePersonaCommand` so validation matches across all three surfaces.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/persona` | Resolved persona for the current user (name, pronouns, tone, narration, presetId, signaturePhrases, userFacts) |
| GET | `/api/persona/presets` | List shipped persona presets (`personas/*.yaml`) — no auth |
| PATCH | `/api/persona` | Update one or more of `{ name, tone, narration, presetId }` |
| POST | `/api/persona/facts` | Append a free-form self-fact (`{ fact }`, 4–280 chars) |
| DELETE | `/api/persona/facts/:idx` | Remove the N-th free-form fact (0-indexed across `extra:*`) |
| POST | `/api/persona/reset` | Restore Octipus default — drops custom name and facts |

## Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tools` | List registered tools |
| GET | `/api/tools/:id` | Get tool details |
| GET | `/api/tools/tools/all` | All tools (built-in + MCP combined) |
| GET | `/api/tools/permissions` | User permission overrides |
| PUT | `/api/tools/permissions` | Set permission level |
| DELETE | `/api/tools/permissions/:toolId/:action` | Reset permission |
| POST | `/api/tools/:toolId/tools/:toolName/execute` | Execute a tool function |

## Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List notifications (paginated) |
| POST | `/api/notifications/:id/read` | Mark notification as read |
| POST | `/api/notifications/read-all` | Mark all notifications read |

## Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a chat message (optional `expertId` for expert routing) |
| POST | `/api/chat/approve` | Respond to an approval request |

## Swarm

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/swarm/nodes?rootSessionId=<id>` | List swarm nodes in a session (tree rehydration after WS replay ages out). Session owner or admin. |
| GET | `/api/swarm/nodes/:id` | Full node detail including `result` jsonb. |
| POST | `/api/swarm/nodes/:id/cancel` | Cancel a node and all descendants. Runs `AgentManager.stop` on each plus a DB walk; returns `{ cancelled, nodeId, descendantIds, stoppedLive }`. |

## Trajectories

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trajectories?outcome=&from=&to=&limit=` | List trajectory runs (one per `handleMessage`). Filters by outcome (`success` / `failure` / `partial` / `cancelled`) and date range, capped at 1000. |
| GET | `/api/trajectories/:id` | Single trajectory record. |

## Skill Proposals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills/proposals` | List pending skill proposals (detector-auto-generated). |
| POST | `/api/skills/proposals/:id/approve` | Promote a proposal to a custom expert. Body: `{ name?, role?, systemPrompt? }`. |
| POST | `/api/skills/proposals/:id/reject` | Reject and suppress for 90 days. |

## Knowledge

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge/readiness` | Run the KB self-check (DB + embedding model + vector write probe). Returns 503 with `{ kb: { ready: false, reasons: [...] } }` if the KB is not ready. |
| GET | `/api/knowledge` | Browse entries (lightweight, no vectors). |
| GET | `/api/knowledge/stats` | Counts per source type. |
| POST | `/api/knowledge/search` | Search (`mode`: `hybrid` / `semantic` / `keyword`). 503 if KB not ready. |
| GET | `/api/knowledge/:id` | Full entry. |
| DELETE | `/api/knowledge/:id` | Delete entry. |
| POST | `/api/knowledge/cleanup` | Orphan / stale / short / duplicate cleanup with optional `dryRun`. |
| GET | `/api/knowledge/cleanup-history` | Recent cleanup runs. |
| POST | `/api/knowledge/index` | Index a file or directory. 503 if KB not ready. |

## MCP

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp/servers` | List MCP servers with connection status (admin). |
| POST | `/api/mcp/servers` | Add a server (admin). |
| POST | `/api/mcp/servers/:id/toggle` | Enable/disable. |
| POST | `/api/mcp/servers/:id/connect` | Connect manually. |
| POST | `/api/mcp/servers/:id/disconnect` | Disconnect. |
| DELETE | `/api/mcp/servers/:id` | Remove. |
| GET | `/api/mcp/tools` | All tools across connected servers. |
| GET | `/api/mcp/servers/:id/tools` | Tools for one server. |
| GET | `/api/mcp/circuit` | Circuit-breaker state for every server (admin). |
| POST | `/api/mcp/circuit/:serverId/reset` | Force-close a server's breaker (admin). |

## Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio (base64) to text |

## Gateway WebSocket

Connect to `/gateway` for real-time communication. All messages are JSON, Zod-validated.

### Authentication

First message must be `auth` within 5 seconds:
```json
{
  "type": "auth",
  "method": "session_token",
  "credentials": { "token": "<jwt>" },
  "clientType": "webchat"
}
```

Auth methods: `session_token`, `local` (TUI), `hmac` (adapters), `api_key`.

### Client → Gateway Messages

| Type | Description |
|------|-------------|
| `auth` | Authentication handshake |
| `chat.send` | Send chat message (requires `sessionId`, `content`) |
| `command` | Execute gateway command (`name`, optional `args`) |
| `subscribe` | Subscribe to event patterns (e.g., `["agent.*"]`) |
| `unsubscribe` | Remove event subscriptions |
| `permission.respond` | Approve/deny permission request |
| `approval.respond` | Approve/deny pipeline approval |
| `agent.stop` | Stop a running agent (admin/local only) |
| `ping` | Heartbeat |

### Gateway → Client Messages

| Type | Description |
|------|-------------|
| `auth_ok` | Auth success (includes `connectionId`, `capabilities`, `serverTime`) |
| `auth_error` | Auth failure |
| `event` | Gateway event (agent lifecycle, chat response, etc.) |
| `command.result` | Result of a command |
| `error` | Error with `code` and `message` |
| `pong` | Heartbeat response with server time |

### Gateway Commands

Available via `{ "type": "command", "name": "<cmd>" }`:

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/status` | Session status and running agents |
| `/expert [name]` | Switch expert or list available |
| `/abort` | Cancel all running agents |
| `/clear` | Clear conversation |
| `/compact` | Compact session context |
| `/think [level]` | Set thinking depth (off/low/medium/high) |
| `/verbose [on\|off]` | Toggle verbose output |
| `/usage [mode]` | Usage display (off/tokens/full) |

### Gateway REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/gateway/status` | Hub status (connections, events) |
| GET | `/api/gateway/connections` | Active connections (admin) |
| GET | `/api/gateway/events/stats` | Event bus metrics |
| GET | `/api/gateway/adapters` | Channel adapter status |
| GET | `/api/health/time` | Server time and timezone |

### Legacy WebSocket (deprecated)

The old `/ws?token=<jwt>` endpoint still works during migration but will be removed. Use `/gateway` for new integrations.
