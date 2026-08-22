# Rebuild session findings — 2026-08-22

Companion to [rebuild-execution-plan.md](rebuild-execution-plan.md). What the first working session through that plan actually found, as opposed to what it set out to do. Eight commits on `main`, `a912a5f3` through `860e8a9d`.

The plan's phases produced less than the bugs found while walking them, so this document leads with the bugs.

## The bug class this repository keeps paying for

Every defect below is one shape: **a guard that cannot fail, or cannot be reached.** Four were already in the tree. Five more were authored during this session and caught in review. That ratio is the finding — the failure mode is not writing a bad check, it is writing a good check the shipping path never arrives at.

Phase 0 already carried "prove the guard fails", which establishes that a guard *can* go red. It says nothing about whether production ever reaches it. Both halves are now written into Phase 0; the second is the one that gets skipped.

### Gates found inert in the tree

**The structured handoff, and the audit rule that fed on it.** Every non-terminal stage is instructed to emit a ```` ```handoff ```` fence. `runStepNode` stripped it before returning, and the walker handed the *stripped* reply to `createHandoffContext` — so `parseStructuredHandoff` returned null on every stage of every pipeline and each handoff was silently regex-scraped out of prose instead.

The consequence runs further than lossy handoffs. `confidence` is set from the structured block alone, deliberately: prose extraction cannot produce one, because a missing signal is not a low one. With the block never parsed, every handoff carried no confidence, `handoffConfidenceByStage` returned an empty map, `auditScopeBefore` never admitted a stage on its low-confidence branch, and the audit rule that fails a PASS for **unaddressed low-confidence doubt could not fire at all**. A stage could hand off saying it was unsure and the gate was structurally incapable of noticing.

**A run that stopped short reported success.** `selectEdge` returns null for two unrelated reasons and the walker treated both as the end of the pipeline. A QA stage could fail, exhaust its retry budget, find no edge left, and have the failing work handed back as "completed successfully" — in the run row, the UI and the notification.

**The routing eval compared the classifier with itself.** Unit mode set `ctx.routedRole` to `classification.topic`, and the assertion's fallback was `classification.topic` too. Forty-three assertions across eight suites reported that routing worked without ever observing a route. The first fix only moved the lie: integration mode was still answering from the same field, which would have made routing assertions runnable *only* in the mode that still faked them.

**The role-confusion red-team plugin could not fail.** `classification` and `routes_to_role` returned `passed: true` with the message "requires orchestrator integration" — a self-declared pass counted toward the attack being defended, in the suite where a false green is worst. The plugin exists to test whether an attacker can steer the system into a privileged role.

### Gates authored broken during this session

All five were caught in review before shipping. They are listed because the pattern is more useful than the individual fixes.

- Gated the role-fit rewrite on the **router** tier — which no path reaching that function can ever be, since router mode short-circuits into `runRouterTurn` before spawning. Dead in every path that could reach it.
- Re-gated it on `lite` — live at one of its three call sites. Pipeline stage workers and depth-1 agents on small local models passed no tier at all.
- Made the eval refuse unit-mode routing while integration mode went on faking the answer.
- Demoted a red-team test only when *every* assertion was unverified. The motivating plugin pairs its routing check with a conclusive content check, so the conclusive half carried the test to green with the routing check unmade.
- Keyed "stopped short" to **does this node have any outgoing edge**, which would have reported every healthy run of the shipped Bug Fix preset and every drained plan loop as a failure — the compiler emits `qa_fail` and self-audit edges for a terminal QA stage but no `qa_pass` edge.

Two further habits fell out of this. Where a tier or flag is resolved once and consumed later, **thread the resolved value rather than re-deriving it**: a second derivation from a model id ignored `metadata.paramCount` and gave a different answer for the same model. And a guard that cannot be made to fail should not be kept as decoration — one test written this session passed either way, and its comment was corrected to say so rather than leaving it looking like protection.

## Other defects found

**Incidental JSON could overwrite a real verdict.** The alias tier accepted any object with a verdict word plus "something more", and `summary`/`notes` counted — so a pasted test-runner payload (`{"result": "success", "summary": "12 tests passed"}`) or health check (`{"status": "ok", "notes": "service up"}`) parsed as a PASS. That tier runs *before* the prose tiers, so an auditor that wrote a genuine FAIL and ended its report with a tool-output fence had the FAIL replaced by a pass — which the coverage gate then diverted into the auditor-only retry loop, so the real failure never reached the implementer.

The fix is asymmetric by risk, and the general rule is now in Phase 0: a stray FAIL costs one retry and can only tighten the gate, a stray PASS overwrites a genuine failure and ships the work. A symmetric bar was simultaneously too strict for real failing verdicts and too loose for incidental payloads.

**Stage workers inherited the orchestrator's whole metadata object** — including `isSystemUser`, which bypasses tool permission checks, `isAdmin`, and `originalRequest`, which re-seeded each worker's drift detector with the parent's vocabulary and weakened the guard meant to notice a worker wandering off its own task. Now copied by name, so a future privilege flag stays behind unless somebody chooses to forward it.

**The cheap verdict correction killed the run it existed to rescue.** It told the auditor to run nothing and change nothing, then judged the visit against the stage's own `runsCommands` declaration, failed it for obeying, and a failed evidence gate aborts the pipeline. Correction visits are now judged against a narrowed declaration — with `readOnly` deliberately kept, since a correction that edits the code it already judged has invalidated the verdict it is correcting.

**A coverage rejection was being sent down the correction path.** Both audit-gate failures took it, but they need opposite prompts: an unparseable report is correctable in place because the findings stand, while a PASS that does not account for stages in scope means the auditor never looked. Telling it to re-read nothing left it able only to re-word, the gate rejected the same uncovered stages, and the retry budget burned down with the stage still unexamined.

**A delegating stage silently produced no plan.** Swarm children got `{ originalRequest }` only, so `plan__add_items` from inside a child answered "Not running inside a pipeline" and a `producesPlan` stage that spawned a planner left no items — the loop that reads them then ran zero times, which reads as success.

**Packaging evidence was decided by path, and wrongly in both directions.** It exempted a packaging stage that built into the workspace root — failing it for "changing 0 files", since a shell-built package raises no tool counter either — and counted a read-only verification stage that happened to build into `dist/`. It is now the stage's declaration that decides, at the diff rather than the walk: a snapshot that hides files can never be re-scored, and a suffix skip is content-blind, so a read-only stage could overwrite a checked-in wheel and report nothing. The `*.egg-info` prune was the same hole with a directory name the running stage chooses.

## Two plan assumptions that did not survive the code

**Named workflow files (Phase 2 step b) — declined.** The plan assumed the explicit delegation path had to be built, and that building it would delete the runtime stage-graph assembly. There are four templates in the database (2, 3, 7 and 7 steps), already declaratively explicit, with conditional edges, retry edges, per-stage model overrides, `foreach` over a plan and human-input stages; nothing reaches for expressiveness a TypeScript body would add. And the deletion does not happen: of `pipeline-manager.ts`'s 2,461 lines the walker is roughly 470, while verdict parsing, the evidence gate, checkpoint, resume, pause, stop and the three node runners would be re-plumbed into a new engine rather than replaced by it — which itself adds a worker-thread host, script validation and cap enforcement. It would also move user-editable parameterised recipes out of the database and into the source tree.

**Phase 3's premise is narrower than written.** "Completion is a claim in a return value" is now mostly false for pipelines: node status is written with awaited updates at both ends of a stage, the evidence gate holds a stage to its declaration, and `reconcileInterrupted` converts a crashed run to `paused`. The real gap is that `run-log.ts` is explicitly fire-and-forget — correct for observability, wrong for anything a decision derives from. Scope the phase to that subset and measure before converting.

The general lesson is the one the ladder already encodes and this session had to relearn twice: **the plan is a hypothesis about the code, and the code is the authority.** Both assumptions read as obviously true in the plan document and were false against the repository.

## What was pushed back on rather than fixed

Reviews are input, not instruction. Two findings were declined with reasons recorded in the source so they are not re-filed: `dist/`/`build/` staying counted is the deliberate half of the packaging rule, not a gap, since exempting them everywhere would let a `producesArtifacts` stage pass having built nothing; and the tier-1b candidate-ordering fix is unobservable by construction, so its test pins the last-block rule instead and says plainly that no test can guard the reordering.

## State at the end of the session

`main` is green: 3,953 tests pass, 0 fail, `tsc --noEmit` clean, `bun run lint` clean, `cargo check` clean on the desktop crate. Nothing is left uncommitted. `.tmp-wave/` in the repo root is untracked and predates the session.
