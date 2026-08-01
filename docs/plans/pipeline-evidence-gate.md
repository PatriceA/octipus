# Pipelines must not mark a stage done on the child's word alone

## The failure

Measured 2026-08-01, session `7bbc1ead-9435-43a5-b19a-1a0e33b8554a`.

Prompt: *"Have a look at the resume.md in my workspace, implement all open points
end2end, do code review in between phases"*, against a `resume.md` naming three
concrete deliverables (`calc/percent.ts`, `calc/percent.test.ts`,
`calc/README.md`).

The orchestrator chose `create_pipeline` and built the 7-stage **Full
Development Cycle**: Research & Discovery → Requirements & Architecture →
Implementation → Testing → Code Review → QA Validation → Summary & Handoff.
Every approval was granted. **All 7 stages reached `status='completed'` and the
pipeline reached `completed`.**

It wrote **zero files**. No `calc/`, no `percent.ts`, no test, no README —
`find` over the workspace for anything newer than the run comes back empty.
`verification_evidence` gained **0 rows**, despite Testing, Code Review *and* QA
Validation stages all reporting success.

So: a full green development cycle over an empty workspace. This is the concrete
form of "half done, low quality stuff" — it isn't that the output is poor, it's
that there is no output and nothing says so.

## Why it isn't caught today

The "gate deliverables on evidence, not on what the child says" work
(PRs #295 / #298) landed on the **swarm** path only.

Reference counts for receipt/scorer/evidence symbols:

| file | refs |
|---|---|
| `src/core/swarm/spawner.ts` | 18 |
| `src/core/swarm/swarm-tool.ts` | 14 |
| `src/core/orchestrator/pipeline-manager.ts` | **3** |

…and all 3 in `pipeline-manager.ts` are *record-only* — `recordQaVerdict` →
`verificationEvidenceRepository`, best-effort, warns on failure (~L997-1018).
Nothing there blocks a stage from completing when it produced no artifact.

`create_pipeline` is exactly what the orchestrator picks for "implement this
end-to-end", so **the one path a user hits for real implementation work is the
one without the gate.**

## What already exists (do NOT rebuild)

Most of the machinery is there; the pipeline just never reads it.

- `ToolExecutor` maintains `SideEffectCounters` and exposes
  `getSideEffectCounters()` — `src/core/tool-executor.ts:151,180`.
- `AgentWorker.getSideEffectCounters()` delegates to it —
  `src/core/agent-worker.ts:331`. **LLM-backed workers already carry the data.**
- `buildReceipt()` — `src/core/swarm/receipt.ts:138`; only caller today is
  `src/core/swarm/spawner.ts:934`.
- `runScorers()` — `src/core/swarm/scorers.ts:121`; the relevant scorer kind is
  `{ kind: 'side_effect', minFilesChanged: 1 }`.
- `deriveCodeDiffScorer(shape)` — `scorers.ts:318`. Deliberately narrow: it
  fires only when the brief declares `expectedOutput.shape === 'code-diff'`,
  *"so it cannot produce a false `contract_failed` for a child that was never
  supposed to write anything."* Keep that principle — see Risk.

The gap in one line: **`pipeline-manager.ts` and `worker-spawner.ts` contain
zero references to `SideEffectCounters` / `filesChanged` / `buildReceipt` /
`runScorers` / `sideEffect`.**

## Phase A — pipelines read the counters that already exist

**Files:** `src/core/orchestrator/pipeline-manager.ts`,
`src/core/orchestrator/worker-spawner.ts`

1. Return the stage worker's `getSideEffectCounters()` alongside its result from
   `spawnWorker` (`worker-spawner.ts`), so the caller can see what the stage
   actually did.
2. In `pipeline-manager.ts`, gate stage completion: a stage whose role is
   hands-on and whose counters show `filesChanged === 0` must not be marked
   `completed`. Mark it failed/needs-retry and surface the reason — the retry
   paths already exist (`spawnWorker` retry at ~L375, QA retry at ~L422).
3. Persist the counters to `verification_evidence` so a run is auditable after
   the fact, matching what `recordQaVerdict` does today.

**Chokepoint, not per-site.** `status: 'completed'` is written at roughly
L274, L393, L440, L519, L725, L815, L846, L893. Gate in one helper both the
sequential and the retry paths route through, or the next stage type added will
silently skip the gate.

**Which roles are hands-on** — do not guess from the stage name. Derive it the
way the swarm path does, from the declared expected output. Stage templates
already carry a role (`coding`, `qa`, `research`, `review`, …); the honest rule
is that a stage must declare it produces artifacts, and only declared stages are
gated. `Research & Discovery` legitimately writes nothing and must stay green.

**Check:** the exact `resume.md` scenario. Implementation stage writes nothing ⇒
pipeline does NOT report completed. A research-only pipeline still completes.

## Phase B — CLI-backed stages have no counters at all

This is why Phase A alone is not enough here: the `agents` lane primary is
`cli/claude`, so the Implementation stage ran on a **`CLIAgentWorker`**, which
does not override `getSideEffectCounters()` and therefore inherits the
`agent-base.ts:146` default returning `null`. The CLI writes files in its own
process; octipus never sees those writes through its own `ToolExecutor`.

This is a hole in the **swarm** path too, not just pipelines: a `cli/claude`
child declared `shape: 'code-diff'` has no counters for `runScorers` to score,
so its `side_effect` scorer cannot fail it either.

The raw material is already parsed. `src/core/cli-adapters.ts:605-608` documents
that the stream parser already emits:

```
cli_tool_use    { id, toolName, title?, args }
cli_tool_result { id, toolName, args?, output, exitCode?, isError }
```

using the CLI's own stable ids (Claude `tool_use.id`, codex `item.id`). There is
also existing path-extraction for shell edits (`cli-adapters.ts:270-271`,
returning `{ action: 'edit', path }`).

So Phase B is a **mapping job, not instrumentation from scratch**: count
file-mutating `cli_tool_use` events (Claude `Write` / `Edit` / `NotebookEdit`,
plus the already-detected `sed -i` shell edits) into a `SideEffectCounters`, and
override `getSideEffectCounters()` on `CLIAgentWorker` to return it.

**Check:** a `cli/claude` child that writes one file reports `filesChanged >= 1`;
one that only reads reports 0.

## Risk

The failure mode to avoid is the opposite one: failing work that actually
succeeded. `deriveCodeDiffScorer`'s comment is the standing guidance —

> *a wrong guess here is worse than no gate, because it fails work that actually
> succeeded*

So gate on a **declared** expectation, never on inferred intent from the task
wording. A stage that was never meant to write files must stay green, and a
missing-counters case (`null`, e.g. a CLI worker before Phase B lands) must be
treated as "unknown", not as "zero" — otherwise Phase A alone turns every
CLI-backed stage red.

## Order

Phase A is independently useful for LLM-backed stages and is the smaller change.
Phase B is what makes it bite on the default `agents`-lane config. Landing A
without B leaves CLI stages ungated but must not make them *falsely* fail — see
Risk.

## Related

- `docs/plans/quality-enforcement.md` — what the gate does on the swarm path.
- Memory: `project_octipus_pipeline_no_evidence_gate`,
  `project_octipus_resume_md_scenario` (same run; the long "hang" in it was a
  correct `awaiting_approval` wait, **not** a bug — do not "fix" the missing
  wall race on `final` tools, it is load-bearing).
