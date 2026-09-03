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
│   │   ├── root agent/   # Message classification, worker spawning, pipelines
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
├── web/                    # Vite + React Router web UI
├── browser-extension/      # Chrome extension for real browser control
├── eval/                   # YAML-based capability eval suites
├── scripts/
│   ├── e2e/                # E2E test suite (27 modules, 142 tests)
│   └── setup.ts            # Bootstrap setup wizard
└── docs/                   # Documentation
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend with hot reload |
| `npm run start` | Start backend (no watch) |
| `npm run start:all` | Start full stack (backend, web, workers) via `bin/octi start` |
| `npm run stop:all` | Stop full stack via `bin/octi stop` |
| `npm test` | Run unit and integration tests |
| `npm run test:tui` | Run TUI tests only |
| `npm run test:e2e` | Run E2E API test suite |
| `npm run test:web` | Run web UI E2E tests (Playwright) |
| `npm run test:web:headed` | Run web E2E tests with visible browser |
| `npm run test:web:ui` | Open Playwright UI mode |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | Lint code with Biome |
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Generate migrations from schema changes |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run setup` | Interactive setup wizard |
| `npm run eval` | Run eval suite (can add `--suite routing` or `--suite quality`) |
| `npm run eval --baseline latest` | Same, plus a regression gate: exits 1 if any test that PASSED in the newest `eval/results/*.json` now fails, even when the overall score improved. Pass a path instead of `latest` to pin a committed baseline. |
| `npm run build` | Build backend for distribution |
| `npm run build:cli` | Compile `bin/octi.ts` → static `dist/octi` binary |
| `npm run backup` | Backup database, config, vault |
| `octi doctor` | Run environment health checks (what is wired, what is missing) |
| `octi init` | Run the pi-tui setup wizard (falls back to `npm run setup` on non-TTY) |

## Running Tests

```bash
npm test                              # Unit tests
npm test src/utils/crypto.test.ts     # Specific file
npm test --coverage                   # With coverage
npm run test:e2e                      # E2E (requires running server)
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
| Runtime | Node ≥ 24 end-to-end (server, tests, scripts, TUI, web build) | — |
| Backend | Hono (HTTP) + `ws` (WebSocket), behind the app in `src/api/http/` | — |
| Test runner | Vitest | — |
| ORM | Drizzle | — |
| Database | PostgreSQL + pgvector | — |
| Database Embedded | PGlite (via @electric-sql/pglite) | Optional (Postgres still preferred for production) |
| Cache / queue / pub-sub | PostgreSQL | key expiry, a queue table, `LISTEN`/`NOTIFY` |
| Web UI | Vite + React Router, React 19, Tailwind CSS | — |
| Channels | grammY (Telegram), Bolt.js (Slack), Bot Framework (Teams), WhatsApp Cloud API | — |
| Auth | argon2id via `node:crypto`, scrypt, @simplewebauthn/server, otplib | — |
| Browser | Playwright | — |
| Logging | Pino | — |
| Validation | Zod | — |
