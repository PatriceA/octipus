# Octipus rebuild: execution plan

Date: 2026-08-22
Status: in progress — phases 0 to 2 done or decided, phase 3 scoped and largely done, phase 4 invariants done (2026-08-22)
Findings: [rebuild-findings-2026-08-22.md](rebuild-findings-2026-08-22.md)
Supersedes: `rebuild-stack-and-orchestration.md` and `deepseek-harness-lessons.md`, both merged into this document.

## What this is

One ordered plan covering two decisions taken together: what stack Octipus would use if started today, and whether the orchestrator layer should exist at all. It is not a rewrite. Every phase is an in-place change to this repository, independently shippable and independently revertible.

The rules and contracts below draw on a close read of DeepSeek Harness (`github.com/deepseek-ai/deepseek-harness`, MIT, published 2026-08-13) — fifty packages, roughly 495k lines of TypeScript, some 1,500 design notes. It is worth citing because a well-resourced team building the same kind of system reached the same conclusion about orchestration from an independent direction, and because their documented bug classes map, line for line, onto incidents Octipus has already paid for. Their `defensive-patterns.md` opens by stating that every rule in it is a defect class that actually shipped there. It reads like our own postmortem list.

What is taken from them is rules, not structure. Their plugin kernel, fifty-package split, bilingual documentation, per-file hundred-percent coverage gate, and dual-SDK projection are all team-scale and public-platform-scale costs that a solo product should not pay. Almost everything valuable is a constraint on how state is recorded and how completion is proven, and none of it requires a plugin kernel.

## The two positions

**The orchestrator should not decide control flow.** It currently does, and every expensive bug of the last three months traces back to that. A seven-stage pipeline reported every stage complete and wrote zero files, because completion was the model's own claim. Quality gates passed in CI and were inert in production three separate times, because the flag reaching the gate was set in a template the live path never used. The detached-child cap defaulted to zero while the type declared six, so good child results were silently discarded for weeks. The QA verdict contract rubber-stamps around sixty percent of the time. Finished answers sat undelivered for a median of forty-three seconds. None of these are prompt problems; none would be fixed by a better classifier. All are the same structural problem — a language model placed in charge of sequencing, completion, and budget, with its self-report trusted as the record of what happened.

There is a second, simpler problem: Octipus carries roughly 11,600 lines of orchestrator and 5,600 of swarm, some seventeen thousand lines whose entire job is deciding which model does which piece of work, for a single operator.

The replacement is two paths. The **default** is a single agent loop with tools — one model, one conversation, running until the work is done. The **explicit** path is a named workflow: a TypeScript file spelling out the fan-out in ordinary code, chosen by name, never inferred from the shape of a sentence. What disappears is the layer between them — the classifier, the runtime stage-graph assembly, role contracts, the handoff protocol, the mode selector.

Harness organises this the same way, and states it as a formula throughout its subsystem docs: there is a small agent-loop spine (session, system prompt, tools, agent, loop) and everything else — compaction, spill, subagents, workflows, plan mode, goals — is an optional capability explicitly *not* part of it. Their three delegation surfaces are separate optional packages, none consulted unless the model calls the tool.

**The stack was mostly right; the runtime was not.** TypeScript end to end, Postgres with pgvector as the only stateful component, MCP as the tool boundary, and thin clients over HTTP all stay. The Cockroach evaluation and the desktop sidecar experiment each already settled their question.

Bun as the production runtime has cost more days than it saved: an Elysia adapter `beforeExit` handler that killed the server while leaving the process alive and the port unbound with no log line; `mock.module` leaking process-wide so tests pass in isolation and fail in CI; a test process exiting 99 with zero reported failures, which `tail` hides; Dependabot unable to write `bun.lock`, so every root dependency PR fails by construction; a Playwright pin that had to be held exactly. None of it was product work. LiteLLM is a second process and a second deploy standing in for a library concern. Next.js provides server rendering the app never uses, and its static-export mode needed workarounds to make the Tauri client's detail routes work.

## Phase order

The ordering principle is: adopt the cheap rules first, delete before porting, and make completion provable before building anything else on top of it.

Deleting seventeen thousand lines before the runtime migration means not porting code that is about to disappear. The consequence is stated plainly in Phase 5: workflows run in-process without durable retries or crash resumption until the durable engine lands. That gap is acceptable because the current system has no durable resumption either.

### Phase 0 — Rules

No code churn. Cheapest phase, largest effect on our actual incident history, blocks nothing.

Three testing rules, adopted as policy and applied to existing tests as they are touched:

*Verify the world, not the self-report.* An end-to-end assertion re-runs the command or re-reads the file externally, and asserts that untouched files are byte-identical. Harness's wording is that a keyword probe on the agent's own output "lets a cheating agent pass" — which is exactly how our seven-stage pipeline reported success while writing nothing, and exactly what a sixty-percent rubber-stamp rate looks like.

*Prove the guard fails.* A new gate is not done until the regression it guards has been introduced, watched go red, and reverted. Three inert gates have shipped past a green CI here. Harness gives a worked example: a loader smoke test stayed green when a default export replaced required named exports, so they added an explicit assertion and proved it failed first.

*Prove the guard is REACHED.* Added 2026-08-22, and the one this repository keeps paying for. The rule above establishes that a guard can fail; it says nothing about whether the shipping path ever arrives at it. Every regression authored during the first session of this plan was of the second kind and none of the first: a role-fit gate keyed to the router tier, which no path reaching that function can ever be; the same gate keyed to `lite`, live at one of its three call sites; an eval that refused to fake an answer in unit mode while integration mode went on faking it; a red-team demotion that only fired when *every* assertion was unverified, in a suite whose motivating plugin pairs one with a conclusive check; and a stopped-short test keyed to "does this node have any outgoing edge", which would have reported every healthy run of a shipped preset as a failure. Four gates already in the tree turned out to be unreachable for the same reason, one of them the audit rule for unaddressed low-confidence doubt.

So the check has two halves and the second is the one that gets skipped. Name the path that ships, and assert the value arrives there — a test that captures what the production call site actually passes, not one that calls the guard directly with a hand-made argument. Where a tier or a flag is resolved once and consumed later, thread the resolved value rather than re-deriving it: two derivations of one fact will disagree, and the disagreement is invisible.

*Test the real entry path.* The published artifact under the real runtime, not the source under a loader — this exposes settle races, module resolution failures, and swallowed load errors that a dev-mode loader masks. Our `bun --compile` sidecar crashed at boot for precisely this reason. The corollary for a product with two storage modes: `STORAGE_MODE=embedded` is a shipped path, so it needs its own lane rather than being treated as a development convenience.

Two supporting habits: mock only the expensive or non-deterministic boundary (LLM adapter, network, clock) and keep everything downstream real — our `mock.module` leak is the cost of the opposite habit; and treat an uncovered line as probable dead code the gate is correctly flagging for deletion rather than a test to bolt on.

Four configuration rules, adopted at the same time, each naming a bug already shipped here:

*No hardcoded tunables.* Deployment-varying choices are validated config fields. A `DEFAULT_*` constant or a test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.

*Defaulting is explicit at boundaries.* A resolve step in the owning implementation, never a hidden `?? default` inside the call. The detach-cap bug — config defaulting to zero while the type declared six — is exactly what these two rules prevent.

*Misconfiguration fails loud* at load when self-contained, otherwise at the earliest resolvable point, and never silently skips a missing referent.

*Soft guidance and hard enforcement are separate systems.* A prompt-level mode contributes prompt text and nothing else; permission and sandbox enforcement never read or write that state. Ours are entangled, which is part of why a gate could look active while enforcing nothing.

*A guard sits on the risk-weighted side.* Where a check can be wrong in both directions, the two mistakes rarely cost the same, and the bar belongs on the expensive one. The alias verdict tier is the worked example: reading a stray JSON payload as a FAIL costs one retry and can only tighten the gate, while reading one as a PASS overwrites a genuine failure the auditor wrote in prose and ships the work. A symmetric rule there was both too strict for real failing verdicts and too loose for incidental payloads; an asymmetric one is neither.

Runnable check: the testing rules are applied first to the evidence gate and the QA verdict contract, the two guards with a known false-pass history.

### Phase 1 — Drops (done, 2026-08-22)

Smaller than planned, because an audit found most of it already gone and one target still load-bearing. Recorded here rather than silently dropped, since both findings change what later phases can assume.

The desktop sidecar was already removed with the thin client. There is no `externalBin` in `tauri.conf.json`, no spawn or kill path in `lib.rs`, and no runtime-port store entry — the store holds only `backendUrl`, which is the thin-client design and stays. The one genuine remnant was `@tauri-apps/plugin-shell` in `web/package.json`: no JavaScript import, no matching Rust crate, and no `shell:` permission in the capability manifest. It was the process-spawning dependency the sidecar needed, and it is now removed.

The swarm scorers and call-graph machinery are **not** droppable and the planned deletion is declined. Both are live. `scorers.ts` is wired into the `spawn_child` tool schema, its validation path, both result formatters, and the spawner — including the evidence scorers that the quality-enforcement work attaches automatically, which are the mechanism a `contract_failed` verdict rides on. `call-graph.ts` backs the escalate tool and the spawner's cycle detection and task fingerprinting. Deleting either today breaks child spawning outright.

This matters beyond Phase 1: the evidence scorers are the only thing currently standing between a child's self-report and a recorded result, so they must be carried across the Phase 2 collapse rather than removed with the surrounding orchestrator, and retired only once Phase 3 makes completion a logged fact.

Runnable check: the desktop build succeeds and the desktop client still logs in against a remote backend.

### Phase 2 — Collapse the orchestrator (partly done, 2026-08-22)

**Done: the inference layer no longer picks the specialist.** The keyword classifier decided three things in a row, each overriding the one before, with the model's own reading of the request coming last. Two of the three are gone.

The delegation policy is now unconditional. It used to be emitted only inside `if (classification.topic)`, so a message the regex table did not recognise reached the orchestrator with no delegation guidance at all — and the requests least likely to match a keyword are exactly the ones most likely to need a specialist. It is policy, not a classification result.

The topic no longer reaches a capable model. "You have been pre-classified as X, use this as the child role" replaced a full-mode orchestrator's reading of the whole request with a table's reading — a table whose own source carries years of comments about the asks it steals from the right role. Lite keeps it, demoted from instruction to hint, because a small model is literal enough to follow one and weak enough to route badly without it. Provenance follows: `classifier(topic)` is listed as a source only where it is consumed.

The deterministic role-fit rewrite is weak-model-only. Its own rationale was always a small-model workaround, but it ran for every model, so a capable orchestrator that deliberately chose `architecture` had that replaced by a regex read of the task brief alone — logged as a correction rather than as an override.

**Still open.** The classifier remains for the casual fast-path, output mode and memory scope, all of which are cheap and earn their place. The mode selector remains and should: it resolves a hardware capability tier, not a task guess, and router/lite exist because a small local model cannot drive a full agentic loop. Neither is the inference the phase was aimed at. What is left of the original target is `handoff.ts`, `role-contract.ts` and the runtime stage-graph assembly, none of which is now obviously worth deleting — see the workflow decision below.

Route every request through the single-agent loop by default. `direct-response.ts` and the tool executor already contain most of what is needed; the work is deleting the layer above them.

**Named workflow files are DECLINED at current scale (decided 2026-08-22).** The plan assumed the explicit path had to be built, and that building it would delete the runtime stage-graph assembly. Measured against the repository, neither half holds.

There are four pipeline templates in the database — two, three, seven and seven steps. They are already explicit: a declarative step list with conditional edges, retry edges, per-stage model overrides, `foreach` over a plan, and human-input stages. Nothing in them is reaching for expressiveness a TypeScript body would supply, and nothing has asked for it.

The deletion does not happen either. Of `pipeline-manager.ts`'s 2,461 lines, the graph walker is roughly 470. The rest is QA verdict parsing, the evidence gate, checkpoint, resume, pause and stop, and the three node runners — all of which a workflow engine would have to be re-plumbed into rather than replacing. Against that, the engine adds a worker-thread host, script validation, cap enforcement and the fatal-versus-null failure discipline. It is a net addition of complexity to run four templates, and it would take those templates out of the database, where they are user-editable recipes with parameters, and put them in the source tree, where they are not.

The orchestration thesis stands and was the valuable half: delegation is chosen explicitly rather than inferred, which is what removing the classifier's role directive achieved. Revisit workflow files when a template genuinely cannot express what it needs, and let that template be the argument.

Kept for whenever that argument arrives, the Harness workflow seam is close enough to serve as a reference contract, and its own documentation notes the field vocabulary matches Claude Code's dynamic-workflows meta block, so this is a converging design rather than a novel one. Four parts worth copying:

The identity block is plain JSON data, validated before any script text is evaluated, so a malformed workflow fails loud before the engine runs a line. The run executes in a worker thread, one per run. Failure discipline is split: script misuse — bad arguments, unknown options, a tripped cap — throws fatally and the `parallel`/`pipeline` combinators *re-throw* rather than mapping the item to `null`, because a typo must kill the script loudly instead of dissolving into something that reads as an ordinary child failure; the per-item `null` is reserved strictly for genuine child-run failures. And a run can never wedge: the result promise does not reject (a script failure resolves with an error stop reason), and after cancellation the engine force-settles within a bounded grace period even if the script never settles.

One further rule from the same source generalises beyond workflows: observation events carry data snapshots, never live handles, so a subscriber cannot acquire `cancel`/`dispose`; each listener gets its own cloned payload; and a throwing subscriber is logged rather than propagated, because one bad subscriber must never break core lifecycle.

Runnable check for what remains: an end-to-end run of the seven-stage pipeline asserting non-zero files written and non-zero evidence rows — the exact scenario that previously reported success while doing nothing.

### Phase 3 — The session log as the spine (scoped and largely done, 2026-08-22)

The largest structural change, and the one that makes completion provable rather than claimed.

**First finding, fixed: a run that could take no route out of a stage reported "completed successfully".** The walk ends when `selectEdge` returns null, and every such exit was treated as the end of the pipeline. That null has two unrelated causes — a node with no route for the outcome it produced has finished; a node whose route existed and is now exhausted has stopped short — so a QA stage could fail, burn its retry budget, and have the failing work handed back as a success, with the row, the UI and the notification all agreeing. `routeExhausted` now asks whether an edge matching this outcome exists and every one is at its `maxTraversals`. The stopped run no longer stamps `completedAt` or notifies under the completion type, both of which are read as "this finished" regardless of the status column.

**Reassessment of the premise.** The phase was written on the assumption that completion is a claim in a return value. For pipelines that is now mostly false: `pipeline_nodes.status` is written with an awaited update at both ends of each stage, the evidence gate holds a stage to what it declared, and `reconcileInterrupted` already converts a crashed run to `paused`. The remaining gap the phase names is narrower than "make the log authoritative" — it is that `run-log.ts` is explicitly fire-and-forget ("an aid, not the critical path"), which is right for observability and wrong for anything a decision is derived from.

So scope this phase to the decision-bearing subset rather than a wholesale conversion: which facts must survive a crash, which of those are currently written best-effort, and what reads them. Everything else stays where it is. Measure before converting — the assumption that a rewrite was needed did not survive contact with the code once, and this is the same shape of assumption.

Make the session event log authoritative under one rule: anything that reaches a model request must be reconstructable from the log. Live coordination state — status, queues, in-flight children — travels on a separate non-durable channel and is never the record of what happened. State that matters becomes a fold over the log rather than a mirror held in memory, so resume, fork, and compaction recover it for free, and replay can reject histories that should be impossible (sequence gaps, stale revisions, mutations against stopped phases, cap overflow).

Completion becomes a logged bracket. Every multi-step operation writes a durable start, does the work, and writes its end *last*. Harness states the reasoning exactly: releasing the lock last turns a crash mid-operation into a detectable orphaned start rather than an end that falsely claims the operation finished. An unmatched start at the log tail is legitimate interruption evidence; anywhere else it is corruption.

This subsumes the evidence gate. A stage that produced nothing has nothing to project, so there is no separate gate to bypass and no flag to be dropped between a template and a checker — the recurring bug class ends structurally rather than by a fourth fix.

**Second finding, fixed: the bracket had no durable start.** Measuring the decision-bearing subset, as the reassessment above demanded, turned up the opposite of what the phase expected. `run-log.ts` is fire-and-forget, but its only reader is the API trace view, so no decision derives from it and it can stay exactly as it is. The gap was one layer over: the swarm ledger's `spawn` event and the `swarm_nodes` row were *both* best-effort, and both are load-bearing. The node row is what cascade-cancel, the orphan reaper and the budget walk resolve a running child through; the ledger event is what `replay` and `findRootsWithIncomplete` key off, so a child with no `spawn` row is invisible to reconciliation permanently.

The fix is the bracket rule with the Phase 0 asymmetry applied to writes rather than to guards. `recordSpawn` throws and the spawn is abandoned if it cannot be recorded — the worker is stopped and every reservation it took is returned (node row cancelled, call-graph fingerprint released, fan-out slot given back), returning `denied` rather than `tool_error` so the crash and backup-model ladders do not spawn two more workers against the same broken write. `recordTerminal` and `reconcile` stay best-effort, because a dropped terminal leaves the node in-flight and the next reconcile cancels it: the cheap direction to be wrong in. Pipeline stage workers had a swallowed node row and no ledger events at all; they now record the same durable start and a best-effort terminal on both the success and failure paths.

**What is left.** The wholesale conversion described above — state as a fold over the log, replay rejecting impossible histories, the evidence gate subsumed — is NOT done and is no longer obviously worth doing. Pipelines already write node status with awaited updates at both ends, and the two writes that were genuinely best-effort are now durable. Treat the remaining text as a hypothesis to re-measure against the code before building, the same way the premise above did not survive first contact.

Runnable check: `ledger.test.ts` proves the asymmetry directly — a spawn append against an unwritable repository rejects, while a terminal and a reconcile against the same repository do not. Reverting `recordSpawn` to `safeAppend` was watched go red. Still open: kill the process mid-stage and assert the resumed run reports interruption rather than completion.

### Phase 4 — Log-derived subsystems (invariants done, 2026-08-22)

Three subsystems that only become simple once Phase 3 lands, and should follow it directly. Phase 3 was scoped down rather than delivered whole, so the two that depend on a full log fold — token accounting and goal state — are not unblocked by it and should be re-argued from the code before being started.

*Token accounting* becomes one measurement service replaying the log — total request pressure plus per-node positional pricing, with the last successful call's provider usage reused as a baseline only when the canonical request envelope matches, and the whole envelope repriced heuristically otherwise. This removes the hand-threaded per-stage pools and `NodeBudget.childTokensUsed` entirely, and makes a token-blind stage unrepresentable, because pressure is a property of the log rather than something a stage reports.

*Goal state* — the unwritten blocked-versus-stuck plan — becomes a durable objective with `active`/`paused`/`blocked`/`complete` phases, a block reason carrying both a stable kebab-case code for routing and a free-form message for humans, and a compare-and-set round cap. Two details are worth copying exactly: the durable phase answers what happened to the objective while process-local activation separately answers whether a continuation may start another round, deliberately not the same field; and every mutation writes a complete post-mutation snapshot rather than a delta, so the fold is trivial and a partially-applied change is not representable.

*Runtime invariants* become a registry where each area registers checks under its own name, asserting only over authoritative event streams or mutable data — never that a service or method exists — with failures attributed to the owning area. Harness pairs this with a mechanical gate that rejects unexplained empty checks: an area with nothing checkable must say specifically why. This is the check that would have caught all three inert gates, because it runs where the product runs rather than where the test runs.

**Done: `src/core/invariants.ts`.** A registry keyed by area and name, a boot pass that logs violations with their owning area and never blocks the boot, and a check that throws reported as an *error* rather than as a pass — not knowing is not the same as being fine. The mechanical gate for unexplained empty areas is deliberately skipped: it is a team-scale ceremony, and with two areas the ledger is the check.

Two invariants to start, both taken from incidents. The detach cap is read through `getLevelDefault(0)`, the same call the runtime makes after this deployment's settings are merged, which is exactly the reading the incident lacked while every unit test agreed with the type. And every swarm node below the root created in the last seven days must carry the ledger `spawn` event that replay and the boot reconcile key off; the seven-day window keeps rows written before the bracket existed from being reported forever as a violation nobody can act on.

The same measurement fixed a third instance of the recurring bug class on the way past: `swarmLevelSchema.maxPendingDetached` carried `.default(0)` while each level's object default carried 6/3/0 and `getLevelDefault` carried a third `?? LEVEL_DEFAULT[depth]` resolve step. Three sources for one fact, and the field default was the one that won — a level object setting any other key parsed as a hard zero, making the resolve step below it unreachable. That is the detach-cap incident's exact shape minus the type disagreement that was the only reason anyone noticed. The field is now optional.

Runnable check: the DB-backed lane inserts a child node with no start event, watches the invariant report it, appends the event, and watches it hold again — the production query against real rows. Still open: exercising the detach-cap invariant against a live deployment configured back to zero.

### Phase 5 — Runtime

Move the production runtime to Node LTS and replace Elysia with Hono — a close ergonomic match that runs unchanged on Node with no adapter lifecycle surprises. Bun stays for scripts and one-off tooling, where startup time is a genuine benefit and process semantics do not matter.

Move the test runner to Vitest, retiring `mock.module`. Dependency injection at the accessor layer — already the established pattern for the embedding service — replaces module mocking everywhere.

Storage stays as it is. Both modes are product: `external` is the normal deployment, and `embedded` PGlite is the supported path for installs with no Postgres of their own. Neither is a test fixture and neither is being replaced. Tests continue to run against whatever `DATABASE_URL` names — the existing default is a plain local `octipus_test` database — so a container is never required to run the suite, and a developer with a local Postgres install needs nothing else.

What does change is that both modes get a lane. The `embedded` path ships to users and must be exercised as such, not merely as whatever a test happened to pick up. The PGlite problem this phase actually fixes is narrow and belongs to the runner rather than to storage: a test process that exits 99 while reporting zero failures is an exit-code propagation bug, and the Vitest migration is what makes that visible instead of hidden behind a pipe.

Then put durable execution underneath the workflows from Phase 2. DBOS is the right first choice because it is a library over Postgres, which we already run, rather than a separate service; Temporal is the fallback if volume ever justifies its operational cost. The engine owns retries, timeouts, wall-clock budgets, and crash resumption — all currently hand-rolled, all having failed at least once.

This phase is mechanical and large. Do it in one branch; a half-migrated runtime is worse than either end state.

Runnable check: the full suite green under Vitest in both storage modes, with a non-zero exit code correctly propagated in each; `scripts/run-health.ts` still gating delivery latency; and a workflow that survives a process kill and resumes.

### Phase 6 — Provider layer

Replace LiteLLM with the Vercel AI SDK as an in-process library, keeping the existing topic-to-model binding as the selection mechanism. Local models continue through Ollama's OpenAI-compatible endpoint. The standing rule that no model name is ever hardcoded stays in force; per-model behaviour continues to live in `model_config.metadata`.

Runnable check: the evaluation suite passes against both a paid provider and a local model with no LiteLLM process running.

### Phase 7 — Web

Replace Next.js with Vite and React Router in `web/`. The app uses no server rendering, and the static-export workarounds for the Tauri client's parameterised routes disappear with the framework. The marketing site keeps its own stack.

Runnable check: the Playwright web suite passes and the Tauri client's detail pages resolve without query-parameter routing hacks.

### Phase 8 — Data

Retire Valkey. Postgres already serves as the vector store and system of record; `LISTEN`/`NOTIFY` covers pub/sub, advisory locks cover locking, a table covers the queue. Reintroduce a cache only against a measurement showing Postgres is the bottleneck.

Constrain migrations so the journal cannot drift: generate only, never hand-edit, with `drizzle-kit check` in CI.

Runnable check: the stack boots and passes integration tests with the Valkey container removed from compose.

## Independent items

These depend on nothing and can land in any phase.

*Tool-output spill.* Oversized tool output is persisted rather than inlined: save the full text, return an opaque locator, the exact byte count, and a retrieval hint; the model sees a head/tail preview plus the reference. The details matter — write under a private `0700` root into a session-hashed subdirectory with an exclusive owner-only open so a planted symlink cannot redirect the write; keep the locator opaque so consumers render it with the hint rather than assuming a filesystem read, letting a remote backend return a URI instead; and make the policy best-effort, so a save failure keeps the original inline result rather than turning a successful call into an error.

*Credential scrubbing for spawned commands.* Drop `*KEY*`, `*SECRET*`, `*TOKEN*`, and `*PASSWORD*` from the environment handed to spawned processes so harness credentials cannot leak into output or spill files. Octipus deliberately gives spawned CLI agents the full host config and that decision stands — but the credential subset is worth scrubbing separately from the plugin and hook configuration the CLIs genuinely need.

*Generated, gated catalogs.* Generate the service surface, module graph, and event producer/consumer matrix from the TypeScript program and verify them fresh in CI. Our docs drift measurably — the website lags the repo by about two weeks and the palette has diverged — and generated-plus-gated is the only permanent fix for that class.

*Four remaining defensive rules.* Report orthogonal outcomes independently: a process can time out *and* exit zero because it trapped the signal, so surface `timedOut`, `signal`, and `exitCode` separately rather than nesting one inside another's branch. Normalise a public contract on both sides, so a thrown exception always means a defect rather than a provider problem. Async state is not synchronous state — several queued follow-ups may share one running interval, so a caller that owns a run defines its interval explicitly and describes output as interval-wide; and if the awaited transition can never occur the wait hangs, so handle the nothing-to-wait-for branch (our long "hang" that turned out to be a correct `awaiting_approval` wait is this rule). Dispose must reach quiescence, not merely request it: kill then await exit, and close listener and notification registries *before* killing so late completions stay silent.

## Not in scope

A rewrite — every phase is in-place. A move away from Postgres; that was evaluated in March and pgvector remains the binding constraint. Dropping embedded PGlite, or requiring Docker to run the test suite — both storage modes stay, and the suite stays runnable against a plain local Postgres. Rust in the core, until a specific hot path is measured. Event sourcing beyond what the log and the workflow engine's own history provide. Kubernetes. And from the Harness read specifically: the plugin kernel, the multi-package split, bilingual documentation, a per-file hundred-percent coverage gate, and dual-SDK projection.

## Expected outcome

Around seventeen thousand lines of coordination logic reduce to a single agent loop plus a small set of explicit workflow files. One runtime instead of two, one process for model routing instead of two, one data store instead of two. The bug classes behind the delivery lag, the inert gates, the discarded detached children, and the zero-file pipeline become unrepresentable rather than merely fixed.
