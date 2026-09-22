# Cost-aware General delegation — 2026-09-17

## Reason for the change

The previous no-coding-spawn-after-reading rule addressed an observed cost problem:
General investigated extensively, then delegated the same job, and the child read
and investigated it again. The user clarified that this was intentional cost
control. The goal remains avoiding that duplicate work, not encouraging General
to investigate every task before routing it.

The earlier [prompt audit](prompt-effectiveness-audit-2026-09-17.md) identified the
blanket guard as too restrictive. This implementation refines it rather than simply
removing it. Other audit findings remain outstanding.

## Behavior

- Clear specialist work or an explicit delegation request: delegate before reading
  implementation files. Provide target, constraints and acceptance criteria without
  first conducting a full investigation.
- Bounded work that General can implement and verify: complete it directly. Do not
  delegate the same investigation after already acquiring the necessary context.
- Unclear scope: resolve only the specific question needed to choose an owner.
- Unexpected complexity or distinct remaining work: permit a later coding handoff,
  carrying findings and completed checks instead of restarting the investigation.
- Independent review may intentionally re-read relevant code. Its purpose is a
  second verification, not duplicate implementation.
- Root checks and synthesizes child results. One specific corrective assignment
  can address an evidenced gap; no blind respawn, duplicate automatic retry, or
  retry around a denial. Lite mode retains its single-delegation policy.

Root policy, delegation documentation and pipeline tool guidance now agree on the
cost criteria. Coding full/lite prompts tell the recipient to use parent findings,
inspect current relevant code when necessary, and respect the remaining scope and
file ownership. No change was made to execution permissions or budgets.

## Runtime contract

After an observed parent file read, coding delegation still fails unless a valid
`handoff` is supplied. This includes advisory roles rewritten to coding in lite or
weak-model execution. Both full and lite schemas advertise the optional field.

Required fields:

| Field | Purpose |
| --- | --- |
| `reason` | Why the remaining work now needs delegation |
| `completedWork` | Findings and work already performed |
| `remainingWork` | Remaining deliverable and acceptance criteria |
| `files` | Relevant paths, ownership and exclusions |
| `verification` | Actual previous checks/results, or explicitly none, plus pending checks |

Fields must be nonempty strings, at most 2,000 characters each. Unknown fields and
malformed values fail explicitly. The combined brief and rendered handoff must fit
the existing 4,000-character brief budget; there is no silent truncation. Findings
and constraints reach the child through the normal task brief, which retains input
guards, permission checks and normal spawning. Handoff is not the `plan` parameter
and does not select a cheaper mechanical executor model.

This is structural enforcement, not a semantic proof that assignments do not
overlap. The parent can still provide a poor handoff. The existing read counter
observes `filesystem__read_file` calls through Octipus; shell/native CLI reads and
other investigation are not fully covered by that counter. Prompt guidance applies
to those paths too, but should not be represented as complete instrumentation.

## Validation and remaining measurement

Focused tests cover missing/malformed/oversized handoffs, propagation of findings,
paths and checks, early delegation without a handoff, full/lite behavior and role
rewriting. Prompt contract tests cover cost guidance and pipeline/scorer consistency.

The routing eval unit mode can check classification but cannot observe real
specialist selection: six cases passed and six require backend integration. A
broad eval was initially started, then stopped when its generic direct-model
response cases were confirmed not to exercise this delegation path. Those provider
calls do not count as evidence for this change. No live end-to-end cost comparison
or deployment was performed.

A useful live comparison must measure General plus children plus corrective work:
small direct fix, clear specialist task, explicit delegation after inspection,
unexpected complexity, and independent review. Record total cost/tokens, duplicate
file reads, completion time and verified outcome. Structural tests alone do not
establish monetary savings or improved model decisions.

Final checks: **6,006 passed, 179 skipped, zero failures** across the complete
repository suite; **90 focused delegation/prompt tests passed**. Typecheck, lint,
production build, catalog check and `git diff --check` passed. An initial full run
compared new prompt source against an older bundle; rebuilding and running the
complete suite again resolved it. Independent review found and verified fixes for
the lite role-rewrite bypass and conflicting pipeline/scorer wording; no blockers
remain in this delta. No commit, push or backend restart was performed.
