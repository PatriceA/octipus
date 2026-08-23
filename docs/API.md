# API Reference

All endpoints are under `/api` with JWT Bearer authentication (except health and auth).

Interactive documentation available at `http://localhost:3005/swagger`.

## Getting an API token

Every authenticated endpoint expects an `Authorization: Bearer <token>` header. Throughout these docs the placeholder is `$OCTIPUS_API_TOKEN`. There are two ways to get a token:

- **Login JWT** — `POST /api/auth/login` returns a session JWT. Good for short-lived / interactive use; it expires.
- **Personal Access Token** — create a long-lived token under **Settings → API Tokens** in the web UI (or `POST /api/api-tokens`). Best for scripts, cron, and webhooks. Manage them via the [API Tokens](#api-tokens) endpoints; revoke with `DELETE /api/api-tokens/:id`.

Admin-only endpoints (anything marked *admin*, plus system-scoped vault writes) require a token belonging to an admin user. Export it once:

```bash
export OCTIPUS_API_TOKEN="<your-token>"
curl -H "Authorization: Bearer $OCTIPUS_API_TOKEN" http://localhost:3005/api/auth/me
```

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
| POST | `/api/auth/login-mobile` | No | Login returning bearer token in response body (for native clients) |
| POST | `/api/auth/logout` | Yes | Logout and invalidate session |
| GET | `/api/auth/me` | Yes | Get current user info |
| GET | `/api/auth/ws-ticket` | Yes | Get short-lived token for WebSocket authentication |
| POST | `/api/auth/passkey/register/options` | Yes | Generate WebAuthn registration options |
| POST | `/api/auth/passkey/register/verify` | Yes | Verify WebAuthn registration response |
| POST | `/api/auth/passkey/auth/options` | No | Generate WebAuthn authentication options |
| POST | `/api/auth/passkey/auth/verify` | No | Verify WebAuthn authentication response |
| POST | `/api/auth/totp/setup` | Yes | Setup TOTP 2FA |
| POST | `/api/auth/totp/enable` | Yes | Enable TOTP after verification |
| POST | `/api/auth/totp/disable` | Yes | Disable TOTP 2FA |
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

## Verification

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/verification/:sessionId` | Get verification evidence and status for a session |

## Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List all models |
| POST | `/api/models` | Register new model |
| GET | `/api/models/:name` | Get model details |
| PATCH | `/api/models/:name` | Update model config |
| DELETE | `/api/models/:name` | Delete model |
| POST | `/api/models/:name/default` | Set as default model |
| GET | `/api/models/routing` | Get topic routing |
| GET | `/api/models/health` | Check provider health |
| GET | `/api/models/cli/status` | CLI tool availability |
| GET | `/api/models/cli/quota` | CLI quota status |
| GET | `/api/models/providers/ollama/models` | List available Ollama models |
| GET | `/api/models/providers/litellm/models` | List LiteLLM models |
| GET | `/api/models/providers/:provider/known` | Known models for a provider |

## Roles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | List all roles with current tool bindings |
| PATCH | `/api/roles/:role` | Update role's tool allowlist (admin) |

## Topics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/topics` | List all topics with current model bindings and config |
| PATCH | `/api/topics/:topic/config` | Update topic config (executorModel, temperature, maxTokens) (admin) |
| PUT | `/api/topics/:topic/binding` | Set topic's primary/backup model binding (admin) |
| POST | `/api/topics/assign-all` | Bind one model as primary for all text topics (admin) |

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
| GET | `/api/pipelines/:id` | Get pipeline detail with nodes |
| POST | `/api/pipelines/:id/stop` | Stop a running pipeline |
| GET | `/api/pipelines/:id/plan` | List the plan a `foreach` node iterates |
| POST | `/api/pipelines/:id/plan` | Append plan items (editable while running) |
| PATCH | `/api/pipelines/:id/plan/:itemId` | Edit or reorder a plan item |
| DELETE | `/api/pipelines/:id/plan/:itemId` | Drop a still-pending plan item |
| POST | `/api/pipelines/:id/pause` | Pause at the next node boundary |
| POST | `/api/pipelines/:id/resume` | Resume from the newest checkpoint, or from `fromSeq` (rewind) |
| GET | `/api/pipelines/:id/checkpoints` | List checkpoints (node-boundary snapshots) |
| PATCH | `/api/pipelines/:id/checkpoints/:seq` | Edit what the next node will read |
| GET | `/api/pipelines/templates` | List pipeline templates |
| POST | `/api/pipelines/templates` | Create pipeline template |
| PUT | `/api/pipelines/templates/:id` | Update pipeline template |
| DELETE | `/api/pipelines/templates/:id` | Delete pipeline template |

## Runs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runs/:sessionId/events` | The run log — one ordered stream of node, plan and tool events |
| GET | `/api/runs/:sessionId/trace` | The same log folded into spans, with per-span duration and cost |

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

Per-user orchestrator persona — name, tone, narration volume, free-form self-facts — plus the per-arm voices that shadow it. Same controls as the `/persona` slash command (see [CHAT-COMMANDS.md](CHAT-COMMANDS.md#personas-orchestrator-identity)) and the web `/persona` page. Writes delegate to `handlePersonaCommand` so validation matches across all three surfaces.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/persona` | Resolved persona for the current user (name, pronouns, tone, narration, presetId, signaturePhrases, userFacts) |
| GET | `/api/persona/presets` | List shipped persona presets (`personas/*.yaml`) — no auth |
| PATCH | `/api/persona` | Update one or more of `{ name, tone, narration, presetId }` |
| POST | `/api/persona/facts` | Append a free-form self-fact (`{ fact }`, 4–280 chars) |
| DELETE | `/api/persona/facts/:idx` | Remove the N-th free-form fact (0-indexed across `extra:*`) |
| POST | `/api/persona/reset` | Restore Octipus default — drops custom name and facts |
| GET | `/api/persona/arms` | Per-arm persona bindings (`{ arms: { review: "terse-engineer" } }`); `{}` when no arm has its own voice |
| PUT | `/api/persona/arms/:role` | Shadow one arm's voice with `{ presetId }`. 400 with the reason for an unknown role/preset, or for `orchestrator` (use `PATCH /api/persona`) |
| DELETE | `/api/persona/arms/:role` | Clear it — that arm runs with no persona, as before |

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

## Reader

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/reader` | Fetch and extract article/page content |
| GET | `/api/reader/:id` | Get reader result |

## Documents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/documents/upload` | Upload one or more documents |
| GET | `/api/documents` | List documents (with optional filtering by category/status) |
| GET | `/api/documents/:id` | Get document details |
| GET | `/api/documents/:id/raw` | Stream original file (with `?download=1` for attachment mode) |
| DELETE | `/api/documents/:id` | Delete document |
| POST | `/api/documents/:id/cancel` | Cancel document processing |

## Research

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/research` | Start a deep research job |
| GET | `/api/research/jobs/:jobId` | Get research job status and results |

## Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List user's tasks |
| POST | `/api/tasks` | Create a task |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/complete` | Mark task complete |

## Recurring Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/recurring-tasks` | List recurring tasks |
| POST | `/api/recurring-tasks` | Create recurring task |
| PATCH | `/api/recurring-tasks/:id` | Update recurring task |
| DELETE | `/api/recurring-tasks/:id` | Delete recurring task |

## Email

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/email/send` | Send an email (gated) |
| GET | `/api/email/triage` | Get email triage results |

## Capabilities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/capabilities/hwfit` | Get hardware-fit model recommendations |

## SAML & SSO

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/saml/metadata` | Retrieve SAML metadata |
| POST | `/api/saml/acs` | SAML assertion consumer service |

## SCIM (System for Cross-domain Identity Management)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scim/2.0/Users` | List users |
| POST | `/api/scim/2.0/Users` | Create user |
| GET | `/api/scim/2.0/Users/:id` | Get user |
| PUT | `/api/scim/2.0/Users/:id` | Update user |
| DELETE | `/api/scim/2.0/Users/:id` | Delete user |
| GET | `/api/scim/2.0/Groups` | List groups |

## Organizations & Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orgs` | List organizations (admin) |
| POST | `/api/orgs` | Create organization (admin) |
| GET | `/api/orgs/:id` | Get org details |
| PATCH | `/api/orgs/:id` | Update org |
| DELETE | `/api/orgs/:id` | Delete org |
| GET | `/api/admin/users` | List all users (admin) |
| POST | `/api/admin/users` | Create user (admin) |
| PATCH | `/api/admin/users/:id` | Update user (admin) |
| GET | `/api/admin/quotas` | List usage quotas (admin) |
| GET | `/api/admin/quotas/:userId` | Get user quota details (admin) |
| PATCH | `/api/admin/quotas/:userId` | Update user quota overrides (admin) |
| DELETE | `/api/admin/quotas/:userId` | Clear user quota overrides (admin) |
| POST | `/api/admin/impersonate/:userId` | Start impersonation session (admin) |
| POST | `/api/admin/impersonate/stop` | Stop impersonation session |
| GET | `/api/admin/impersonate` | List recent impersonation sessions (admin) |
| GET | `/api/admin/audit` | Audit log (admin) |

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

`mode='graph'` is available to agents through the `knowledge` tool, not on
this route — see [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md).

## Notes

Authored markdown notes — the knowledge graph's Tier 2 surface. Full model in
[KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes` | List notes. Query: `kind`, `tag`, `includeArchived`, `limit` (max 500). |
| POST | `/api/notes` | Create or update a note (re-links `[[wikilinks]]`/`#tags` and re-indexes). |
| POST | `/api/notes/query` | Property query: `{ kind?, tag?, frontmatter?, sort?, order?, limit? }`. |
| GET | `/api/notes/index` | Lightweight `{id,title,slug,kind}` list — the source for `[[` autocomplete. |
| GET | `/api/notes/tags` | Tag → count across active notes. |
| POST | `/api/notes/capture` | Append `{ text, date?, workspaceId? }` to a daily note. |
| GET | `/api/notes/:id` | Read a note with its backlinks. |
| GET | `/api/notes/:id/suggestions` | Semantically related, not-yet-linked entities (computed, not persisted). |
| PATCH | `/api/notes/:id/pin` | `{ pinned: boolean }`. |
| DELETE | `/api/notes/:id` | Archive (soft). `?hard=true` also deletes the note's chunks and edges. |

## Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph` | Global mode: active notes + resolved edges (max 2000 nodes / 5000 edges). With `entryType` + `entryId`: local neighbourhood, `hops` clamped 1–5. Ghost (unresolved) edges are never returned. |
| GET | `/api/graph/canvas` | [JSON Canvas](https://jsoncanvas.org/) projection of a neighbourhood. Query: `entryType`, `entryId`, `hops` (1–5). |

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

## Skill Topic Assignments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skill-topic-assignments` | List skill-topic bindings |
| POST | `/api/skill-topic-assignments` | Create assignment |
| DELETE | `/api/skill-topic-assignments/:id` | Delete assignment |

## Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/metrics` | System metrics (uptime, requests, etc.) |

## Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs` | List logs (paginated) |

## Memory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory` | Get memory state |
| POST | `/api/memory/index` | Index memory |
| DELETE | `/api/memory/:id` | Delete memory entry |

## Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search` | Global search across all knowledge |

## Workspace

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workspace` | Get workspace info |
| PATCH | `/api/workspace` | Update workspace |

## Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get all settings |
| PATCH | `/api/settings` | Update settings |

## Channel Bindings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channel-bindings` | List channel bindings |
| POST | `/api/channel-bindings` | Create binding |
| DELETE | `/api/channel-bindings/:id` | Delete binding |

## Devices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/devices` | List devices |
| POST | `/api/devices` | Register device |
| DELETE | `/api/devices/:id` | Unregister device |

## API Tokens

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/api-tokens` | List API tokens |
| POST | `/api/api-tokens` | Create token |
| DELETE | `/api/api-tokens/:id` | Revoke token |
| POST | `/api/api-tokens/:id/rotate` | Rotate token |

## OAuth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/oauth/providers` | List available OAuth providers |
| POST | `/api/oauth/connect` | Initiate OAuth flow |
| GET | `/api/oauth/callback` | OAuth callback handler |
| DELETE | `/api/oauth/:provider` | Disconnect OAuth provider |

## Connectors

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connectors` | List available connectors |
| GET | `/api/connectors/:id` | Get connector details |

## Plugins

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/plugins` | List plugins |
| POST | `/api/plugins` | Install plugin |
| DELETE | `/api/plugins/:id` | Uninstall plugin |

## Webhooks (Outgoing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/webhooks` | List outgoing webhooks |
| POST | `/api/webhooks` | Create webhook |
| PATCH | `/api/webhooks/:id` | Update webhook |
| DELETE | `/api/webhooks/:id` | Delete webhook |
| POST | `/api/webhooks/:id/test` | Test webhook delivery |

## Webhook Incoming

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/hooks/incoming/:hookId` | Receive inbound webhook (no auth) |

## Teams Webhook (Channel Integration)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/teams` | Microsoft Teams webhook receiver |

## WhatsApp Webhook (Channel Integration)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/whatsapp` | WhatsApp Cloud API webhook receiver |

## Evaluations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/evaluations` | List evaluations |
| POST | `/api/evaluations` | Run evaluation |
| GET | `/api/evaluations/:id` | Get evaluation results |

## Eval

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/eval` | Execute eval scenario |

## Artifacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/artifacts/_meta` | Get artifact host mode (subdomain or DNS-less) |
| GET | `/api/artifacts` | List artifacts in workspace |
| POST | `/api/artifacts` | Create new artifact |
| GET | `/api/artifacts/spec/:slugOrId` | Get full artifact spec for validation |
| GET | `/api/artifacts/:id` | Get artifact details |
| PUT | `/api/artifacts/:id` | Update artifact |
| DELETE | `/api/artifacts/:id` | Delete artifact |
| GET | `/api/artifacts/:id/versions` | List artifact versions |
| POST | `/api/artifacts/:id/versions/:versionId/restore` | Restore artifact to previous version |
| GET | `/api/artifacts/:id/data-sources` | List artifact data sources |
| POST | `/api/artifacts/:id/data-sources` | Add data source |
| DELETE | `/api/artifacts/:id/data-sources/:sourceId` | Remove data source |
| POST | `/api/artifacts/:id/refresh` | Refresh artifact data |
| GET | `/api/artifacts/:id/data/:sourceName` | Get data from source |
| POST | `/api/artifacts/:id/share-links` | Create share link |
| GET | `/api/artifacts/:id/share-links` | List share links |
| DELETE | `/api/artifacts/:id/share-links/:linkId` | Delete share link |
| GET | `/api/artifacts/:id/feed.rss` | Get RSS feed |

## Artifact Pages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/artifact-pages/:id` | Get artifact page info |

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

## OpenAI-compatible API (`/v1`)

Octipus exposes an OpenAI-compatible surface at `/v1` so off-the-shelf OpenAI
SDKs can talk to it. Authenticate with a personal access token
(`Authorization: Bearer octi_…`) exactly like `/api`. The `api:chat` scope is
enforced on completions (unscoped tokens are full-access — see
[token scopes](#api-tokens)).

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/models` | List available models: `octipus/orchestrator` + every registry model. |
| POST | `/v1/chat/completions` | Chat completion (streaming and non-streaming). |

### Model modes

- **`octipus/orchestrator`** (default when `model` is omitted) runs the latest
  user message through the full agent turn — the root agent with its tools,
  delegating to specialists when it needs one. The id is unchanged for
  compatibility; there is no separate orchestrator behind it any more. This
  mode is **session-stateful**: pass a stable `user` field (or an
  `X-Octipus-Session` header) to keep a conversation sticky; otherwise each
  call runs in a fresh ephemeral session.
- **A registry model id** (e.g. `gpt-4o`, `llama3.2`, from `GET /v1/models`) is
  a single-turn **passthrough** to that provider — no tools, no session — and
  honors OpenAI's stateless `messages`-array semantics exactly. Real provider
  token usage is returned.

### Example — Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="https://your-host/v1", api_key="octi_…")

# Orchestrator pipeline
resp = client.chat.completions.create(
    model="octipus/orchestrator",
    messages=[{"role": "user", "content": "Summarize today's open PRs"}],
    user="my-session-id",  # optional: keep the conversation sticky
)
print(resp.choices[0].message.content)

# Passthrough to a specific model, streaming
for chunk in client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a haiku about octopuses"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

### Example — curl

```bash
curl https://your-host/v1/chat/completions \
  -H "Authorization: Bearer octi_…" \
  -H "Content-Type: application/json" \
  -d '{"model":"octipus/orchestrator","messages":[{"role":"user","content":"hello"}]}'
```

### Notes & limits

- **Streaming** (`stream: true`) is protocol-correct SSE that chunks the final
  message text. Token-true streaming (per-delta) is a planned follow-up.
- `octipus/<role>` model ids (forced single-role) are **not yet wired** and
  return `400 model_not_found`; use `octipus/orchestrator` or a registry model.
- Errors use the OpenAI error envelope (`invalid_request_error`,
  `authentication_error`, `server_error`) so SDK error handling works.
