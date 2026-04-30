# Weekly Changelog — 2026-W10 (Mar 4–10)

> **Repository:** octipus
> **Period:** 2026-03-04 → 2026-03-10
> **Total commits:** 43 | **Lines changed:** ~52,000+

---

## Top 10 Largest Commits by Diff Size

| # | Lines Changed | Date | Commit |
|---|--------------|------|--------|
| 1 | 10,696 | Mar 4 | Refactor codebase structure: extract components, split modules, organize files |
| 2 | 5,096 | Mar 8 | Security hardening: replace argon2 native dep, fix auth/webhook/header vulnerabilities |
| 3 | 4,760 | Mar 5 | Refactor architecture: tools/skills/experts separation, skills CRUD API |
| 4 | 4,151 | Mar 4 | Add dynamic runtime configuration: settings DB, vault secrets, hot-reload |
| 5 | 3,283 | Mar 5 | Add preset agents, token optimization, agent teams, enhanced chat UI |
| 6 | 3,020 | Mar 6 | Revamp chat to editor-style 3-panel layout, unify Tools & Permissions page |
| 7 | 2,338 | Mar 5 | Add multi-session chat, RAG pipeline, recurring tasks, hook suggestions |
| 8 | 2,313 | Mar 8 | Add embedded database mode (PGlite + in-memory), setup wizard |
| 9 | 1,790 | Mar 10 | Add hook execution logging, merge recurring tasks into hooks |
| 10 | 1,546 | Mar 9 | Add browser extension bridge, fix duplicate chat messages |

---

## Changelog by Feature Area

### Architecture & Refactoring
- **Codebase restructure** (Mar 4, 65 files): Extracted components, split monolithic modules into organized file structure
- **Architecture refactor** (Mar 5, 95 files): Separated tools/skills/experts into distinct domains, added skills CRUD API, cleaned up README
- **Tools & Skills separation** (Mar 5): Split Tools and Skills into distinct pages in the web UI
- **README updates** (Mar 4–5): Updated project structure documentation to reflect new architecture

### Security
- **Security hardening** (Mar 8, 13 files): Replaced argon2 native dependency, fixed auth/webhook/header vulnerabilities across 5,096 lines
- **Critical vulnerability fixes** (Mar 6, 23 files): Patched critical and high-severity security issues
- **Remaining vulnerability fixes** (Mar 6, 21 files): Addressed remaining HIGH, MEDIUM, and LOW severity findings
- **Security scan & report** (Mar 6): Comprehensive security audit with SSRF, injection, and network findings documented

### Infrastructure & Database
- **Dynamic runtime configuration** (Mar 4, 45 files): Settings DB, vault secrets, hot-reload capability
- **Embedded database mode** (Mar 8, 44 files): PGlite + in-memory storage — zero external dependencies required
- **Setup wizard** (Mar 8): Interactive setup with auto-detection of running services and storage mode selection
- **RAG pipeline fixes** (Mar 9): Fixed pgvector schema, float encoding, documented nomic-embed-text dependency

### Chat & UI
- **3-panel chat layout** (Mar 6, 9 files): Revamped chat to editor-style layout, unified Tools & Permissions page
- **Multi-session chat** (Mar 5, 35 files): Added session management, cross-channel messaging, session context summaries
- **Enhanced chat UI** (Mar 5, 47 files): Preset agents, token optimization, agent teams
- **Session management fixes** (Mar 6): Auto-titles, expert selector, new session flow, cleanup
- **Browser extension bridge** (Mar 9, 30 files): Chrome extension integration, fixed duplicate chat messages, improved MCP integration

### Agent System
- **Auto-select experts** (Mar 7): Orchestrator auto-matches domain experts when spawning workers
- **Agent worker reasoning** (Mar 7): Workers override `think: true` for complex tasks even when model config disables thinking
- **Agent failure handling** (Mar 9): Auto-approve worker permissions, guard pipeline null refs, graceful embedding fallback
- **Pipeline approval flow** (Mar 9): Fixed approval flow, added WebSocket reconnection, expanded roles and topics

### Skills & Hooks
- **Skill CRUD** (Mar 9, 10 files): Full CRUD for skills across web UI and MCP; hook edit modal; extended e2e tests
- **Markdown skills** (Mar 10, 8 files): Added markdown content field for Claude Code-style skill definitions
- **Editable system skills** (Mar 10): Allow editing system/preset skills
- **Hook execution logging** (Mar 10, 16 files): Merged recurring tasks into hooks system, added prompting docs

### RAG & Knowledge
- **RAG auto-indexing** (Mar 9, 6 files): Expanded knowledge tool to 8 roles, added RAG documentation
- **RAG pipeline** (Mar 5): Added as part of multi-session chat feature set
- **Recurring tasks** (Mar 5): Hook suggestions, integrated into hooks system (Mar 10)

### Telegram & Messaging
- **Telegram fixes** (Mar 7): Fixed old-context issue, added chat message polling
- **Empty response fix** (Mar 7): Fixed empty Telegram responses, session delete, thinking toggle
- **Cross-channel messaging** (Mar 5): Messages from Telegram appear in web UI

### CLI & DevOps
- **CLI resilience** (Mar 5, 7 files): Fixed startup crash, improved CLI error handling, rewrote README
- **CLI restart & health** (Mar 8, 5 files): Fixed restart procedure, health checks, setup wizard flow
- **Windows support** (Mar 8): Suppress console windows, fix embedded DB path resolution
- **E2e test improvements** (Mar 8–9): Public health endpoints, duplicate user handling, agent cleanup after runs
- **Production build fix** (Mar 10): Added type parameter to api.get call
- **Hook UUID fix** (Mar 10): Fixed hook actions using invalid UUID strings for session IDs

---

## Summary

This was a high-velocity week focused on **three major themes**:

1. **Architecture overhaul** — Two large refactors (10,696 and 4,760 lines) reorganized the codebase from a monolithic structure into a clean domain-separated architecture (tools/skills/experts).

2. **Security hardening** — A full security audit produced a report and four fix commits totaling ~6,000 lines of changes, replacing vulnerable dependencies and patching injection/SSRF/auth issues.

3. **Feature expansion** — Major new capabilities including embedded database mode (zero-dependency deployment), browser extension bridge, multi-session chat, RAG pipeline, and a revamped 3-panel chat UI.

The week closed with refinements to the skills/hooks system and production stability fixes.
