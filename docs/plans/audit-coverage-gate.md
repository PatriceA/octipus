# The auditor must name what it audited

Status: proposed, 2026-08-03. Ports three enforcement rules from
[jcode](https://github.com/1jehuang/jcode)'s `crates/jcode-plan/src/dag/ops.rs`
into the pipeline path.

## Why this, now

`docs/plans/quality-loop-status.md` states the remaining gap precisely:

> octipus can now be *caught* producing nothing, which is a real improvement
> over silently claiming success. It cannot yet be shown to produce *good*
> work, because nothing scores quality.

The evidence gate (`131ff1bc`) gates the **producer**: a stage that declares
`producesArtifacts` and changes zero files fails. Nothing gates the
**auditor**. A QA Validation or Code Review stage passes today on:

```json
{ "passed": true, "issues": [], "feedback": "All stages look good." }
```

`parseQAResult` accepts that, `recordQaEvidence` records `passed: true`, and
the pipeline goes green. The verdict never names a single thing it checked.
That is a rubber stamp with a database row behind it.

jcode enforces the opposite as an engine rule, not a prompt request: an audit
that cannot name its scope cannot pass. Three rules, all pure functions over an
already-parsed verdict, all portable in a day.

## What exists (do NOT rebuild)

| thing | location |
|---|---|
| producer-side gate | `stageEvidenceFailure()` — `src/core/orchestrator/pipeline-manager.ts:85` |
| gate chokepoint | `assertStageEvidence()` — same file, `:1106` |
| verdict parsing (3 tiers: JSON → inline → prose) | `parseQAResult()` — `:1178` |
| confidence parsing | `normalizeConfidence()` / `parseConfidence()` — `:16`, `:20` |
| evidence ledger + `confidence` column | `src/db/schema/verification-evidence.ts` |
| QA retry path | `runStages()` retry at ~`:422` |
| existing gate test | `src/core/orchestrator/pipeline-evidence-gate.test.ts` |

`QAValidationResult` **already carries `confidence`** and already gets
persisted. Half of Phase 2 is wiring, not new structure.

## Phase 1 — Coverage debt: a pass must address every audited stage

Port of `validate_gate_pass` → `DagError::UncoveredSiblings`
(`ops.rs:789-878`). jcode's rule in one line: *enumerated accounting is what
separates an audit from a rubber stamp — "all good, no gaps" cannot pass over
work it never names.*

**New file** `src/core/orchestrator/audit-coverage.ts`, one exported pure
function, so it is unit-testable without a model, a DB, or a pipeline:

```ts
/** Stages a passing verdict failed to address. Empty = the audit is accounted for. */
export function uncoveredStages(verdict: QAValidationResult, scope: string[]): string[]
```

- **Scope** = prior stages in this run that declared `producesArtifacts` and
  reached `completed`. Derived from the run, never from the stage name — same
  discipline as `stageEvidenceFailure`, which gates on the *declared*
  expectation.
- **Addressed** = the stage name appears in `feedback` or in any `issues[]`
  entry. Match normalized (case-folded, punctuation-stripped, whitespace
  collapsed) substring — Octipus stage names are prose (`Code Review`), not
  jcode's slug ids, so jcode's `mentions_node_id` token-boundary matcher
  (`ops.rs:593`) is the wrong shape here. Do not port it verbatim.
- **Only gates a pass.** A `passed: false` verdict is already routing to retry;
  it has nothing to prove.

**No enumeration cap.** jcode relaxes full enumeration above 20 audited nodes
(`GATE_COVERAGE_ENUMERATION_CAP`). Pipeline templates top out at 7 stages, so
the cap would be dead code. Skip it; add it if a template ever exceeds ~15.

**Wire-in:** the same chokepoint discipline the evidence-gate plan established.
One helper both the sequential and retry paths route through — `status:
'completed'` is written at ~8 sites and a per-site gate will be skipped by the
next stage type someone adds.

**Failure is a retry with feedback, not a hard fail.** Feed the uncovered stage
names back into the retry prompt: *"your verdict did not address:
Implementation, Testing."* jcode does the same — the error carries the
uncovered ids. A model told exactly what is missing fixes it on attempt two;
a hard fail just loses the run.

## Phase 2 — Thin-verdict rejection

Port of `validate_artifact` → `DagError::ThinArtifact` (`ops.rs:703-747`).

Extend `QAValidationResult` with `whatIDidNotCheck: string[]`. A `passed: true`
verdict is rejected when:

1. `whatIDidNotCheck` is empty, **or**
2. `confidence` is absent or unparseable.

jcode's note on (1) is the reason it works: *forcing an agent to list what it
did not explore surfaces unexplored crannies.* An explicit
`["nothing — the diff is three lines"]` is a legal answer; silence is not.
On (2), jcode rejects unparseable confidence the same way it rejects thin
findings, because every downstream rule keys off the rung — and Octipus's
`confidence` column is nullable today, so nothing forces one.

**The real risk lives here, not in Phase 1.** The QA/review stage prompt must
ask for `whatIDidNotCheck` in the same breath as `passed`, or *every* verdict
fails on the first run. Prompt change and gate must land in the same commit.
Follow jcode's phrasing on confidence — *"honest 'low' is welcome: it routes
follow-up work instead of penalizing you"* — or the model learns to always
answer `high`.

## Phase 3 — Confidence debt

Port of `DagError::UnaddressedLowConfidence` (`ops.rs:822-838`). Reuses
Phase 1's matcher, so it is nearly free once that lands.

A completed stage whose own verdict self-reported `confidence: 'low'` must be
addressed **by name** in the auditor's `feedback` or `issues` before the
auditor may pass. Carry over jcode's one sharp detail:

> The gate's own `what_i_did_not_check` deliberately does NOT count: declaring
> "I did not check X" is the opposite of addressing X.

So Phase 3 matches against `feedback`/`issues` only, never against
`whatIDidNotCheck`.

## Explicitly not in this plan

- **DAG rewrite, ownership trees, worktree managers, subtree broadcast, the
  1000-member cap.** jcode's swarm is a general graph engine; Octipus pipelines
  are linear templates. The gate rules transfer; the substrate does not.
- **Growth accounting** (`seeded_count`/`grown_count`). Meaningful when a plan
  grows itself; Octipus pipeline templates are fixed, so the number would
  always read "0 grown".
- **jcode's `agentgrep` prior-observation replay** (`tool/agentgrep/context.rs`
  — builds a known-files/regions set from the transcript, invalidated by
  compaction cutoff and file mtime, so search results collapse what the agent
  already read). The biggest *efficiency* idea in that repo and worth its own
  plan. Not first, because the gap this repo has measured is quality, not
  context cost.
- **Swarm-path parity.** The same coverage rule belongs on `runScorers()` as a
  `kind: 'audit_coverage'` scorer. Do it after the pipeline version has caught
  something real, not before.

## Testing

The gates are pure functions over an already-parsed verdict, so **the bulk of
this needs no model, no DB, and no pipeline run.** That is the point of
extracting `uncoveredStages` rather than inlining the check.

### 1. Unit — `src/core/orchestrator/audit-coverage.test.ts`

Table-driven, mirroring `dag/tests.rs`. The negative cases matter more than the
positive ones, because the failure mode to avoid is failing work that
succeeded (`deriveCodeDiffScorer`'s standing guidance).

Must fail:
- `passed: true`, `feedback: "All stages look good"`, scope of 3 → all 3 uncovered.
- `passed: true`, names 2 of 3 stages → 1 uncovered.
- `passed: true`, `whatIDidNotCheck: []` → thin.
- `passed: true`, no `confidence` → thin.
- `passed: true`, ignores a stage that self-reported `low` → confidence debt.
- `passed: true`, mentions the low-confidence stage **only** inside
  `whatIDidNotCheck` → still fails (Phase 3's sharp edge).

Must pass:
- Every scope stage named in `feedback`, `whatIDidNotCheck` non-empty,
  confidence present.
- Stage named in an `issues[]` entry rather than `feedback`.
- Name matched across case and punctuation (`code review` vs `Code Review`).
- **Empty scope** — a research-only pipeline with no artifact stages. Same
  invariant `stageEvidenceFailure` protects: `Research & Discovery`
  legitimately writes nothing and must stay green.
- `passed: false` → never gated, regardless of shape.

### 2. Integration — extend `pipeline-evidence-gate.test.ts`

The existing file covers the producer side. Add the auditor scenario, which is
the inverse of the `resume.md` failure: **producer writes files, auditor
rubber-stamps ⇒ pipeline does not complete.**

- Stage writes 2 files, QA returns `{passed: true, issues: []}` naming nothing
  → stage not `completed`, retry raised, feedback names the uncovered stages.
- Same run, retry returns a verdict naming all scope stages → completes.
- Research-only template runs green end to end (regression guard).

### 3. Measurement — make it a number, not just a test

This is the piece that closes `quality-loop-status.md` Phase 2, and it is why
this plan is worth more than three unit tests.

Record every gate rejection to `verification_evidence` with a new kind
`audit_coverage` (append-only, same as `side_effect`; needs a
`bun run db:generate` migration + journal entry). Then add one dimension to
`scripts/run-health.ts` alongside `deliveryLag`:

```
rubberStampRate = QA passes rejected by the coverage gate / total QA passes
```

That gives a baseline the day it lands and a target to loop against — the
stopping condition the status doc says does not exist. A rate that stays high
means the audit prompts are wrong, not that the gate is wrong; a rate that
falls to zero and stays there means the gate can be relaxed to sampling.

### 4. Eval

One case in `eval/capability-quality.yaml`: a task whose review stage is asked
to validate multi-stage output, asserting the verdict names the stages. Cheap,
and it catches prompt regressions the unit tests cannot see.

### Gate for "done"

`bun run typecheck && bun run lint && bun test`, plus `bun run eval` (AGENT.md:
prompt changes must pass the eval suite — Phase 2 changes a prompt).
Coverage floor is 52.30%; three new pure-function test files move it up, not
down.

## Order

Phase 1 first: largest rubber-stamp surface, no prompt change, therefore no
risk of failing honest work. Phase 2 second and in one commit with its prompt
change. Phase 3 last — it is ~20 lines once Phase 1's matcher exists.

Measurement (Testing §3) lands with Phase 1, not after all three. A gate whose
rejection rate nobody watches is the same unverified claim this plan exists to
stop.

## Related

- `docs/plans/pipeline-evidence-gate.md` — the producer-side gate this builds on.
- `docs/plans/quality-enforcement.md` — the swarm-path gate (`#295`/`#298`).
- `docs/plans/quality-loop-status.md` — the measurable gap this closes.
- jcode `crates/jcode-plan/src/dag/ops.rs` and `docs/SWARM_TASK_GRAPH.md` §6.
