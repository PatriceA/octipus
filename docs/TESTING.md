# Testing

The suites below test different boundaries. Passing UI tests with stubbed API
responses or generating adversarial prompts does not prove that a real model can
complete a task through the deployed application.

## Unit and embedded database tests

`npm test` runs Vitest across `unit`, `database`, and `terminal` projects. The configuration
includes `.test.ts` and `.spec.ts` files in `src/` and `scripts/`, plus CLI tests
in `bin/`. Database-marked suites run with one worker to avoid shared-database
conflicts and concurrent PGlite problems. The terminal project runs
`tests/tui/*.e2e.test.ts` with one worker. See `vitest.config.ts` for discovery.

```bash
npm test
npm run test:tui
```

External Postgres tests gated on `INTEGRATION=1` are skipped in the ordinary
lane. A green `npm test` does not mean those tests ran. The terminal clients live
in `src/tui-pi/` and `src/tui-editor/`; they use pi-tui.

## Provider boundary

Code that talks to a model provider is tested against a scripted provider on
a real local socket, not against a mocked SDK or `fetch`. Two test-only
modules in `src/models/testing/` make up the seam:

| Module | What it stands in for |
| --- | --- |
| `scripted-provider.ts` | The provider's HTTP endpoint (an OpenAI-compatible server, the LiteLLM proxy, a Gemini-compatible gateway). Listens on `127.0.0.1` port 0, records every request (`path`, `query`, `headers`, parsed `body`, arrival time, whether the client hung up), and answers from a queue (`enqueue`) or a handler (`respondWith`): `json`, `text` (malformed bodies), `sse` (streams, optionally ending in a socket reset or held open for an abort), `reset` and `hang`. `chatCompletion`, `chatChunk`, `embeddings` and `openAIError` build OpenAI-shaped bodies. An unscripted request gets a loud 500. |
| `model-doubles.ts` | The model registry (`registryDouble`, rows built with `modelRow`) and the vault (`vaultDouble`), installed with `vi.mock` so the real router and providers read rows and keys from memory. |

`src/models/litellm-client.boundary.test.ts` (the LiteLLM client: completion,
embeddings, streaming, vision keys, SDK retries, failure classification) and
`src/models/providers/router.boundary.test.ts` (resolution, custom endpoint
credentials and wire shape, the circuit breaker and proxy fallback) show the
pattern. Assert on what crossed the wire and on the typed result or
`ClassifiedError`, not on internal calls. Timing (a Retry-After wait, a
request timeout) runs under `vi.useFakeTimers({ toFake: ['setTimeout',
'clearTimeout', 'Date'] })`, advancing the clock in small steps while the
socket I/O runs; `receivedAt` is then fake time. Point the code at the double
by its URL (`LITELLM_URL`, a row's `endpoint`), never at a real host.

The production acceptance lane (`scripts/e2e/acceptance.ts`) scripts the same
double with a handler. `litellm-client.test.ts` and the per-provider suites
still mock the SDK where they test branching the wire cannot show.

### Known provider-boundary gaps

Tests whose names start with "currently" pin behaviour as it is, not as it
should be. Change the test with the behaviour.

| Pinned behaviour | Why it looks wrong |
| --- | --- |
| A rate-limited LiteLLM model is re-sent to the same proxy after the rate limiter's backoff (`router.boundary.test.ts`). | The "fallback" is the same endpoint, and the provider's Retry-After is ignored. |
| A LiteLLM model whose re-send is rate limited too fails after two sends. | Same: two sends to one endpoint in about a second. |
| With the LiteLLM breaker open, LiteLLM models are still sent through the fallback. | That breaker never stops a request for the models it guards. |
| Without a proxy URL, an unknown model resolves to custom-gemini, the last registered provider. | The error is "no model row found" from a provider nobody chose, not "no provider for this model". |
| `ProviderRouter.embed` chooses by model name only and refuses LiteLLM. | It ignores the row's provider, unlike `LiteLLMClient.embed`. |
| `LiteLLMClient.stream` re-sends a direct provider's request that failed before its first chunk to the proxy, under the same model id (`litellm-client.boundary.test.ts`). | It contradicts the no-cross-provider-fallback rule `complete()` documents, and can hide the direct provider's real error behind the proxy's "model not found". |
| A ClassifiedError with `FALLBACK_PROVIDER` recovery (an exhausted quota) counts as retryable, so the agent loop retries the same model up to three times. | Exhausted quota is not cured by waiting. Not pinned by a test here; see `ClassifiedError.isRetryable`. |

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
`src/tui-kit/`, `src/tui-pi/`, `src/tui-editor/` and `tests/tui/`. Run `npm run test:tui`; the retired Ink
`src/tui/test-utils.tsx` shim no longer exists.

## Consolidation acceptance lanes

`npm run test:acceptance` builds and starts the production backend with an isolated
embedded database and a local scripted provider. It checks a real model-adapter
request, a repository diff and unchanged file, unattended refusal with no write,
and persisted messages after process restart and reauthentication. CI gates this
lane and uploads its JSON report. Scripted output is lifecycle evidence, not a
model-quality score.

`src/plugins/packages/host-scopes.isolation.test.ts` and
`bundled-research.isolation.test.ts` exercise the research plugin's background
runs (`agent:run`) and saved documents (`documents:write`) end to end against
embedded storage; `src/core/jobs/jobs.integration.test.ts` covers
interrupted-job recovery. (The core research module and its
`workflow-acceptance.test.ts` are removed.) `src/security/dispatch-authorization.test.ts` exercises
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

## Documentation website synchronization

The shared website references are generated from the repository documentation.
Validate the publisher and check for text drift with:

```bash
node --test scripts/sync-website-docs.test.mjs
node scripts/sync-website-docs.mjs /path/to/octipus-website --check
npm --prefix /path/to/octipus-website run build
```

The sync tests use temporary website directories and verify link conversion,
fenced examples, replacement of old MDX copies, and non-mutating drift checks.
They use Node's test runner and are separate from `npm test`. A website build
checks rendering; browser checks and link validation assess the served result.
