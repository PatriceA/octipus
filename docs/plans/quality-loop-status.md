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
| Branch | `worktree-quality-loop` (off `895850ca`) |
| Backend tests | 3657 pass / 0 fail / 175 skip (`bun test src scripts`) |
| Typecheck | clean |
| Providers | unchanged; `grok` still holds no topic role |

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

A `SEARXNG_ENGINES` env allowlist (e.g. `SEARXNG_ENGINES=google`) was added so
an operator can pin the engines they trust without editing SearXNG's own
config. Unset by default — current behaviour is unchanged.

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
