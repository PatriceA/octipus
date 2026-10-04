# Gateway Architecture

The Gateway Hub is the central WebSocket entry point for all clients — web UI, TUI, mobile, IDE extensions, and channel adapters. Every message, event, and command flows through a single authenticated connection with unified security, routing, and observability.

## Architecture

```
                       ┌────────────────────────────────────┐
  Web UI ─────────────►│                                    │
  TUI (local) ────────►│        GATEWAY HUB                 │
  Mobile ─────────────►│                                    │
  IDE/ACP ────────────►│  - ConnectionManager (auth, budgets)│──► Root agent
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
                                ├─ Idle timeout
                                ├─ Rate limit exceeded
                                ├─ Auth token expired
                                └─ Server shutdown (graceful drain)
```

## Authentication

Clients connect to `ws://host:port/gateway` and must send an auth message within 5 seconds.

| Client Type | Auth Method | Trust Level |
|-------------|-------------|-------------|
| Web UI | `session_token` | `user` |
| TUI / editor | `session_token` (the CLI login in `~/.octipus/session.json`) | `user` |
| Mobile/IDE | `session_token` or `api_key` | `user` |
| Automation | `api_key` (a personal API token, `octi_…`) | `user` |

There are two methods, `session_token` and `api_key`, and one trust level for
people: `user`. Trust never widens what a connection may see or touch:

- Events reach a connection only when they belong to its user.
- Every ownership check compares user ids — joining a session, `/history`,
  `/proposals`, answering a permission request or approval, `agent.stop`. An
  admin's connection gets no further than anyone else's.
- Admin-only commands (`/reload-extensions`, `/mcp reconnect`) read
  `users.is_admin` from the database when they run.
- An admin answers someone else's permission request or approval only through
  the audited REST routes `POST /api/admin/permission-requests/:id/resolve`
  and `POST /api/admin/approvals/:id/resolve` (each takes a `reason`).

The machine token (`local`, `~/.octipus/local-token`) and the `hmac` adapter
method were removed: the first reached every user's sessions from loopback,
the second was never wired. The TUI signs in with the CLI login instead (see
[the TUI guide](../guides/tui.md)).

### Client address

The address used for the pre-auth cap and the audit log is the socket's peer
address. `X-Forwarded-For` / `X-Real-IP` are believed only when that peer is
listed in `security.trustedProxies` (`TRUSTED_PROXIES`); see
[CONFIGURATION.md](../CONFIGURATION.md#reverse-proxy). REST rate limits, login
lockouts and the audit log use the same rule (`src/security/client-ip.ts`).

### Connection Budgets

- Max 10 connections per user
- Max 20 connections per address that have not authenticated yet. There is
  no per-address cap on signed-in connections: behind a reverse proxy every
  client shares one address, and that cap would become an install-wide one.

## Protocol

### Client → Gateway

| Message Type | Description |
|---|---|
| `auth` | Authentication handshake (must be first message) |
| `chat.send` | Send a chat message to the root agent |
| `chat.interject` | Side-channel question sent while root agent is running (non-blocking) |
| `chat.steer` | Inject a message into the running root agent turn to change course mid-flight |
| `command` | Execute a gateway command (e.g., `/expert`, `/status`) |
| `subscribe` | Subscribe to event patterns (e.g., `agent.*`) |
| `unsubscribe` | Remove event subscriptions |
| `permission.respond` | Approve/deny a permission request |
| `approval.respond` | Approve/deny a pipeline approval (the requester only) |
| `agent.stop` | Stop one of your own running agents |
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
| `events_dropped` | Notification that events were dropped from the replay buffer |

## Event Bus

The `GatewayEventBus` is a typed pub/sub system that replaces scattered EventEmitter patterns:

- **Pattern matching**: Subscribe to `agent.*`, `swarm.*`, `chat.message`, or `*` (all events)
- **Replay buffer**: Last 200 events per session for reconnection (`swarm.*` events included)
- **Error isolation**: One handler throwing doesn't break other handlers
- **Security filtering**: Events are only delivered to connections authorized to see them

### Event Families

| Family | Events | Emitter |
|---|---|---|
| `chat.*` | `chat.message`, `chat.response`, `chat.typing` | Root agent |
| `agent.*` | `agent.spawned`, `agent.completed`, `agent.failed`, `agent.stopped`, `agent.status`, `agent.event`, `agent.action`, `agent.iteration`, `agent.blocked` | AgentManager / Executor |
| `swarm.*` | `swarm.node_spawned`, `swarm.node_completed`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked`, `swarm.narration` | SwarmSpawner / AgentWorker / SwarmCallGraph |
| `permission.*` | `permission.request`, `permission.response` | PermissionManager |
| `approval.*` | `approval.request`, `approval.response` | PipelineManager |
| `tool.*` | `tool.invoked`, `tool.result` | ToolExecutor |

Additional event families exist for worker lifecycle, pipelines, sessions, and extensions. See `src/core/gateway/protocol.ts` for the complete list of `GatewayEventType` definitions.

`swarm.node_spawned` payload includes `rootSessionId`, `nodeId`, `parentNodeId`, `kind`, `depth`, `topicPath`, `role`, `expertId`, `model`, `budgets`, and a `taskBriefPreview` (first 200 chars). The web UI composes the live swarm tree from these events and falls back to `GET /api/swarm/nodes` for rehydration.

### Event Bridge

The `connectEventBridge()` function subscribes to:
- Root agent events → mapped to `chat.response`, `agent.spawned`, `agent.completed`, etc.
- Agent manager events → mapped to `agent.*`
- Permission requests → mapped to `permission.request`

## Rate Limiting

Sliding window rate limiter per connection per action type:

| Action | User Limit |
|--------|-----------|
| `chat.send` | 30/min |
| `command` | 60/min |
| `subscribe` | 30/min |
| default | 60/min |

## Commands

Built-in commands available via the gateway protocol:

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | List available commands |
| `/status` | `/s` | Show session status and running agents |
| `/expert` | `/e` | Switch expert or list available |
| `/abort` | `/stop`, `/cancel` | Cancel your running agents |
| `/clear` | `/cls` | Clear conversation display |
| `/compact` | | Compact session context |
| `/cost` | | Show cumulative token usage and cost for this session |
| `/diff` | | Show git diff for workspace changes |
| `/changes` | | Review git changes — list, or a file diff |
| `/reload-extensions` | `/reload` | Re-discover and reload user extensions |
| `/persona` | | Configure the root agent persona |
| `/version` | `/v` | Show Octipus version and build info |

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
BaseChannel (abstract, src/channels/interface.ts)
  ├── TelegramChannel (wraps Grammy)
  ├── SlackChannel (wraps Bolt, Socket Mode)
  ├── TeamsChannel
  ├── WhatsAppChannel
  └── WebChatChannel
```

Adapters are reached through the `UnifiedMessageInterface` (`getUMI()`), which
owns registration and routing — see [the channel-adapter guide](../guides/channel-adapter.md).

### Adapter communication

Channel adapters call the `UnifiedMessageInterface` methods and receive shared
backend events. They do not send a separate `channel.message` / `channel.send`
wire protocol. The actual gateway frames are defined in
`src/core/gateway/protocol.ts`; use that schema when implementing a client.

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
├── cli-session.ts        # The CLI login (~/.octipus/session.json) terminal clients use
├── presence.ts           # Who's connected, idle timeouts
├── commands.ts           # Command registry + 9 built-in commands
├── feedback.ts           # Emoji reactions + stall detection
├── message-handler.ts    # Routes messages to root agent/permissions
├── event-bridge.ts       # Bridges root agent events to event bus
├── connection-manager.ts # Per-connection state, budgets, subscriptions
├── message-handler.ts    # Dispatches inbound client messages
├── presence.ts           # Presence tracking
├── rate-limiter.ts       # Per-connection rate limits
├── steering.ts           # chat.steer / chat.interject handling
├── hub.ts                # GatewayHub singleton (wires everything)
└── index.ts              # Public exports

src/channels/
├── interface.ts          # BaseChannel + UnifiedMessageInterface (getUMI)
├── discovery.ts          # Channel discovery / enablement
├── linking.ts            # Account-linking codes
├── telegram/  slack/  teams/  whatsapp/  webchat/

src/api/
├── gateway-ws.ts         # /gateway WebSocket endpoint
└── routes/gateway.ts     # REST API for dashboard

src/tui-pi/              # pi-tui terminal client
src/tui-editor/          # pi-tui code editor
```
