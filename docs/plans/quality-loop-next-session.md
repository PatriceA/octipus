# Quality loop — open points for the next session

Handoff written 2026-08-08. `main` is at `2bcd7985`, clean, 3945 tests pass,
typecheck and biome clean. Background: `docs/plans/quality-loop-status.md` is the
long-form record of how each gate came to exist and what it was measured against
— read it only if you need the *why*; everything you need to start is here.

## Where things actually stand

A clean seven-stage `Full Development Cycle` runs end to end and every stage does
its own job. Verified 2026-08-07 building `ipv4.py` + suite:

| stage | commands | files changed | |
|---|---|---|---|
| Implementation | 11 | 8 | produced + committed |
| Testing | 17 | wrote and committed its suite | |
| Code Review | 15 | **0** | read-only held |
| QA Validation | 17 / 23 / 16 | **0** | 3 audit rejections → human escalation |

Independently checked, not believed: `python3 test_ipv4.py` → 20/20 groups pass,
committed as `2e549db` in the workspace repo, `git status` clean.

The scoreboard (`bun run scripts/quality-score.ts`):

| axis | value | target | n | |
|---|---|---|---|---|
| deliveredPct | 86% | ≥ 95% | 81 | fail |
| lagP95Seconds | 0s | ≤ 10s | 34 | pass |
| paidTokensPerRun | 203,711 | ≤ 60,000 | 151 | **fail — worst axis** |
| autonomyPct | 100% | ≥ 90% | 232 | pass |

`bun run scripts/run-health.ts --days 7` also reports **rubberStampRate 60%**
(6 of 10 passing audit verdicts rejected).

## The open points, in the order I'd take them

### 1. The QA stage cannot reliably emit its verdict — blocks everything else

**Symptom.** The `qa_validation` stage writes a good prose report and omits the
required ```json verdict block. On the 2026-08-07 run it did so **three times in
a row**, so all three retries were spent on formatting and the substance was
never re-judged. The pipeline then escalated to a human — correct behaviour, but
the budget went to the wrong thing.

This is now the dominant term in `rubberStampRate`: most rejections read
"produced no machine-readable verdict", not "rubber-stamped".

**Where.** `QA_VERDICT_JSON_INSTRUCTION` in `src/core/orchestrator/pipeline-manager.ts`
(appended to a `qa_validation` stage's input); `parseQAResult` is the reader,
with a prose fallback tier.

**The fix belongs in the contract, not the gate.** Ideas worth trying, cheapest
first: put the JSON block requirement at the *top* of the stage input rather than
appended after a long prompt; shrink the required object (the current five fields
including `whatIDidNotCheck` is a lot to remember after a 3000-word report); or
make the retry prompt lead with a filled-in example rather than a description.

**Do not** solve it by widening `parseQAResult`'s prose tier — a verdict that has
to be guessed at is the thing the gate exists to reject.

### 2. `paidTokensPerRun` is 3.4× target, and the fix already exists unused

**Verified 2026-08-08:** every stage of the ipv4 run was on a paid model
(`deepseek-v4-flash`, plus `claude-sonnet-4-6` for research). Not one local
token.

The planner→executor split — the machinery built specifically to move this
number — **lives only in `src/core/swarm/spawner.ts` and only fires for
`spawn_child`**. `src/core/orchestrator/worker-spawner.ts`, the path every
pipeline stage takes, contains no `hasPlan` and no `executorModel` reference at
all. Pipeline stages cannot route to the cheap lane, ever.

So the obvious move is to give a pipeline stage the same option: a stage whose
work is mechanical (the plan is the approved architecture document, after all)
binds to the lane's `executorModel`. Measure with `bun run scripts/executor-split.ts`.

Read the "planner→executor" verdict in `quality-loop-status.md` first — the A/B
found the saving real (314k paid → 0) but costing **6.6× wall clock**, and on one
task the cheap arm gave up where the expensive one persisted. Latency and
correctness both need watching, which is why this is a measured experiment and
not a config flip.

### 3. `deliveredPct` 86% → ≥95%

81 samples, comfortably measured now. The remaining failures have not been read
one by one — do that before assuming they are stale. Query:

```sql
SELECT stage, detail FROM verification_evidence
 WHERE passed = false AND created_at > now() - interval '30 days'
 ORDER BY created_at DESC;
```

At least one known-legitimate failure is in there — see #4.

### 4. A re-run over already-finished work fails the evidence gate

Implementation was pointed at `slugify.py`, found it already complete and
correct, changed nothing, and the gate failed it for "changed 0 files". Correct
by the rule as written; wrong in spirit.

**Deliberately not fixed.** Relaxing "declared artifacts but changed nothing" is
exactly how the original failure got in (a seven-stage run reporting green over
an empty workspace). Any fix has to distinguish "did nothing because there was
nothing to do, and *verified* that" from "did nothing" — which is a real design
question, not a patch.

### 5. Preset content changes never reach an existing install

`seedPresetTemplates` never overwrites an existing preset, so user edits survive
— but so do stale prompts. Only the *gating flags* are backfilled
(`planProducesArtifactsBackfill`). Every prompt/`toolIds` change I made this
session needed a throwaway script to push into the stored row, and a real user
would simply never receive it.

**Owner decision:** should presets the user has not customised be refreshed from
the shipped definitions on boot? That needs a way to tell "untouched" from
"edited" (a shipped-content hash on the row would do it). Until then, every
preset improvement ships dead.

### 6. Smaller, verified, unowned

- **Shell cwd ≠ workspace root.** The shell tool ran with
  `cwd: /home/patrice/.octipus/workspace` while the filesystem sandbox root is
  `.../workspace/users/<uid>/workspaces/default/files`. Agents cope by using
  absolute paths, but a bare `python3 test_x.py` from shell will not find the
  file. Never investigated.
- **`toolConfig` provider error** — unchanged from the earlier session, still
  unchased.
- **`TPG_API_KEY` is `scope=user`** while the models referencing it are global;
  this is the single remaining e2e failure (141/142) and is an owner decision
  because it is a secret.
- **Dependabot #303** still open.
- **Workspace clutter.** My test runs left `dice/stats/vectors/roman/intervals/
  sizefmt/slugify/duration/ipv4` modules, several `REQUIREMENTS_AND_ARCHITECTURE_*.md`
  files and a stray `_probe_tmp.py` in the user workspace. Harmless, but it makes
  Implementation stages explore more than they need to — one run truncated partly
  because of it. Clear it before benchmarking anything.

## The bug class to watch for — it has bitten four times

A stage **declaration** dropped between where it is written and where it is read.
`stepConfigToStageTemplate` and `buildStagesFromTemplate` both enumerate fields,
so anything not explicitly listed is silently discarded and the stage runs
ungated while looking configured. It happened to `producesArtifacts`,
`stageType`, `runsCommands` and `toolIds`.

**Adding a new stage declaration means touching all six:**

1. `PipelineStepConfig` in `src/db/schema/pipeline-templates.ts`
2. `StageTemplate` + `stepConfigToStageTemplate` in `templates.ts`
3. `buildStagesFromTemplate` in `templates.ts`
4. `stageEvidenceFailure` / `assertStageEvidence` in `pipeline-manager.ts`
5. The seed presets in `src/db/seed-presets.ts`
6. `planProducesArtifactsBackfill` — or existing installs never get it

There is a round-trip test in `templates.test.ts` that fails if 2 or 3 are
missed. It does not cover 6; a declaration that only reaches new installs is the
next variant of this bug.

## Two gate false positives worth remembering

Both cost a wasted run, and both are the same mistake: punishing a stage for
doing its job.

- **`__pycache__` tripped `readOnly`.** Running the suite is what a read-only
  reviewer is *for*; Python's bytecode is not an edit. Fixed by pruning tool
  caches and bytecode from the snapshot — but **not** `dist`/`build`, which a
  stage may legitimately be asked to produce.
- **A truncated turn was accepted as a report.** 95 characters ending
  mid-sentence became a Testing stage's account of a test run. `wasTruncated()`
  now refuses that, for pipeline stages only — chat still shows the user a
  fragment they can see is cut off.

## How to run one yourself

```bash
bun run src/index.ts                     # backend must be restarted after any change
curl -s -X POST -H "Authorization: Bearer $(cat ~/.octipus/mcp-token)" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Run a Full Development Cycle pipeline (create_pipeline, type: Full Development Cycle) for: <task>","channel":"api"}' \
  http://localhost:3005/api/chat
```

`Requirements & Architecture` requires approval — poll
`GET /api/chat/approvals/pending` and POST the `requestId` to
`/api/chat/approve`. Then read the gates, and **check the claims against the
filesystem** rather than the stage reports:

```sql
SELECT kind, passed, stage, detail->>'commandsRun', detail->>'filesTouched',
       detail->>'filesChanged'
  FROM verification_evidence
 WHERE pipeline_id = (SELECT id FROM pipelines ORDER BY created_at DESC LIMIT 1)
 ORDER BY created_at;
```

Two practical notes. Point each run at a **new module name** — a re-run over
finished work fails the gate (#4). And the install has a **10M tokens/day**
safety cap that resets at 00:00 UTC; one full cycle costs roughly 3–4M, so two
runs a day is the ceiling before it bites. It reports itself honestly now if you
hit it.
