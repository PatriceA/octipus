# Product consolidation: predictable everyday work

Date: 2026-09-10
Status: phases 1–4 implemented in the working tree; validation and remaining measurement gaps are recorded in [the implementation report](../reports/consolidation-2026-09-10.md). Phase 5 is deferred.

## Outcome and scope

Make Octipus easier to understand and more dependable for three workflows:

1. Investigate and change a repository, with a reviewable diff and verification.
2. Research a question, save a sourced report, and identify missing evidence.
3. Turn information into follow-up tasks and run a bounded automation.

Keep the current Node, React, Postgres/PGlite, and root-agent architecture. Work
incrementally in independently reviewable changes. Do not expand channels or
feature categories during this cycle unless an acceptance scenario requires it.
Existing roadmap ideas remain proposals; this plan takes sequencing priority for
the consolidation cycle. No calendar commitments are implied by the phase sizes.

## Review baseline

The initial review read code, documentation, UI source, and CI configuration. It
did not exercise live model providers or the browser and is not a security audit.
Forty-four targeted tests passed across five approval, budget, cancellation, and
receipt suites. Some emitted database errors against the unit lane's deliberately
invalid database hostname; they do not establish persistence behavior.

Backend typechecking failed at `scripts/measure-tool-payload.ts:32` in an existing
uncommitted edit, where an arbitrary string was passed as an `AgentRole`. Establish
a clean agreed baseline before implementation; preserve unrelated local work.

## Phase 0 — realistic documentation (completed in this change)

- Replace unrestricted autonomy and universal capability claims with concrete
  workflows, configuration dependencies, and alpha limitations.
- Describe the root tool loop and optional delegation accurately.
- Separate prompt guidance, execution evidence, and correctness guarantees.
- State the current unattended approval behavior and actual CI evaluation scope.
- Correct research-job persistence descriptions and stale contributor paths.
- Link this plan from the roadmap and documentation index.

Validation: inspect the diff, verify changed local Markdown links, and check
specific behavior claims against their implementation. Historical plans remain
historical; this change does not attempt to rewrite the entire documentation tree.

## Phase 1 — preserve authorization across execution paths

Priority: highest. Size: medium; likely several PRs.

Pre-change behavior: `routeApproval` could convert unattended `ASK` into execution.
The default unattended deny list covers destructive shell execution and filesystem
deletion. `BaseTool` also skipped some unattended permission checks, relying on the
agent loop to have checked them. Centralizing a decision function alone does not
prove every caller reaches it.

### Changes

1. Trace the root, child, nested child, pipeline, direct tool API, hook, cron, and
   MCP dispatch paths. Record which layer authenticates the caller, checks the
   stored permission, and invokes the tool. Reuse the existing policy module.
2. Preserve `ASK`: relay child requests to the attended root/session. Where no
   approval surface exists, return a structured blocked result before execution.
   Keep the operation resumable only where the existing lifecycle supports it.
3. Support explicit prior authorization for unattended automation through a
   reviewable scope: allowed actions, workspace/resources, duration or run, and
   applicable budget. Reuse existing permission storage where possible. A grant
   must not override a stored denial or broaden through delegation.
4. Persist the effective authorization source in the audit record. Handle grant
   expiry, revocation, cancellation, and restart without silently executing pending
   work. Publish migration notes for automations that previously auto-approved.

### Acceptance

- The same action and principal receive consistent policy enforcement through
  every listed entry path; tests invoke those paths, not only `routeApproval`.
- An `ASK` action without a matching grant produces no external side effect until
  approval. A child cannot obtain more authority by spawning another child.
- Denial, expiry, and cancellation never release a waiting operation to execute.
- One approval prompt identifies the action and scope; reconnecting cannot approve
  it twice. Unattended calls return a useful blocked result without a long silent wait.
- Tests explicitly cover the tool middleware skip paths and prove the relevant
  guards are reached. Use isolated fixtures and read the resulting state independently.

## Phase 2 — truthful status and failure recovery

Priority: high. Size: small to medium; can proceed independently of Phase 1.

Start with `web/app/page.tsx` and
`web/components/chat/new-session-dialog.tsx`, where failed reads currently become
zero/idle values or an empty project list. Then inspect chat, run, research, and
document views for the same pattern.

### Changes and acceptance

- Represent loading, available, stale, and unavailable data separately. A failed
  usage request never displays a newly fabricated `$0.00`; actual zero remains valid.
- Retain the last successful value with a timestamp and a visible stale indicator.
  Provide a retry action with a useful error explanation.
- Distinguish an empty project directory from a failed or denied directory read;
  show partial results when one configured root cannot be read.
- On client reconnect, reconcile against durable backend state. Do not infer idle
  or completed from a missing event stream.
- Display interrupted work and missing deliverables explicitly. A research result
  without `documentId` must not imply the document was saved.
- Verify offline/reconnect, HTTP errors, permission refusal, genuine empty data,
  partial data, and successful recovery in the browser. Preserve keyboard access
  to error details and retry controls.

## Phase 3 — prove a small set of complete workflows

Priority: high. Size: medium. Begin baseline measurement early; final permission
and status assertions depend on Phases 1 and 2.

Extend existing harnesses rather than introducing a second eval framework. Keep
three separate evidence categories:

- Fast deterministic tests for contracts and policy.
- Production backend + client tests with a scripted provider for lifecycle and
  actual filesystem/database side effects; no browser API stubbing in this lane.
- Budgeted real-provider evaluations for task quality and adversarial behavior.
  Record the exact model/provider, configuration, prompt revision, and fixture.

| Scenario | Independent completion evidence |
| --- | --- |
| Repository edit | Expected diff, unchanged unrelated files, and externally rerun checks |
| Sourced research | Retrievable document, accessible source references, and an assessed answer against a known source fixture |
| Information → task | Correct persisted task, provenance, workspace, and no duplicate on retry |
| Denied delegated action | No forbidden side effect, plus a useful blocked/denied result |
| Cancel delegated work | Descendants reach terminal state; no new calls start after cancellation; in-flight external work is reported accurately |
| Restart mid-run | Honest interrupted state and documented recovery boundary; no claim of automatic mid-turn resumption |
| Client reconnect | The same run and pending approval are recovered without duplicate execution |

Track completion rate, false-success rate, time to first useful feedback, total
completion time, token/cost usage, approval count, and failed tool calls. Measure
direct and delegated execution on the same tasks before changing delegation policy.

Acceptance: deterministic scenarios gate relevant PRs; real-provider runs are
available on demand and as a budgeted release check. Keep generator dry-runs clearly
labeled. Missing keys or skipped scenarios must be reported as unmeasured. Set
quality and latency thresholds from a recorded baseline before using them as gates;
do not invent targets that the first run has never measured. Require zero forbidden
side effects and zero false-success results in the deterministic acceptance fixtures.

## Phase 4 — simplify navigation and onboarding

Priority: next. Size: medium; prototype after the state vocabulary is settled.

Proposed primary navigation:

| Area | Existing capabilities grouped inside it |
| --- | --- |
| Work | Chat, ongoing runs, tasks, inbox, recent activity |
| Library | Notes, documents, saved reading, knowledge search, artifacts |
| Automations | Pipelines, hooks, schedules, automation history |
| Connections | Model providers, MCP, channels, external accounts |
| Settings | Permissions, persona, people/profiles, memory controls, advanced agent configuration |

These are navigation groupings, not a database migration or deletion of advanced
features. Keep existing URLs and deep links working. Place evaluations and detailed
agent traces within the relevant configuration and run views.

Explain the vocabulary where it matters: a role constrains a worker, an expert is
a preset, a persona controls assistant presentation, a profile describes a person,
and a topic selects a model binding. Users should not need all five to start work.

Acceptance:

- A fresh install with one configured text model can start a chat without choosing
  an expert, role, topic, or pipeline. Expose missing capabilities before dependent work.
- Each of the three target workflows has an obvious start and a discoverable result.
- Advanced controls remain reachable; existing bookmarks still resolve.
- Test keyboard navigation, narrow viewports, permission prompts, empty states, and
  recovery in a browser. Observe representative new-user walkthroughs and record
  where people hesitate before finalizing the grouping.

## Phase 5 — reduce complexity using the new acceptance coverage

Priority: ongoing after relevant coverage exists. Size: small PRs.

Start with the responsibility changed by an earlier phase rather than splitting
files to meet a line-count target. Candidate boundaries are approval waiting,
run-state transitions, evidence assembly, and chat data/state hooks in
`pipeline-manager.ts`, `swarm/spawner.ts`, `agent-worker.ts`, and `web/app/chat/page.tsx`.

For each extraction, identify its owner, inputs, persisted state, cancellation
behavior, and callers. Keep behavior changes separate from structural changes.
Do not add a workflow engine, plugin kernel, or event-sourcing rewrite without a
measured requirement the current mechanisms cannot meet.

Acceptance: relevant workflow results and policy decisions stay unchanged; no new
copy of an existing lifecycle state or security decision; required checks pass.

## Follow-through and definition of done

Sequence: documentation → permissions and truthful status → complete-workflow
checks → navigation changes → measured extractions. Harness baseline work can run
alongside the first implementation phases.

Use one issue per bounded implementation item and attach its acceptance evidence.
Update this plan's status when that evidence exists. For code changes, run the
repository's required typecheck, lint, and test checks; UI changes also need browser
validation. Record blocked or skipped checks explicitly.

The cycle is complete when the three target workflows can be demonstrated from a
fresh setup, authorization is preserved across the tested entry paths, failures are
visible without reading logs, and the documentation distinguishes tested behavior
from configuration-dependent capability. New feature categories should be argued
from remaining user needs after that review.
