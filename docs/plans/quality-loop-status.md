# The quality loop: what the brief asked, what is done, what is next

Status as of 2026-08-03. Every claim below is either a commit SHA, a command
output, or explicitly marked as unverified. Where something was *not* done, it
says so plainly rather than being folded into a neighbouring item that was.

The 2026-08-02 revision named two gaps and called them "the two the brief made
*measurable*". Both are now measured, and the measurements are below. They did
not all come out favourably, which is the point.

## Where things stand

| | |
|---|---|
| Branch | merged to `main` 2026-08-03 — this work no longer lives on `worktree-quality-loop` |
| Backend tests | 3657 pass / 0 fail / 175 skip (`bun test src scripts`) |
| Typecheck | clean |
| Providers | unchanged; `grok` still holds no topic role, and its account is out of credits |
| Dev DB | migrated through `0083`; `verification_evidence` is no longer empty |

## The audit-coverage gate (merged separately, on `main`)

Three commits landed on `main` while this branch was open — `fdeaf5ab`,
`9bc0df16`, `126b501d`, plan in `docs/plans/audit-coverage-gate.md`. They are a
third gate, distinct from the evidence gate and the outage gate below: a QA or
review PASS is rejected unless it names every stage it audited, states what it
did *not* check with a confidence, and addresses any stage that handed off
unsure. Ported from jcode's `validate_gate_pass` / `validate_artifact` /
`UnaddressedLowConfidence`.

`scripts/run-health.ts` reports its `rubberStampRate` — the share of *passing*
audit verdicts the gate had to reject. Read it as a signal about the review
prompts, not the gate: a high first reading means stages are being asked the
wrong question.

The gate judges whether the *audit* was accountable, never whether the *code*
was good — the same claim ceiling `receipt.ts` states for receipts
(`notCertified: ['correctness', 'security']`). What it buys is narrow and worth
stating exactly: a green pipeline now costs more than a sentence.

### Migration `0082` was a collision, and it hid the enum

Both this branch and `main` generated a migration numbered `0082`
(`0082_shocking_wind_dancer`, the `planned` column, vs `0082_public_mysterio`,
the `audit_coverage` enum value). The merge keeps `main`'s and renumbers this
branch's to `0083_overconfident_ultimatum`, restamped so it sorts *after*
`0082` — drizzle applies by timestamp, not by filename, so a renumber that
kept the old `when` would have been silently skipped on every fresh database.

`0083` is written `ADD COLUMN IF NOT EXISTS` because any database that ran the
branch already has the column. One consequence on this dev database, harmless
but worth knowing: `drizzle.__drizzle_migrations` still holds a row for the
retired `0082_shocking_wind_dancer` hash. Drizzle only ever compares
timestamps, so it is inert.

## The two measurable gaps — now closed

### 1. The planner→executor split: measured, and the answer is "yes, but"

The routing shipped in `#259`–`#262`; nothing had ever measured whether it
*saves*. It now can, three ways:

- `swarm_nodes.planned` (migration `0082`) records whether the parent supplied
  a plan. Without it an executor-model row is indistinguishable from a lane
  that merely happens to be bound to a cheap model. The column defaults to
  `false`, so history cannot be scored retroactively — only runs from here on
  count.
- `scripts/executor-split.ts` scores planned spawns that already happened.
- `scripts/executor-ab.ts` runs the experiment that produces them: the same
  task brief, twice, on the same lane, with and without a plan.

The A/B, run against the live install. Arm A (no plan) routes to the `agents`
lane primary `deepseek-v4-flash` (metered); arm B (planned) routes to the
lane's `executorModel` `ornith:35b` (local, free):

| task | A tokens | A tools | A secs | B tokens | B tools | B secs |
|---|---|---|---|---|---|---|
| read-types | 83,075 | 12 | 22 | 52,923 | 9 | 116 |
| count-migrations | 53,323 | 7 | 14 | 9,626 | **1** | 17 |
| find-script | 177,928 | 24 | 46 | 139,947 | 17 | 405 |
| **total** | **314,326** | 43 | **82** | 202,496 | 27 | **538** |

What that says, against the pass conditions this document set:

- **Paid tokens: 314,326 → 0.** Every executor token was local. The saving on
  the child is real, not a rounding artefact.
- **The executor does real work — on 2 of 3 tasks.** 9 and 17 tool calls clear
  the ≥3 bar comfortably. It is not transcribing a finished answer.
- **1 of 3 is exactly the anti-pattern the brief named.** `count-migrations`
  yielded a single executor tool call. That plan did the thinking; the
  executor ran one command and reported. On that task the split moved cost
  rather than removing it.
- **The saving costs 6.6× wall clock.** 82s → 538s. Nothing in the original
  plan mentioned latency, and it is the largest single effect measured here.
  A user waiting 6.7 minutes instead of 46 seconds may not consider free
  tokens a good trade.
- **On one task the split traded a correct answer for a cheap one.** In
  `read-types`, arm A improvised past a missing path (it fell back to shell,
  found the file, returned the correct union) while arm B concluded the file
  did not exist and stopped. Cheaper, faster to give up, wrong.

Two caveats that keep the numbers honest, both printed by the harness itself:

- The harness authors the plan, so arm B excludes whatever a real parent would
  have spent writing it. **The saving is an upper bound.**
- Child agents run in a sandboxed workspace that does not contain this
  repository, so both arms worked harder than the tasks imply. The comparison
  is still like-for-like — both arms faced the identical sandbox — but the
  absolute token counts are inflated.

**Verdict on the brief's actual question:** the local model is not "just using
a few tokens to run 5 commands" — on two of three tasks it did substantive
tool work. But the failure mode the brief predicted is real and reproducible,
it appeared in one run of three, and the split buys its savings with a large
latency penalty and at least one correctness regression. Phase 5 (semantic
accept) should still not be built on this evidence.

### 2. There is now a baseline, a target, and a stopping condition

`scripts/quality-score.ts` + `scripts/quality-baseline.json`. Four axes, no
rollup — a weighted single score lets a cheap run that delivered nothing
cancel out an expensive run that did.

Measured over the last 30 days (recorded in `quality-baseline.json`):

| axis | value | target | n | status |
|---|---|---|---|---|
| deliveredPct | **n/a** | ≥ 95% | 0 | no data |
| lagP95Seconds | 143s | ≤ 10s | 16 | below the 20-sample floor |
| paidTokensPerRun | 181,128 | ≤ 60,000 | 30 | **fail** |
| autonomyPct | 100% | ≥ 90% | 110 | pass |

Two axes cannot be judged yet, and that is the truthful reading rather than a
defect in the tool:

- **deliveredPct has no data at all.** `verification_evidence` is empty: the
  evidence gate merged (`131ff1bc`) *after* the last recorded runs. The gate
  this whole effort was built around has never once fired on this install. It
  is untested in production, not proven.
- **lagP95** has 16 samples against a floor of 20. The observed 143s is 14×
  the target, so this is very likely a fail once it has the samples — but a
  target met or missed on 16 runs is not a measurement, and the tool says so
  rather than rounding it into a verdict.

`--gate` requires *both* that nothing is below target and that nothing is
unmeasured, so an install with no data exits non-zero instead of printing a
green board over an empty table. That is the same failure this document was
opened to stop.

## Phase 3 — the unrun scenarios

**Trip planning: run — and it found the most serious defect in this document.**
The brief's only non-coding scenario, and the only test of whether octipus is a
general assistant rather than a coding agent.

The output is genuinely good. Routed to the `research` lane
(`claude-sonnet-4-6`), fanned out to two `gemini-flash-lite` subagents, and
produced a usable 3-day Munich→Berchtesgaden itinerary: day-by-day structure,
concrete places, rough drive times, per-stop food, dog-specific constraints
that are actually correct (dogs are not permitted on the Königssee boats), and
— unprompted — a "verify before you go" section flagging exactly the claims
that drift. As a piece of writing it is what the brief hoped for.

**It is also entirely unverified, and the system never said so.** Across every
attempt, the number of successful web searches was zero:

- `websearch` tries SearXNG, then falls back to DuckDuckGo via Playwright.
  SearXNG is up (HTTP 200 on `localhost:8888`) but every upstream engine is
  blocked: `brave: Suspended: too many requests`, `duckduckgo: CAPTCHA`,
  `startpage: Suspended: CAPTCHA`. It returns 0 results with a populated
  `unresponsive_engines`, which the tool correctly treats as infra failure
  rather than "no results" — and then the browser fallback hits the same
  CAPTCHA wall and fails with "No results extracted from DuckDuckGo".
- The research child made 5 web searches. All 5 failed (`toolErrors: 5` in the
  node receipt).
- It then died with a provider error — `The toolConfig field must be defined
  when using toolUse and toolResult content blocks` — and the node was marked
  `tool_error`.
- **The spawner's retry then answered the question with no searches at all,
  and the run was reported `ok`.** The polished itinerary above is the retry's
  output: model recall, presented to the user with no indication that every
  attempt to check a fact had failed.

That last step is the defect. It is the same class as the failure this whole
document exists to stop — a green result over work that did not happen — only
here the cover is better, because the answer is articulate and self-flags
uncertainty in prose while the machinery stays silent about a total tool
outage.

### Fixed: a run that loses every tool can no longer return `ok`

Two changes, both in the swarm spawner, both keyed off the deterministic
receipt rather than anything the model said:

1. **A tool-outage gate on every spawn** (`deriveToolOutageScorer`). If a child
   attempted tools and *none* succeeded, the result is `contract_failed`, not
   `ok`. It reuses the existing `side_effect` scorer, so it inherits the rule
   that a CLI worker exposing no counters is never gated on evidence it cannot
   emit.

   **Delegation does not count as a working tool.** This is the part that
   matters: in the measured run the child's 5 web searches all failed while
   `spawn_child` succeeded, leaving `toolCalls = 1` — a naive "did any tool
   work?" check passes that, and the outage stays hidden behind a meta-call.
   The gate counts only substantive tools, excluding `spawn_child` /
   `collect_children` / `escalate_to_different_expert`.

   It cannot produce a false failure: a child that never touched a tool has
   zero errors and is untouched, and any single successful substantive call is
   enough to pass.

2. **A retry can no longer erase the attempt it replaced.** `runChildWithRetry`
   discarded the failed result once a later attempt succeeded, so the parent
   saw a clean `ok`. The returned result now carries
   `Recovered after N failed attempt(s): …` in its notes, including the failed
   tool-call count. The status is left alone — the recovered answer may be
   perfectly good — but nobody has to infer a clean run any more.

Verified against the original failure, not just unit tests: re-running the
trip-planning scenario with search still broken now yields

    contract_failed · 3 tool calls · every tool call failed (3 error(s),
    0 succeeded) — the deliverable cannot be based on anything the tools
    returned

where the same run previously returned `ok` with a polished itinerary.

### The search outage itself: mostly a stale container, partly bot defense

Measured rather than assumed. The egress IP is a clean residential German
Vodafone address, so this is not datacenter-IP reputation, and the URLs and
parsers are not "wrong pages":

| engine | running instance (2026.3.1, 5 months old) | current image |
|---|---|---|
| google | 0 results | **20, all relevant** |
| bing | 10 **irrelevant** results | 10 **irrelevant** results |
| duckduckgo | CAPTCHA | CAPTCHA |
| brave | rate-limited | rate-limited |
| startpage | CAPTCHA | CAPTCHA |
| mojeek / qwant | access denied | 0 |

Two separate things are going on:

- **The installed SearXNG was five months old and its engine parsers had
  rotted.** Querying the running instance exactly as the tool does
  (`categories=general`, no engine pin) returned **0 results**; the same query
  against a current image returned **38 relevant results**. The outage was a
  container update, not a code bug.
- **Brave and Startpage are genuine bot defense.** They block SearXNG-style
  scraping regardless of IP or version. They fail *loudly*, which is the
  harmless kind — the aggregate works without them.

**Resolved 2026-08-03: the container was updated (→ `2026.8.3`) and search
works.** A correction to the first reading above: DuckDuckGo's block was *not*
pure bot defense — it came back with the update too, so only Brave and
Startpage remain unresponsive. The live engine mix is now `google cse` (20
results) + `duckduckgo` (10), Bing absent, so nothing pollutes the aggregate.

End-to-end re-run of the trip scenario after the update, which is also the
negative control for the new gate:

| | before (broken search) | after update |
|---|---|---|
| search calls | 5, **all failed** | **7 searches + 1 fetch_page, 0 failures** |
| outcome | provider error → retry → `ok`, unsourced | `ok`, sourced |
| with the new gate | `contract_failed` | `ok` — **gate correctly silent** |
| wall clock | 86–129s | 44s |

The gate not firing here is the important half: it fails total outages without
failing healthy runs, and the run is *faster* now because it is not burning
attempts on dead tools.
- **Bing is the dangerous one and must stay off.** On *both* image versions it
  returns ten confident, well-formed, irrelevant results for any input —
  `zzzqqq Berchtesgaden` comes back with furniture shops, and it never returns
  zero. A silently-wrong engine is far worse for an agent than a dead one:
  the loud failures above are what let the outage gate above work at all.
  Anyone "fixing" search by enabling Bing would convert a caught failure into
  an uncaught one.

A `SEARXNG_ENGINES` env allowlist was added so an operator can pin the engines
they trust without editing SearXNG's own config. Unset by default.

Two things about it are worth writing down, because both were wrong on the
first attempt and only measurement caught them:

- **`categories` and `engines` are a UNION, not a filter.** Sending
  `categories=general&engines=bing` runs bing *plus* every other general
  engine — 30 results (20 google cse + 10 bing) where `engines=bing` alone
  returns 10. The allowlist as first shipped kept `categories=general`, so it
  could only ever *add* engines, never restrict to them. It now sends
  `engines` alone when set, and `categories` alone when not.
- **The param takes full engine names, not shortcuts.** `engines=bi` does not
  select bing; it is ignored and the defaults run. The engine that actually
  works here is named `google cse` — with a space — so
  `SEARXNG_ENGINES=google cse` is the correct value, not `goc`.

**Turning an engine off properly** belongs in SearXNG, not here, because it
then applies to everything using the instance. Their `settings.yml` is just
`use_default_settings: true`, so appending

    engines:
      - name: bing
        disabled: true

and restarting is enough — verified on a scratch instance (`/config` then
reports `"enabled": false` for bing and it drops out of default searches).
Note `disabled` means "not in the default set", not "forbidden": an explicit
`engines=bing` request still activates it.

Still open: the `toolConfig` provider error needs chasing in the provider
layer.

One finding was **a bug in the harness, not the product**, recorded because it
is an easy trap: the first attempt granted the child only
`filesystem`/`shell`/`git`, so `websearch` was intersected away and the tree
"researched" a German road trip by grepping the local filesystem and listing
skills. In the logs that looks identical to a product failure. The harness now
grants a superset of what the task's role needs, with a comment saying why.

**Still unrun:** Hermes-style install UX, and "one UI over 3 existing tools,
end2end, with test coverage". Neither is a measurement — both are product work
that needs a person to say what "good" looks like first.

## Phase 4 — deferred items

- **`agent.blocked` now renders.** The backend has emitted it since
  blocked-vs-stuck Phase 1 and the protocol carried it, but no client showed
  it, so a worker waiting on a slow provider still looked exactly like a hung
  one — the entire point of the event. The TUI gateway adapter now renders it
  as `Waiting: <reason> (<duration>)`, with tests including the case where a
  missing reason must produce nothing rather than `Waiting: undefined`.
- **`TPG_API_KEY` is still `scope=user`** while the models referencing it are
  global. Unchanged: it is a secret and an owner decision.
- **Dependabot #303** still open.
- **Planner→executor Phase 5** — still gated, see the verdict above.
- **Legacy `deepseek-chat` / `deepseek-reasoner` LiteLLM aliases** unchanged.

## Two things found along the way that affect every number here

- **Cost in currency is not available.** `cost_log` has 2,134 rows and
  `total_cost` is `0` in every one of them, because only 1 of 20 registered
  models has a price configured. Anything reporting money today would report a
  confident zero. Both new tools therefore price work in *paid-provider
  tokens*, classifying by `model_config.provider` (`ollama`/`cli` are free).
  Configuring per-model prices would upgrade every cost number here.
- **`agent_events` triple-counts tool calls.** One invocation emits up to
  three `action` rows (`tool_call`, `tool_call_complete`, and an untyped batch
  row carrying a `toolCalls` array). Counting every `action` row inflates tool
  calls ~3×, which would have let a single-tool-call executor clear the
  "did real work" bar. Both tools count `data->>'type' IN ('tool_call',
  'cli_tool_use')` — the same predicate the TUI adapter already used.

## The honest answer to the brief's own test

> *"Could octipus perform the same task I just gave you, or would it fail or
> output half-done, low-quality stuff?"*

Mixed, and now with numbers behind it rather than an impression. On a real
non-coding request it produced work a person could use. On coding tasks it
recovers from a dead end by trying another route — the plan-less arm did
exactly that.

The trip-planning run gave the sharpest answer, and it was not reassuring:
octipus lost every one of its research tools, hit a provider error, silently
retried without them, and returned a confident answer marked `ok`. "Half-done,
low-quality stuff" was not the failure — **well-written, unverified,
confidently delivered** was. That specific hole is now closed: the same run
returns `contract_failed` and names the outage. The underlying search outage
turned out to be a five-month-old container, not an unfixable wall.

Alongside that: the evidence gate has still never fired on a real run, cost per
run is 3× the target, delivery lag looks ~14× the target on the samples that
exist, and the cheap-executor path gave up where the expensive one persisted.
Two of four quality axes still have no data, so there is a scoreboard now but
not yet a loop.

**Next, in order:** (1) ~~update the SearXNG container~~ — done, search works
again and the trip scenario now answers from real sources; (2) get `deliveredPct` and `lagP95Seconds` above their
sample floors. Note that the new outage gate does *not* help `deliveredPct`:
`verification_evidence` is written only by `pipeline-manager.ts`, so swarm
scorer gates — including this one — never reach that table. Either pipelines
have to run, or the swarm gates need to record evidence too; the latter is
probably the smaller change and would make one table mean one thing.
(3) Chase the `toolConfig` provider error.

---

# 2026-08-03, later: three real pipelines run, and what they exposed

The step above — "run one real pipeline" — was taken. Three were: a 7-stage
`Full Development Cycle`, a `Bug Fix`, and a plain swarm delegation. All three
found something, and two of the findings say the gates were narrower than this
document claimed.

## The scoreboard moved, but not by much

| axis | 2026-08-03 morning | after these runs | target |
|---|---|---|---|
| deliveredPct | n/a (0 samples) | 75% (4 samples) | ≥ 95% |
| lagP95Seconds | 143s (16, below floor) | 26s (33 samples) — **fail** | ≤ 10s |
| paidTokensPerRun | 181,128 — fail | 113,310 — fail | ≤ 60,000 |
| autonomyPct | 100% — pass | 100% (129) — pass | ≥ 90% |

`lagP95Seconds` crossed its sample floor and is now a judged **fail** rather
than a guess. `deliveredPct` finally has data and still sits under its floor —
20 samples is a lot of pipelines, which is why the swarm-gate change below
matters more than running more of them.

## 1. The audit-coverage gate could never have fired

This is the sharpest finding, and it corrects a claim in the earlier half of
this document. `rubberStampRate` was not empty because nobody had run a
pipeline. It was empty because **no shipped pipeline template set
`stageType: 'qa_validation'`** — not `Full Development Cycle`, not `Bug Fix`,
not `Research & Analysis`.

Everything downstream keys off that flag: `QA_VERDICT_JSON_INSTRUCTION` is only
appended to a `qa_validation` stage, so no machine-readable verdict is ever
requested, `gateQaVerdict` never sees one to hold to account, and no
`audit_coverage` row is ever written. Three commits and 54 tests of gate, wired
to a switch that shipped in the off position.

The 7-stage run proved it end to end: **all seven stages reported completed —
including Testing, Code Review and QA Validation — and
`verification_evidence` held exactly one row**, from the evidence gate on
Implementation. Running pipelines forever would never have produced a
rubber-stamp number.

Fixed by declaring the auditor of record in the presets: `QA Validation` (Full
Development Cycle, retrying Implementation rather than the stage before it) and
`Verify Fix` (Bug Fix). The `producesArtifacts` backfill was widened to carry
`stageType` too — an install seeded before a flag exists keeps its old steps
forever, which is the same way this hole opened.

## 2. The evidence gate had a false positive: shell-written files were invisible

**Fixed — see "The workspace snapshot" below.** The diagnosis stands as written;
only the last paragraph's "deliberately not built here" no longer holds.


The `Bug Fix` run failed at `Implement Fix` with

    declares it produces artifacts but changed 0 files
    (18 tool calls, 11 commands, 2 tool errors)

and the stage **had done the work**. `dice.py` and `test_dice.py` were both
modified inside that stage's window (20:21, stage ran 20:18–20:23) and the suite
went from 18 tests to 21, all passing when run by hand.

The stage wrote through `shell__run` — a heredoc or equivalent — and
`filesChanged` counts only `FILE_CHANGE_TOOLS`. A worker that prefers the shell
is indistinguishable from one that wrote nothing, so the gate fails legitimate
work. It is one of the four `deliveredPct` samples, and the reason that axis
reads 75% rather than 100%.

This is not a reason to relax the gate — the failure it was built to catch is
real and was caught. It is a reason to stop treating tool counters as the whole
evidence.

### The workspace snapshot

`src/core/orchestrator/workspace-snapshot.ts`. A snapshot is
`relative path → "<mtimeMs>:<size>"` for every regular file under the root the
stage's worker actually writes to; diffing the before and after counts
creations, rewrites and deletions, and is blind to which tool did the writing.

The gate now reads **two independent signals and requires only one** to show
work:

| signal | sees | blind to |
|---|---|---|
| `counters.filesChanged` | file-mutating tool calls | anything written via `shell__run` |
| `filesTouched` (snapshot) | the disk, whoever wrote it | which stage wrote it (a concurrent pipeline counts) |

Requiring both would fail every stage that used only the tool the other signal
misses — which is the bug. Both "could not measure" cases still pass: absent
counters (a CLI worker) and an unusable snapshot (unreadable root, tree over the
20k-file cap) are `null`, and `null` never reads as zero. The gate bites only
when a signal is present *and* says nothing happened, and the failure message
now names which evidence was consulted (`workspace unchanged on disk` vs
`no workspace snapshot`), so a rejection is auditable without re-running it.

Three details that are load-bearing rather than incidental:

- **The root comes from `WorkspaceFS.forSession`,** the same resolver the worker
  uses — a dev-mode session with a `projectPath` runs its agents inside that
  project, everyone else gets the per-user nested workspace. Reimplementing that
  choice would have snapshotted a different directory than the one being
  written, reporting "unchanged" for every stage. Verified against a real run:
  the resolver returns the exact directory the earlier pipelines wrote `dice.py`
  into.
- **A root that does not exist yet is an EMPTY snapshot, not an unavailable
  one.** Otherwise the first stage to create the workspace has no baseline and
  everything it writes goes unmeasured.
- **A truncated walk is never diffed.** The traversal cut-off shifts as files
  appear, which would manufacture differences no stage caused; `node_modules`
  and `.git` are pruned for cost, and the walk is sorted so two passes over an
  unchanged tree agree.

The same blindness existed in the swarm's `code-diff` scorer
(`deriveCodeDiffScorer` → `minFilesChanged`), which reads the identical counter
from the child's receipt. It takes the same second opinion now: the spawner
snapshots around any child whose brief asks about files — and only those, so
this is not a cost on every spawn.

### Verified by reproducing the original failure

A `Bug Fix` pipeline was re-run with the implementing stage told to make every
edit through the shell — the exact shape that failed before. The ledger row:

| | counters | snapshot |
|---|---|---|
| `Implement Fix` | `filesChanged: 0`, `commandsRun: 22` | `filesTouched: 1` |

**Passed**, where the same shape was a hard failure two hours earlier. The change
is real: `dice.py` gained `roll_one(sides, seed=None)` and the suite went 21 → 22
passing when run by hand.

Two things came free with it, because the run finally reached stages that had
never executed:

- **`rubberStampRate` has its first real value: 0% (2 passing verdicts, 0
  rejected).** The audit-coverage gate fired for the first time since it was
  written — `audit_coverage` and `qa_verdict` rows for `Verify Fix`, both
  `high` confidence. Two verdicts is not a baseline, but it is no longer zero,
  and the prompt contracts survived contact with a real model.
- **`deliveredPct` moved 75% → 90% over 10 samples.** The single remaining
  failure is the pre-fix run that motivated all this; it ages out of the window
  on its own.

## 3. A Testing stage that cannot run tests will simulate them

In the 7-stage run, the Testing work reached a subagent whose tool set had been
intersected down to `filesystem`. It said so plainly —

> "I cannot run shell commands — no `shell` tool is available in my function
> set. I'll simulate execution by analyzing the test logic"

— then produced a full per-test PASS table and "Results: 18 passed, 0 failed".
Its receipt is honest (`commandsRun: 0`, `toolCalls: 2`, both reads) and the
claim happened to be true: running the suite by hand gave the same 18/18. But
nothing gated on "a stage whose job is to run tests ran no commands", so a
correct-by-luck simulation was accepted as a test run.

The template declares `toolIds: ['filesystem', 'shell', 'browser']` for Testing;
the tools were lost between the stage and the child.

### Fixed: `runsCommands`

`PipelineStepConfig.runsCommands` declares a stage whose purpose is to EXECUTE.
A declared stage that finishes having run zero commands fails, whatever its
prose says. Declared on Testing and QA Validation (Full Development Cycle) and
Verify Fix (Bug Fix).

**Filesystem evidence deliberately does not satisfy it.** The snapshot answers
"did anything change", never "was it verified"; letting it stand in would reopen
the exact hole.

**Code Review is held to NEITHER declaration**, and that is a judgement call
rather than an oversight: its prompt does tell it to run the suite, but its
purpose is reading code, and a review of a tree with nothing runnable in it is
still a real review. Declaring it would trade a caught lie for a failed honest
run — the trade this gate exists to refuse.

**A stage is a tree, so the counters are too.** `mergeCounters` folds every swarm
child's receipt into the stage's tally before the gate reads it. A worker that
delegates records `spawn_child` and nothing else, so gating on the parent alone
would have failed every stage that delegated — the same false positive as the
shell-write one, a level up. In the run that produced this finding, four
subagents did the work of a stage whose own worker ran almost nothing.

### Two defects the first live run of that gate exposed

Both are the same species — a declaration that never reaches the thing that
reads it, and a failure reported as something it was not.

- **The declaration was dropped in transit.** `stepConfigToStageTemplate` and
  `buildStagesFromTemplate` enumerate fields, so `runsCommands` never reached
  the gate: the Testing stage carried it in the DB and wrote no evidence row at
  all. Both mappers carry it now, and a round-trip test fails if a future flag
  is added without being listed. This was the **third** time a declaration went
  missing between where it is written and where it is read (`producesArtifacts`,
  `stageType`, `runsCommands`) — the test exists so there is no fourth.
- **A quota abort was reported as a user stop.** The run died at QA Validation
  with `Agent was stopped by user`; the truth was
  `tokensPerDay: 10118911/10000000`. `wasUserStopped` is a substring match that a
  quota abort satisfies, so an operator is sent looking for a person who
  cancelled while the one line naming the cap — and where to raise it — is
  discarded. `QuotaExceededError` is matched structurally now, before that
  heuristic, and propagated intact.

## 4. Swarm gates now write evidence

The previous section's own recommendation, taken: `singleSpawnAndRun` records a
`verification_evidence` row for every child that runs the scorer gates, so the
always-on tool-outage gate and every schema/code-diff scorer now reach the same
table the pipeline writes to. One table means one thing.

Verified live rather than by mock — a `spawn_child` delegation after the change
produced two rows carrying `node_id`, where the same path produced none before.

## 5. The whole loop, run end to end and checked against reality

2026-08-04. A clean 7-stage `Full Development Cycle` (build `vectors.py` —
`dot`/`norm`/`scale`) on the fixed code. Every gate fired, and every claim was
checked against the filesystem rather than read from the report:

| stage | commands | files | verdict |
|---|---|---|---|
| Implementation | 8 | `filesTouched: 1`, `filesChanged: 3` | pass |
| Testing | **25** | 2 written | pass |
| QA Validation (1st) | 17 | — | `qa_verdict` pass → **`audit_coverage` FAIL** |
| QA Validation (retry) | 20 | — | `qa_verdict` pass → `audit_coverage` pass |

**The QA loop closed by itself.** The first verdict came back as prose with
`uncovered: ["Implementation"]` and an empty `whatIDidNotCheck` — a bare pass
naming nothing. The gate rejected it and re-ran the auditor alone. The second
verdict came back as JSON, covered its scope, and listed four real limits it had
not checked (other Python versions, mypy on the test files, the ADR sections,
whether the design doc gets committed). Rejected → re-run → accountable pass, with
no human in the loop.

**Agent reports vs reality — checked, not trusted:**

- `test_vectors.py` → the report claims 7 tests; running it gives **7/7**.
- `test_vectors_edge_cases.py` → claims 31; running it gives **31/31**.
- The Testing stage cited commit `4f5c7cf` as the baseline suite. That commit
  exists in the workspace repo and is exactly "Add assert-based test suite for
  vectors module (7 tests)".
- Its receipt shows `shell__run: 25` — this stage really executed, which is the
  thing `runsCommands` now guarantees rather than hopes for.

**All four quality axes are measured for the first time**, which was the whole
point of Phase 2 — until now the scoreboard always had an axis reading `n/a`:

| axis | value | target | n | status |
|---|---|---|---|---|
| deliveredPct | 89% | ≥ 95% | 27 | fail |
| lagP95Seconds | 0s | ≤ 10s | 33 | **pass** |
| paidTokensPerRun | 182,653 | ≤ 60,000 | 77 | fail |
| autonomyPct | 100% | ≥ 90% | 156 | pass |

`rubberStampRate`: **40% — 2 of 5 passing verdicts rejected.** That is the first
informative reading (the earlier 0% was two verdicts from one pipeline), and it
says what the metric was built to say: two in five auditors would have rubber
stamped, and the gate caught both. Read it as a signal about the review prompts.

There is a scoreboard AND a loop now. What there is not yet is a passing board:
two axes are below target, which is the honest state to leave this in.

## 6. The finished product — 2026-08-07

A clean seven-stage `Full Development Cycle` building `ipv4.py`
(`parse` / `format_int` / `in_cidr`) plus its suite. Every stage did its own job,
and every claim was checked against the filesystem:

| stage | commands | files changed | verdict |
|---|---|---|---|
| Implementation | 11 | 8 (2 declared artifacts) | pass |
| Testing | 17 | committed its suite | pass |
| Code Review | 15 | **0** | pass |
| QA Validation | 17 / 23 / 16 | **0** | 3 audit rejections → human escalation |

Independently verified rather than believed: `python3 test_ipv4.py` → **20 of 20
test groups pass**, committed as `2e549db`, and `git status` is **clean** — no
modified-but-uncommitted deliverable, which took one more fix (Testing now
commits the suites it writes, the way Implementation always committed its code).

Read-only held: Code Review and QA each ran 15–23 commands and changed nothing.
That is the instruction their prompts always carried and nothing had ever
enforced.

### Four false starts on the way, each a real defect

- **`readOnly` fired on its own by-product.** Code Review ran the suite exactly
  as instructed, Python wrote `__pycache__/*.pyc`, and the gate failed it for
  editing what it was reviewing. Running the code is what these stages are FOR,
  so the snapshot now prunes tool caches and bytecode — but not `dist/`, which a
  stage may legitimately be asked to produce.
- **A truncated turn became a report.** A Testing stage "reported" 95 characters
  ending mid-sentence and the pipeline handed that on as its account of the test
  run, leaving a failing test behind. A cut-off final turn is now recorded and
  refused for pipeline stages.
- **An empty result was accepted.** A worker completed with `''` after
  compaction; only the evidence gate caught it, and only because that stage
  declared artifacts.
- **A re-run over finished work fails the gate.** Implementation found
  `slugify.py` already complete and correctly changed nothing — the gate failed
  it. Correct by rule, wrong in spirit; noted, not fixed, because relaxing it is
  how the original "green over an empty workspace" failure got in.

### The open one: the auditor cannot reliably emit its verdict

`rubberStampRate` is **60% over 7 days (6 of 10 passing verdicts rejected)** —
and the reason has shifted. Most rejections are no longer "named nothing it
audited" but "produced no machine-readable verdict at all": the QA stage writes
a good prose report and omits the required ```json block. On this run it did so
three times in a row, burning the entire retry budget on formatting before the
substance was ever re-judged — exactly the failure mode this document warned
about when the gate was written.

The escalation that followed is the system working: three rejections, then a
human asked "continue despite QA failures, or abort?" rather than a silent pass
or a silent fail. But the budget should be spent on substance. The fix belongs
in the prompt/verdict contract, not the gate.

## What is actually next

1. **Make the QA verdict contract stick** (finding above). Three of four
   attempts omitted the JSON block. Until that lands, every audited pipeline
   risks spending its retries on formatting.
2. **`paidTokensPerRun` is 3× its target** and is now the worst axis. The
   planner→executor split exists to move exactly this number and has never been
   pointed at pipeline stages — every stage above ran on the paid lane.
3. **`deliveredPct` 86% → ≥95%** (81 samples now, comfortably measured). It is measured now (27 samples); the remaining
   failures need reading one by one rather than assuming they are all stale.
3. **Watch `rubberStampRate`.** 40% on five verdicts is a signal, not a
   baseline. If it stays high the review prompts need work; if it falls to zero
   across a real spread of runs, the gate could relax to sampling.
5. Chase the `toolConfig` provider error (unchanged).
