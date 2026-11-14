<p align="center">
  <img src="docs/images/hero.png" alt="Octipus" width="600">
</p>

# Octipus

A self-hosted AI workspace for projects, knowledge, and connected tools.

[![Octipus on StartupScores](https://startupscores.com/badge/octipus.svg?style=shield&v=combo&theme=dark)](https://startupscores.com/open-source/octipus)

> **Alpha · building in public.** A working, opinionated platform — not a finished product. Breaking changes happen; migration notes ship with them. Treat it as a foundation to build on.

**Website:** [https://octipus.cc](https://octipus.cc)

---

## Install

**Requires Node.js 24.22.1 or newer (or 26.12.1+, including npm), Git, and a model provider.** Embedded mode needs no external database. Check `node --version` first; older Node versions can fail on crypto or module loading.

```bash
# Linux / macOS / WSL (Bash + curl) — quick start: five questions, ends with the web UI open
curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash -s -- --quick
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.ps1))) -Quick
```

Quick start uses embedded storage with default paths and ports, asks for an admin account and one model provider, then runs `octi start web` and opens **http://localhost:3007**. Drop `--quick` / `-Quick` for the full wizard (storage mode, ports, optional tools, voice); it ends with `octi start web` as the next step. Add the printed CLI directory to PATH if your shell needs it.

For Docker without host Node/npm, clone this repository and run `bash scripts/install-docker.sh`; keep the checked-in `.env.docker` template available because Compose loads it into the app container. The web UI is **http://localhost:3017**.

**[Full installation guide](docs/INSTALLATION.md)** — prerequisites, one-command start, manual install, headless setup, audits, upgrades, Docker, and troubleshooting.

---

## What it is

Octipus is an open-source, self-hosted AI workspace for working with projects,
knowledge, and connected tools. You can use it through a web interface, terminal,
or messaging channel, and choose local or hosted model providers.

The root agent answers with its own tools and can delegate bounded tasks to
specialist agents. Pipelines support explicit stages and human input. Available
capabilities depend on your models, installed tools, connections, and permissions.

## Project goal

The goal is to make everyday work easier to carry out and inspect: investigate a
codebase, prepare a sourced report, or turn information into follow-up tasks.
Octipus provides execution records, configurable permissions, and budget controls
to help you understand what ran and what needs attention.

This is an alpha project. Model output and tool execution can fail, and completed
work still needs verification. Local models support a self-hosted setup; hosted
providers and external services you connect receive the data sent to them. Self-hosting
lets you choose those connections, but does not make every workflow local.

The current improvement cycle focuses on measuring workflow reliability and
reviewing the execution code. Permission, status-reporting, navigation, and
acceptance-test changes from phases 1–4 are on `main`; the remaining evidence
and limitations are tracked in the
[consolidation report](docs/reports/consolidation-2026-09-10.md).

## Community

Contributions of every size welcome — bug reports, doc fixes, new roles, new channels, new tools.

- **GitHub Issues** — bugs and concrete feature requests
- **GitHub Discussions** — proposals, design conversations, show-and-tell
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — setup, repo layout, PR checklist
- **[DESIGN.md](./DESIGN.md)** — the principles every PR runs through
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** — how we run arguments
- **[ROADMAP.md](./ROADMAP.md)** — what's in flight

For security issues, see [SECURITY.md](./SECURITY.md). **Do not** file security reports as public issues.

CLI execution can reuse vendor logins where permitted. See [CLI agents](docs/CLI-AGENTS.md) for subscription, tool, plan and permission behavior.

## Architecture in one paragraph

```
Channels → Gateway (WebSocket, typed Zod protocol)
          → Root agent (answers with its own tools; spawns when a specialist is needed)
            → Agents (3-level Swarm: root → Agent → Subagent)
              → Tools / Skills / Roles / Pipelines
                → Models (Ollama, OpenAI, Anthropic, Gemini, OpenRouter, LiteLLM, CLI)
                  → Postgres + pgvector (or embedded PGlite)
```

**Hierarchy:** Tools (executable capabilities) → Skills (domain knowledge) → Roles (a tool set, a permission boundary and a prompt, editable from the Topics page) → Lanes (which model serves a kind of work) → Agents (runtime workers, 3-level Swarm via `spawn_child`) → Pipelines (sequential handover with approval gates).

Deep dive: [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md).

Release history and upgrade notes: [Changelog](CHANGELOG.md) · [GitHub releases](https://github.com/PatriceA/octipus/releases).

## Technologies and ideas worth a look

- **Node** end to end — one runtime for the server, the scripts, the tests and the web build.
- **Drizzle ORM** + Postgres + **pgvector** for hybrid (BM25 + vector) RAG.
- **PGlite** for embedded mode — zero external deps, single-user.
- **WebSocket gateway** with typed Zod protocol — every channel speaks the same dialect.
- **Three-tier permission system** (ALLOW / ASK / DENY) with pre/post hooks and audit trail.
- **Prompt-injection mitigations** — a system preamble, input checks, and an LLM output guard supplement execution permissions; they do not guarantee that hostile input will be detected.
- **AES-256-GCM encrypted vault** with per-tool access control.
- **Topic → model routing** — config-driven, no hardcoded defaults.
- **Browser extension** for human-in-the-loop control of the user's real Chrome.

## Feature set (current state)

| Area | What's there |
|---|---|
| **Agents** | 3-level Swarm, 16 built-in roles, editable custom roles, and seeded or mounted skills |
| **Models** | Ollama, OpenAI, Anthropic, Gemini, Grok, DeepSeek, Mistral, Z.AI (GLM), Moonshot (Kimi), Meta (Muse), OpenRouter, Voyage, custom OpenAI/Gemini-compat, LiteLLM, CLI (Claude Code / Codex / Antigravity / Vibe / GLM / Kimi) |
| **Tools** | Filesystem, shell (local/SSH/Docker), git, browser (Playwright + extension), web search, Docker, knowledge base, scheduling, voice, M365, GitHub, and external MCP bridges. The standalone MCP server exposes 83 tools across 23 groups, published as [`octipus-mcp-server`](https://www.npmjs.com/package/octipus-mcp-server). |
| **Channels** | Telegram, Slack, Teams, WhatsApp, web UI, TUI (chat shell + editor, built on [pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui)), voice (Twilio), MCP server |
| **Knowledge** | Hybrid search (BM25 + vector), tiered content, auto-indexing, document ingest + OCR, authored knowledge graph (notes, `[[wikilinks]]`, Obsidian vault + Canvas) |
| **Enrichment** | Deep Research (the Research example plugin: report with source references → Documents), To-Do list, Email triage, Hardware-aware onboarding |
| **Automation** | Hooks, webhooks, cron tasks, plugin system |
| **Eval** | Provider conformance suite, 16 built-in assertion types, red-team plugins (5 attacks, 49 cases) |
| **Security** | WebAuthn passkeys, TOTP 2FA, JWT sessions, encrypted vault, audit log |

Full feature breakdown: see the [documentation index](#documentation) below.

## Quick start

**Embedded (zero external deps, single-user):**

```bash
git clone https://github.com/PatriceA/octipus.git
cd octipus && npm ci
cd web && npm ci && cd ..
cd mcp-server && npm ci && cd ..   # standalone MCP server (not a root workspace)
npm run build
npm --prefix web run build
npm run setup        # the single wizard (same as `octi setup`)
node bin/octi.mjs start web   # backend + web UI (server / browser); works on Windows too
# …or `node bin/octi.mjs start` for the backend alone, then `npm run tui` / `node bin/octi.mjs desktop`
```

Then open [http://localhost:3007](http://localhost:3007) and log in
with the admin account you registered during `octi setup`. The terminal
sets up the install; the **setup guide** on the home page then sets Octipus
up for what you do: coding agents, your mailbox, a chat, separate areas of
work ([docs/ONBOARDING.md](docs/ONBOARDING.md)).

**Desktop app (optional):** the Tauri desktop client needs the Rust toolchain
plus Tauri's system libraries on top of the deps above. One line installs them
all — it detects your platform (Arch/Manjaro, Debian/Ubuntu, Fedora, openSUSE,
macOS) and warms the Cargo cache:

```bash
scripts/install-desktop-deps.sh    # then: octi desktop
```

Or fold it into the one-shot installer with `--desktop`:

```bash
curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash -s -- --desktop
```

**Docker (production):** see [docs/DOCKER.md](docs/DOCKER.md).
**External Postgres:** see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Requirements: **Node ≥ 24.22.1**, **Docker** (for the full stack), **Postgres 16** (external mode).

> **Runtime:** Node, everywhere — the server, the scripts, the tests, the TUI and the web build. `npm run build` produces `dist/index.js` and `npm start` runs that artifact, not the source; the web bundle is static files served by `web/serve.mjs`.

## Outlook

Highlights from the [roadmap](./ROADMAP.md):

- **Execution-code review** — simplify shared dispatch and lifecycle paths without weakening permission boundaries.
- **Measured workflow baselines** — run the opt-in live-provider suite and record its configuration and limits.
- **Trajectory learning consumers** — labeled training pairs from recorded runs.
- **Dynamic role definition from chat** — "define a role that does X with tools Y" → live role.
- **Skill marketplace** — export/import signed JSON, install from the web UI.
- **Pipeline templates from natural language** — describe a workflow, get a runnable pipeline.
- **First-class human-in-the-loop primitive** — wait-for-input nodes with form schemas.
- **Mobile clients** — native iOS/Android via the gateway protocol.

Open directions (later): federation between Octipus instances, local-first sync (PGlite + CRDTs), full-duplex voice, sandboxed tool execution (WASI), plugin signing.

## Documentation

| | |
|---|---|
| **[Agent Architecture](docs/AGENT-ARCHITECTURE.md)** | Tools, skills, roles, agents, swarm |
| **[Swarm Reliability & Verification](docs/SWARM-RELIABILITY.md)** | Receipts, scorer gates, crash-resume ledger |
| **[Tool & Role Routing](docs/TOOL-ROUTING.md)** | What triggers which tool or role |
| **[Channels](docs/CHANNELS.md)** | Telegram, Slack, Teams, WhatsApp, WebChat, Voice, MCP |
| **[Visible Work Plans](docs/WORK-PLANS.md)** | Follow progress and give feedback in web and terminal conversations |
| **[Chat Commands](docs/CHAT-COMMANDS.md)** | Slash commands and channel availability |
| **[API Reference](docs/API.md)** | REST and WebSocket API reference |
| **[Architecture Catalog](docs/architecture/generated/CATALOG.md)** | Generated from the source and gated in CI: every mounted route, the module import graph, the gateway event matrix |
| **[Enrichment Features](docs/ENRICHMENT.md)** | Deep Research (the Research example plugin), Tasks, Email triage, Hardware-aware onboarding, the web-read fetch behind the Reader example plugin |
| **[Shared Spaces](docs/SPACES.md)** | Workspaces several people share: roles, invites, archive, purge |
| **[Configuration](docs/CONFIGURATION.md)** | Env vars, ports, services |
| **[LiteLLM Proxy](docs/LITELLM.md)** | Route models through a LiteLLM proxy; auth, adding models, 401 fixes |
| **[Small / Local Models](docs/SMALL-MODELS.md)** | Run on one small local model: setup, what works/degrades, single-model binding |
| **[Ollama](docs/OLLAMA.md)** | Ollama models: size tiers, tool support, context length (`num_ctx`), lazy tool discovery, iGPU |
| **[Direct Providers](docs/DIRECT-PROVIDERS.md)** | Caching, reasoning, tool schemas, usage and cost provenance |
| **[Custom Providers](docs/CUSTOM-PROVIDERS.md)** | Direct OpenAI/Gemini-compatible endpoints |
| **[Configuration Precedence](docs/CONFIGURATION-PRECEDENCE.md)** | `.env`-bootstrap vs DB-runtime split |
| **[Browser Extension](docs/BROWSER-EXTENSION.md)** | Chrome extension for real browser control |
| **[RAG / Knowledge Base](docs/RAG.md)** | Hybrid search, tiered content, auto-indexing |
| **[Knowledge Graph](docs/KNOWLEDGE-GRAPH.md)** | Notes, `[[wikilinks]]`, authored edges, graph traversal, Obsidian vault + Canvas |
| **[MCP Server](docs/MCP-SERVER.md)** | Expose Octipus as MCP tools |
| **[MCP Integration](docs/MCP-INTEGRATION.md)** | Connect external MCP servers |
| **[Hooks & Automation](docs/HOOKS.md)** | Event hooks, webhooks, cron, execution control |
| **[Webhooks](docs/WEBHOOKS.md)** | GitHub/GitLab event ingestion |
| **[Capability Comparison](docs/CAPABILITY-COMPARISON.md)** | Feature comparison vs alternatives |
| **[Development](docs/DEVELOPMENT.md)** | Project structure, commands, tech stack |
| **[Testing](docs/TESTING.md)** | Test matrix (unit, E2E, integration, red-team) |
| **[Troubleshooting](docs/TROUBLESHOOTING.md)** | Common issues and solutions |
| **[Self-repair & recovery](docs/RECOVERY.md)** | What happens when the backend won't start, and how to reach it remotely |

## License

[MIT](./LICENSE) — free to use, copy, modify, distribute, sublicense, and sell. No warranty. Use at your own risk.

Copyright © 2026 Patrice Allegue and contributors.
