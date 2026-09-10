# Testing

The suites below test different boundaries. Passing UI tests with stubbed API
responses or generating adversarial prompts does not prove that a real model can
complete a task through the deployed application.

## Unit and embedded database tests

`npm test` runs Vitest across `unit` and `database` projects. The configuration
includes `.test.ts` and `.spec.ts` files in `src/` and `scripts/`, plus CLI tests
in `bin/`. Database-marked suites run with one worker to avoid shared-database
conflicts and concurrent PGlite problems. See `vitest.config.ts` for discovery.

```bash
npm test
npm run test:tui
```

External Postgres tests gated on `INTEGRATION=1` are skipped in the ordinary
lane. A green `npm test` does not mean those tests ran. The terminal clients live
in `src/tui-pi/` and `src/tui-editor/`; they use pi-tui.

## External database integration

```bash
npm run test:integration
```

The harness brings up the isolated test Postgres from
`docker-compose.test.yml`, migrates it, and runs the integration-enabled suite.
It exercises database behavior including permissions and tenant boundaries with
mocked model providers. Docker is required. The default host port is 5443; use
`TEST_POSTGRES_PORT` if that port is occupied.

## API and WebSocket E2E

```bash
npm run test:e2e
```

These tests exercise a running backend. Inspect `scripts/test-e2e.ts` and
`scripts/e2e/` for required configuration and the selected scenarios. They are a
separate command from the default CI unit and database lanes. Report which
scenarios ran and which providers were real or mocked.

## Browser UI tests

```bash
npm run test:web:install
npm run test:web
npm run test:web:headed
npm run test:web:ui
npm run test:web:list
```

Playwright builds and serves the production Vite web bundle at
`http://localhost:3007`. The shared fixtures intercept API requests, including a
catch-all for otherwise unmocked paths, so no backend or provider keys are needed.
These tests validate frontend behavior against fixtures, not authentication or
execution through a real backend. Even supplying `MASTER_KEY` to the fixture does
not remove that API interception.

Configuration: `playwright.config.ts`. Tests and fixtures: `tests/web/`.
The configured project is desktop Chromium; responsive behavior must be assessed
from individual specs rather than assuming a separate mobile project exists.
Console-error and accessibility checks provide additional UI coverage.

## Model evaluations and red-team checks

```bash
npm run eval
npm run eval:routing
npm run eval:quality
npx tsx --import ./scripts/md-loader.mjs src/eval/red-team/cli.ts --dry-run
```

The committed red-team workflow runs **only the dry-run**: it checks generation
and harness operation without making model calls. It runs weekly, on demand, and
on PRs matching its red-team paths. It does not test the resistance of a deployed
model to prompt injection, and it does not gate arbitrary prompt or role changes
on live adversarial results.

Changes to prompts, roles, routing, or tool selection should run relevant actual
evaluations and report their model configuration, results, and skipped cases.
The consolidation acceptance lanes below add production-path checks and an
opt-in live baseline. Their evidence is separate from the generator dry-run.

## Current CI evidence

| Lane | What it establishes | What it does not establish |
| --- | --- | --- |
| Backend | Typecheck, lint, catalog consistency, unit/embedded tests, coverage ratchet, dependency audit | Real-provider task completion |
| Integration | External Postgres behavior with integration tests enabled | Live model quality |
| Web E2E | Browser behavior with API fixtures | Client → real backend → tool execution |
| Red-team | Adversarial case generation in dry-run mode | Actual model resistance to attacks |

Workflow definitions in `.github/workflows/` are authoritative for triggers and
commands. Do not report skipped tests as passed. Keep runtime estimates in dated
measurement reports rather than treating them as fixed properties of a suite.

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

**TUI test failures**: the current clients use pi-tui, with tests under
`src/tui-pi/` and `src/tui-editor/`. Run `npm run test:tui`; the retired Ink
`src/tui/test-utils.tsx` shim no longer exists.

## Consolidation acceptance lanes

`npm run test:acceptance` builds and starts the production backend with an isolated
embedded database and a local scripted provider. It checks a real model-adapter
request, a repository diff and unchanged file, unattended refusal with no write,
and persisted messages after process restart and reauthentication. CI gates this
lane and uploads its JSON report. Scripted output is lifecycle evidence, not a
model-quality score.

`src/core/research/workflow-acceptance.test.ts` exercises research persistence,
source provenance, concurrent task-ingestion retries, and interrupted-job recovery
against embedded storage. `src/security/dispatch-authorization.test.ts` exercises
actual dispatch guards with independently observed side effects, including MCP.
Browser tests in `tests/web/consolidation.spec.ts` use API fixtures for failure and
recovery states; they do not claim to test the model/backend integration.

`npm run test:live-baseline` uses the existing eval runner with three fixed cases,
one at a time, and a three-minute client limit. Set `OCTIPUS_EVAL_URL`,
`OCTIPUS_EVAL_MODEL`, `OCTIPUS_EVAL_PROVIDER`, `OCTIPUS_API_KEY`, and
`OCTIPUS_EVAL_BUDGET_REFERENCE` for a **dedicated** backend/provider account with a
spending limit. The reference identifies that configured limit; it does not set
one. A client timeout does not cancel backend work or enforce a monetary cap.
Missing configuration writes an unmeasured report and exits 2. The
`live-baseline.yml` workflow supports manual and published-release runs through
the `live-evaluation` environment. It measures a baseline, without inventing a
quality threshold. It is a post-publication check, not a pre-release gate.

Provider quality, direct/delegated comparisons, first useful feedback, exact spend,
and approval/tool-error counts remain unmeasured where telemetry is absent.
Run live baseline locally before release if a release decision depends on it.
