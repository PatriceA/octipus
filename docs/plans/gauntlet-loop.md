# Gauntlet loop: build → independent critic → keep the best

Status as of 2026-10-01. This plan tracks how far Octipus has adopted the
"gauntlet loop" pattern (Matt Shumer's technique, packaged at
[robonuggets/gauntlet-loop](https://github.com/robonuggets/gauntlet-loop)), and
what is left to do. Each shipped item names the PR that merged it. Each open
item says what it costs in tokens.

## The pattern, in one paragraph

A lead agent splits a goal into deliverables. Each deliverable gets a builder
and a separate critic that starts with fresh context. The critic opens the
actual output and puts it next to a concrete, fetchable quality bar (a named
reference that already exists), with the labels removed. It then says which of
the two is better. It does not give a score out of 10, because scores drift
upward from round to round. If the build loses, it goes back to the builder
with the reasons, and the loop repeats until the build wins.

## What Octipus already had

| Gauntlet piece | Octipus before this plan |
|---|---|
| Lead agent decomposes | Root agent, work plans, pipeline plan items (`producesPlan` / `loopOverPlan`) |
| Builder ≠ critic | Each pipeline stage is a fresh worker. Code Review and QA are `readOnly` and on the `verify` lane |
| Critic inspects real output | `runsCommands`, the evidence gate and the stage `verifyCommand` |
| Critic can't rubber-stamp | Audit-coverage gate (names stages, states `whatIDidNotCheck` and confidence) |
| Loop on failure | Pipeline `qa_fail` edge (default 3 retries, then a human decides) and the swarm contract retry |

## Shipped

### PR #380: acceptance criteria, independent review, best attempt

- **Independent review.** The Bug Fix recipe's *Verify Fix* stage moved from
  `coding` to `qa` (the Verify lane). When a QA stage resolves to the model an
  implementation stage used, the run posts a one-time `qa_same_model` notice.
- **Acceptance criteria per plan item.**
  - Plan items carry `acceptance` (migration 0119).
  - QA must return `criteria: [{criterion, met, evidence}]`.
  - The gate sends back a pass that skips a criterion or gives no evidence. A
    pass that reports a criterion as unmet becomes a real failure and goes back
    to the builder.
  - Workers can't edit the criteria. People can, through the plan API.
- **Keep the best attempt.**
  - Pipeline QA verdicts are kept per item, with the workspace HEAD. When
    retries run out, the escalation names the best earlier attempt.
  - When a swarm contract retry does worse and touched nothing, the earlier
    result is kept.

### PR #379: flow guard (security, related)

This adds a deterministic information-flow check after OpenAPPA. It is not part
of the gauntlet pattern, but it shares the validation run below. See
[FLOW-GUARD.md](../FLOW-GUARD.md).

## Step 1: live validation (not done — needs a running install)

Both PRs are covered by unit tests and CI (Postgres integration included), but
neither has run against real models. The cloud session that built them could
not start Octipus with providers, so this has to happen on a real install. Do it
before building step 2: the new contract text and criteria rules change what
the auditor is asked to produce, and only a real model shows whether it
complies.

**Setup**
- On the Topics page, bind a **different** model to **Verify** than to
  **Build**. Until they differ, every QA run reviews with the model that wrote
  the code, and the `qa_same_model` notice will fire.

**Pipeline run**
- Start a *Full Development Cycle* with a small task, for example "add a
  `GET /health` endpoint that returns `{ ok: true }`, with a test". Set
  `verifyCommand` to the project's test command.
- Expected behaviour:
  - The approval prompt lists each plan item with an `Acceptance:` line.
  - The implementer's input shows "Acceptance criteria (QA will check each one)".
  - The QA verdict carries a `criteria` array.
  - `verification_evidence` rows for the stage include `criteria`.
- Force a failure, for example by adding a criterion the code can't meet
  through `PATCH /pipelines/:id/plan/:itemId`. Confirm the work goes back to
  Implementation with "Acceptance criterion not met: …" in its feedback.
- Let the retries run out. Confirm the escalation names the best attempt, with
  a commit or "plus uncommitted changes".

**Flow guard**
- In an attended chat, have the agent read a `.env` file, then fetch a URL.
  Confirm an approval prompt appears and gives the reason.
- Repeat with the same task through a Claude Code CLI model.
- Confirm that a `{{secret:NAME}}` vault call is never held for approval.

**What to record**
- Whether the auditor emits `criteria` on the first try, or needs a
  correction round. Each correction is a full auditor turn.
- How many tokens the QA turn uses with and without criteria. The expected
  cost is a few hundred tokens of contract text, plus whatever the auditor
  writes per criterion.
- Any criterion the matcher pairs with the wrong entry, or misses. Its rules are
  in `matchCriteria` (`src/core/agent/audit-coverage.ts`).

If the auditor regularly fails to emit `criteria`, fix the contract text
(`qaCriteriaInstruction`) before anything else. A gate the model can't satisfy
only burns retries.

## Step 2: reference bar with blind pairwise judging (next to build)

This is the core of the pattern that Octipus still lacks. The critic compares
the output against something that already exists and picks a winner, instead of
returning PASS/FAIL or a score.

**Shape**
- **Where the bar is set:**
  - A pipeline recipe stage gets `qualityBar: { kind: 'url' | 'file' | 'repo', ref: string, aspect?: string }`.
  - A plan item can carry its own bar, which overrides the stage's.
  - `spawn_child` gets `expectedOutput.qualityBar`, with the same shape.
- **Who judges:** a new `pairwise_judge` step, run by the existing QA stage when
  a bar is set.
  - It receives the bar's content and the build's output, labelled **A** and
    **B** in a random order recorded server-side.
  - Its verdict is `{ winner: 'A' | 'B' | 'tie', reasons: string[], whatWouldFlip: string }`.
  - The gate maps it back: the build wins, the reference wins, or a tie.
- **What a loss does:** a loss is a `qa_fail` that carries the reasons and
  `whatWouldFlip`, so the existing retry edge and attempt ledger apply unchanged.
  A tie counts as a loss; the bar has to be beaten, not matched.
- **Visual work:** a URL bar and a web build are compared as screenshots
  through the existing `visual` tool, as two images in one vision call.
- **Order bias:** to counter it, run the comparison twice with A and B swapped.
  It only counts as a win when the build wins both times. This doubles the
  judge's cost, so it is a recipe flag (`judgeBothOrders`), on by default only
  for the final item.

**Cost**
- Opt-in. Nothing changes unless a bar is set.
- One judge call per round, or two with `judgeBothOrders`. The cost is
  dominated by the bar's size, so the bar is truncated to a budget set by
  `qualityBar.maxTokens` (default 8k).

**Guards**
- A bar that can't be fetched fails the stage before the judge runs. A critic
  comparing against nothing invents a comparison, which is the most common
  failure mode named in the original method.
- The judge never sees which side is the build. Labels, file paths and commit
  messages that would reveal it are stripped from both sides.
- There is a round cap. The original method has none, but Octipus runs under
  token and wall-clock budgets. The cap reuses `maxRetries`.

**Code touch points**
- `seed-presets.ts` / `templates.ts` (stage field)
- `plan` tool and `plan_items` (per-item bar; migration)
- `pipeline-manager.ts` (judge step and gate mapping)
- `swarm-tool.ts` / `spawner.ts` (`expectedOutput.qualityBar`)
- A new `pairwise-judge.ts` (prompt and parser, pure)
- `tools/visual` (two-image compare already exists)

## Step 3: builder + critic mode for swarms

- `spawn_child` gets `critic: { lane?: 'verify', bar?: QualityBar, maxRounds?: number }`.
- The spawner runs the builder child, then a fresh read-only critic child on the
  `verify` lane, using the step 2 judge when a bar is given and the
  acceptance-criteria verdict otherwise.
- A loss re-dispatches the builder through the existing contract-retry path,
  with the critic's reasons quoted back. `preferEarlierAttempt` already keeps
  the better result.
- Cost: one critic child per round, and only when `critic` is passed.

## Step 4: let the root choose the loop

The delegation prompt (`src/core/agent/delegation-prompt.md`) currently uses
pipelines only when the user asks for staged work. Add a rule: for
multi-deliverable build or design work, spawn with `critic` (step 3), and
propose a pipeline when the work needs a plan.

This raises token spend on exactly those tasks, so it sits behind a setting,
`agent.autoCritic`, off by default until step 1's numbers say what it costs.

Also fix the stale claim in `docs/AGENT-ARCHITECTURE.md` that the delegation
prompt prefers pipelines.

## Step 5: verify hook per item (ROADMAP B1b)

The stage `verifyCommand` runs only on the last plan item, because early items
legitimately fail a project-wide suite. B1b's `pre_verify` hook runs a scoped
check (tests, build or lint for the files an item touched) before every QA turn.
The result goes into the verdict as ground truth, as `verifyCommand` already
does.

Cost: no model tokens, only wall-clock time.

## Out of scope

- **Automatic rollback to the best attempt.** Rewriting a workspace without
  asking a person is their decision. The attempt ledger names the attempt; it
  does not restore it.
- **Unbounded loops.** The original method has no round cap. Octipus keeps
  one.
