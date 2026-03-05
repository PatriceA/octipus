# Changelog

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
