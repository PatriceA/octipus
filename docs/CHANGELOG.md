# Changelog

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
