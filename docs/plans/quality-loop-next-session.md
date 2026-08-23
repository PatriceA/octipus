# Quality loop — open points for the next session

**Superseded as the entry point, 2026-08-23.** Start from *Where this stands* in
[rebuild-execution-plan.md](rebuild-execution-plan.md), which is the current
record of what is done and what is next. This document is still the best account
of how the quality gates came to exist and which of its own points were closed —
read it for that, not for what to do next.

Handoff rewritten 2026-08-08 (evening) after working the previous handoff's six
points end to end and running three full seven-stage pipelines against them.
Background: `docs/plans/quality-loop-status.md` is the long-form record of how
each gate came to exist — read it only if you need the *why*.

## What changed this session

Every open point from the previous handoff was taken up. Five are closed, one is
still deliberately unfixed, and the runs surfaced two new defects that were
worth more than most of the original list.

| # | Point | Outcome |
|---|---|---|
| 1 | QA stage cannot emit its verdict | **Fixed.** Contract stated up front, spec repeated after. |
| 2 | `paidTokensPerRun` 3.4× target | **Mechanism delivered and measured.** Pipeline stages can now reach the cheap lane. |
| 3 | `deliveredPct` 86% | **Root-caused.** The failures were not stale; one was a false failure with a real cause (see #6). |
| 4 | Re-run over finished work fails the gate | Still deliberately unfixed — it is a design question, not a patch. |
| 5 | Preset content never reaches an install | **Fixed.** Shipped-content hash. |
| 6 | Smaller, unowned | Shell cwd **fixed in three places**; `toolConfig` **root-caused and fixed**; Dependabot closed; clutter cleared; `TPG_API_KEY` still yours. |

### 1. The QA verdict contract — fixed

`QA_VERDICT_JSON_LEAD` now states the requirement *before* the stage prompt and
`QA_VERDICT_JSON_INSTRUCTION` specifies it after, both through one
`withQaVerdictContract()` chokepoint covering the initial pass, the
implementation retry and the auditor-only re-run. Position was the whole fix:
the instruction used to be appended after a ~3000-word prompt.

The example is written with placeholders (`<true|false>`) rather than real
values, so an echoed contract still cannot be misread as a verdict —
`parseQAResult` scans every fence for one that parses with a boolean `passed`.
`qa-verdict-instruction.test.ts` asserts the whole wrapper stays echo-inert.

**Measured on the 2026-08-08 CLI run:** the QA stage reached the structured
`json` tier on its first attempt (`source: 'json'` in `verification_evidence`),
and the one audit rejection it drew was *substantive* — "passed without
addressing 1 audited stage(s): Implementation" — not "produced no
machine-readable verdict". The re-run then passed. That is exactly the shape the
previous handoff asked for: retries spent on substance, not formatting.

### 2. planner→executor for pipeline stages — delivered, and the binding matters

New `mechanical` declaration on `PipelineStepConfig`: a stage that EXECUTES an
already-approved plan binds to its lane's `executorModel` instead of the lane
primary. Declared on `Implementation` and `Testing` (and `Implement Fix` in the
Bug Fix recipe); deliberately NOT on the judgment stages, because a cheap
auditor is how a rubber stamp gets in.

All model resolution — first pass, implementation retry, auditor re-run — now
goes through one `resolveStageModel()`, so a retry can never silently land on a
different model than the attempt it repeats. Precedence: explicit per-stage
`model` → `mechanical` lane executor → topic primary.

**This is the part to read before changing anything.** The mechanism works; the
executor you bind to it decides whether the pipeline does.

Measured with `agents.executorModel = ornith:35b` (local, 30k context, 890M iGPU):

| | |
|---|---|
| Implementation | ran on ornith, **0 paid tokens**, ~19 min, working code |
| per-turn latency | 11s → 42s early, **4m37s** by turn 5 as context grew |
| deliverable | correct on happy paths; `^1.2` partial range crashed; 9-assertion suite |
| Testing | **failed** — truncated mid-turn, context chain overflowed 30k |

The run died at 47 minutes. The `wasTruncated()` guard correctly refused a
325-char fragment as a test report, so the failure was reported honestly rather
than passed off as a green stage — the gate did its job.

**Owner decision taken 2026-08-08:** repoint the executor lanes to a CLI model.
`agents` and `background` are now `cli/vibe`; the stale legacy `coding` row was
cleared (it canonicalizes to `agents` and only invited confusion). CLI providers
are in `quality-score.ts`'s `FREE_PROVIDERS`, so `paidTokensPerRun` still drops,
but with a real context window and none of the iGPU latency.

The local lane is not wrong in principle — it is wrong for *late* pipeline
stages, which carry the whole handoff chain. A 30k-context model cannot hold a
seven-stage chain, and no amount of gate tuning changes that.

### 3. `deliveredPct` — the failures were read, not assumed

11 failures in 30 days: 4 "no machine-readable verdict" (#1 targets them
directly), 3 genuine rubber stamps (the gate working), 3 legitimate
`producesArtifacts` failures — and **one false failure worth chasing**. An
Implementation stage on 2026-08-07 made 27 tool calls, ran 13 commands, called
`git__commit`, and the gate recorded `filesChanged: 0, filesTouched: 0`. Its
cause is #6's first bullet.

### 4. A re-run over already-finished work — still not fixed

Unchanged from the previous handoff, and deliberately so. Relaxing "declared
artifacts but changed nothing" is how the original failure got in. Any fix has
to distinguish "did nothing because there was nothing to do, and *verified*
that" from "did nothing". That is a design question and it should be answered
before it is coded.

### 5. Preset content now reaches an existing install

`pipeline_templates.shipped_hash` (migration `0084_wise_stepford_cuckoos`) holds
a hash of the steps the install was last shipped, so `seedPresetTemplates` can
tell an untouched preset from an edited one. Four outcomes, all pure and tested
in `preset-reconcile.test.ts`:

- **untouched** (hash matches stored steps) → refresh wholesale
- **adoptable** (no hash, content already equals shipped) → record the hash, so
  an install seeded before the column existed stops being frozen
- **edited** → content untouched, only missing gating flags backfilled
- **steady state** → no write

A null hash is read as EDITED. Silently discarding someone's pipeline is worse
than a stale prompt, so a row we cannot *prove* is untouched is never
overwritten.

Verified live: the new `mechanical` flag reached this install's already-seeded
preset on the next boot.

### 6. The smaller items

- **Shell cwd ≠ workspace root — fixed, in THREE places.** The shell tool
  defaulted to the flat `config.workspace.rootPath`, two levels above the
  `<root>/users/<uid>/workspaces/default/files` the filesystem sandbox enforces.
  So `shell__run` started somewhere `filesystem__*` was not, a bare
  `python3 test_x.py` could not find the file the agent had just written, and a
  heredoc landed outside the user's workspace where the evidence gate's snapshot
  does not look — which is the false failure in #3. `cli-agent-worker.ts` had the
  identical bug and would have broken every CLI stage. Both now go through
  `WorkspaceFS.forAgent` / `forSession`, the shared resolvers whose own doc
  comments say they mirror the code that had drifted from them.
- **`toolConfig` provider error — root-caused and fixed.** A turn with tools
  DISABLED (after a `final` tool, or an exhausted budget) sent
  `tools: undefined` while the history still carried tool_use/tool_result
  blocks. Anthropic-family providers reject that outright: *"The toolConfig
  field must be defined when using toolUse and toolResult content blocks."* That
  is what killed a research child on 2026-08-02 — and the spawner's retry then
  answered from model recall having made no searches at all. The tools are now
  declared with `toolChoice: 'none'`, the supported way to say "no more tool
  calls" while keeping the history valid.
- **Dependabot #303** — closed already, and no open Dependabot PRs remain.
- **Workspace clutter** — the nine finished modules and their
  `REQUIREMENTS_AND_ARCHITECTURE_*.md` documents are archived to
  `~/.octipus/workspace-archive-2026-08-08/`, committed, tree clean.
- **`TPG_API_KEY` is still `scope=user`.** Unchanged and still yours: writing a
  system-scope secret is an owner action.

## New this session: two defects the runs found

### A. `readOnly` was unreachable for exactly the workers that need it

`stageEvidenceFailure` opened with `if (counters === null) return null`, so the
`readOnly` rule — documented three lines below as "judged on the SNAPSHOT
alone" — could never fire for a worker that keeps no tally. That is **every CLI
worker**. The one class of worker octipus cannot count was also the one class it
never gated.

Measured on the CLI run: `QA Validation` is declared `readOnly`, the snapshot
recorded `filesTouched: 2`, the stage left a `test_bug.py` probe beside the
product and handed the deliverable back modified and uncommitted — and the gate
passed it. This is the same failure `readOnly` was written for on 2026-08-04,
walking straight back in through the counter-less door.

Fixed: the snapshot-only rule is now evaluated before the counters bail-out, and
`assertStageEvidence`'s `!measured` early return is guarded on `!failure` so a
snapshot-decidable failure still throws. The counter-only rules
(`runsCommands`, `producesArtifacts`) still pass ungated without counters —
failing work that actually succeeded remains the worse error.

**Generalise this.** Every rule should be checked against the *weakest* worker
that can reach it, not the best-instrumented one. Ask of each new gate: what
does it do when the worker reports nothing?

### B. ~450 lines of dead duplicate pipeline code, deleted

`createFromTemplate` and its private `runStages` had **no caller anywhere in the
repo** — a second, drifting copy of the entire stage run loop. It was the main
breeding ground for the bug class below: two loops to keep in sync, and the
dead one silently diverging. Gone.

## The bug class to watch for — it has bitten four times

A stage **declaration** dropped between where it is written and where it is
read. `stepConfigToStageTemplate` and `buildStagesFromTemplate` both enumerate
fields, so anything not listed is silently discarded and the stage runs ungated
while looking configured. It happened to `producesArtifacts`, `stageType`,
`runsCommands` and `toolIds`.

**Adding a stage declaration still means touching all six:**

1. `PipelineStepConfig` in `src/db/schema/pipeline-templates.ts`
2. `StageTemplate` + `stepConfigToStageTemplate` in `templates.ts`
3. `buildStagesFromTemplate` in `templates.ts`
4. `stageEvidenceFailure` / `assertStageEvidence` in `pipeline-manager.ts`
5. The seed presets in `src/db/seed-presets.ts`
6. `planProducesArtifactsBackfill` — or existing installs never get it

**The guards no longer enumerate.** The previous handoff noted that the
round-trip test itself listed fields, so a new flag went missing from the mapper
*and* from the test meant to catch that. Both guards are now table-driven:

- `templates.test.ts` round-trips one fully-populated step key by key through
  both mappers (covers 2 and 3)
- `pipeline-evidence-gate.test.ts` has a `describe.each` over every boolean
  declaration (covers 6 — the touch point that previously had no test, named
  last time as "the next variant of this bug")

Adding a flag is now one line in each list rather than a new test.

## Two gate false positives worth remembering

Unchanged, and both are the same mistake — punishing a stage for doing its job:
`__pycache__` tripping `readOnly` (fixed by pruning tool caches from the
snapshot, but **not** `dist`/`build`), and a truncated turn accepted as a report
(`wasTruncated()` now refuses it for pipeline stages; it earned its keep this
session by catching the ornith Testing failure).

## How to run one yourself

```bash
bun run src/index.ts                     # restart after any change
curl -s -X POST -H "Authorization: Bearer $(cat ~/.octipus/mcp-token)" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Run a Full Development Cycle pipeline (create_pipeline, type: Full Development Cycle) for: <task>","channel":"api"}' \
  http://localhost:3005/api/chat
```

`Requirements & Architecture` needs approval — poll
`GET /api/chat/approvals/pending` and POST the `requestId` to
`/api/chat/approve`. The response shape is `{"approvals":[{"requestId":...}]}`.

There is also a **`Full Development Cycle (CLI)`** template (seeded by
`scripts/seed-cli-pipeline.ts`): the same seven stages with each pinned to a CLI
agent by size of job — `cli/claude` for Requirements & Architecture and
Implementation, `cli/gemini` (the `agy` binary) for Research, Testing, Code
Review and QA, `cli/codex` for Summary. It completed all seven stages on
2026-08-08 and produced a correct `cron_expr.py` — leap-year `30 2 29 2 *`
resolving to 2028-02-29, all six malformed expressions rejected with clear
errors — with the Testing stage finding and fixing a real year-wrapping bug.

Then **check the claims against the filesystem**, never the stage reports:

```sql
SELECT kind, passed, stage, detail->>'commandsRun', detail->>'filesTouched',
       detail->>'filesChanged', detail->>'source'
  FROM verification_evidence
 WHERE pipeline_id = (SELECT id FROM pipelines ORDER BY created_at DESC LIMIT 1)
 ORDER BY created_at;
```

Point each run at a **new module name** (#4), and remember the **10M
tokens/day** cap resets at 00:00 UTC.

## Where to pick up

1. **Re-measure the board.** `bun run scripts/quality-score.ts` and
   `bun run scripts/run-health.ts --days 7`. The samples behind
   `paidTokensPerRun` and `rubberStampRate` predate every fix here, so both
   numbers are still describing the old system. Give it a few runs on the new
   executor binding before trusting either.
2. **Watch the CLI executor.** `cli/vibe` is now the `agents` executor. It is
   free by the metric's definition but spends CLI quota, and `quota-tracker`
   has the last word. If it throttles, the honest options are a different CLI
   agent or accepting paid tokens on the mechanical stages.
3. **Answer #4** — the design question, before coding anything.
4. **`TPG_API_KEY`** — yours.
5. The websearch stack is still down (SearXNG's engines blocked, DuckDuckGo
   CAPTCHA). Research stages cope via `fetch_page`, but every run pays for it in
   wasted searches. Unrelated to the quality loop; worth its own look.
