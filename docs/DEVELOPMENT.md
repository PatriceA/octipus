# Development

## Project Structure

```
octipus/
├── bin/                    # CLI scripts (octi start/stop)
├── src/
│   ├── api/                # REST API & WebSocket
│   │   ├── routes/         # Endpoint handlers
│   │   ├── middleware/     # Auth guard
│   │   └── websocket.ts   # WebSocket handler
│   ├── channels/           # Messaging channels (Telegram, Slack, Teams, WhatsApp, WebChat)
│   ├── config/             # Zod-validated configuration, settings service, hot-reload
│   ├── core/               # Agent runtime
│   │   ├── agent-worker.ts # LLM agent loop (thought → action → observation)
│   │   ├── cli-agent-worker.ts  # CLI model agent (Claude Code, Antigravity, Codex, Mistral Vibe)
│   │   ├── tool-executor.ts     # Tool execution with permissions
│   │   ├── agent-manager.ts
│   │   ├── orchestrator/   # Message classification, worker spawning, pipelines
│   │   └── types.ts
│   ├── db/                 # Database layer (Drizzle ORM, migrations, seeds)
│   ├── hooks/              # Event-driven automation
│   ├── mcp/                # Model Context Protocol bridge
│   ├── models/             # LLM providers, routing, cost/quota tracking
│   ├── security/           # Auth (JWT, passkeys, TOTP), vault, permissions
│   ├── skills/             # Domain knowledge registry (DB-backed)
│   ├── tools/              # Built-in tool modules (filesystem, shell, git, browser, browser-ext, documents, messaging, knowledge, etc.)
│   ├── visual/             # Playwright visual debugger
│   └── voice/              # STT, TTS, wake word
├── mcp-server/             # MCP server bridge for CLI models
├── web/                    # Next.js 14 web UI
├── browser-extension/      # Chrome extension for real browser control
├── eval/                   # YAML-based capability eval suites
├── scripts/
│   ├── e2e/                # E2E test suite (22 modules, 112 tests)
│   └── setup.ts            # Bootstrap setup wizard
└── docs/                   # Documentation
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start backend with hot reload |
| `bun run start` | Start backend (no watch) |
| `bun run start:all` | Start full stack (backend, web, workers) via `bin/octi start` |
| `bun run stop:all` | Stop full stack via `bin/octi stop` |
| `bun test` | Run unit and integration tests |
| `bun run test:tui` | Run TUI tests only |
| `bun run test:e2e` | Run E2E API test suite |
| `bun run test:web` | Run web UI E2E tests (Playwright) |
| `bun run test:web:headed` | Run web E2E tests with visible browser |
| `bun run test:web:ui` | Open Playwright UI mode |
| `bun run typecheck` | Type check without emitting |
| `bun run lint` | Lint code with Biome |
| `bun run db:migrate` | Run database migrations |
| `bun run db:generate` | Generate migrations from schema changes |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run setup` | Interactive setup wizard |
| `bun run eval` | Run eval suite (can add `--suite routing` or `--suite quality`) |
| `bun run build` | Build backend for distribution |
| `bun run build:cli` | Compile `bin/octi.ts` → static `dist/octi` binary |
| `bun run backup` | Backup database, Valkey, config, vault |
| `octi doctor` | Run environment health checks (what is wired, what is missing) |
| `octi init` | Run the pi-tui setup wizard (falls back to `bun run setup` on non-TTY) |

## Running Tests

```bash
bun test                              # Unit tests
bun test src/utils/crypto.test.ts     # Specific file
bun test --coverage                   # With coverage
bun run test:e2e                      # E2E (requires running server)
```

## Adding New Components

### New Tool
1. Create `src/tools/<name>/index.ts` extending `BaseTool`
2. Register in `src/tools/index.ts`

### New Skill
Create via the API (`POST /api/skills`) or add to `src/db/seed-skills.ts` for system skills.

### New Expert
Add entry to `SYSTEM_EXPERTS` in `src/db/seed-experts.ts`, or create via API (`POST /api/experts`).

## Tech Stack

| Layer | Technology | Requirements |
|-------|-----------|--------------|
| Runtime | Bun ≥ 1.1 end-to-end (all server code, tests, scripts) | — |
| Web Runtime | Node ≥ 18 | Next.js only |
| Backend | Elysia (HTTP + WebSocket) | — |
| ORM | Drizzle | — |
| Database | PostgreSQL + pgvector | — |
| Database Embedded | PGlite (via @electric-sql/pglite) | Optional (Postgres still preferred for production) |
| Cache | Valkey (Redis-compatible) | via ioredis |
| Web UI | Next.js 14, React 18, Tailwind CSS | — |
| Channels | grammY (Telegram), Bolt.js (Slack), Bot Framework (Teams), WhatsApp Cloud API | — |
| Auth | Bun.password (argon2id), scrypt, @simplewebauthn/server, otplib | — |
| Browser | Playwright | — |
| Logging | Pino | — |
| Validation | Zod | — |
