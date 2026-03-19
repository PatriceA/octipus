# Capability Comparison: Assistant vs OpenClaw

Feature comparison with [OpenClaw](https://docs.openclaw.ai/) as of March 2026.

## Legend
- **Yes** — fully implemented
- **Partial** — implemented with limitations
- **No** — not implemented
- **N/A** — not applicable to our architecture

## Core Capabilities

| Capability | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Multi-agent orchestration | Yes | Yes | Orchestrator + specialist roles |
| Sub-agent spawning | Yes (depth/concurrency limits) | Yes (workers, teams, pipelines) | Assistant has 3 delegation modes |
| Agent team (parallel) | Yes | Yes | `spawn_team` |
| Pipeline (sequential) | Yes | Yes | `create_pipeline` with handoff context |
| Role-based routing | Yes | Yes | 16 specialist roles |
| Expert system / personas | Yes | Yes | DB-backed presets with tools + skills |

## Channels

| Channel | OpenClaw | Assistant | Notes |
|---|---|---|---|
| WebChat | Yes | Yes | WebSocket-based |
| Telegram | Yes | Yes | Polling via grammy |
| Slack | Yes | Yes | Socket mode via Bolt |
| WhatsApp | Yes | Yes | Cloud API webhooks |
| Microsoft Teams | Yes | Yes | Bot Framework webhook |
| Discord | Yes | No | Not planned currently |
| Signal | Yes | No | Not planned currently |
| SMS | Yes | No | Not planned currently |

## Tools

| Tool | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Web search | Yes | Yes | SearXNG backend |
| Browser automation (Playwright) | Yes | Yes | Isolated headless browser |
| Real browser control | No | Yes | Browser extension (browser-ext) |
| Shell/command execution | Yes | Yes | Sandboxed per workspace |
| File system read/write | Yes | Yes | Workspace-scoped |
| Git operations | Yes | Yes | Dedicated git tool |
| Docker management | Yes | Yes | Container/image/compose ops |
| GitHub integration | Yes | Yes | Issues, PRs, releases |
| Knowledge base (RAG) | Yes (BM25 + vector) | Yes (hybrid BM25 + pgvector) | Tiered content (L0/L1/L2) |
| Document processing / OCR | Yes | Yes | glm-ocr via Ollama |
| Email (Google Workspace) | Yes | Yes | OAuth2 integration |
| Email (Microsoft 365) | Yes | Yes | Graph API integration |
| Calendar management | Yes | Yes | Google + Microsoft |
| Voice/TTS | Partial | Partial | Kokoro TTS |
| Image generation | Yes (via services) | No | Could add via nanobanana |
| Cross-channel messaging | Yes | Yes | Unified messaging tool |
| MCP protocol | No | Yes | External tool integration |

## Browser Automation (Detailed)

| Feature | OpenClaw | Assistant (browser-ext) | Assistant (Playwright) |
|---|---|---|---|
| Navigate to URL | Yes | Yes | Yes |
| Click elements | Yes | Yes (+ double-click) | Yes |
| Type/fill inputs | Yes | Yes | Yes |
| Screenshot | Yes | Yes | Yes (+ full-page, element) |
| Extract page content | Yes | Yes | Yes (text, HTML) |
| Execute JavaScript | Yes | Yes | Yes |
| Tab management (new/close/select) | Yes | Yes | N/A (page-based) |
| Hover element | Yes | Yes | Yes |
| Press keyboard key | Yes | Yes (+ modifiers) | Yes |
| Scroll (direction + to element) | Yes | Yes | Yes |
| Select dropdown option | Yes | Yes | Yes |
| Drag and drop | Yes | Yes | Yes |
| Wait for element/text | Yes | Yes | Yes |
| Highlight element (debug) | Yes | Yes | N/A |
| Cookie read/write | Yes | Yes | N/A |
| localStorage/sessionStorage | Yes | Yes | N/A |
| Console log capture | Yes | Yes | N/A |
| Network request monitoring | Yes | Yes (Performance API) | N/A |
| Dialog handling (alert/confirm) | Yes | Yes | N/A |
| PDF generation | Yes | N/A | Yes |
| Real browser (user sessions) | Partial (attach mode) | Yes (default) | No |
| Device emulation | Yes | No | Possible via Playwright |
| Performance tracing | Yes | No | Possible via Playwright |

## Automation & Scheduling

| Feature | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Cron-based scheduling | Yes | Yes | Hooks with cronExpression |
| Event-driven hooks | Yes | Yes | 8 trigger types |
| Webhook triggers | Yes | Yes | Custom webhook endpoints |
| Recurring task management | Yes | Yes | UI + API + MCP |
| Agent-spawning actions | Yes | Yes | orchestrated agent spawning |

## Security

| Feature | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Tool access profiles | Yes | Yes | Permission system (ALLOW/ASK/DENY) |
| Per-action permissions | Yes | Yes | Tool-level permission checks |
| Model failover chains | Yes | Yes | Fallback models via LiteLLM |
| Security preamble | No | Yes | Injected into all worker prompts |
| Prompt injection protection | Partial | Yes | SECURITY_PREAMBLE + input guard |
| Credential vault | Partial | Yes | Encrypted credential storage |
| Red-team test suite | No | Yes | Automated security eval suite |

## Knowledge & RAG

| Feature | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Vector search (cosine) | Yes | Yes | pgvector with HNSW index |
| BM25 full-text search | Yes | Yes | PostgreSQL tsvector + GIN |
| Hybrid search (RRF) | Yes | Yes | Reciprocal Rank Fusion |
| Tiered content loading | Yes | Yes | L0 abstract, L1 overview, L2 full |
| Auto-indexing agent outputs | Yes | Yes | Agent files auto-indexed |
| Document processing pipeline | Yes | Yes | Upload → OCR → categorize → index |
| File categorization | Yes | Yes | LLM-based categorization |

## UI & Experience

| Feature | OpenClaw | Assistant | Notes |
|---|---|---|---|
| Web UI | Yes | Yes | React + Tailwind |
| Settings management | Yes | Yes | Hot-reload config |
| Agent monitoring | Yes | Yes | Events, logs, status |
| Session history | Yes | Yes | Full message history |
| File upload (webchat) | Yes | Yes | Multi-file upload support |
| Permission prompts | Yes | Yes | Channel-based + web approval |

## Gaps (OpenClaw has, we don't)

1. **Discord/Signal/SMS channels** — Lower priority; existing 5 channels cover most use cases
2. **Image generation** — Could integrate nanobanana service; not core functionality
3. **Device emulation** — OpenClaw can emulate mobile devices; could add via Playwright options
4. **Performance tracing** — OpenClaw has trace start/stop; could add via Playwright trace API

## Advantages (We have, OpenClaw doesn't)

1. **Real browser control (default)** — browser-ext connects to user's actual browser with cookies/sessions as the primary browser tool, not just an attach mode
2. **MCP protocol support** — Extend capabilities via external MCP servers
3. **Expert system** — DB-backed personas with role + tools + domain skills
4. **Domain knowledge skills** — Injected best practices (security, architecture, testing)
5. **Red-team testing** — Automated security evaluation suite
6. **Encrypted credential vault** — Secure secret storage
7. **Security preamble** — Hardened prompts for weaker models
8. **Pipeline templates** — Pre-built multi-stage workflows
9. **Hot-reload configuration** — Runtime config changes without restart
10. **Dual browser tools** — Both real browser (browser-ext) AND isolated Playwright, chosen per task
