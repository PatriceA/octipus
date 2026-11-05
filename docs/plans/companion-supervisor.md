# Companion supervisor implementation plan

Status: M1 through M8 implemented and independently reviewed on `feat/companion-supervisor`. The opt-in release is ready for activation. Existing live work has not been enrolled or restarted. See [setup and rollout](../COMPANION-SUPERVISION.md).

Companion becomes the persistent owner of the user's work across projects and sessions. The user gives it an outcome; Companion starts or adopts sessions, follows their progress, investigates blockers, coordinates repairs, verifies recovery and reports meaningful results. The user should no longer need to copy error reports between sessions to keep work moving.

The first release must demonstrate a complete loop: accept a goal, start a project session, detect a runtime blocker, perform an authorized repair, verify it in the affected runtime, resume the existing work and report the result. This covers ordinary requests as well as long development pipelines.

## Product behavior

The main Companion conversation is the user's entry point. Project sessions remain accessible for detailed work. A project overview shows the outcome, current activity, evidence of progress, blockers, costs and next action for each supervised goal.

Examples:

- “Finish Life² and keep it moving.” Adopt the existing work plan and pipeline, retain completed milestones, monitor review and device testing, and resolve execution prerequisites.
- “Deploy Solar System Map and check it works.” Coordinate backups, deployment and acceptance under the existing authorization, using fresh live evidence.
- “Make a presentation from this PDF using my words.” Start a focused document session with the source's protection level and return the finished artifact.
- “What needs my attention?” Summarize verified changes, unresolved decisions and priorities across the user's supervised goals.

Companion must distinguish a product decision from a technical blocker. Missing SDK mounts, an empty SSH agent, a stale approval binding and a failed test require diagnosis. They must not automatically become questions asking the user to repeat consent.

## Existing foundations

| Foundation | Reuse | Required extension |
|---|---|---|
| Agent service and session repository | Normal session creation, model selection, execution and history | Scoped tools for supervising other authorized sessions and linking them to a goal |
| Pipeline manager and work plans | Stage execution, acceptance, checkpoints and recovery | Structured blocker events and an external supervisor that preserves completed work |
| Persistent monitors | Stored conditions, leases, probes and continuations | Supervision across linked sessions; existing monitors remain session scoped |
| Heartbeat and role agents | Cheap pending-work checks, standing instructions, quotas and task checkout | Share scheduling and budgeting without creating a competing work owner |
| Gateway event bus | Immediate change notification and existing UI subscriptions | Durable event delivery and restart reconciliation; its in-memory replay buffer is insufficient for recovery |
| Task board and workspace repositories | Tasks, dependencies, assignees and repository identities | Link supervision to existing tasks and projects rather than introducing another task board |
| Companion identity and presence | Existing persona, appearance, tray and notifications | Show aggregate supervised work and actionable updates through the same identity |
| Run permission profiles and tool executor | Authorization, run scope and actual execution outcomes | Explicit delegation into linked sessions and maintenance runtimes |

Relevant code: [agent service](../../src/core/agent/service.ts), [session repository](../../src/db/repositories/session-repository.ts), [pipeline manager](../../src/core/agent/pipeline-manager.ts), [monitors](../../src/core/monitors/service.ts), [heartbeat](../../src/core/heartbeat.ts), [role agents](../../src/core/tasks/role-agents.ts), [event bus](../../src/core/gateway/event-bus.ts), [turn queue](../../src/core/session-turn-lock.ts), [permission profiles](../../src/security/pipeline-permissions.ts) and [companion presence plan](companion-presence.md).

## Architecture

Use a durable supervision service with short, event-triggered agent turns. The service owns scheduling, claims, authorization checks and action records. The model diagnoses situations and selects actions through that service. Its conversation can compact or change provider without losing responsibility for ongoing work.

| Layer | Responsibility |
|---|---|
| Companion conversation | Receive goals, accept steering and explain verified progress |
| Supervision service | Persist ownership, consume events, schedule turns, reconcile work and enforce budgets |
| Project sessions | Perform focused work using existing agents, work plans and pipelines |
| Maintenance runtime | Diagnose and repair authorized installation or host prerequisites |
| Evidence and activity view | Expose what happened, what was verified and what happens next |

One logical Companion belongs to each user. Access to another workspace requires current membership and explicit supervision scope. Personal supervision does not automatically enroll shared rooms or another user's sessions. The first release supports personal workspaces; unsupported shared-space adoption must return a clear explanation.

Settings must expose Companion's bound model, eligible fallback models, supervised workspaces, default autonomy, notification preferences, concurrency and spending limits. Keep model selection explicit: specialist availability or tool declarations must not silently replace the Companion model. Derive worker model eligibility from the task, configured bindings and source protection requirements. Persistent responsibility lives in the database; a continuously running model process is unnecessary.

### Durable records

Introduce scoped supervision records, with migrations and repository methods:

- `companion_goals`: user, workspace, original request, desired outcome, acceptance criteria, priority, state, policy reference, budget, revision and timestamps. Link to an existing task or work plan when present. This record describes responsibility, not a replacement list of implementation tasks.
- `companion_session_links`: goal, session or pipeline reference, purpose, created or adopted origin, cancellation behavior and last observed revision. Prevent duplicate active ownership of an execution; allow read-only references from other goals.
- `companion_incidents`: affected execution, structured blocker category, current evidence, fingerprint, repair owner, attempts, verification and resolution. One active incident for the same execution and blocker identity.
- `companion_actions`: intended operation, target revision, authorization reference, idempotency key, lease, execution reference, outcome and evidence. Persist intent before dispatch and reconcile incomplete actions after a crash.
- Durable event outbox and consumption receipts: use an existing durable facility if one is found during implementation; otherwise add one. Persist important execution transitions with the state change that produces them.

Store references and bounded summaries rather than copies of every transcript. Preserve the originating owner, workspace, protection level and data provenance on observations and derived summaries.

Goal states: queued, active, waiting, needs decision, completed, cancelled. Incident states: observed, diagnosing, repairing, verifying, resolved, escalated. A completed goal requires evidence for its acceptance criteria; a repair exiting successfully does not complete the project.

### Event processing and concurrency

Wake Companion for new requests, execution completion or failure, actionable blocked states, approval changes, meaningful CI results, verified dependency changes and suspected stalls. Map concrete existing event producers before adding event types; do not subscribe to names that are only declared.

Persist events before delivery, deduplicate by stable identity and claim work with database leases. Re-read the target's current state and revision before acting. Serialize turns through existing session entry points and add durable action claims around cross-session mutations; the in-process turn queue alone does not cover crashes or multiple processes.

An event burst should produce one relevant investigation, not one model call per log line. Reconciliation checks for missed transitions after restart. External effects use operation-specific idempotency or inspection of the target system. Expired leases do not establish that an operation failed.

Silence alone is not a stall: account for a running command, provider wait, human decision, deadline and recorded progress before intervening. Companion must not resume a session the user deliberately paused, restart a cancelled goal, or compete with a healthy worker.

## Authorization and repair

Use goal-level delegation covering the intended repositories, linked executions, runtime capabilities and actions. Reuse existing run-wide approval semantics for child pipelines, recording the authorization's provenance and effective scope. Do not introduce per-command allowlists or make an internal handoff require the same approval again.

Check authorization server-side on every consequential action. Revocation and scope changes take effect on subsequent dispatches. Existing hard denials and source protection requirements remain effective. A newly discovered requirement outside the delegated scope creates one clear decision tied to the actual missing capability.

For uncertain outcomes, automatically inspect recorded effects and current external state. Repeat read-only checks freely within the delegated scope. Repeat a mutation when the earlier operation is verified absent or the operation has a reliable idempotency contract. Otherwise escalate once with the unresolved fact; do not repeatedly reopen replay prompts or treat a timeout as evidence of failure.

### Maintenance runtime

Provide an explicitly configured runtime for installation-level maintenance, separate from project testing runtimes. It must be able to inspect the relevant Octipus configuration and host prerequisites even when a project's sandbox is broken. The control service holds the capability binding; the model cannot grant itself host authority.

Expose the configuration in Settings with discoverable runtimes, capability descriptions, scope, connection health and test actions. Capabilities include approved workspace storage, installed CLI tools, SDK and cache paths, host networking, USB/ADB, SSH agent access, Docker and authorized service management. Reuse existing runtime registrations where possible. Users should not edit hidden connection files or add each newly generated command.

Initially support diagnosis and repair of runtime configuration and approved prerequisites. For defects requiring Octipus source changes, open a linked maintenance work session, preserve unrelated edits, implement the change, run tests and review, then build and activate it under the user's maintenance policy. A code change is not considered live until the running version and affected operation are verified.

Restarting Octipus requires an external launcher or maintenance process that survives the backend restart. Persist the restart intent and affected execution checkpoints first. Respect the user's preference about interrupting active work; resume only the executions whose continuation was authorized. Broad unattended host maintenance is opt-in, with visible scope and revocation.

## Recovery workflow

1. Observe the blocker and fetch current execution history and status.
2. Determine whether work is active, finished, explicitly paused, blocked on a real decision, or failing for a technical reason.
3. Claim the incident and record a diagnosis backed by current evidence.
4. Select an authorized repair or delegate a focused maintenance session. Correlate shared infrastructure failures so several projects do not apply the same repair concurrently.
5. Verify the repaired operation in the affected testing or execution runtime. A workstation check is supporting evidence, not a substitute.
6. Resume the original checkpoint with fresh execution where necessary. Preserve completed plan items and known completed effects.
7. Resolve the incident only after verification, then monitor the next execution transition.
8. Send a concise update with outcome, evidence and next action. Ask the user only for a product decision, missing scope or an unresolved external prerequisite.

Count materially different repair attempts rather than every diagnostic call. Start with a configurable default of two unsuccessful repair strategies per incident, plus time and token budgets. Repeating the same command under unchanged conditions consumes an attempt and cannot continue indefinitely. Limits end in one actionable escalation with saved evidence.

## Implementation milestones

### Progress and review

M1 adds durable goal and execution-link storage, strict personal-workspace scope, idempotent goal creation and adoption, optimistic revisions, ownership exclusion, pause and cancellation semantics, and completion against current scoped verification evidence. Source tasks and saved work plans can be linked. Goal protection levels retain their observed maximum after source deletion. Adoption and cancellation do not start, restart or stop existing project executions.

An independent code review identified protection loss after source deletion, stale passing evidence, a goal/session lock-order inversion and conflation of independent checks. These were corrected and regression tests added. The follow-up review found no remaining blocking issues in M1. Pipeline evidence now includes stable plan-item and node identity across retries; ambiguous older pipeline records require scoped or aggregate verification for goal completion.

Validation includes the new PGlite repository suite with an actual close/reopen, pipeline-loop integration tests, the existing full-migration isolation suite, typecheck, lint, generated catalog checks and backend build. The concurrent tests validate idempotency and ownership outcomes on PGlite; multi-connection PostgreSQL lock ordering has been code reviewed, not exercised by those tests.

M2 adds authenticated goal/session APIs, the Companion page and General-agent tools, persisted model bindings, atomic session creation and action receipts, generation checks, cross-instance dispatch claims, live steering, pause/continuation and bounded inspection of adopted work. Cross-session transfers preserve numeric protection and flow labels, including label writes still pending in the originating process. Receipt results carry their own provenance. Unknown outcomes block later turns pending inspection.

The M2 review identified and corrected privacy transfer gaps, concurrent session dispatch, cleared-conversation replay, live cloud steering, retry-key lifecycle, HTTP UUID validation and completion while work remains active. The final independent review found no remaining blocking M2 issues. Validation: 64 focused backend tests and three browser scenarios passed, with typechecks, lint and build checks.

M3 adds transactionally recorded source events, coalesced persisted supervisor wakes, opt-in settings and a dedicated scoped controller conversation. The controller uses an API or local tool-capable text model; project sessions retain CLI support. Observation mode withholds mutation and generic execution/delegation tools. Pauses and stops are durable across existing command, API and gateway surfaces. Active ownership protects project recovery state from retention. Stale workers generate bounded inspection-only suspicions using progress, command receipts and human/provider waits.

Independent M3 review found and verified fixes for unstarted event loss on reconfiguration, workspace starvation, retention, pause preservation and silent CLI stalls. Backend validation includes 130 passing tests across repository, retention, controller policy and pipeline-loop suites, followed by focused reruns. Four browser scenarios pass, including persisted supervision settings and revocation. Queued automatic-action authority revalidation is explicitly required in M4 before activation.

M4 adds scoped incident detection, bounded strategies tied to automatic dispatch, fresh affected-runtime verification, automatic interrupted-observation reconciliation and evidence-backed uncertain-effect reconciliation. Queued mutations carry a revocable settings revision. Goal-level repository scope can be approved once and inherited by child pipelines. Explicit owner decisions can authorize exactly one additional strategy after escalation without rewriting prior failure history.

M5 adds an operator-configured maintenance runtime and test action in Settings → CLI tools. It has independent approved directory trees and optional host services/USB/SSH-agent access. Scoped maintenance workers can obtain an independent read-only child review. Managed activation requires tests/build/review for the current source, survives backend termination through a detached launcher and persists captured resumptions atomically with completion. An admission gate protects the wait-for-idle policy. Its managed handoff is not an OS privilege boundary for arbitrary approved scripts.

M6 adds goal execution approval/revocation, incident state and repair-attempt display, exact verification panels, minimized app-only notifications, quiet hours and notification-to-goal navigation. Workspace changes remount local form state and caches. M7 adds acyclic dependencies, per-goal and UTC daily usage accounting, shared reservations for turns/observations/stages, native child budget clamps and persistent overlapping checkout/maintenance claims, including adopted work.

M8 exercises a complete engine-driven recovery with no browser: the service boundary is deterministic, while database persistence and required process-sandbox commands are real. A persisted failure is consumed after database reopen, maintenance repairs the prerequisite, the original runtime is verified, continuation executes exactly once and the goal completes against fresh evidence. Separate tests cover external launcher success/failure, atomic captured-resume recovery, source paging, protected document references and delegation. Required-sandbox cases explicitly skip without a runner; no unconfined fallback is counted as sandbox proof. Physical device operation and a production service restart remain operational checks rather than claims made by these fixtures.

Independent reviews were run for every milestone and their blocking findings corrected. The host USB prerequisite is a separate commit; unrelated CLI compaction edits remain outside this feature. No existing live sessions or pipelines have been enrolled, and the live backend has not been restarted as part of this implementation.

### M1 Durable goals and ownership

Add shared types, migrations, scoped repositories and a supervision service skeleton. Link goals to existing tasks, work plans, sessions and pipelines. Support create, inspect, adopt, prioritize, pause, cancel and completion with evidence. Define how cancellation treats created versus adopted executions; default to preserving adopted work unless stopping it was requested.

Acceptance: a goal and its links survive restart; adopting an existing pipeline creates no duplicate run; another user cannot discover or mutate its records; stopping supervision does not silently stop an adopted project.

Suggested implementation homes are `src/core/companion/` for service, scheduling and incidents; `src/shared/companion-supervision.ts` for contracts; scoped schema and repository modules under `src/db/`; `src/tools/companion/` for model-callable operations; and `src/api/routes/companion.ts` for authenticated UI access. Keep the existing appearance types in `src/shared/companion.ts`. Register new tools through the normal catalog and role configuration.

### M2 Session management and first vertical slice

Add Companion tools and owner-scoped API operations to start a session, adopt one, inspect state and bounded history, steer it, and request pause or continuation through existing services. Keep project model bindings, protection levels and provider-specific session reuse intact. Use a focused session for ordinary tasks and a pipeline when the requested workflow needs one.

Build a minimal Companion view that accepts a goal and shows its linked work. Ensure two simultaneous requests cannot create two executions for the same action key.

Acceptance: one user request creates one goal and one intended execution; Companion can provide a verified status without the user opening that session; later steering reaches the existing execution without restarting completed work.

### M3 Durable observation and proactive continuation

Add outbox producers at the authoritative execution transitions, a consumer with leases and deduplication, event coalescing and startup reconciliation. Integrate existing monitor probes and heartbeat scheduling; retain one work owner when both notice the same condition. Add stall detection that accounts for active commands and provider waits.

Acceptance: with all browser tabs closed, a child completion wakes Companion; duplicate events cause one consequential action; a backend restart recovers a missed transition; a long healthy build is not interrupted.

### M4 Incident diagnosis and bounded recovery

Add structured blocker reports and an incident service, plus the action journal. Implement classification for test failure, environment failure, authentication failure, authorization mismatch, model availability and unknown operation outcome. Start with automatic diagnosis, authorized session continuation and repairs that existing runtime capabilities can perform.

Acceptance: an SDK visibility failure produces a diagnosis, verified runtime repair and fresh gate execution; a historical refusal does not create a new approval request after scope repair; uncertain completed effects are checked before retry; exhausting attempts produces one escalation rather than another agent loop.

### M5 Maintenance runtime and activation

Implement runtime registration and capability testing in Settings, maintenance dispatch, scoped audit records and service activation through the external launcher. Extend shared incident handling to host services. Route source-level Octipus repairs through a maintenance work session with validation and review.

Acceptance: USB/ADB and SSH-agent prerequisites can be diagnosed and repaired without transferring errors to another chat; raw private keys are never copied into a repository or transcript; an authorized restart survives termination of the original backend and resumes only the intended work; unrelated active work follows the configured interruption policy.

### M6 Companion overview and feedback

Extend the existing Companion surfaces with goals, linked sessions, dependency and incident status, recent verified outcomes, budgets and next actions. Keep detailed logs available by link. Offer actions to steer, pause, resume, reprioritize and stop supervision. Group reports about one underlying incident.

Acceptance: the user can understand what all supervised projects are doing from one view; a status claim links to current evidence; a repair produces one useful notification; quiet hours suppress routine notifications while approved background work can continue. Decisions remain visible in the app.

### M7 Cross project coordination and resource management

Add dependency scheduling, repository write coordination, shared infrastructure incident ownership, per-goal budgets and configurable concurrency. Coordinate with task checkout, pipeline workers and native CLI capacity rather than introducing an independent unlimited pool. Support persistent standing instructions through existing user memory facilities.

Acceptance: two projects depending on the same host repair wait on one incident; two sessions cannot simultaneously mutate the same checkout without an explicit isolation strategy; budget exhaustion preserves state and explains the next step; independent work continues while another goal awaits a decision.

### M8 End to end validation and rollout

Run the real acceptance scenarios below, complete code review, and release behind an opt-in Companion supervision setting. Let users adopt existing work without migration or replay. Enable capabilities incrementally: observation and session coordination first, automatic recovery next, host maintenance after its runtime is configured.

Acceptance: the complete goal-to-recovery loop succeeds with the browser closed and across a backend restart, with no duplicated deployment or cleanup. Existing direct chats, heartbeat tasks and pipelines continue to work without enrollment.

## Validation scenarios

| Scenario | Required result |
|---|---|
| Gradle or Android cache is inaccessible | Repair the runtime; execute the gate there; continue the original milestone |
| Phone appears on host but not in QA | Inspect SDK, network, ADB and USB capabilities; verify device access in QA; distinguish OS permissions and phone authorization |
| SSH responds but rejects authentication | Inspect the configured runtime's agent and identity availability; distinguish authentication from approval enforcement; verify the existing trusted connection |
| Run scope was approved but an old refusal remains | Re-read current authorization; verify the affected operation; retain historical denial records without treating them as current decisions |
| A deploy times out after possibly starting | Inspect actual deployment state before any repeat; continue acceptance when the effect already occurred |
| A user pauses work while repair is underway | Stop dispatching new work for that goal; retain evidence; do not automatically resume the paused execution |
| Several goals hit one broken host | Claim one shared maintenance incident and notify dependent goals when its verification passes |
| Backend restarts between dispatch and receipt | Reconcile journal and target state; do not infer failure or blindly repeat the operation |
| A protected document starts a new session | Preserve the source protection level, eligible model and artifact access through supervision and summaries |
| A local specialist model is unavailable | Report the actual prerequisite or use an authorized eligible alternative; never silently route general work to an OCR model |
| CI fails after a project change | Diagnose against the current commit, coordinate a fix and review, and watch the intended checks |
| A presentation request completes | Return its artifact and verify the requested content constraints without creating a development pipeline |

Use unit tests for transitions, classification, event coalescing and budgets; database integration tests for ownership, revisions, leases and restart reconciliation; API tests for delegated scope and revocation; browser tests for goal intake, adoption, decisions and incident visibility. Use fault injection for duplicate events, crashes and lost receipts. Live runtime checks must exercise the actual registered runtime, not only a mock or workstation equivalent.

## Delivery order and release boundary

Implement M1 through M4 as the first vertical slice, with only the UI needed to use and inspect it. M5 is required to solve installation-level blockers autonomously. Expand the overview and coordination through M6 and M7, then complete M8 before enabling broad unattended operation.

The first release is complete when a user can hand Companion a goal and it can keep the associated work moving through a real technical blocker, with verified recovery and no manual transfer of error reports. It must expose any remaining missing capability truthfully and preserve progress when human input is actually required.
