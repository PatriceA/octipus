# Feature and performance pass — 2026-08-23

Scope: the rebuild plan's Phase 3 and Phase 4 work, the independent items that came with it, and then a full measured pass over the product through both clients — the web UI in a real browser and the TUI in a real pty — against a live backend on this machine.

Twenty-one commits on `main`, `ce99d53b`..`8f7af29d`, 44 files, +2239/−107. Every lane green at the end.

## What the pass measured

| Lane | Result | Wall clock |
|---|---|---|
| `tsc --noEmit` | clean | — |
| `biome lint` | clean, 904 files | 0.2s |
| Unit suite (`bun test src scripts`) | 4298 tests, 0 fail, 184 skip | 74s |
| TUI unit suite | 251 tests, 0 fail | 0.3s |
| Web suite (Playwright, stubbed API) | 64 tests, 0 fail | 8.2s |
| Integration lane (real Postgres) | 4250 tests, 0 fail, 84 skip | 80s |
| E2E suite (live backend, 142 cases) | 142 pass, 0 fail | 193s |
| Feature bench (10 scenarios, live) | 10/10, twice | 4m and 6m |
| API surface (16 endpoints) | 16/16 healthy | median 12–16ms |
| Live web UI (real browser) | 11/11 steps | 8.1s |
| Live TUI (real pty) | 4/4 steps | 22.3s |

The last three are new harnesses written for this pass; the rest already existed.

## Performance

**API read surface.** Sixteen endpoints behind the web UI — sessions, models, topics, agents, tools, experts, pipelines, notes, knowledge, tasks, memory, settings, persona, skills, health, metrics — answer in a median of 12–16ms, worst 206ms. Nothing in the read path is slow.

**Web UI.** Login page 0.2s, login round trip 0.6s, and every page in the navigation renders in 0.53–0.85s. A chat turn, timed from pressing enter to the answer appearing on screen in an assistant bubble, took 2.4s and 6.0s across two runs.

**TUI.** Boot and gateway connect 0.2s. A plain answer 2.8–5.2s. A shell-tool answer 18.3–23.1s.

**Chat turns through the API**, ten scenarios, two full runs:

| Scenario | Run A | Run B | Tokens | Tools | Routed to |
|---|---|---|---|---|---|
| simple question | 3.8s | 2.6s | ~8.4k | 0 | orchestrator answers |
| follow-up (pronoun resolution) | 2.3s | 4.8s | ~8.5k | 0 | orchestrator answers |
| today's date | 6.6s | 4.4s | ~8.4k | 0 | orchestrator answers |
| shell command | 25.2s | 31.7s | ~46k | 1 | coding |
| write and read a file | 40.5s | 3m43s | 58k / 186k | 2 / 14 | coding |
| oversized output | 34.7s | 1m7s | ~50k | 1 | coding |
| knowledge base lookup | 28.7s | 23.0s | ~65k | 1 | research |
| delegation, three bullets | 31.1s | 34.0s | ~26k | 0 | review |
| create an artifact | 41.0s | 31.3s | 47k / 57k | 1 / 2 | coding |
| refuse to print a secret | 26.8s | 24.3s | ~8.9k | 0 | orchestrator answers |

**Delivery lag** — the measure that caught the old latency bug, the time a user waits *after* their answer already exists — over 86 runs today: median 11ms, p95 19ms. The three outliers in the 30-day window (4m11s, 3m10s, 26s) all predate this session. Nothing produced during this pass waited on post-answer bookkeeping.

**Runtime invariants** report from the live boot: `checked: 2, held: 2, violations: 0, errors: 0`.

## Two numbers worth acting on

**A one-line question costs ~8.4k tokens.** Every trivial turn — "what is the capital of France" — carries about 8,400 tokens of prompt. That is the system prompt plus tool JSON schema, and it is the floor for every interaction the orchestrator answers itself. Halving it is worth more than any latency work on this list.

**The same task can cost 3× more on a second run.** The write-and-read-a-file scenario took 40s / 58k tokens / 2 tool calls once and 3m43s / 186k tokens / 14 tool calls the next time, with the same prompt and the same model. Median latency is stable (28.7s vs 31.3s across runs) but the tail is not, and the variance is in how many tool calls the model decides to make.

## Defects found and fixed

Everything below was found by running the product, not by reading it.

**A swarm child's start was not durable.** The ledger `spawn` event and the `swarm_nodes` row were both best-effort, and both are load-bearing: the row is what cascade-cancel, the orphan reaper and the budget walk resolve a running child through; the event is what replay and the boot reconcile key off. Dropping either left a child that was running and that nothing could account for or stop. The start is now durable and asymmetric by risk — `recordSpawn` throws and the child does not run if it cannot be recorded, while terminals stay best-effort because a dropped terminal just means the next reconcile cancels the node. Pipeline stage workers had no ledger events at all and now get the same bracket.

**The detach cap had three defaults and the wrong one won.** A field-level `.default(0)` shadowed the per-level defaults of 6/3/0 and made the resolve step below it unreachable — the detach-cap incident's exact shape, minus the type disagreement that was the only reason anyone noticed last time.

**The Prometheus endpoint was never mounted.** Every counter and histogram fed a registry nothing exposed; the route was imported by no file but its own test, which builds the route object directly and passes. A scraper got a 404 and would have concluded metrics were off rather than absent.

**Credentials leaked into spawned processes.** The env filter was anchored to the end of the variable name, so `AWS_SECRET_ACCESS_KEY` read as safe. It was also the shell tool's private filter: `git`, `docker`, `gh` and `glab` all spawned with the full `process.env`, and the docker one matters most because the model writes the arguments and `docker run --env NAME` forwards a variable into a container whose output it then reads. One filter now, in `src/security/child-env.ts`, with a per-tool keep list for the two CLIs that need their own token. The `env` tool also stopped answering with a credential asked for by name.

**A shell deadline did not reach the process tree.** The kill went to the direct child while the promise resolves on `close`, which waits for the pipes — and a backgrounded grandchild still holds them. `sh -c "sleep 10 & sleep 10"` with a 500ms timeout sat unresolved for seconds, and `useShell` is model-reachable, so a stage could burn its wall clock on a command reported as timed out. Fixed with a process group, along with three smaller ones on the same path: an already-aborted signal was ignored, a command that finished just inside its budget could still be stamped as timed out, and the abort listener leaked on spawn failure.

**Oversized tool output was cut and lost.** Anything over 50,000 characters was truncated with `[truncated]` and the rest was gone from the transcript too. It is now saved into the agent's own workspace, with the model given a head, a tail, the exact size and the path — retrieval needs no new mechanism because the agent's filesystem and grep tools are already scoped there. Verified live: two files of 129KB and 149KB, owner-only, written during the bench.

**Shutdown did not wait for agents.** `stopAll` asked every worker to stop and returned, so the gateway, the MCP bridge and the API server went down underneath work still in flight. It now waits for quiescence, bounded so it cannot outlast the force-exit watchdog, and drops subscribers first — but only at process shutdown, never for the live `/stop-all` command, whose subscribers are the UI's event stream.

**The orchestrator reported its own toolset as the product's capability.** Asked what Octipus uses for a vector store, it answered "Octipus has no searchable knowledge base exposed in this session" — in three of four runs. It holds `profiles` and nothing else by design, with a `research` specialist one spawn away that has exactly that tool. Both delegation prompts now say plainly that a tool it does not hold is a reason to spawn, not a reason to decline. Measured after: two of two runs delegate and answer correctly, in 12.5s and 14.6s.

**Ordinary use signed the user out — twice over.** This is the one only a real browser could find. Clicking through seven pages and sending a message produced a storm of 401s, an empty settings page and a composer that stayed disabled a minute after a valid login.

The first cause: the per-IP window meant to stop credential stuffing covered all of `/api/auth/*` at 20 requests a minute, and the web app reads `/api/auth/me` on every page mount. Ordinary navigation spent the attacker budget, and a 429 on `me` reads to the front-end as "not logged in". The window now covers only the endpoints that take a credential.

The second: the session cap's overflow path revoked *every* session the user had. Each WebSocket handshake mints a ticket session, so twenty accumulated within a minute of normal clicking and the twenty-first signed the user out of their browser, their phone and everything else mid-click. The cap now evicts oldest-first, and short-lived tickets neither fill it nor are capped by it.

## Defects in the tests, not the product

Three assertions failed the product for behaving correctly, and each is worth naming because a false red costs the same review time as a real bug.

The E2E swarm suite compared every child's model against its lane binding, while the shipped `Data Engineer` expert deliberately pins a different one — an expert's `modelPreference` outranking the lane is the point of choosing an expert. The bench's secret-disclosure check matched a base64 *shape* against whitespace-stripped prose, which flagged a correct refusal; it now compares against the actual secret. And the live UI check's first version waited for its own marker to appear twice, which the composer echo and the transcript satisfy on their own — it passed in 206ms with no model involved.

## Open items

**Prompt overhead.** ~8.4k tokens on every orchestrator-answered turn. The measurement exists (`project_octipus_prompt_size`); the reduction does not.

**Tool-call variance.** Same task, 2 tool calls one run and 14 the next. Worth a cap or a plan-first nudge for mechanical file work.

**One rare unit-test flake.** A single failure appeared twice in roughly ten full-suite runs and never reproduced — five consecutive clean runs afterwards, and the failing test's name was not captured. Unresolved.

**The `new` session dialog.** Confirming it creates an empty "New Chat" while the composer's first message lands in a separate auto-created session, so a user who clicks `new` and types can end up with two sessions. Cosmetic, but visible in the session list.

**Metrics are off by default.** `/api/metrics` now exists but returns 404 until `METRICS_TOKEN` is set — deliberate, and worth setting if anything is scraping.

## What is left in the rebuild plan

Phase 3 is scoped and largely done; the wholesale conversion of state into a fold over the log is not done and is no longer obviously worth doing — re-measure before building it. Phase 4's invariant registry has landed with two invariants; token accounting and goal state assumed the full log fold and are not unblocked by what shipped. Phases 5 to 8 — Node and Hono, Vitest, DBOS, the AI SDK, Vite, dropping Valkey — are untouched, and each is a single-branch migration rather than an increment.
