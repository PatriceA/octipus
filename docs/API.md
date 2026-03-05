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

## Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio (base64) to text |

## WebSocket

Connect to `/ws?token=<jwt>` for real-time events:
- `subscribe` / `unsubscribe` — manage event subscriptions
- `message` — send chat message
- `agent.status` — agent status changes
- `agent.message` — agent responses
- `agent.tool_call` — tool execution events
