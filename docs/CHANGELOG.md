# Changelog

## 2026-04-01 — Expert System, Channel Feedback, Permission Engine

### Expert System Overhaul
- **Expert prompts now work on ALL CLI agents**: Gemini CLI gets expert identity via temp `GEMINI.md` in cwd, Codex CLI via temp `AGENTS.md`, Claude Code via `--append-system-prompt`. System prompt is piped via stdin as additional context.
- **Root cause fix**: `loadHistory()` was called after `addSystemMessage()`, wiping the expert system prompt. Reordered in agent-manager so system prompt persists.
- **Expert switching on ALL channels**: `/expert <name>` now works on Telegram, Slack, WhatsApp, Teams — not just TUI. Expert selection stored in session context (persists across messages).
- **Hallucinated tool interception**: Small models (qwen3) that invent `respond`/`reply`/`answer` tools now have their message extracted and returned as final text response.
- **Ollama expert mode**: Thinking enabled (removes `think:false` override), response guidelines prevent tool-call loops, raw JSON tool calls stripped from output.

### Channel Feedback — Emoji Reactions
- **Emoji reactions replace text status messages** on Telegram, Slack, WhatsApp, Teams, WebChat
- **Reaction lifecycle**: 👀 received → 🧠/💻/🔍 worker spawned (role-specific) → 🔧/📖/💬 tool use → ✅ done / ❌ failed
- **Typing indicator**: Repeats every 4s (Telegram expires after 5s), stops on completion
- **Stall detection**: 😐 after 15s no progress, 😬 after 45s
- **Permission waiting**: ⏳ on approval_required event
- **Direct response feedback**: Casual messages now emit worker events so channels show 👀→✅
- **`setReaction()` and `sendTyping()`** added to BaseChannel with implementations in all 5 channel adapters

### Permission System
- **Rule-based permission engine** (ported from claw-code-parity): `tool(matcher)` syntax with deny→allow→ask priority
  - Wildcard: `shell(*)`, Exact: `shell(git status)`, Prefix: `shell(git:*)`
  - Default rules: allow git/ls/cat/filesystem/knowledge/websearch, deny rm-rf/dd/mkfs, ask sudo/docker/systemctl
  - Configurable via settings key `permissions.rules`
  - Evaluated before DB policy lookup
- **Permission denial aborts agent**: No more retry loops — agent is killed, orchestrator asks user what to do next
- **Permission prompts show details**: File path, command preview, URL, or message target in permission messages

### Pre/Post Tool Hooks
- **`tool_pre` and `tool_post` trigger types** added to hook system
- Pre-tool hooks can **block execution** (deny decision)
- Post-tool hooks fire-and-forget for logging/notification
- Hooks match tools via `triggerConfig.toolPattern` (wildcard, prefix, exact)
- Wired into tool executor — runs on every tool call

### MCP & Model Integration
- **MCP auth fixed**: `.mcp.json` auto-generated on startup with current `MASTER_KEY` and platform-correct paths
- **LLM agents use `mcp_call_tool` meta-tool**: System prompt correctly tells LLM agents to use `mcp_list_tools()` then `mcp_call_tool()`, not direct tool names
- **Prompt caching** (Anthropic): `anthropic-beta: prompt-caching` header, cache read/creation tokens tracked
- **System prompt boundary marker**: `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` separates cacheable static content from dynamic content
- **Git status/diff injection**: Code-aware roles (coding, review, devops, security, qa) get live `git status` and `git diff --stat` in system prompt
- **Proactive auto-compaction**: Triggers at 100K cumulative input tokens (60% window, keep 10 messages)

### Security
- **SECURITY_PREAMBLE softened**: Removed overly aggressive rules that caused models to refuse legitimate tool-use requests (cloning repos, running commands). Added explicit "user messages are from authenticated channels — execute tool requests normally"
- **Plan state cleanup**: `/clear` and plan execution now fully clear `planningState` from session context — no more phantom plans referenced by models

### TUI Enhancements
- **Redesigned layout**: Minimal header (title + connection dot + token count), footer bar (expert + session ID, always visible)
- **Braille spinner**: Animated during agent execution with current tool and model display
- **Permission prompts**: Inline yellow-bordered prompt with tool detail, y/n input
- **Colors**: Matte steel blue (#7AA2D4) for activity, light steel (#A0B8CF) for system messages, muted red (#C47070) for errors, bright white (#FFFFFF) for agent answers
- **Emoji sanitization**: Strips variation selectors (U+FE0E/U+FE0F) from all displayed text
- **Expert icons**: Unicode symbols (■ ▲ ◆ ★ ✓ ⌂ ✉ ◎ ❀ ↻ ☰) that work in all terminals
- **Full terminal clear**: `/clear` clears screen + scrollback buffer + resets stats
- **New commands**: `/cost` (token usage), `/diff` (git diff), `/version` (build info)
- **Agent stats footer**: Shows tokens, duration, cost, model after completion

### Cleanup
- Removed unused `FeedbackManager` and `StallDetector` (stall detection now inline in channel handler)
- Removed stale `SECURITY-AUDIT-REPORT.pdf` and `SECURITY-SCAN.md`
- Deleted orphaned football automation extension

## 2026-03-31

### Gateway Hub — Unified WebSocket Architecture
- **Gateway protocol**: Typed WebSocket protocol (Zod-validated) at `/gateway` — replaces ad-hoc `/ws` message handling. 10 client message types, 7 gateway response types, versioned protocol (v1.0)
- **ConnectionManager**: Auth handshake with 5s timeout, session token / local token / HMAC / API key auth, connection budgets (per-user: 10, per-IP: 50), graceful drain on shutdown
- **GatewayEventBus**: Central typed pub/sub replacing scattered EventEmitters. Pattern-based subscriptions (`agent.*`, `*`), per-session replay buffer (200 events), error isolation between handlers
- **RateLimiter**: Sliding window per-connection per-action with trust-level-aware limits (user: 30/min chat, system: 200/min)
- **PresenceTracker**: Tracks who's connected from where with per-client-type idle timeouts (30min remote, none for local/system)
- **CommandRegistry**: 9 built-in commands (`/help`, `/status`, `/expert`, `/abort`, `/clear`, `/compact`, `/think`, `/verbose`, `/usage`) with alias support and trust-level permission gating
- **FeedbackManager**: Maps agent lifecycle events to emoji reactions with debounce (700ms intermediate, immediate terminal). Tool-specific emojis (filesystem, shell, browser, etc.)
- **StallDetector**: Fires soft (10s) and hard (30s) stall notifications for agents with no progress
- **Event bridge**: Orchestrator + AgentManager + PermissionManager events → gateway event bus
- **Channel adapters**: GatewayAdapter base class with adapter↔gateway protocol. Transitional Telegram + Slack adapters wrapping existing implementations
- **TUI**: Ink-based terminal UI with gateway WS client, local-token auth, exponential backoff reconnect, chat + commands
- **DB-driven roles**: System prompt templates moved from hardcoded `roles.ts` to `roles` database table. Seeded on startup, editable at runtime via API
- **Dashboard API**: `GET /api/gateway/status`, `/connections`, `/events/stats`, `/adapters`
- **56 new tests**: Protocol validation, rate limiting, event bus pub/sub, command handlers, stall detection — all passing
- **6 pre-existing test failures fixed**: conformance (mock routing), evaluators (mock provider), git parseStatus (regex)
- **Migration**: 0020 (gateway audit enum values), 0021 (roles table)

### Scheduled Tasks & Calendar
- **Datetime tasks**: One-time scheduled hooks at specific date/time (auto-disable after firing)
- **Calendar tab**: Weekly view in Hooks & Tasks with week navigation, cron + datetime task display
- **Server time display**: `GET /health/time` endpoint, shown in calendar and tasks tabs
- **Schedule picker**: Separate date + time pickers for datetime mode

### Pipeline System
- **DB-driven templates**: Removed hardcoded pipeline templates, orchestrator uses DB templates
- **Retry config in UI**: stageType, maxRetries, retryTargetStage exposed in pipeline editor
- **Dynamic template selection**: `list_pipeline_templates` meta-tool for orchestrator

### Settings & UI
- **Settings audit**: Removed duplicate workspace path from Configuration tab, wired Notifications tab to backend
- **Automation UX**: Renamed "Create Hook" to "New Automation", smart button labels, hidden redundant checkboxes

## 2026-03-27

### Model Evaluation & Provider Testing Framework
- **Provider conformance tests**: 10 automated tests per provider (basic completion, streaming, tool calling, vision, embeddings, etc.) with capability-gated skipping
- **Model evaluation framework**: 8 evaluators (relevance, faithfulness, coherence, format-compliance, latency, tool-accuracy, instruction-following, completeness) with 4 standard datasets
- **Model capabilities locked**: supportsTools/Vision/Streaming are preset per provider, not user-editable
- **Evaluation API**: Full REST API for running tests, storing results, cross-model comparison
- **Web UI**: Conformance matrix, score cards, drill-down, comparison table in Evaluations page
- **Chat commands**: `/eval conformance`, `/eval quality <model>`, `/eval compare`
- **CI integration**: GitHub Action runs conformance tests on provider code changes

### Docker Support
- Dockerfile with multi-stage build (Bun + Next.js)
- docker-compose.yml with PostgreSQL (pgvector) and Redis
- Default ports: API=3015, Web=3017

### Mobile App Integration
- QR code device pairing in Settings > Mobile App
- Backend pairing endpoint with LAN IP detection
- API host defaults to 0.0.0.0 for LAN access

### Bug Fixes
- Fix embeddings cleanup PostgresError (uuid cast)
- Register evaluation migration in Drizzle journal

## 2026-03-26

### CLI Agent Reliability & Windows Stability
- **Gemini CLI event parsing**: Fixed parser to match actual Gemini CLI stream-json format — `tool_use` (not `tool_call`), `parameters` (not `tool_args`), `result` with nested `stats` (not top-level `stats`), streaming deltas
- **Codex CLI event parsing**: Rewrote parser for actual Codex `--json` JSONL format — `thread.started`, `item.started`/`item.completed` (command_execution, agent_message), `turn.completed` with usage stats
- **Claude CLI `--verbose` flag**: Claude Code now requires `--verbose` when using `--output-format stream-json` with `--print` mode
- **Removed `--bare` flag**: Claude CLI `--bare` disables OAuth/keychain auth, breaking Pro/Max subscription users. Removed to preserve normal auth flow
- **Windows command-line length fix**: System prompts passed via `--append-system-prompt-file` (temp file) instead of `--append-system-prompt=<inline>` to avoid the ~8191-char Windows limit
- **CLI agent hard timeout**: Reliable `setTimeout`-based timeout that force-kills CLI processes (spawn `timeout` option is unreliable on Windows). Default 15 min
- **Agent stop propagation**: Stopping an agent now stops all agents in the same session via `stopSession()` — prevents orphan CLI workers running indefinitely
- **Aborted agents throw**: CLI workers throw on abort instead of resolving, so orchestrator correctly detects stop and doesn't proceed to next pipeline stage
- **Stopped status in UI**: Orchestrator emits `status: 'stopped'` (not `'failed'`) on user abort; chat UI marks agents as 'stopped' when response indicates abort

### Startup & Process Management
- **Lazy Playwright imports**: `import { chromium } from 'playwright'` moved from top-level to lazy `await import('playwright')` in browser, websearch, and screenshot tools. Startup dropped from ~20s to ~2s
- **Graceful shutdown**: `stopAll()` kills all running agents and CLI child processes before exit
- **Orphan process cleanup**: `kill_all_assistant` in `assistant.cmd` now kills orphan `cmd.exe` wrapper processes and stray `bun.exe` instances that held log file locks, preventing backend restart

### Ollama Configuration
- **Optional Ollama URL**: Removed hardcoded `http://localhost:11434` default. Ollama URL is now truly optional — if not configured, health check returns `not_configured` instead of failing against localhost
- **Settings-driven health check**: `checkOllama()` uses the DB-configured URL, not a hardcoded default

## 2026-03-19

### Knowledge Base Upgrade — Hybrid Search & Tiered Content
- **Hybrid search**: Three search modes — `hybrid` (BM25 + vector with Reciprocal Rank Fusion), `fts` (BM25 full-text), `vector` (cosine similarity) — via `mode` parameter on `search_knowledge`
- **Tiered content loading**: L0 abstract (2-3 sentence summary), L1 overview (key points), L2 full content — reduces token usage for browsing results
- **BM25 full-text search**: PostgreSQL tsvector column with GIN index, auto-populated from content
- **`read_knowledge` tool**: Load full L2 content for specific entries after browsing L0/L1 summaries

### Document Processing & OCR
- **Document upload API**: `POST /api/documents/upload` with multipart file upload, queue-based processing
- **Document management**: `GET /api/documents` (list with category/status filters), `GET /api/documents/:id` (details)
- **OCR pipeline**: Upload → glm-ocr via Ollama → LLM categorization → file organization → summary → knowledge base indexing
- **Channel attachments**: Automatic file processing for uploads from Telegram, Slack, Teams, WhatsApp
- **Documents schema**: New `documents` table with status tracking, categorization, OCR text, summaries

### Browser Extension v2.0.0
- **16 new commands**: Tab management (new_tab, close_tab, select_tab), interactions (hover, select, press_key, scroll, drag), waiting (wait_for, highlight), storage (set_cookies, get_storage, set_storage), monitoring (get_console, get_network), dialogs (handle_dialog)
- **Double-click support**: `click` command now accepts `doubleClick` parameter
- **Playwright parity**: Added hover, press_key, drag, and PDF generation to the Playwright browser tool
- **Full competitor feature parity**: Browser automation now matches competitor's capabilities across both browser tools

### Channel Expansion
- **WhatsApp channel**: Meta Cloud API with webhook verification, HMAC signature validation, media support, message deduplication
- **Teams webhook**: Azure Bot Framework webhook endpoint for production deployments
- **Cross-channel messaging tool**: Unified `messaging` tool with `list_channels`, `list_contacts`, `send_message` for sending across all connected channels

### Testing
- **22 new E2E tests**: Documents API, browser extension v2 tools, messaging tool, knowledge hybrid search, WhatsApp/Teams webhooks
- **112 total E2E tests** (up from 90), all passing
- **Capability eval suites**: 5 YAML eval files covering routing, tools, quality, orchestration, and channel-specific features

## 2026-03-08

### Embedded Database Mode (Zero External Dependencies)
- **PGlite support**: In-process WASM PostgreSQL via `@electric-sql/pglite` — no external PostgreSQL needed
- **In-memory storage**: `MemoryStorageProvider` replaces Redis for cache, pub/sub, and queues in embedded mode
- **StorageProvider abstraction**: Interface over Redis with two implementations (`RedisStorageProvider`, `MemoryStorageProvider`) — existing code keeps working via compatibility wrappers
- **Custom PGlite migrator**: Drizzle's built-in migrator uses `query()` (single statement only); custom migrator uses `exec()` for multi-statement SQL with automatic `uuid_generate_v4()` → `gen_random_uuid()` patching
- **Lazy DB access**: All repositories and services use getter-based lazy initialization to support async DB startup in embedded mode
- **`STORAGE_MODE` env var**: `embedded` (PGlite + in-memory) or `external` (PostgreSQL + Redis, default) — fully backward compatible
- **Interactive setup wizard** (`bun run setup`): Auto-detects running services, storage mode selection, optional extras installation (Playwright, Ollama), generates `.env`, runs migrations

### Agent & Orchestrator Fixes
- **Worker failure events**: `worker_completed` event emitted with `failed`/`stopped` status so UI shows agents as failed instead of perpetually running
- **Anti-hallucination guard**: Error return from failed workers prefixed with `[WORKER FAILED]... Do NOT make up or fabricate any data`
- **maxTokens fix**: Removed hardcoded 8192 fallback — uses model's own `defaultMaxTokens` or `maxTokens` per model registry
- **Max Output Tokens UI**: Field shown but disabled in edit model dialog (model capability, not user-configurable)

## 2026-03-07

### Telegram & Chat Fixes
- **Recent message loading**: Fixed long-lived sessions loading oldest messages instead of most recent — `findRecentBySession()` replaces `findBySession()` in orchestrator context
- **Thinking token stripping**: `<think>` blocks stripped from both sync and streaming LLM responses — prevents empty responses from models with reasoning enabled
- **Disable Thinking UI**: Checkbox in model Add and Edit dialogs to set `extraBody: { think: false }` per model
- **Agent worker reasoning**: Agent workers override `think: true` for complex tool-use tasks, even when model config disables thinking
- **Chat auto-update**: 10-second polling for messages and session list — cross-channel messages (Telegram) appear in web UI without reload

### Automatic Expert Selection
- **Auto-match experts**: `spawn_worker(role)` automatically finds and applies the matching system expert — inherits system prompt, domain knowledge skills, and model preference
- **Priority chain**: Explicit UI expert selection > auto-matched expert by role > generic role config
- **Skill injection**: Expert's assigned skills loaded via `SkillRegistry.buildPromptFragment()` and appended as domain knowledge to worker context

### Session Management
- **Session delete fix**: Delete now calls backend API before removing from UI state — sessions no longer reappear on reload
- **Auto-titling**: Sessions automatically titled from first message content
- **Session cleanup cron**: Hourly job archives inactive webchat sessions older than 24h

## 2026-03-06

### Security Hardening (42 vulnerabilities fixed)
- **Rate limiting**: Redis sliding-window rate limiter on auth endpoints (20 req/min per IP)
- **Account lockout**: Exponential backoff after 5 failed login attempts (15/30/60 min)
- **HttpOnly session cookies**: Set alongside JSON response for XSS-safe session persistence
- **SSRF protection**: URL validation blocks private/internal IP ranges
- **Command injection prevention**: `spawn` with args array replaces `exec` with string interpolation in backup scripts
- **Timing-safe comparison**: HMAC-based constant-time comparison for webhook signatures
- **ReDoS protection**: `safeRegExp()` utility for user-supplied regex patterns
- **WebSocket sanitization**: Content trimmed to 50k chars, HTML entities escaped
- **Generic error messages**: Validation errors and auth failures no longer leak implementation details
- **Restricted health endpoints**: Detailed health info requires authentication
- **Session limits**: Maximum 20 concurrent sessions per user
- **Webhook HMAC verification**: Signatures verified before processing webhook payloads
- **Password complexity**: Uppercase, lowercase, and digit required
- **Secret name removal**: Error messages no longer include vault secret names
- **CORS hardening**: Wildcard origin disables credentials; explicit origins required for credentialed requests
- **Security headers**: Content-Type-Options, Frame-Options, XSS-Protection headers added

### Chat UI Revamp
- **3-panel editor layout**: Sessions sidebar, message timeline, context/tools panel
- **Rich prompt input**: Multi-modal input with file attachments and expert selection
- **Message timeline**: Code rendering, unified activity view, agent event display

## 2026-03-05

### Architecture Refactoring
- **Tools vs Skills separation**: Renamed executable "skills" to "tools" (`src/tools/`), introduced domain knowledge "skills" as DB-backed entities
- **Experts system**: Renamed "presets" to "experts" — pre-configured agent personas with assigned tools and skills
- **16 agent roles**: orchestrator, research, coding, review, qa, communication, general, design, devops, security, data, ai, finance, automation, pm, writing
- **15 system experts**: Coder, Reviewer, Researcher, UI/UX Designer, DevOps Engineer, Security Analyst, Data Engineer, AI Engineer, QA Engineer, Financial Analyst, Automation Engineer, Project Manager, Technical Writer, Communicator, General
- **20 system skills**: software-architecture, data-structures, test-automation, design-principles, design-frameworks, devops-practices, container-orchestration, security-practices, cloud-platforms, financial-analysis, ai-engineering, automation-patterns, database-design, api-design, project-management, technical-writing, performance-engineering, data-engineering, machine-learning, networking
- **Skills CRUD API**: Full REST API for creating/managing custom domain knowledge skills
- **Skills MCP tools**: `assistant_list_skills` and `assistant_get_skill`

### Multi-Session Chat, RAG, Recurring Tasks
- **Multi-session chat**: Multiple named chat sessions with context summaries
- **RAG pipeline**: Knowledge base with vector search (pgvector), file indexing, semantic search
- **Recurring tasks**: Cron-based scheduled tasks with CRUD API
- **Hook suggestions**: AI-powered automation suggestions based on user patterns
- **Cross-channel messaging**: Send messages across Telegram, Slack, Teams from any channel

## 2026-03-04

### Preset Agents & Token Optimization
- **Preset agent system**: Pre-configured agent personas (Coder, Reviewer, Researcher, etc.)
- **Token optimization**: Context compaction, token budget enforcement
- **Agent teams**: Parallel multi-agent execution
- **Enhanced chat UI**: Expert picker, session management

## 2026-03-03

### Agent Lifecycle & Runtime Limits
- **Agent stop/kill**: Full stop capability with `stopped` status
- **Token budget**: Per-agent token limit (default: 100k) prevents runaway agents
- **Agent timeout**: Wall-clock timeout checked before each LLM call
- **Communication role**: Google Workspace and Microsoft 365 skills for email, calendar, contacts

### MCP Authentication
- **MASTER_KEY auth**: Backend accepts MASTER_KEY as Bearer token for API/MCP access

### Web UI
- **Card design**: Standardized all cards with consistent ring/rounded styling
- **Color tokens**: Replaced hard-coded colors with semantic tokens
- **Settings fixes**: Fixed CLI integration detection

## 2026-03-02

### MCP Server Bridge
- **MCP server package**: 14 tools exposed for CLI models via stdio or HTTP transport
- **Skill execution API**: Bridge endpoint for MCP tool calls

### E2E Tests
- **Extended to 56 tests** covering tools, MCP, hooks, agents, sessions, models, chat

## 2026-03-01

### Orchestrator & Agent Runtime
- **Orchestrator**: Multi-agent orchestration with message classification
- **Worker isolation**: Workers receive task-only context, no session history
- **Consecutive failure protection**: Tools disabled after 3 failures
- **Reasoning model detection**: Auto-skips incompatible reasoning models
- **Safe fallback routing**: Only falls back to local models, never paid APIs

### Chat & Web Search
- **Session persistence**: Chat sessions survive page reloads
- **SearXNG integration**: Meta-search with Playwright fallback
- **Page fetching**: JS-rendered content extraction

### Model Management
- **Extra body parameters**: Per-model custom params (e.g., `{ think: false }`)
- **Model test endpoint**: Pre-registration connection validation

## 2026-02-28

### Web UI
- **Add Model dialog**: Provider-aware model selection
- **Pipeline templates**: Multi-stage pipeline creation
- **Notification bell**: Unread count badge
- **Dashboard**: System health overview
