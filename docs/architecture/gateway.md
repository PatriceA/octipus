# Gateway Architecture

The Gateway Hub is the central WebSocket entry point for all clients — web UI, TUI, mobile, IDE extensions, and channel adapters. Every message, event, and command flows through a single authenticated connection with unified security, routing, and observability.

## Architecture

```
                       ┌────────────────────────────────────┐
  Web UI ─────────────►│                                    │
  TUI (local) ────────►│        GATEWAY HUB                 │
  Mobile ─────────────►│                                    │
  IDE/ACP ────────────►│  - ConnectionManager (auth, budgets)│──► Orchestrator
  Telegram adapter ───►│  - GatewayEventBus (pub/sub)       │──► Agent Workers
  Slack adapter ──────►│  - CommandRegistry (9 commands)     │──► Tool Execution
  Teams webhook ──────►│  - FeedbackManager (emoji/stall)   │──► Permission Mgr
  WhatsApp webhook ───►│  - PresenceTracker (idle timeouts)  │
                       │  - RateLimiter (per-connection)     │
                       └────────────────────────────────────┘
```

## Connection Lifecycle

```
CONNECTING → AUTHENTICATING → ACTIVE → DRAINING → CLOSED
                                │
                                ├─ Idle timeout (30min remote, none local)
                                ├─ Rate limit exceeded
                                ├─ Auth token expired
                                └─ Server shutdown (graceful drain)
```

## Authentication

Clients connect to `ws://host:port/gateway` and must send an auth message within 5 seconds.

| Client Type | Auth Method | Trust Level |
|-------------|-------------|-------------|
| Web UI | `session_token` | `user` |
| TUI | `local` (file token at `~/.octipus/local-token`) | `local` |
| Channel adapters | `hmac` (per-adapter key) | `system` |
| Mobile/IDE | `session_token` or `api_key` | `user` |
| API/System | `api_key` (MASTER_KEY) | `system` |

### Connection Budgets

- Max 10 connections per user
- Max 50 connections per IP
- Max 20 pre-auth connections per IP

## Protocol

### Client → Gateway

| Message Type | Description |
|---|---|
| `auth` | Authentication handshake (must be first message) |
| `chat.send` | Send a chat message to the orchestrator |
| `command` | Execute a gateway command (e.g., `/expert`, `/status`) |
| `subscribe` | Subscribe to event patterns (e.g., `agent.*`) |
| `unsubscribe` | Remove event subscriptions |
| `permission.respond` | Approve/deny a permission request |
| `approval.respond` | Approve/deny a pipeline approval |
| `agent.stop` | Stop a running agent (admin/local only) |
| `ping` | Heartbeat |

### Gateway → Client

| Message Type | Description |
|---|---|
| `auth_ok` | Authentication successful (includes capabilities) |
| `auth_error` | Authentication failed |
| `event` | Gateway event (agent lifecycle, chat response, etc.) |
| `command.result` | Result of a command execution |
| `error` | Error message (rate limit, validation, etc.) |
| `pong` | Heartbeat response with server time |

## Event Bus

The `GatewayEventBus` is a typed pub/sub system that replaces scattered EventEmitter patterns:

- **Pattern matching**: Subscribe to `agent.*`, `swarm.*`, `chat.message`, or `*` (all events)
- **Replay buffer**: Last 200 events per session for reconnection (`swarm.*` events included)
- **Error isolation**: One handler throwing doesn't break other handlers
- **Security filtering**: Events are only delivered to connections authorized to see them

### Event Families

| Family | Events | Emitter |
|---|---|---|
| `chat.*` | `chat.message`, `chat.response`, `chat.typing` | Orchestrator |
| `agent.*` | `agent.spawned`, `agent.completed`, `agent.failed`, `agent.stopped`, `agent.status`, `agent.event` | AgentManager |
| `swarm.*` | `swarm.node_spawned`, `swarm.node_completed`, `swarm.node_status`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked` | SwarmSpawner / AgentWorker / SwarmCallGraph |
| `permission.*` | `permission.request`, `permission.response` | PermissionManager |
| `approval.*` | `approval.request`, `approval.response` | PipelineManager |
| `tool.*` | `tool.invoked`, `tool.result` | ToolExecutor |

`swarm.node_spawned` payload includes `rootSessionId`, `nodeId`, `parentNodeId`, `kind`, `depth`, `topicPath`, `role`, `expertId`, `model`, `budgets`, and a `taskBriefPreview` (first 200 chars). The web UI composes the live swarm tree from these events and falls back to `GET /api/swarm/nodes` for rehydration.

### Event Bridge

The `connectEventBridge()` function subscribes to:
- Orchestrator events → mapped to `chat.response`, `agent.spawned`, `agent.completed`, etc.
- Agent manager events → mapped to `agent.*`
- Permission requests → mapped to `permission.request`

## Rate Limiting

Sliding window rate limiter per connection per action type:

| Action | User Limit | Local Limit | System Limit |
|--------|-----------|-------------|--------------|
| `chat.send` | 30/min | 60/min | 200/min |
| `command` | 60/min | 120/min | 200/min |
| `subscribe` | 30/min | 60/min | 100/min |
| default | 60/min | 120/min | 300/min |

## Commands

Built-in commands available via the gateway protocol:

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | List available commands |
| `/status` | `/s` | Show session status and running agents |
| `/expert` | `/e` | Switch expert or list available |
| `/abort` | `/stop`, `/cancel` | Cancel all running agents |
| `/clear` | `/cls` | Clear conversation display |
| `/compact` | | Compact session context |
| `/think` | | Set thinking depth (off/low/medium/high) |
| `/verbose` | `/v` | Toggle verbose output |
| `/usage` | | Set usage display (off/tokens/full) |

## Feedback System

The `FeedbackManager` maps agent lifecycle events to emoji reactions:

| Agent State | Emoji | Debounce |
|-------------|-------|----------|
| Classifying | 🤔 | 700ms |
| Expert selected | 🧠 | 700ms |
| Tool use | 🔧/📖/💻/🔍 | 700ms |
| Completed | ✅ | Immediate |
| Error | ❌ | Immediate |
| Soft stall (10s) | 😐 | — |
| Hard stall (30s) | 😬 | — |

## Channel Adapters

Channel adapters connect to the gateway using the adapter protocol:

```
GatewayAdapter (abstract)
  ├── TelegramGatewayAdapter (wraps Grammy)
  ├── SlackGatewayAdapter (wraps Bolt)
  └── (future: Teams, WhatsApp, custom)
```

### Adapter ↔ Gateway Messages

| Direction | Message | Description |
|-----------|---------|-------------|
| Adapter → Gateway | `channel.message` | Incoming user message |
| Adapter → Gateway | `channel.status` | Connection status |
| Gateway → Adapter | `channel.send` | Send response to user |
| Gateway → Adapter | `channel.react` | Set emoji reaction |
| Gateway → Adapter | `channel.typing` | Typing indicator |

## API Endpoints

| Endpoint | Description | Auth |
|----------|-------------|------|
| `GET /api/gateway/status` | Hub status (connections, events) | User |
| `GET /api/gateway/connections` | Active connection list | Admin |
| `GET /api/gateway/events/stats` | Event bus metrics | User |
| `GET /api/gateway/adapters` | Channel adapter status | User |

## Files

```
src/core/gateway/
├── protocol.ts           # Typed protocol schemas (Zod) + helpers
├── connection-manager.ts # Auth, budgets, connection lifecycle
├── event-bus.ts          # Central pub/sub with replay buffer
├── rate-limiter.ts       # Sliding window per-connection limiter
├── local-auth.ts         # ~/.octipus/local-token auth
├── presence.ts           # Who's connected, idle timeouts
├── commands.ts           # Command registry + 9 built-in commands
├── feedback.ts           # Emoji reactions + stall detection
├── message-handler.ts    # Routes messages to orchestrator/permissions
├── event-bridge.ts       # Bridges orchestrator events to event bus
├── adapter-registry.ts   # Manages channel adapters
├── hub.ts                # GatewayHub singleton (wires everything)
├── index.ts              # Public exports
└── gateway.test.ts       # 56 unit tests

src/channels/
├── adapter-base.ts       # GatewayAdapter abstract base class
└── adapters/
    ├── telegram-adapter.ts
    └── slack-adapter.ts

src/api/
├── gateway-ws.ts         # /gateway WebSocket endpoint
└── routes/gateway.ts     # REST API for dashboard

src/tui/
├── gateway-client.ts     # WebSocket client with reconnect
├── app.tsx               # Ink terminal UI
└── index.tsx             # Entry point
```
