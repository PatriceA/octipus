# Testing

This project has four distinct test surfaces. Each is scoped so it runs fast
and doesn't need the full stack.

## 1. Unit + integration tests — `npm test`

Runs the Vitest suite (`src/**/*.test.ts`, `scripts/**/*.test.ts`) across two
projects. Files that touch a database — embedded PGlite or the shared test
Postgres — run in the `database` project at one worker; everything else runs at
full width in `unit`. The split is classified by reading the files, not from a
list, because a file in the wrong project hangs or deadlocks rather than
failing (see `vitest.config.ts`). Most specs are pure in-process and fine
offline.

```
npm test               # unit + integration under src/ and scripts/
npm run test:tui       # just the TUI tests (src/tui-pi and src/tui-editor)
```

The TUI suite uses `ink-testing-library` with a compatibility shim (see
`src/tui/test-utils.tsx`) to bridge ink v4's stdin expectations with the v3
testing library's stdin mock. The `MockGatewayClient` mirrors the real
`GatewayClient` API so tests never hit the backend WS.

## 2. API + WS E2E — `scripts/e2e/`

End-to-end HTTP + WebSocket tests against a running backend.

```
npm run test:e2e
```

See `scripts/e2e/index.ts` for the root agent and `scripts/e2e/fixtures.ts`
for the shared auth / session state.

## 3. Web UI E2E — Playwright

Full browser-based tests against the Vite-built web app at `http://localhost:3007`,
with the backend on `http://localhost:3005/api` for real routes and heavy
`page.route()` interception for everything else.

```
npm run test:web:install   # one-time: playwright install chromium
npm run test:web           # headless Chromium
npm run test:web:headed    # headed (watch it run)
npm run test:web:ui        # Playwright's interactive UI mode
npm run test:web:list      # list discovered tests without running
```

Config lives at `playwright.config.ts` and tests at `tests/web/*.spec.ts`.

Key design notes:

- **Dev server orchestration**: `playwright.config.ts`'s `webServer` block
  builds the web bundle and serves it with `web/serve.mjs`. Every `/api/**`
  call is stubbed in the browser, so no backend is needed. In CI we don't
  reuse existing servers; locally we do.
  Set `PLAYWRIGHT_SKIP_WEBSERVERS=1` to run against a hand-started stack.
- **Auth fixture** (`tests/web/fixtures/auth.ts`): the `authenticatedPage`
  fixture seeds `localStorage` with a stub token + intercepts `/api/auth/me`
  so the AuthProvider passes the guard. When `MASTER_KEY` is set in env, the
  real key is used and we exercise the master-key auth path.
- **Mock-heavy**: the UI is under test here, not the backend (the backend has
  881+ unit tests of its own). Default stubs in `tests/web/fixtures/api-stubs.ts`
  cover sessions, models, experts, MCP, knowledge, skills, pipelines, swarm,
  settings — tests compose or override as needed.
- **Console-error watchdog**: the auth fixture wires `page.on('pageerror')`
  and `page.on('console')` so any unhandled page error or `console.error`
  fails the test via `expectNoConsoleErrors(consoleErrors)`. A short
  `ERROR_ALLOWLIST` filters known-benign Next.js dev noise (favicon 404,
  fast-refresh notices, React DevTools suggestion).
- **Accessibility**: `@axe-core/playwright` runs on the dashboard + chat page
  and fails on serious/critical violations.
- **Mobile**: the `responsive.spec.ts` suite runs under the `chromium-mobile`
  project (Pixel 5 viewport) — see `playwright.config.ts`.

## 4. Integration harness — `npm run test:integration`

Previously-skipped integration tests backed by `docker-compose.test.yml`. Spins up an isolated Postgres and runs specs that need real DB transactions or cross-process pub/sub. Coverage includes MCP transports (stdio + SSE) and storage provider parity (Postgres vs in-memory).

```
npm run test:integration
```

The compose file is scoped to this harness — ports don't collide with the dev stack.

## 5. CI matrix

| Surface           | Command             | Needs docker? | Typical time |
|-------------------|---------------------|---------------|--------------|
| Unit + TUI        | `npm test`          | no            | ~5s          |
| Integration (DB)  | `npm run test:integration` | yes (test compose) | ~30s |
| API E2E           | `npm run test:e2e`  | yes           | ~1–2 min     |
| Web UI (Playwright) | `npm run test:web` | no (webServer auto-starts) | ~2–5 min |

Run them all in parallel lanes; the Web UI lane is fully self-contained because
it intercepts all provider calls — no API keys needed.

### Swarm test coverage

The swarm module has its own test bundle under `src/core/swarm/*.test.ts`:

| File | Tests | Purpose |
|---|---|---|
| `call-graph.test.ts` | 12 | Fingerprint dedup, ancestor-chain rejection, escalation cap, registry GC, fingerprint release on failure |
| `budget-enforcement.test.ts` | 5 | Pre-LLM-call `BudgetExceededError`, `CascadedCancellationError`, `ChildTimeoutError`, taxonomy mapping |
| `cascade-cancel.test.ts` | 5 | `AgentManager.stop({cascade})` walks, non-cascade target-only, constructor signal chain |
| `spawner.test.ts` | extended +6 | Depth-2 hard leaf, fan-out cap, duplicate-fingerprint cancelled result, escalation 1/lifetime, `parallelGroup` bucketing |
| `orphan-reaper.test.ts` | — | Orphan reaper sweep flips stale `running` → `cancelled` |
| `swarm-tool.test.ts` | — | `spawn_child` tool surface and validation |

Full swarm flow E2E lives at `scripts/e2e/tests/swarm-flow.ts` — exercises Root agent → Agent → Subagent end to end with real gateway events.

## Troubleshooting

**Playwright tests flake on my machine**: check that `API_PORT=3005` and that
the backend starts cleanly (run `npm run dev` by hand once). If the
webServer block times out, bump its `timeout:` in `playwright.config.ts`.

**Playwright specs picked up by the unit runner**: they are excluded in
`vitest.config.ts`. `npm run test:web` is the only thing that runs them.

**TUI tests fail with `stdin.ref is not a function`**: make sure your tests
import `render` from `src/tui/test-utils.tsx`, not directly from
`ink-testing-library` — the shim in `test-utils` patches the Stdin mock.
