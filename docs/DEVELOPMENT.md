# Development

## Project Structure

```
assistant/
├── bin/                    # CLI scripts (assistant start/stop)
├── src/
│   ├── api/                # REST API & WebSocket
│   │   ├── routes/         # Endpoint handlers
│   │   ├── middleware/     # Auth guard
│   │   └── websocket.ts   # WebSocket handler
│   ├── channels/           # Messaging channels (Telegram, Slack, Teams, WebChat)
│   ├── config/             # Zod-validated configuration, settings service, hot-reload
│   ├── core/               # Agent runtime
│   │   ├── agent-worker.ts # LLM agent loop (thought → action → observation)
│   │   ├── cli-agent-worker.ts  # CLI model agent (Claude Code, Gemini CLI)
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
│   ├── tools/              # Built-in tool modules (filesystem, shell, git, browser, etc.)
│   ├── visual/             # Playwright visual debugger
│   └── voice/              # STT, TTS, wake word
├── mcp-server/             # MCP server bridge for CLI models
├── web/                    # Next.js 14 web UI
├── tui/                    # Ink terminal UI
├── scripts/
│   ├── e2e/                # E2E test suite
│   └── setup.ts            # Bootstrap setup wizard
└── docs/                   # Documentation
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start backend with hot reload |
| `bun test` | Run unit tests |
| `bun run test:e2e` | Run E2E API test suite |
| `bun run typecheck` | Type check without emitting |
| `bun run db:migrate` | Run database migrations |
| `bun run db:generate` | Generate migrations from schema changes |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run tui` | Start terminal UI |
| `bun run setup` | Interactive setup wizard |
| `bun run backup` | Backup database, Redis, config, vault |

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

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Backend | Elysia |
| ORM | Drizzle |
| Database | PostgreSQL + pgvector |
| Cache | Redis (ioredis) |
| Web UI | Next.js 14, React 18, Tailwind CSS |
| Terminal UI | Ink |
| LLM Client | OpenAI SDK (via LiteLLM proxy) |
| Channels | grammY (Telegram), Bolt.js (Slack), Bot Framework (Teams) |
| Auth | argon2, @simplewebauthn/server, otplib |
| Browser | Playwright |
| Logging | Pino |
| Validation | Zod |
