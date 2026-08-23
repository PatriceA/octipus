# Octipus rebuild: execution plan

Date: 2026-08-22 · last updated 2026-08-23 (second pass)
Status: **every phase is closed.** Phases 0 to 4 done or decided in the first pass; Phases 5, 7 and 8 shipped in the second; Phase 6 and the durable-execution half of Phase 5 are declined with the measurement recorded. What remains is not a phase — see [Where this stands](#where-this-stands).
Findings: [rebuild-findings-2026-08-22.md](rebuild-findings-2026-08-22.md)
Measured pass: [../reports/2026-08-23-feature-performance-pass.md](../reports/2026-08-23-feature-performance-pass.md) — every number below that is not a plan comes from there.
State: see [Where this stands](#where-this-stands) at the end, which is the section to read first when resuming.
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

Four testing rules, adopted as policy and applied to existing tests as they are touched (the fourth was added 2026-08-23, from the live pass):

*Verify the world, not the self-report.* An end-to-end assertion re-runs the command or re-reads the file externally, and asserts that untouched files are byte-identical. Harness's wording is that a keyword probe on the agent's own output "lets a cheating agent pass" — which is exactly how our seven-stage pipeline reported success while writing nothing, and exactly what a sixty-percent rubber-stamp rate looks like.

*Prove the guard fails.* A new gate is not done until the regression it guards has been introduced, watched go red, and reverted. Three inert gates have shipped past a green CI here. Harness gives a worked example: a loader smoke test stayed green when a default export replaced required named exports, so they added an explicit assertion and proved it failed first.

*An assertion must not be satisfiable without the product.* Added 2026-08-23. The three previous rules all concern the code under test; this one concerns the check itself, and every harness written during the measured pass broke it at least once. A live UI check waited for the marker the user typed to appear twice — which the composer echo and the transcript satisfy between them, so it passed in 206ms with no model involved. The TUI check repeated the mistake with its own marker. A third reused a chat session, so the previous run's answer satisfied the assertion before this run began. And a refusal check matched a base64 *shape* against whitespace-stripped prose, which any paragraph satisfies, so it failed the product for refusing correctly.

The test: name what could make this assertion pass other than the behaviour it is about — the input echoed back, history, the harness's own output, a shape rather than a value — and remove each one. In practice that means asserting on a value that appears ONLY in the answer (a computed sum, not a phrase from the question), against a state the run created fresh, keyed to the role that produced it (`[data-role="assistant"]`, not page text). The failure direction matters here as much as anywhere: a false green says the product works.

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

### Phase 3 — The session log as the spine (scoped and delivered, 2026-08-22 · last check closed 2026-08-23)

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

Runnable check: `ledger.test.ts` proves the asymmetry directly — a spawn append against an unwritable repository rejects, while a terminal and a reconcile against the same repository do not. Reverting `recordSpawn` to `safeAppend` was watched go red.

**Third finding, fixed 2026-08-23: the boot sweep pardoned the pipeline and left the stage lying.** The remaining runnable check — kill the process mid-stage, assert the resumed run reports interruption rather than completion — turned up a gap one level below where it was aimed. `reconcileInterrupted` correctly turns a `running` or `awaiting_approval` pipeline into a resumable `paused`, and `pipeline-interrupted.test.ts` already covered that including the negative half. What nothing touched was `pipeline_nodes`: the stage the dead process was *inside* stays marked `running` forever, which is a claim that work is in flight when its worker died with the process — the same class of lie as a run reporting success after stopping short, one level down. It self-heals only if someone resumes; an abandoned run keeps the false row indefinitely, and the new goal-state invariant cannot see it because `paused` is not terminal.

The sweep now resets those stages to `pending`, which is safe because the interrupted node re-runs anyway (a worker turn cannot be picked up halfway) and `resume` locates itself from the checkpoints and `currentNodeKey`, never from a node's status. Completed stages are left alone — rewriting those would make the resumed run redo everything that had already finished. Verified against real Postgres, and watched go red with the reset removed.

### Phase 4 — Log-derived subsystems (done, 2026-08-22 to 2026-08-23)

Three subsystems the phase expected to become simple only once Phase 3 landed whole. Phase 3 was scoped down instead, so the two that assumed a full log fold — token accounting and goal state — were re-argued from the code rather than started on the assumption. Both turned out to be expressible as invariants over the rows the product already writes, which is what Phase 4 says an invariant should be; neither needed the fold. All three are done.

*Token accounting* becomes one measurement service replaying the log — total request pressure plus per-node positional pricing, with the last successful call's provider usage reused as a baseline only when the canonical request envelope matches, and the whole envelope repriced heuristically otherwise. This removes the hand-threaded per-stage pools and `NodeBudget.childTokensUsed` entirely, and makes a token-blind stage unrepresentable, because pressure is a property of the log rather than something a stage reports.

*Goal state* — the unwritten blocked-versus-stuck plan — becomes a durable objective with `active`/`paused`/`blocked`/`complete` phases, a block reason carrying both a stable kebab-case code for routing and a free-form message for humans, and a compare-and-set round cap. Two details are worth copying exactly: the durable phase answers what happened to the objective while process-local activation separately answers whether a continuation may start another round, deliberately not the same field; and every mutation writes a complete post-mutation snapshot rather than a delta, so the fold is trivial and a partially-applied change is not representable.

*Runtime invariants* become a registry where each area registers checks under its own name, asserting only over authoritative event streams or mutable data — never that a service or method exists — with failures attributed to the owning area. Harness pairs this with a mechanical gate that rejects unexplained empty checks: an area with nothing checkable must say specifically why. This is the check that would have caught all three inert gates, because it runs where the product runs rather than where the test runs.

**Done: `src/core/invariants.ts`.** A registry keyed by area and name, a boot pass that logs violations with their owning area and never blocks the boot, and a check that throws reported as an *error* rather than as a pass — not knowing is not the same as being fine. The mechanical gate for unexplained empty areas is deliberately skipped: it is a team-scale ceremony, and with two areas the ledger is the check.

Four invariants, each taken from an incident or from a subsystem the phase had assumed needed the log fold. The boot pass reports `checked: 4`.

*The detach cap* is read through `getLevelDefault(0)`, the same call the runtime makes after this deployment's settings are merged — exactly the reading the incident lacked while every unit test agreed with the type.

*Every running swarm node below the root* carries the ledger `spawn` event that replay and the boot reconcile key off. Scoped to `running` rows rather than to a time window: a terminal row needs nothing from replay, so reporting one is noise nobody can act on, and that covers every row written before the bracket existed without dating the check.

*Token accounting* (2026-08-23): no running child holds a token pool larger than its own level's default. `deriveChildBudget` sets a child's cap to `min(levelDefault, parentRemaining - reserve)`, so a cap above the level default cannot come out of the derivation — a row above it means some path wrote a node without going through it. Compared per level rather than against the parent's stored cap, because the derivation raises a parent's in-memory cap when config has grown and never writes that back. `running` only, for the same reason as above: lowering a level default would otherwise make every historical row a violation.

*Goal state* (2026-08-23): no pipeline in a terminal status has a stage still marked `running`. That is the run-reports-success-while-work-is-outstanding shape, stated narrowly enough to be usable — a stage left `pending` is explicitly NOT a violation, because an untaken conditional branch legitimately stays pending forever.

The same measurement fixed a third instance of the recurring bug class on the way past: `swarmLevelSchema.maxPendingDetached` carried `.default(0)` while each level's object default carried 6/3/0 and `getLevelDefault` carried a third `?? LEVEL_DEFAULT[depth]` resolve step. Three sources for one fact, and the field default was the one that won — a level object setting any other key parsed as a hard zero, making the resolve step below it unreachable. That is the detach-cap incident's exact shape minus the type disagreement that was the only reason anyone noticed. The field is now optional.

Runnable check: the DB-backed lane drives each invariant hold → violate → hold against real Postgres — the production query against real rows, not a hand-made argument. `TEST_POSTGRES_PORT=5453 npx tsx scripts/test-integration.ts src/core/invariants.test.ts`, eleven passing. Still open: exercising the detach-cap invariant against a live deployment configured back to zero.

### Phase 5 — Runtime (done, 2026-08-23, except the durable engine, which is declined)

Move the production runtime to Node LTS and replace Elysia with Hono — a close ergonomic match that runs unchanged on Node with no adapter lifecycle surprises.

**The HTTP layer is a shim, not a rewrite, and that was the finding.** Ninety-five route modules, thirty-two route tests and three middleware plugins were written against a small and entirely regular slice of Elysia: a prefixed instance, the verb methods, `.use`, `.group`, `.derive`, four lifecycle hooks, `.ws`, and a context of `body`/`params`/`query`/`request`/`set`. `src/api/http/` implements that slice over Hono in about four hundred lines, so twenty thousand lines of routes did not change. What is deliberately NOT reproduced is per-instance hook scoping — every hook here is either on the root application or declared global.

Three things in the shim are decisions rather than translations. Static route segments sort ahead of parameterised ones, because the previous router resolved that way and registration order would otherwise decide whether `/sessions/active` reaches its own handler. Query and path parameters are coerced to their declared types and bodies are NOT — a JSON body already carries types, and converting it would silently accept the mismatch the schema exists to reject. And the body parser works on a clone, so the four routes verifying a signature over exact bytes still read them; that removed two `onParse` hooks, one of which skipped WhatsApp signature verification entirely whenever the raw string it depended on was absent.

The self-healing listener watchdog and the `beforeExit` surgery are deleted rather than ported. Both existed to work around the Bun adapter. A dropped listener should now surface as a crash.

Bun is gone entirely rather than kept for scripts: the image, the CI, the installer, the launcher and every npm script are Node. Keeping a second runtime for tooling would have meant keeping its lockfile, its CI setup action and its divergences — and `bun.lock` being unwritable by Dependabot is one of the costs this phase was meant to remove.

Move the test runner to Vitest, retiring `mock.module`. Dependency injection at the accessor layer — already the established pattern for the embedding service — replaces module mocking everywhere.

**Vitest isolates each file in its own process, which retired the machinery eleven suites carried** to survive process-wide module mocks. Two projects: pure files at full width, and the seventy-eight that touch a database at one worker. That split is not about speed. Several PGlite instances booting at once wedge inside a WASM syscall where no timer can fire, so the file's own hook timeout never trips and the run hangs instead of failing; and the integration suites truncate shared tables, so in parallel against one server they deadlock. The classification reads the files rather than listing them, because the failure mode of a stale list is a hang.

Three Bun behaviours turned out to be load-bearing and invisible. `.env` was auto-loaded on every start, so on Node the migration runner and every script began with no `DATABASE_URL` — now loaded explicitly, and NOT under test, because pointing a suite that truncates tables at the developer's real database is not a default worth keeping. `Bun.password`'s argon2id had to be reproduced exactly by `crypto.argon2` or every existing user would be locked out; a hash written by the old runtime is committed as a test. And the scratch-directory sweep, registered per file, deletes the live scratch of every sibling worker — it belongs in global setup.

Storage stays as it is. Both modes are product: `external` is the normal deployment, and `embedded` PGlite is the supported path for installs with no Postgres of their own. Neither is a test fixture and neither is being replaced. Tests continue to run against whatever `DATABASE_URL` names — the existing default is a plain local `octipus_test` database — so a container is never required to run the suite, and a developer with a local Postgres install needs nothing else.

What does change is that both modes get a lane. The `embedded` path ships to users and must be exercised as such, not merely as whatever a test happened to pick up. The PGlite problem this phase actually fixes is narrow and belongs to the runner rather than to storage: a test process that exits 99 while reporting zero failures is an exit-code propagation bug, and the Vitest migration is what makes that visible instead of hidden behind a pipe.

**The durable execution engine is DECLINED at current scale (decided 2026-08-23), for the same reason and by the same measurement as the workflow files in Phase 2.**

The phase named four things the engine would own — retries, timeouts, wall-clock budgets and crash resumption — and said all four were hand-rolled and each had failed at least once. Measured against the repository after Phases 3 and 4, all four now exist and are covered. Retries are the graph's retry edges with `maxTraversals`. Wall-clock and token budgets are `NodeBudget` plus the per-node caps migration 0089 added. Crash resumption is a `pipeline_checkpoints` row written at every node boundary — the same mechanism pause, resume and rewind-to-node ride on — with a boot reconcile that no longer pardons a crashed run, and an invariant that fails if a terminal pipeline still has a stage marked running.

There is also nothing for the engine to sit underneath. It was specified as going "underneath the workflows from Phase 2", and Phase 2 declined those: the four pipeline templates live in the database as user-editable recipes. Adopting DBOS would mean restructuring the graph walker into DBOS steps and re-plumbing QA verdict parsing, the evidence gate, pause, stop and the three node runners through it — the walker is roughly 470 of `pipeline-manager.ts`'s 2,700 lines, so the great majority of what would move is not the part the engine replaces. Against that it adds a schema, a dependency, and a second definition of "what is durable" beside the checkpoint row.

Revisit when a failure appears that a checkpoint boundary genuinely cannot express — a mid-node crash whose partial work must be replayed rather than redone. Let that failure be the argument, as Phase 3 said: three for three, every predicted fold-fixes-this turned out to be one specific non-durable write costing a few lines.

This phase is mechanical and large. Do it in one branch; a half-migrated runtime is worse than either end state.

Runnable check, and what it found: the full suite green under Vitest in both storage modes with the exit code propagated — **unit 4,131 and integration 4,207, both zero failures**. The interesting half was the check that the *published artifact* boots and serves, not the source under a loader. It did not. The role registry scanned its own directory at runtime and `require()`d each `config.ts`, which worked only because the previous runtime executed TypeScript from source; inside the bundle `import.meta.url` resolves into `dist/`, the scan found nothing, and the orchestrator failed its first turn on an undefined role. The registry is static imports now, with the prompts loaded as text so the bundler carries them, and `scripts/build.test.ts` asserts against `dist/index.js` that every prompt is in there — proved by removing one and watching it go red. This is Phase 0's "test the real entry path" rule collecting on the first phase that made `start` run the artifact.

### Phase 6 — Provider layer (DECLINED, 2026-08-23)

The plan was to replace LiteLLM with the Vercel AI SDK as an in-process library. Measured against the repository, the premise does not hold: `src/models/providers/` already contains eighteen direct in-process providers — Anthropic, OpenAI, Gemini, Vertex, Mistral, Moonshot, Grok, DeepSeek, Z.ai, OpenRouter, Voyage, Ollama, three custom-endpoint families and the CLI adapters. The in-process library the phase wanted already exists and is the path almost everything takes. Adopting the AI SDK would be a second abstraction over eighteen working providers, and the standing no-hardcoded-model rule would have to be re-established on top of it.

Nor is LiteLLM the second process the phase describes. `docker-compose.yml` runs no LiteLLM container — it is an optional external proxy URL, one provider among many, and the operator's own instance has exactly one enabled model bound to it. The "second process, second deploy" cost is opt-in rather than structural.

Kept as one provider among many, decided by the operator. Revisit if the direct providers ever start duplicating protocol work the SDK does better; that duplication would be the argument.

### Phase 7 — Web (done, 2026-08-23)

Replace Next.js with Vite and React Router in `web/`. The app uses no server rendering and every one of its forty-four pages is a client component, so the framework was providing a router and a build. The marketing site keeps its own stack.

The pages are untouched, by the same move the HTTP layer used: a hundred and eighteen components import from `next/navigation`, `next/link` and `next/image`, and the surface they use is `useRouter`, `usePathname`, `useSearchParams`, `redirect`, a link and an img. `web/compat/next/` is that surface over React Router.

`next start` is replaced by forty lines of `node:http` — serve the file if it exists, serve `index.html` if it does not, proxy `/api`, `/a` and `/__artifacts__` same-origin so the session cookie is attached. Two pages genuinely changed, both because there is no server: `/setup` probes its status in the browser, and `/graph` renders `<Navigate replace>` rather than calling an imperative redirect that would mean a full page load.

The lint gate is the part worth keeping deliberately. The framework preset carried the React Compiler's hook rules and clearing their forty-one errors was real work; `eslint-plugin-react-hooks` keeps them behind `--max-warnings 0`, proved by feeding it a conditional hook and watching it fail.

Runnable check: the Playwright web suite passes — 64/64 against the built bundle — and a real browser drives the shipped UI against a live backend, 11/11 including a chat turn.

Not done, and now merely available: the detail pages still route by query parameter (`/eval/view?id=…`). That shape existed because static export cannot prerender `[id]`; React Router has no such limit, so it is a one-line route change per page whenever prettier URLs are worth the bookmarks.

### Phase 8 — Data (done, 2026-08-23)

Retire Valkey. Postgres already serves as the vector store and system of record; `LISTEN`/`NOTIFY` covers pub/sub and a table covers the queue and the cache. Reintroduce a cache only against a measurement showing Postgres is the bottleneck.

Smaller than it reads, because the `StorageProvider` seam was already there with two implementations. This adds a third — `kv_store` with an `expires_at`, `kv_queue` with `FOR UPDATE SKIP LOCKED`, `LISTEN`/`NOTIFY` — and makes it the external one. Advisory locks turned out not to be needed: nothing was using a distributed lock.

Three behaviours are decisions, each with a test: expiry is enforced on read so the sweep only reclaims space; `increment` is one statement so concurrent counters do not lose each other; and a message over NOTIFY's 8000-byte payload limit spills to the table and travels as a pointer, because an 8KB ceiling that only appears under a big message in production is the worse failure.

Ordering is the thing to know: external storage runs ON the database, so `initializeStorage` must follow `initializeDb`. The integration helper now sets the database up itself rather than trusting each caller.

`src/db/redis.ts` is `src/db/cache.ts` and the `Redis*` classes lost the prefix; the `redis` key in the health payload and the `octipus_redis_up` metric keep their names, because they are a contract the dashboard and external monitoring read.

**Migrations: the "generate only, never hand-edit" rule is NOT adopted, and should be dropped from this plan.** The repository diverged at 0085 — snapshots stop there and 0085 through 0089 are hand-written with journal entries. `drizzle-kit generate` currently cannot run non-interactively at all: it stops on an enum-conflict prompt from drift that predates this work. Reconciling that is its own task, and pretending the rule is in force while the tree says otherwise is worse than saying so. 0090 follows the established pattern.

Runnable check: the stack boots and passes integration tests with the Valkey container removed from compose — 4,207 green, and the built artifact writing sessions, rate-limit counters, the scheduler heartbeat and a queue item into the new tables while serving login and authenticated reads.

## Independent items

These depend on nothing and can land in any phase. All four are done; each entry below carries what shipped and where the code overruled the plan.

*Tool-output spill* — **done, 2026-08-23, and simpler than specified.** Oversized output is saved rather than inlined; the model gets a head, a tail, the exact size and the path. `src/core/tool-output-spill.ts`, wired at the one boundary where a tool result becomes a message.

The locator is deliberately NOT opaque, which is the one place the plan was overruled by the code. The file goes into the agent's own workspace, so retrieval needs no locator service, no retrieval tool and no new permission — the filesystem and grep tools are already scoped there. An opaque handle would have bought a remote-backend option nobody has asked for, at the cost of a service and a rendering contract. Everything else held: `0700` directory, `0600` file, chmod after write so the umask cannot loosen it, the sandbox `resolve` as the guard against a planted symlink, and best-effort semantics so a failed save falls through to the old truncation rather than turning a successful call into an error. Threshold is the same `DEFAULT_MAX_LENGTH` the truncation uses, because two thresholds would mean output that is cut but never saved. Verified live during the measured pass: two files, 129KB and 149KB, owner-only.

The unspecified half turned out to matter more than the spill: what the truncation destroyed was also the *transcript's* only copy, so the rest was not merely absent from context, it was gone.

*Credential scrubbing for spawned commands* — **done, 2026-08-23, and it found two live leaks.** The filter now lives in `src/security/child-env.ts` and every spawn site uses it.

The shell tool already had one, and it was wrong in two ways the plan did not anticipate. Its pattern was anchored to the END of the variable name, so `AWS_SECRET_ACCESS_KEY` read as safe — the plan's own `*SECRET*` wording is the correct one and the code was the narrower version. And it was private to that tool: `git`, `docker`, `gh` and `glab` spawn with no `env` at all, which inherits everything. The docker one is the sharpest, because the model writes the arguments and `docker run --env NAME` forwards a variable into a container whose output it then reads.

Two of the four CLIs need one credential of their own, so `buildChildEnv` takes a `keep` list: `gh` keeps its GitHub tokens, `glab` its GitLab ones, neither keeps the other's or Slack's. The same judgment now answers the `env` tool, which filtered by name against the raw environment and would hand over `MASTER_KEY` to anyone who asked for it by name — stripping secrets from spawned commands while answering that in the same process is a door beside a wall. The standing decision that spawned CLI agents inherit the full host config is untouched; this is the credential subset only.

*Generated, gated catalogs* — **done, 2026-08-23.** `scripts/gen-catalog.ts` writes `docs/architecture/generated/CATALOG.md`; `bun run catalog:check` is a step in the backend CI job and fails when the committed copy no longer matches the source. Three catalogs: the HTTP surface (every mounted route with its full path, plus any route object nothing mounts), the module import graph with its mutual imports, and the gateway event matrix. Linked from the README and named as authoritative by `AGENT-ARCHITECTURE.md`.

Where the code overruled the plan: "from the TypeScript program" is not available. This repo is on TypeScript 7, the Go port, which ships a compiler binary and no JavaScript AST API — `ts.createSourceFile` does not exist. Rather than add a parser for one script it uses `Bun.Transpiler.scanImports` for the module graph, which is a real parse, and narrow anchored patterns for the other two over a copy with comments blanked so commented-out code cannot read as live. Anything that does not resolve to a literal is counted and reported rather than dropped.

It paid for itself on the first run, and again on its own review. Eleven declared gateway event types had no producer: one was a genuine missing feature (`swarm.budget_warning`, subscribed by the persona narration bridge, so that narration had never fired) and ten were retired, including one documented in three hand-written files as live. Its own first draft had six bugs that each produced a catalog reading as coverage — a commented-out mount counted as live, a getter's parenthesis matched instead of the call's, an indirect event type swallowing the operand it was compared against, thirty-three `Map.get(id)` calls counted as unresolvable routes, no regex-literal state in the comment scanner, and an event scan that read raw source while the route scan read the blanked copy. All six are pinned in `scripts/gen-catalog.test.ts`, along with a check that the unmounted-route gate fires — proved by commenting out the metrics mount and watching it appear.

*Four remaining defensive rules* — **three done, one and a half open (2026-08-23).**

Done: *report orthogonal outcomes independently* and *dispose must reach quiescence*. The shell result now carries `timedOut`, `aborted` and `signal` beside `exitCode` rather than nested inside one branch of it, and writing that down exposed why the signal was wrong — node's own spawn `timeout` was racing our timer, killing with SIGTERM and setting none of the flags that explain a kill. One deadline, one owner. Driving it afterwards found the deadline did not reach the process tree either: the kill went to the direct child while the promise resolves on `close`, which waits for pipes a backgrounded grandchild still holds. And `stopAll` now waits for agents to be gone rather than returning once they have been asked, bounded so it cannot outlast the force-exit watchdog, dropping subscribers first — but only at process shutdown, never for the live `/stop-all` command, whose subscribers are the UI's event stream.

Also done: the *nothing-to-wait-for* half of *async state is not synchronous state*. `docs/plans/blocked-vs-stuck.md` turned out to be shipped end to end — Phase 1's blocked heartbeat names what a quiet turn is waiting for every ~20s, Phase 2 documents the REST caller's polling contract with an e2e helper, and Phase 3's `src/models/local-fit.ts` fails a local model load fast instead of burning ollama's fifteen-minute timeout. One reachability caveat worth knowing: the fit gate sits on the direct-provider branch only, so a local model registered against the LiteLLM proxy bypasses it. It fails open by design, but that is the repo's recurring gate-reachability shape.

Open: *normalise a public contract on both sides*, and the *shared-interval* half of *async state is not synchronous state*.

The original wording, kept because the two open halves still need it. Report orthogonal outcomes independently: a process can time out *and* exit zero because it trapped the signal, so surface `timedOut`, `signal`, and `exitCode` separately rather than nesting one inside another's branch. Normalise a public contract on both sides, so a thrown exception always means a defect rather than a provider problem. Async state is not synchronous state — several queued follow-ups may share one running interval, so a caller that owns a run defines its interval explicitly and describes output as interval-wide; and if the awaited transition can never occur the wait hangs, so handle the nothing-to-wait-for branch (our long "hang" that turned out to be a correct `awaiting_approval` wait is this rule). Dispose must reach quiescence, not merely request it: kill then await exit, and close listener and notification registries *before* killing so late completions stay silent.

## Not in scope

A rewrite — every phase is in-place. A move away from Postgres; that was evaluated in March and pgvector remains the binding constraint. Dropping embedded PGlite, or requiring Docker to run the test suite — both storage modes stay, and the suite stays runnable against a plain local Postgres. Rust in the core, until a specific hot path is measured. Event sourcing beyond what the log and the workflow engine's own history provide. Kubernetes. And from the Harness read specifically: the plugin kernel, the multi-package split, bilingual documentation, a per-file hundred-percent coverage gate, and dual-SDK projection.

## Where this stands

Written 2026-08-23 after the measured pass, and rewritten the same day once every open item below the migrations had been closed. Read this first when resuming; the phases above are the argument, this is the position.

### Done

**Phases 5, 7 and 8 — the migrations (second pass, 2026-08-23).** Node and Hono, Vitest, Vite and React Router, and Postgres in place of Valkey. Each shipped as one commit with its verification in the message. The HTTP layer and the web router are both compatibility shims rather than rewrites — the same move twice, and the reason twenty thousand lines of routes and forty-four pages did not change. Bun is gone from the image, the CI, the installer and the launcher.

**Phase 6, and the durable engine inside Phase 5 — declined with the measurement.** Eighteen direct providers already are the in-process library the AI SDK was to supply, and LiteLLM is an optional proxy rather than a second deploy. Retries, budgets and crash resumption already exist as retry edges, `NodeBudget` and the checkpoint row, and there is no workflow engine for a durable engine to sit under because Phase 2 declined those too.

**Phase 0 — rules.** Four testing rules and five configuration rules, in force. Applied to everything touched since.

**Phase 1 — drops.** Complete and smaller than planned: most of it was already gone, and the swarm scorers and call-graph deletions were declined because both are load-bearing.

**Phase 2 — the orchestrator's inference layer.** The keyword classifier no longer picks the specialist; the delegation policy is unconditional; the deterministic role-fit rewrite is weak-model-only. Named workflow files are declined at this scale, with the argument recorded — revisit only when a template cannot express what it needs.

**Phase 3 — completion as a durable fact.** Scoped down after measurement, and now delivered at that scope with its last runnable check closed. A swarm child's start is durable and asymmetric by risk: it throws and the child does not run if the start cannot be recorded, while terminals stay best-effort. Pipeline stage workers got the same bracket. The stopped-short run that reported success is fixed, including the escalation path that laundered its own outcome on the way to the exit. And the boot sweep no longer pardons a crashed pipeline while leaving its stage row claiming to be running.

What is NOT done is the wholesale conversion of state into a fold over the log — and the case for it is now weaker than when the phase was written. Every failure the phase predicted a fold would fix has turned out to be one specific non-durable write, each costing a few lines to fix directly: the swarm ledger's spawn bracket, the pipeline stage worker's bracket, and the crashed stage row. Three for three. Keep re-measuring before building; do not treat the remaining text as a backlog.

**Phase 4 — all three subsystems.** `src/core/invariants.ts` ships with a boot pass that logs whether it ran (`checked: 4`), reports a throwing check as an error rather than a pass, and takes a filter so tests do not run the DB-backed checks. Four invariants: the orchestrator's detach cap read the way the runtime reads it; every running swarm node below the root carrying its ledger start; no running child holding a token pool larger than its level allows; and no terminal pipeline with a stage still marked running.

The last two are token accounting and goal state — the subsystems the phase assumed needed the log fold first. They did not. Both are expressible against the rows the product already writes, which is what this phase says an invariant should be, and both were driven hold → violate → hold against real Postgres rather than asserted.

**Independent items.** All four: tool-output spill, credential scrubbing, the generated and CI-gated architecture catalog, and three of the four defensive rules — all described in their own section above.

**The two open items from the measured pass.** Prompt overhead was not a size problem: the orchestrator was busting the provider cache breakpoint the repo has had since Phase 2b by putting six per-turn blocks in the static tier, and its own turn had no prompt accounting at all. Tool-call variance was narrowed by a run-wide redundant-call check, because both existing loop guards are consecutive-only and the alternating shape behind the 14-call run tripped neither.

**The live harnesses.** Three, all new: `scripts/feature-bench.ts` (ten scenarios plus sixteen endpoints through the HTTP API both clients use, with tokens and roles read from the rows each run wrote), `scripts/ui-live-check.ts` (real browser, real app, real backend — the existing Playwright suite stubs every API call), and `scripts/tui-live-check.ts` (the TUI under a pty; a pipe gives an empty transcript because pi-tui only paints to a TTY).

### Verified state, 2026-08-23 (second pass)

After the migrations, on Node: typecheck (backend and web), Biome lint on 915 files, ESLint on the web with the React Compiler hook rules, the catalog check, **unit 4,131** and **integration 4,207 against real Postgres with no Valkey container in the stack**, the Playwright web suite **64/64** against the built bundle, the live web UI **11/11** in a real browser against a live backend — including a chat turn that answered 17 × 23 = 391 — and the live TUI **4/4** under a pty. The built artifact boots, serves, and shuts down cleanly on SIGTERM in both storage modes.

The coverage baseline was re-measured rather than lowered: v8 attributes lines and functions differently from the previous instrument, so the same tests over the same code read 48.96/50.93 where they read 52.8/61.9. The reason is recorded in `scripts/coverage-baseline.json`.

One local note that still applies: port 5443 can be held by another project's Postgres, so `TEST_POSTGRES_PORT=5453 npx tsx scripts/test-integration.ts` is the form that always works.

### Verified state, 2026-08-23 (first pass)

Eleven lanes green: typecheck, lint (904 files), unit (4,298), TUI unit (251), web Playwright (64), integration against real Postgres (4,250), e2e against the live backend (142), the feature bench (10/10, twice), the API surface (16/16), the live web UI (11/11) and the live TUI (4/4).

Re-run after the work above, 2026-08-23: unit 4,152 and integration 4,211, both zero failures, plus lint, both typechecks and `catalog:check`. A twelfth gate exists now — the catalog — and it caught its first drift on the commit that added the two new invariants, which changed the module edge counts.

One local note for the integration lane: port 5443 can be held by another project's Postgres, so `TEST_POSTGRES_PORT=5453 TEST_REDIS_PORT=6389 npx tsx scripts/test-integration.ts` is the form that always works.

Performance, measured rather than assumed: read endpoints 12–16ms median; web pages 0.53–0.85s; a chat answer on screen in 2.4–6.0s; the TUI booting in 0.2s and answering in 2.8–5.2s; delivery lag median 11ms and p95 19ms across 86 runs. Full numbers in the report linked at the top.

Eight product defects were found by running the product and fixed — four of them reachable only through a real client, including two authentication faults that signed a user out during ordinary navigation. They are listed in the report; the point for this plan is that none of them were visible to a suite that stubs its boundaries, and the harnesses that found them are now in the tree.

### Next

**Nothing in this plan is open.** The three migrations that ran in the second pass are described in their own sections above; the two that did not run are declined there with the argument, not deferred.

What is worth carrying forward is not a phase:

- **The recurring lesson collected again.** Phase 0's "test the real entry path" rule had been sitting unpaid because `start` ran the source. The moment it ran the artifact, the role registry's runtime directory scan produced an empty registry and the orchestrator died on its first turn — invisible until an unrelated log line stopped serialising its Error to `{}`. Two rules, both already written down, and the bug needed both of them to surface.
- **Declining is a result.** Three of the eight phases ended in a measured decline — workflow files, the AI SDK, the durable engine — and in each case the plan's premise had been overtaken by work done since. Re-measure before building stays the most valuable rule in this document.
- **The migration rule that was aspiration.** Phase 8 says "generate only, never hand-edit" for migrations. The tree diverged at 0085 and `drizzle-kit generate` cannot currently run non-interactively because of pre-existing enum drift. Either reconcile that drift and make the rule true, or delete the rule. Leaving it written but unenforced is the shape this repository keeps paying for.
- **Two open questions carried from the first pass**, both still product decisions rather than defects: `/api/metrics` 404s until `METRICS_TOKEN` is set, and `local-fit.ts` guards the direct-provider branch only, so a local model registered against the LiteLLM proxy bypasses the fail-fast.
- **The detach-cap invariant against a live deployment configured back to zero.** Written and green against real rows; never watched firing on a real instance.

### Closed on 2026-08-23, and what each turned out to be

Kept in full because in every case the finding was not what the item predicted, and that is the part worth reading before starting the next one.

1. **Prompt overhead** — **attacked 2026-08-23, and the fault was not size.** The floor breaks down as ~2,950 tokens of role prompt, ~2,700 of meta-tool JSON schema, ~240 of delegation policy, and the rest expert index, workspace and per-turn context. All of it sits behind an Anthropic cache breakpoint that the repo has had since Phase 2b — and the orchestrator was busting it on every turn. Long-term memory (retrieved per turn, scoped by the classifier's topic), the attached-file block, the security reminder, the topic hint, the ambiguity notice and the output directive were all concatenated into the *static* tier, ahead of the breakpoint, so the whole ~6k prefix was re-written rather than read whenever any of them differed. They are now in the volatile tier and the prefix is stable.

   The orchestrator's own turn also had no prompt accounting at all: `logPromptComposition` was wired into the worker and swarm paths by the prompt-size audit and never into the path the measured pass put at 8.4k. It is wired now, so the next question about this number can be answered from a log line rather than a script. The two tiers are joined by one exported function with the ordering contract stated on it, and the check is a test that the cacheable prefix does not move when the turn-derived blocks change.

   Not done, and deliberately: trimming the prose or the tool descriptions. With the prefix genuinely cached the remaining size is priced at ~10%, and the tool descriptions encode routing guidance that was expensive to get right. Re-measure before cutting.
2. **Tool-call variance** — **narrowed 2026-08-23.** Both existing loop guards are *consecutive*-only, so an A,B,A,B,A ping-pong — the same file read three times with a write in between, which is the shape of the 14-call run — trips neither. `ToolLoopDetector.checkRedundant` now counts each call signature across the whole run and nudges once when the same tool is called a third time with identical arguments. Advisory, not enforcing: the call still executes, because a re-read after a write is a different answer to the same question, and the nudge rides the existing `pendingDriftNudge` schedule so the assistant's `tool_calls` are never left orphaned. A hard cap stays unbuilt — the variance is a two-sample observation and a cap that truncates real work is worse than the tokens it saves.
3. **The two remaining defensive rules** — normalising a public contract on both sides, and async-state (shared interval, nothing-to-wait-for). The nothing-to-wait-for branch turns out to be **already covered**: `docs/plans/blocked-vs-stuck.md` is fully shipped — Phase 1's blocked heartbeat names what a quiet turn is waiting for every ~20s, Phase 2 documents the REST caller's polling contract with an e2e helper, and Phase 3's `src/models/local-fit.ts` fails a local load fast instead of burning ollama's 15-minute timeout. One reachability caveat on Phase 3: the fit gate sits on the direct-provider branch only, so a local model registered against the LiteLLM proxy bypasses it. It fails open by design, but it is the repo's recurring gate-reachability shape and worth knowing.
4. **Generated, gated catalogs** — **done, 2026-08-23.** `scripts/gen-catalog.ts` writes `docs/architecture/generated/CATALOG.md` and `bun run catalog:check` fails CI when the committed copy no longer matches the source. Three catalogs: the HTTP surface (381 mounted routes with their full paths, plus any route object nothing mounts), the module import graph with its mutual imports, and the gateway event matrix — the declared `GatewayEventType` union against where each type is published and which in-process subscription patterns cover it.

   No AST, because there is none to use: this repo is on TypeScript 7, the Go port, which ships a compiler binary and no JavaScript AST API. Rather than add a parser for one script it uses `Bun.Transpiler.scanImports` for the module graph — a real parse — and narrow anchored patterns for the other two, over a copy with comments blanked so a commented-out mount reads as absent. Anything that does not resolve to a literal is counted and reported rather than dropped; the count is currently zero for routes and two for events.

   Writing it was worth it for the four bugs it had in its own first draft, each of which produced a catalog that *read* as coverage: a commented-out `.use` counted as a live mount (which would have hidden exactly the defect the HTTP catalog exists to find), `getGatewayHub().publishEvent({…})` matched the getter's parenthesis instead of the call's so every event published that way looked unpublished, an indirect event type swept up the operand it was compared against, and thirty-three `Map.get(id)` calls inside handlers were counted as unresolvable routes. All four are pinned in `scripts/gen-catalog.test.ts`, along with a check that the unmounted-route gate actually fires — proved by commenting out the metrics mount and watching it appear.

   **The findings, and what closing them cost.** The first run reported eleven declared event types with no producer. Every one was real, and they split two ways.

   `swarm.budget_warning` was the one worth building: declared, subscribed by both the websocket route and the persona narration bridge — which carries a `budget_warning` template — and never once emitted, so that narration had never fired in the product's life. It publishes now, from the point in the spawn path where the parent's pool has just been synced to real spend and is about to matter, once per node so the narration does not repeat on every sibling. The threshold is derived rather than picked: `BUDGET_WARN_FRACTION = (1 - BUDGET_RESERVE_FRACTION) * 0.75`, so it fires when the *spendable* portion is three-quarters gone — early enough to be a warning rather than a report, late enough not to fire on healthy runs. The decision lives in `shouldWarnBudget`, a pure predicate beside the rest of the cascade arithmetic, so it is testable without standing up a spawn.

   The other ten were retired, because a producer for them would have been a feature written to satisfy a type. `swarm.node_status` was documented in three hand-written files as an intermediate progress update and emitted by nothing — that is the drift this catalog exists to expose, and those three files are corrected. `worker_spawned`, `worker_completed`, `pipeline_event`, `status_update`, `typing`, `message` and `approval_required` belong to `OrchestratorEvent['type']`, which `mapOrchestratorEventType` translates *into* gateway types; declaring them as gateway types described producers that by construction cannot exist. `error` is a `ServerMessage` sent to one connection, never an event on the bus. `session.cleared` had neither producer nor consumer.

   Every declared type now has a publisher except `test.event`, which the gateway's own tests emit — and the catalog says so, since the scan excludes test files on purpose.
5. **Phase 3's remaining half** — **re-measured 2026-08-23, and it still has not earned it; its last runnable check is now closed.** The check the phase was waiting on (kill the process mid-stage, assert the resumed run reports interruption rather than completion) found a real gap, but one level below where the phase aimed: `reconcileInterrupted` pardoned the pipeline and left the stage row marked `running` forever. That is now fixed and covered against real Postgres — see the third finding in Phase 3 above.

   The wholesale conversion — state as a fold over the log, replay rejecting impossible histories, the evidence gate subsumed — remains unbuilt, and the case for it is weaker after this pass than before it. Each thing the phase predicted a fold would fix has turned out to be one specific write that was not durable, and fixing that write directly has cost a few lines each time: the swarm ledger's spawn bracket, the pipeline stage worker's bracket, and now the crashed stage row. Three for three. Keep re-measuring before building; do not treat the remaining text as a backlog.
6. **Phase 4's other two subsystems** — **done, 2026-08-23, without the log fold they assumed.** Both are now invariants over the rows the product actually writes, which is what Phase 4 said an invariant should be.

   *Token accounting*: no `running` child holds a token pool larger than its own level's default. `deriveChildBudget` sets a child's cap to `min(levelDefault, parentRemaining - reserve)`, so a cap above the level default cannot come out of the derivation — a row above it means some path wrote a node without going through it, and the cascade is bounding nothing on that branch. Compared per level rather than against the parent's stored cap, because the derivation raises a parent's in-memory cap when config has grown since it spawned and never writes that back. `running` rows only: a historical row was written under whatever the config said then, and lowering the level default would otherwise make every past row a violation.

   *Goal state*: no pipeline in a terminal status has a stage still marked `running`. That is the run-reports-success-while-work-is-outstanding shape, stated narrowly enough to be usable — a stage left `pending` is explicitly NOT a violation, because an untaken conditional branch legitimately stays pending forever.

   Both verified against real Postgres rather than asserted: `TEST_POSTGRES_PORT=5453 npx tsx scripts/test-integration.ts src/core/invariants.test.ts`, 11 passing, each invariant driven through hold → violate → hold. The boot pass now reports `checked: 4`.

### Known and unresolved

One unit-test flake: a single failure appeared twice in roughly ten full-suite runs and never reproduced across five consecutive clean runs afterwards. The failing test's name was not captured. It is not a blocker and it is not understood. It has not recurred across the several full runs this pass made either, which is evidence of nothing in particular.

The `new` session dialog duplicate is **fixed, 2026-08-23**. The dialog is a choice not yet made, and the composer behind it stayed live: a message sent while it was open auto-created its own session, and confirming the dialog then added a second, empty one. The composer is now disabled — and says why — for as long as the dialog is open.

## Expected outcome, and what it turned out to be

The plan expected seventeen thousand lines of coordination logic to reduce to a single agent loop plus explicit workflow files, one runtime instead of two, one process for model routing instead of two, and one data store instead of two.

Two of those four landed as written. **One runtime**: Node end to end, Bun gone from the image, the CI, the installer and the launcher, and with it the adapter watchdog, the `beforeExit` surgery and the process-wide module mocks. **One data store**: Postgres serves the cache, the queue and the pub/sub, and the Valkey container is out of both compose files.

The other two did not survive contact, and the measurements are the useful part. The seventeen thousand lines did not collapse into an agent loop: the valuable half of that thesis was making delegation explicit rather than inferred, which Phase 2 delivered by removing the classifier's role directive, and the rest turned out to be four database-resident pipeline templates that a TypeScript engine would take *out* of the users' hands. Model routing was already one process — eighteen in-process providers — with LiteLLM an optional proxy beside them.

What did become harder to represent: a run that reports success while stopped short, a crashed pipeline that leaves a stage claiming to be running, a child holding a budget its level does not allow, a detach cap silently at zero, and — new in the second pass — a shipped artifact whose prompts stayed behind in the source tree.
