# Plan: Full Gateway Refactor — WebSocket Hub Architecture

> Status: Draft
> Created: 2026-03-31
> Priority: Strategic

## Vision

Transform the assistant's gateway from a lifecycle manager into the **central WebSocket hub** that all clients connect to — channels, TUI, WebUI, mobile, IDE extensions. Every message, event, and command flows through a single authenticated entry point with unified security, routing, and observability.

```
Current Architecture:
  Telegram (polling) ──► Grammy lib ──► UMI ──► Orchestrator
  Slack (socket) ──────► Bolt lib ───► UMI ──► Orchestrator
  Teams (webhook) ─────► HTTP POST ──► UMI ──► Orchestrator
  WhatsApp (webhook) ──► HTTP POST ──► UMI ──► Orchestrator
  WebChat ─────────────► /ws ────────► UMI ──► Orchestrator
  Web UI ──────────────► REST + /ws

Target Architecture:
                       ┌────────────────────────────────────┐
  Telegram ───────────►│                                    │
  Slack ──────────────►│        GATEWAY (WS Hub)            │
  Teams ──────────────►│                                    │
  WhatsApp ────────────┤  - Unified Auth Layer              │──► Orchestrator
  WebChat ────────────►│  - Event Bus                       │──► Agent Workers
  TUI (local) ────────►│  - Session Management              │──► Tool Execution
  Mobile (Cloudflare) ►│  - Health & Presence               │──► Permission Mgr
  IDE/ACP (Cloudflare)►│  - Audit Trail                     │
                       └────────────────────────────────────┘
```

---

## Table of Contents

1. [Security Architecture](#1-security-architecture)
2. [Gateway Core Refactor](#2-gateway-core-refactor)
3. [Channel Migration](#3-channel-migration)
4. [Channel Commands](#4-channel-commands)
5. [Channel Feedback System](#5-channel-feedback-system)
6. [TUI Client](#6-tui-client)
7. [Self-Configuration (DB-Driven)](#7-self-configuration-db-driven)
8. [Agent Communication Protocol](#8-agent-communication-protocol)
9. [Monitor Dashboard Enhancements](#9-monitor-dashboard-enhancements)
10. [Migration Strategy](#10-migration-strategy) (Phases 0–8)
11. [Validation & Test Suite](#11-validation--test-suite)

---

## 1. Security Architecture

> This is the foundation. Nothing else ships until security is solid.

### 1.1 Connection Authentication

**Current state:** WebSocket auth via session token in query param (`?token=...`), validated against SessionManager (SHA-256 hashed, Redis-backed). REST uses Bearer token via auth-guard middleware.

**Target state:** Layered authentication for different client types.

#### Client Types & Auth Methods

| Client Type | Auth Method | Trust Level | Notes |
|-------------|-------------|-------------|-------|
| **WebChat** | Session token (existing) | `user` | Browser-based, cookie/token |
| **TUI** | Local socket or localhost-only token | `local` | No internet traversal, highest trust |
| **Channel adapters** | Internal shared secret (HMAC) | `system` | Adapter → gateway is internal |
| **Mobile** | Session token + device binding | `user` | Via Cloudflare Tunnel, requires 2FA enrollment |
| **IDE/ACP** | API key + session | `user` | Via Cloudflare Tunnel or local |
| **Agent-to-agent** | Internal JWT (short-lived) | `agent` | Scoped to session + tool subset |

#### Auth Flow (Gateway WebSocket)

```
Client connects to ws://localhost:3007/gateway
  │
  ├─ 1. TLS termination (Cloudflare for remote, plain for localhost)
  │
  ├─ 2. Hello handshake (first message must be auth):
  │     {
  │       "type": "auth",
  │       "method": "session_token" | "api_key" | "hmac" | "local",
  │       "credentials": { ... },
  │       "clientType": "webchat" | "tui" | "channel" | "mobile" | "acp",
  │       "clientVersion": "1.0.0"
  │     }
  │
  ├─ 3. Validate credentials against SessionManager / Vault
  │
  ├─ 4. Assign trust level + connection context:
  │     { userId, sessionId, trustLevel, permissions, rateLimit }
  │
  ├─ 5. Connection registered in presence tracker
  │
  └─ 6. Auth response:
        { "type": "auth_ok", "sessionId": "...", "capabilities": [...] }
        OR
        { "type": "auth_error", "reason": "..." } → connection closed
```

#### Security Rules

- **No auth within 5 seconds → disconnect.** Prevents idle connection abuse.
- **Token rotation:** Session tokens rotate on each auth exchange (sliding window). Old token valid for 30s grace period.
- **Connection budget:** Max connections per user (default 10), per IP (default 50). Pre-auth connections limited to 20 per IP.
- **Localhost bypass:** TUI connecting from `127.0.0.1` can use a simplified local auth (auto-generated file token at `~/.assistant/local-token`). Never exposed externally.
- **Cloudflare Access integration:** Remote clients (mobile, ACP) must pass Cloudflare Access auth before reaching the gateway. Gateway validates the `Cf-Access-Jwt-Assertion` header as a second factor.

### 1.2 Message-Level Security

Every message through the gateway gets:

```
Incoming message
  │
  ├─ 1. Schema validation (reject malformed messages immediately)
  │
  ├─ 2. Rate limiting (per-user, per-client-type, per-action)
  │     - Chat messages: 30/min per user
  │     - Commands: 60/min per user
  │     - Tool executions: subject to permission system
  │     - Channel adapters (system): 200/min per channel
  │
  ├─ 3. Permission check (does this user + trust level allow this action?)
  │     - Existing ALLOW/ASK/DENY system applies
  │     - Trust level gates: e.g., `agent` trust cannot modify permissions
  │
  ├─ 4. Input guard (existing injection detection)
  │
  ├─ 5. Audit log entry (who, what, when, from where)
  │
  └─ 6. Route to handler
```

### 1.3 Channel Adapter Isolation

When channels move from in-process libraries to gateway clients, each adapter runs with:

- **Dedicated HMAC key** per channel adapter (stored in vault, rotated monthly)
- **Scoped permissions:** Telegram adapter can only emit messages for Telegram sessions
- **No direct DB access:** Adapters communicate exclusively through gateway protocol
- **Crash isolation:** One adapter crashing doesn't take down the gateway or other channels
- **Secret injection:** Adapter credentials (bot tokens) loaded from vault at startup, never stored in adapter process memory long-term

### 1.4 Encryption

- **In-transit:** TLS for all remote connections (Cloudflare handles this). Localhost connections are plaintext (acceptable — same machine).
- **At-rest:** Existing AES-256-GCM vault encryption for secrets. Session data in Redis is ephemeral (TTL-based). Message history in PostgreSQL — consider field-level encryption for message content if multi-tenant in future.
- **Agent secrets:** Tool secrets injected at execution time via `{{secret:name}}` — never persisted in agent memory or event logs.

### 1.5 Audit & Observability

Extend existing audit trail to cover gateway-level events:

| Event | Data Logged |
|-------|-------------|
| `gateway.connection.open` | userId, clientType, IP, trustLevel |
| `gateway.connection.close` | userId, reason, duration |
| `gateway.auth.success` | userId, method, clientType |
| `gateway.auth.failure` | IP, method, reason (no credentials logged) |
| `gateway.message.received` | userId, messageType, size (not content) |
| `gateway.rate_limit.hit` | userId, action, limit, window |
| `gateway.permission.escalated` | userId, toolId, action |
| `gateway.channel.adapter.connected` | channelType, adapterId |
| `gateway.channel.adapter.error` | channelType, error (sanitized) |

**Sensitive data policy:** Message content is NEVER logged in audit events. Only metadata (type, size, timestamps). Content logging only in the existing message repository with user consent.

---

## 2. Gateway Core Refactor

### 2.1 New Gateway Responsibilities

Expand `src/core/gateway.ts` from lifecycle manager to connection hub:

```typescript
// New gateway structure
class Gateway {
  // Existing
  private state: GatewayState;
  private config: Config;
  private db: Database;
  private storage: StorageProvider;

  // New
  private connectionManager: ConnectionManager;    // Track all WS connections
  private eventBus: GatewayEventBus;               // Central pub/sub
  private protocolHandler: ProtocolHandler;         // Message schema + routing
  private presenceTracker: PresenceTracker;         // Who's connected, from where
  private adapterRegistry: ChannelAdapterRegistry;  // Channel adapter lifecycle
  private rateLimiter: GatewayRateLimiter;          // Per-connection rate limits
}
```

### 2.2 Event Bus

Replace scattered EventEmitter patterns with a single typed event bus:

```typescript
interface GatewayEvent {
  id: string;            // Unique event ID (ULID)
  type: string;          // Namespaced: "chat.message", "agent.spawned", "channel.status"
  source: string;        // Connection ID or "system"
  userId?: string;
  sessionId?: string;
  timestamp: number;
  payload: unknown;
}
```

- **Fan-out:** Events are delivered to all subscribed connections that have permission to see them
- **Filtering:** Clients subscribe to event patterns (e.g., `agent.*`, `chat.message`)
- **Replay:** Last N events buffered per session for reconnection (existing 200-event ring buffer, expand to gateway level)
- **Back-pressure:** If a client falls behind, events are dropped with a `events_dropped` notification

### 2.3 Protocol Schema

Define a typed message protocol (replaces ad-hoc WebSocket message handling):

```typescript
// Client → Gateway
type ClientMessage =
  | { type: "auth"; method: string; credentials: unknown; clientType: string }
  | { type: "chat.send"; sessionId: string; content: string; expertId?: string }
  | { type: "command"; name: string; args?: Record<string, string> }
  | { type: "subscribe"; patterns: string[] }
  | { type: "unsubscribe"; patterns: string[] }
  | { type: "permission.respond"; requestId: string; approved: boolean }
  | { type: "agent.stop"; agentId: string }
  | { type: "ping" }

// Gateway → Client
type GatewayMessage =
  | { type: "auth_ok"; sessionId: string; capabilities: string[] }
  | { type: "auth_error"; reason: string }
  | { type: "event"; event: GatewayEvent }
  | { type: "command.result"; name: string; result: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "pong" }
```

**Versioning:** Protocol version sent in auth handshake. Gateway supports current version + 1 previous. Breaking changes require version bump.

### 2.4 Connection Lifecycle

```
CONNECTING → AUTHENTICATING → ACTIVE → DRAINING → CLOSED
                                 │
                                 ├─ Idle timeout (configurable, default 30min for remote, none for local)
                                 ├─ Rate limit exceeded (temporary ban: 60s)
                                 ├─ Auth token expired (grace period for re-auth)
                                 └─ Server shutdown (graceful drain: finish pending, reject new)
```

---

## 3. Channel Migration

### 3.1 From In-Process to Adapter Pattern

**Current:** Channel libraries (Grammy, Bolt, etc.) run in the main process. Messages go through UMI EventEmitter.

**Target:** Each channel runs as a separate adapter process that connects to the gateway via WebSocket.

#### Migration per channel:

| Channel | Current | Target Adapter |
|---------|---------|----------------|
| Telegram | Grammy polling in-process | Separate process: Grammy → Gateway WS |
| Slack | Bolt socket mode in-process | Separate process: Bolt → Gateway WS |
| Teams | Webhook handler in API routes | Webhook receiver → Gateway WS |
| WhatsApp | Webhook handler in API routes | Webhook receiver → Gateway WS |
| WebChat | Direct /ws connection | Stays as-is (already a gateway client) |

#### Adapter Process Structure

```typescript
// Each adapter is a lightweight process
class ChannelAdapter {
  private gatewayWs: WebSocket;        // Connection to gateway
  private channelClient: any;          // Grammy/Bolt/etc.

  async start() {
    // 1. Connect to gateway with HMAC auth
    this.gatewayWs = connect("ws://localhost:3007/gateway", {
      auth: { method: "hmac", key: this.adapterKey, clientType: "channel" }
    });

    // 2. Start channel-specific client
    this.channelClient = startTelegramBot(/* ... */);

    // 3. Bridge: channel events → gateway messages
    this.channelClient.on("message", (msg) => {
      this.gatewayWs.send({
        type: "channel.message",
        channel: "telegram",
        from: msg.from,
        content: msg.text,
        attachments: msg.attachments,
        metadata: { chatId: msg.chat.id, messageId: msg.message_id }
      });
    });

    // 4. Bridge: gateway events → channel actions
    this.gatewayWs.on("message", (msg) => {
      if (msg.type === "channel.send") {
        this.channelClient.sendMessage(msg.chatId, msg.content);
      }
      if (msg.type === "channel.react") {
        this.channelClient.react(msg.messageId, msg.emoji);
      }
    });
  }
}
```

#### Benefits

- **Crash isolation:** Telegram adapter crashes → Slack keeps running
- **Independent restarts:** Update Telegram adapter without touching anything else
- **Resource isolation:** Memory-hungry channel doesn't affect gateway
- **Security:** Adapter has no direct DB/vault access — only gateway protocol
- **Testability:** Mock the gateway WS to test adapter logic in isolation

### 3.2 UMI Refactor

The Unified Message Interface (UMI) becomes a **gateway-internal router** instead of an in-process EventEmitter:

- Incoming `channel.message` events from adapters → routed to orchestrator
- Outgoing orchestrator responses → routed to correct adapter via `channel.send`
- Session resolution stays in the gateway (adapter sends channel-specific IDs, gateway resolves to session UUIDs)

### 3.3 Webhook Channels (Teams, WhatsApp)

These channels receive HTTP webhooks from external platforms. Two options:

**Option A: Thin webhook receiver in gateway**
- Gateway exposes `/webhooks/teams`, `/webhooks/whatsapp` HTTP endpoints
- Validates signatures (existing HMAC-SHA256)
- Converts to gateway event, routes internally
- Simpler, fewer processes

**Option B: Separate webhook receiver process**
- Standalone HTTP server receives webhooks
- Forwards to gateway via WS
- Better isolation, but more moving parts

**Recommendation:** Option A for webhook channels (Teams, WhatsApp). They're already HTTP endpoints — just move them into the gateway's HTTP server alongside the WS endpoint. Only polling/socket channels (Telegram, Slack) benefit from separate adapter processes.

---

## 4. Channel Commands

### 4.1 Expanded Command Set

Commands are intercepted at the gateway level (before reaching the orchestrator). Zero LLM latency.

| Command | Description | Current | New |
|---------|-------------|---------|-----|
| `/start` | Welcome message | Exists | Keep |
| `/help` | List commands | Exists | Expand with new commands |
| `/status` | Session status (expert, tokens, costs) | Exists | Enhance with expert info |
| `/clear` | Clear conversation history | Exists | Keep |
| `/link` | Account linking code | Exists | Keep |
| `/expert [name]` | Switch to expert (or list available) | - | **New** |
| `/compact` | Summarize/compact session context | - | **New** — triggers existing session-compaction |
| `/think [level]` | Set thinking depth (off/low/medium/high) | - | **New** — maps to model thinking parameter |
| `/verbose [on\|off]` | Toggle verbose output in channel | - | **New** — controls response detail level |
| `/abort` | Cancel running agent | - | **New** — calls AgentManager.stop() |
| `/usage [off\|tokens\|full]` | Toggle usage/cost footer on responses | - | **New** |
| `/plan` | Show current task plan | Exists (orchestrator) | Move to gateway command layer |

### 4.2 Command Handler Architecture

```typescript
interface ChannelCommand {
  name: string;
  aliases: string[];
  description: string;
  args?: { name: string; required: boolean; type: "string" | "number" | "enum"; values?: string[] }[];
  trustLevels: TrustLevel[];       // Which client types can use this
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

interface CommandContext {
  userId: string;
  sessionId: string;
  channelType: string;
  args: Record<string, string>;
  gateway: Gateway;
}

interface CommandResult {
  text: string;                    // Response message
  ephemeral?: boolean;             // Only visible to command sender (Slack/Discord)
  reactions?: string[];            // Emoji reactions to apply
}
```

### 4.3 `/expert` Command Detail

```
/expert                → List available experts with icons and descriptions
/expert researcher     → Switch session to Researcher expert
/expert reset          → Return to auto-classification (no fixed expert)

Response example:
  Switched to 🔬 Researcher expert.
  Next messages will be handled by the Researcher (using claude-sonnet-4-6).
  Use /expert reset to return to auto-routing.
```

This maps to the existing `expertId` override in `handleExpertMessage()`. The command stores the active expert preference in the session, so subsequent messages skip classification and go directly to the selected expert's worker.

---

## 5. Channel Feedback System

### 5.1 Emoji Reaction Status

Replace text-based status updates with real-time emoji reactions on the user's message.

| Agent State | Emoji | Meaning |
|-------------|-------|---------|
| Queued | 👀 | Message received, queued for processing |
| Classifying | 🤔 | Analyzing message intent |
| Expert selected | 🧠 | Expert/model selected, spawning worker |
| Tool use | 🔧 | Executing a tool |
| Coding | 💻 | Writing/editing code |
| Searching | 🔍 | Web search or knowledge lookup |
| Reading | 📖 | Reading files or documents |
| Waiting approval | ⏳ | Needs user permission for an action |
| Completed | ✅ | Done |
| Error | ❌ | Something went wrong |
| Stall (soft) | 😐 | 10+ seconds without progress |
| Stall (hard) | 😬 | 30+ seconds without progress |

#### Implementation

```typescript
// Gateway subscribes to orchestrator + agent events
// Maps events → emoji reactions → sends to channel adapter

class FeedbackManager {
  private activeReactions: Map<string, string[]>; // messageId → current emojis

  onEvent(event: GatewayEvent) {
    switch (event.type) {
      case "orchestrator.classifying":
        this.setReaction(event.messageId, "🤔");
        break;
      case "agent.tool_call":
        this.setReaction(event.messageId, this.toolEmoji(event.payload.toolName));
        break;
      case "agent.completed":
        this.setReaction(event.messageId, "✅");
        break;
      case "agent.error":
        this.setReaction(event.messageId, "❌");
        break;
    }
  }

  // Debounce: don't spam platform APIs
  // Terminal states (✅, ❌) apply immediately
  // Intermediate states debounced at 700ms
}
```

### 5.2 Stall Detection

```typescript
class StallDetector {
  private lastProgress: Map<string, number>; // agentId → timestamp

  check(agentId: string) {
    const elapsed = Date.now() - this.lastProgress.get(agentId);
    if (elapsed > 30_000) return "hard";   // 😬
    if (elapsed > 10_000) return "soft";   // 😐
    return null;
  }
}
```

Runs on a 5-second interval per active agent. Resets on any agent event (tool call, LLM response, etc.).

### 5.3 Typing Indicators

- Start typing indicator when agent begins processing
- Stop when response is sent or error occurs
- Lifecycle guard: auto-stop after 60 seconds (platform timeout safety)
- Per-platform handling (some platforms require periodic re-send of typing)

### 5.4 Response Footers (configurable via `/usage`)

```
off:     (no footer)
tokens:  📊 847 tokens
full:    📊 847 tokens · $0.003 · claude-sonnet-4-6 · 🔬 Researcher · 2.1s
```

---

## 6. TUI Client

### 6.1 Architecture

The TUI is a **local client** that connects to the gateway via `ws://localhost:3007/gateway`. It does NOT go through Cloudflare — it's same-machine, same as WebChat.

```
┌─────────────────────────────────────────┐
│  TUI Process (Ink/React terminal)       │
│                                         │
│  ┌─ Chat Log (scrollable)               │
│  ├─ Input Editor (multi-line)           │
│  ├─ Status Bar (expert, model, tokens)  │
│  ├─ Agent Panel (toggle: Ctrl+O)        │
│  └─ Modal Overlays (expert/session)     │
│                                         │
│  Auth: local-token file (~/.assistant/)  │
│  Transport: ws://localhost:3007/gateway  │
└─────────────────────────────────────────┘
```

### 6.2 Auth for TUI

Since TUI runs locally:

1. On first `assistant tui`, generate a local token file at `~/.assistant/local-token` (random 32 bytes, hex-encoded)
2. Gateway accepts `method: "local"` auth only from `127.0.0.1` connections
3. Token file is `chmod 600` (user-only read)
4. No password prompt, no browser redirect — instant local access

### 6.3 Features

| Feature | Keybinding | Description |
|---------|------------|-------------|
| Chat | (default) | Send messages, see responses with streaming |
| Expert selector | `Ctrl+E` | Modal: pick expert from list |
| Session selector | `Ctrl+S` | Modal: switch or create session |
| Agent panel | `Ctrl+O` | Toggle: show running agents, status, tools |
| Thinking display | `Ctrl+T` | Toggle: show/hide model thinking blocks |
| Verbose mode | `Ctrl+V` | Toggle: detailed tool call output |
| Abort | `Ctrl+X` | Cancel running agent |
| Clear | `Ctrl+L` | Clear chat display |
| Exit | `Ctrl+C` / `Ctrl+D` | Quit TUI |

### 6.4 TUI Commands

All channel commands (Section 4) work in TUI plus:

| Command | Description |
|---------|-------------|
| `/sessions` | List all sessions |
| `/agents` | List running agents |
| `/settings` | View current config |
| `/exit` | Quit TUI |

### 6.5 Entry Point

```bash
assistant tui              # Launch TUI (connects to running gateway)
assistant start --tui      # Start gateway + open TUI instead of browser
```

If gateway is not running, `assistant tui` prints an error: "Gateway not running. Start it with `assistant start`."

The `--tui` flag on `assistant start` suppresses the browser auto-open and launches the TUI after the gateway is healthy.

---

## 7. Self-Configuration (DB-Driven)

### 7.1 Current State — Already DB-Driven

Self-configuration data **already lives in the database**, not in markdown files:

| Data | Current Location | Table | Notes |
|------|-----------------|-------|-------|
| **Experts** (identity/personas) | PostgreSQL | `presets` | 11 system experts with systemPrompt, criticalRules, deliverableTemplate, skillIds, toolIds |
| **Skills** (domain knowledge) | PostgreSQL | `skills` | 27 system skills with markdown content, principles, bestPractices, antiPatterns, frameworks |
| **Tools** | In-memory ToolRegistry | (not persisted) | 18 built-in tools + plugin tools from `extensions/` dir |
| **Role prompts** | Hardcoded in `roles.ts` | (not persisted) | 16 roles with system prompt templates + SECURITY_PREAMBLE |
| **Project context** | File | `.assistant/project-summary.md` | Auto-updated per workspace after agent/pipeline runs |

**No markdown file self-configuration is needed.** Adding IDENTITY.md / TOOLS.md / EXPERTS.md files would create a sync problem with the DB. Instead, extend the existing DB-driven pattern.

### 7.2 Changes Needed

#### Move role system prompts to DB

The 16 role definitions in `src/core/orchestrator/roles.ts` are the last hardcoded identity configuration. Move them to the `presets` table (or a new `roles` table) so they're editable at runtime.

```
Current: roles.ts → ROLE_CONFIGS hardcoded object → getRoleConfig(role)
Target:  roles table (DB) → cached in memory → getRoleConfig(role)
         Seed on startup, editable via API/UI, audit logged
```

The SECURITY_PREAMBLE remains hardcoded (it's a safety boundary, not configurable).

#### Expose tool manifests via API

Tool descriptions are available at runtime via `registry.getManifests()` but not persisted or user-viewable. Add:
- `GET /tools/manifests` — returns all tool manifests (name, description, permissions, functions)
- Display in dashboard under a "Tools" page

#### Skill content editing in UI

Skills already support markdown `content` field. The UI should allow editing skill content (currently only seeded at startup). The existing Skills page needs a content editor.

### 7.3 What the Agent Can Self-Configure

| Capability | How | Security Gate |
|------------|-----|---------------|
| Create skills | Insert into `skills` table via scheduling/tool API | Stored as user-created (`isSystem: false`) |
| Modify own system prompt | Update expert's `systemPrompt` via API | Audit logged, user can review/revert via UI |
| Suggest new expert profiles | Insert into `presets` table | Stored as user-created (`isSystem: false`) |
| Switch own model | `/expert` command or API | Bounded by available models in registry |
| Compact own context | Automatic or `/compact` | No gate needed |
| Update project summary | Write to `.assistant/project-summary.md` | Already implemented, auto-triggered |

### 7.4 What the Agent CANNOT Self-Configure

- System experts/skills (`isSystem: true` — read-only for agents)
- SECURITY_PREAMBLE (hardcoded safety boundary)
- Vault credentials (requires user auth)
- Permission rules (requires admin)
- Channel connections (requires user setup)
- Other users' sessions or data
- Gateway configuration (restart required, admin only)

---

## 8. Agent Communication Protocol

### 8.1 Current State

The assistant uses MCP (Model Context Protocol) to expose itself as a tool server. External agents (Claude Code, Gemini CLI) call the assistant's tools via MCP.

### 8.2 Enhancement: Bidirectional Agent Protocol

Add an ACP-inspired layer for IDE and external client integration:

```
IDE Extension
    │
    ├─ Connect to gateway via WS (Cloudflare or local)
    ├─ Auth with API key
    ├─ Send: { type: "chat.send", content: "refactor this function", context: { file, selection } }
    ├─ Receive: streaming events (agent thinking, tool calls, file edits)
    └─ Respond to: permission requests, approval prompts
```

This builds on the existing gateway protocol (Section 2.3) — no separate protocol needed. An IDE extension is just another gateway client with `clientType: "acp"`.

### 8.3 Agent-to-Agent (Internal)

Existing agent worker spawning stays internal to the orchestrator. The gateway doesn't need to mediate agent-to-agent calls — they share the same process and AgentManager.

If future multi-machine agents are needed, agents would connect as gateway clients with `clientType: "agent"` and use short-lived JWTs scoped to their session.

---

## 9. Monitor Dashboard Enhancements

### 9.1 New Dashboard Pages

| Page | Content | Priority |
|------|---------|----------|
| **Gateway Connections** | Live connection list: userId, clientType, IP, duration, events/sec | High |
| **Channel Health** | Per-channel: connected/disconnected, last message, error rate, latency | High |
| **Event Stream** | Real-time event log with filters (like OpenClaw's event log) | Medium |
| **Usage Analytics** | Token usage, cost by expert/model/user, trends | Medium |
| **Audit Log** | Security events, permission requests, auth failures | High |
| **Stall Monitor** | Agents currently stalled, historical stall frequency | Low |

### 9.2 Existing Pages to Enhance

| Page | Enhancement |
|------|-------------|
| **Home** | Add gateway connection count, channel status indicators |
| **Agents** | Add real-time emoji status matching channel feedback |
| **Chat** | Show which expert is active, token usage footer |

---

## 10. Migration Strategy

### Phase 0: Foundation (Security)
- [ ] Define gateway protocol schema (TypeScript types + validation)
- [ ] Implement `ConnectionManager` with auth handshake
- [ ] Implement `GatewayRateLimiter` (per-connection)
- [ ] Add gateway audit events to existing audit trail
- [ ] Add local-token auth for TUI/local clients
- [ ] Add Cloudflare Access JWT validation for remote clients
- [ ] Integration tests: auth flows, rate limiting, connection lifecycle

### Phase 1: Event Bus + Protocol
- [ ] Implement `GatewayEventBus` (typed pub/sub replacing scattered EventEmitters)
- [ ] Implement `ProtocolHandler` (schema validation + routing)
- [ ] Implement `PresenceTracker` (connection state)
- [ ] Migrate existing WebSocket endpoints to gateway protocol (3 endpoints: `/ws` main, `/ws/permissions`, `/ws/browser-bridge`)
- [ ] Backward-compatible: existing WebChat clients continue to work during transition
- [ ] Gateway connections dashboard page
- [ ] Integration tests: event delivery, subscriptions, back-pressure

### Phase 2: Channel Commands + Feedback
- [ ] Implement command handler framework at gateway level
- [ ] Add new commands: `/expert`, `/compact`, `/think`, `/verbose`, `/abort`, `/usage`
- [ ] Implement `FeedbackManager` (emoji reactions)
- [ ] Implement `StallDetector`
- [ ] Add typing indicator lifecycle management
- [ ] Add configurable response footers
- [ ] Channel health dashboard page
- [ ] Tests: command parsing, feedback timing, stall detection

### Phase 3: Channel Adapter Migration
- [ ] Define channel adapter protocol (gateway ↔ adapter messages)
- [ ] Migrate Telegram to external adapter process
- [ ] Migrate Slack to external adapter process
- [ ] Move Teams webhook into gateway HTTP server
- [ ] Move WhatsApp webhook into gateway HTTP server
- [ ] Refactor UMI to gateway-internal router
- [ ] Update `assistant start` to manage adapter processes
- [ ] Adapter crash recovery (auto-restart with backoff)
- [ ] Per-adapter HMAC keys in vault
- [ ] Tests: adapter isolation, crash recovery, message routing

### Phase 4: TUI
- [ ] Scaffold Ink-based TUI app (`src/tui/`)
- [ ] Implement gateway WS client with local-token auth
- [ ] Chat view (streaming responses)
- [ ] Expert selector modal
- [ ] Session selector modal
- [ ] Agent panel (toggle)
- [ ] All channel commands available as TUI commands
- [ ] `assistant tui` and `assistant start --tui` entry points
- [ ] Tests: TUI rendering, command handling

### Phase 5: Self-Configuration (DB-Driven) + Agent Protocol
- [ ] Move role system prompts from hardcoded `roles.ts` to DB (new `roles` table or extend `presets`)
- [ ] Seed role prompts on startup, cache in memory, reload on change
- [ ] Add `GET /tools/manifests` API endpoint
- [ ] Add skill content editor to Skills UI page
- [ ] Allow agents to create user-scoped skills/experts via tool API (audit logged)
- [ ] Protect `isSystem: true` records from agent modification
- [ ] ACP-style IDE client support via gateway protocol
- [ ] Agent-to-agent JWT auth for future multi-machine setup
- [ ] Tests: self-config boundaries, permission enforcement, role prompt loading

### Phase 6: Dashboard + Observability
- [ ] Gateway connections page (real-time)
- [ ] Channel health page
- [ ] Event stream viewer
- [ ] Audit log viewer
- [ ] Usage analytics (by expert, model, user)
- [ ] Enhance home page with gateway metrics

### Phase 7: Documentation & Architecture Updates
- [ ] Update `README.md` — new architecture diagram, gateway setup instructions, TUI section
- [ ] Update API documentation (Swagger/OpenAPI) — new gateway protocol, `/health/time`, `/tools/manifests`
- [ ] Create `docs/architecture/gateway.md` — detailed gateway architecture with diagrams
- [ ] Create `docs/architecture/channels.md` — adapter pattern, how to add a new channel
- [ ] Create `docs/architecture/protocol.md` — full gateway protocol reference (client → gateway, gateway → client message types)
- [ ] Create `docs/guides/tui.md` — TUI user guide, keybindings, commands
- [ ] Create `docs/guides/self-configuration.md` — how experts, skills, roles are configured (DB-driven)
- [ ] Create `docs/guides/channel-adapter.md` — how to build a custom channel adapter
- [ ] Update `docs/guides/plugins.md` (if exists) — plugin tools + gateway integration
- [ ] Update existing inline JSDoc/TSDoc in refactored modules
- [ ] Update `CHANGELOG.md` with gateway refactor summary
- [ ] Archive old architecture docs that no longer apply

### Phase 8: Validation & Full Test Suite
- [ ] Update all existing unit tests for refactored modules (gateway, websocket, UMI, channels)
- [ ] New unit tests for: ConnectionManager, GatewayEventBus, ProtocolHandler, PresenceTracker, FeedbackManager, StallDetector
- [ ] New unit tests for: command handlers, channel adapters (mocked gateway WS)
- [ ] New unit tests for: TUI components (Ink test utilities), local-token auth
- [ ] New unit tests for: DB-driven role loading, self-config permission enforcement
- [ ] Integration tests: full auth flows (session token, HMAC, local-token, Cloudflare JWT)
- [ ] Integration tests: channel adapter → gateway → orchestrator → response → adapter round trip
- [ ] Integration tests: WebSocket protocol version negotiation, reconnection, event replay
- [ ] Integration tests: rate limiting under load, connection budget enforcement
- [ ] Integration tests: pipeline execution through new gateway event bus
- [ ] E2E tests: update existing `scripts/test-e2e.ts` suite for new gateway protocol
- [ ] E2E tests: TUI launch → connect → send message → receive response → disconnect
- [ ] E2E tests: channel adapter process lifecycle (start, crash, auto-restart)
- [ ] E2E tests: multi-client scenario (WebChat + TUI + channel adapter concurrent)
- [ ] E2E tests: permission request → approval → tool execution through gateway
- [ ] Run full test suite: `bun test` — **0 failures required**
- [ ] Run E2E suite: `bun run test:e2e` — **0 failures required**
- [ ] Run TypeScript check: `npx tsc --noEmit` — **0 errors on both backend and frontend**
- [ ] Performance test: 100 concurrent WebSocket connections, measure event delivery latency
- [ ] Security test: auth bypass attempts, rate limit enforcement, connection budget limits

---

## 11. Validation & Test Suite

> This phase runs AFTER all other phases. No phase is considered complete until its tests pass. Phase 8 is the final gate.

### Test Infrastructure

**Runner:** Bun test (native, NOT Jest/Vitest)
**Config:** `bunfig.test.toml` with preload `src/test-setup.ts`
**Existing suites:** 18 test files across core, api, security, channels, hooks, models, mcp

### Test Categories

#### Unit Tests (per module, mocked dependencies)

Each new module gets a co-located `.test.ts` file:

```
src/core/gateway.test.ts                    — ConnectionManager, auth handshake, rate limiter
src/core/gateway-event-bus.test.ts          — Pub/sub, filtering, back-pressure, replay
src/core/gateway-protocol.test.ts           — Schema validation, routing, version negotiation
src/core/presence-tracker.test.ts           — Connection tracking, idle timeout, cleanup
src/core/feedback-manager.test.ts           — Emoji mapping, debounce timing, stall detection
src/core/command-handler.test.ts            — Command parsing, permission checks, all commands
src/channels/adapters/telegram.test.ts      — Adapter ↔ gateway WS mock
src/channels/adapters/slack.test.ts         — Adapter ↔ gateway WS mock
src/tui/tui-client.test.ts                  — WS connection, local-token auth, reconnect
```

#### Integration Tests (real DB + Redis, no external services)

```
src/integration/gateway-auth.test.ts        — Full auth flows against real session manager
src/integration/gateway-channels.test.ts    — Adapter → gateway → orchestrator round trip
src/integration/gateway-events.test.ts      — Event delivery across multiple clients
src/integration/gateway-permissions.test.ts — Permission request through gateway protocol
src/integration/gateway-pipelines.test.ts   — Pipeline execution with event bus
```

#### E2E Tests (full system, `scripts/e2e/`)

```
scripts/e2e/gateway-protocol.ts             — WebSocket connect → auth → chat → events → disconnect
scripts/e2e/channel-adapters.ts             — Start adapter process → send message → get response
scripts/e2e/tui-lifecycle.ts                — Launch TUI → interact → exit
scripts/e2e/multi-client.ts                 — Concurrent WebChat + TUI + adapter
scripts/e2e/crash-recovery.ts               — Kill adapter → verify auto-restart
```

### Success Criteria

| Check | Command | Required Result |
|-------|---------|-----------------|
| TypeScript (backend) | `npx tsc --noEmit` | 0 errors |
| TypeScript (frontend) | `cd web && npx tsc --noEmit` | 0 errors |
| Unit tests | `bun test` | 0 failures |
| E2E tests | `bun run test:e2e` | 0 failures |
| No regressions | All 18 existing test suites pass | 0 failures |

**A phase is not complete until all tests written for that phase pass AND all pre-existing tests still pass.**

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing channels during migration | High | Phase 3 migrates one channel at a time. Each channel has a rollback path (re-enable in-process mode). Feature flag per channel. |
| Security regression (new auth surface) | Critical | Phase 0 is security-only. Pen-test before proceeding. All new auth paths have integration tests. |
| Performance (WS hub bottleneck) | Medium | Event bus is in-memory pub/sub — fast. Back-pressure prevents slow clients from blocking. Load test at 100 concurrent connections. |
| TUI maintenance burden | Low | TUI is a thin client — all logic is in the gateway. Ink/React model keeps rendering simple. |
| Protocol versioning complexity | Medium | Support current + 1 previous version only. Clean deprecation policy. |

---

## Dependencies

- **Ink** (`ink@4.4.1`) — already in `package.json` for TUI
- **Cloudflare Tunnel** — already running with domain
- **Existing security infrastructure** — vault, session manager, permission manager, audit trail all stay and get extended
- **No new external services required** — gateway runs in the existing process, adapters are child processes
- **Test runner:** Bun test (native) — config in `bunfig.test.toml`, preload `src/test-setup.ts`
- **Existing test suites (18):** Must continue to pass throughout all phases
- **Plugin tools:** `extensions/` directory plugin loading must be preserved in tool registry migration
- **DB-driven config:** Experts (presets table), Skills (skills table), Pipeline Templates (pipeline_templates table) — all already in PostgreSQL, no file-based config needed
