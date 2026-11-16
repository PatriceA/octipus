# Companion supervision

Companion accepts outcomes, starts or adopts project sessions, monitors committed execution changes, investigates failures and coordinates bounded repairs. Goals, ownership, observations, incidents and action receipts live in the database. Closing the browser does not stop supervision.

Companion chat is optional. Open it from the highlighted card above the chat session list or from the Companion page. Its header identifies the coordinator, fixed model and supervision status; regular sessions remain available for direct work. The saved controller identity determines the distinction, independently of its title or pin.

## Start using it

1. Open **Companion** in a personal workspace. Create a goal with its original request, desired outcome and acceptance criteria, or adopt existing work.
2. Choose a tool-capable API or local model under **Models → Companion model** (also available under **Companion → Background supervision**). This is a fixed General-role binding, independent of topic assignments. Enable observation, coordination or repair. Project sessions can use CLI models; the controller and scoped maintenance workers use API/local models so their tool boundary can be enforced.
3. Approve the goal's repository execution scope when shell work is needed. This covers new commands, scripts, deployment, cleanup and credential/private-data network use within that goal. Child pipelines can inherit the same profile. Existing policy denials and filesystem boundaries still apply.
4. For installation or host repairs, an administrator configures **Settings → CLI tools → Companion maintenance runtime**. Approve directory trees and optional host networking, Docker/USB access and the existing SSH-agent socket. Test the saved runtime from the same page. No private key is copied into a repository or conversation.

Observation cannot dispatch project mutations. Coordination can start and steer owned sessions. Repair can use the configured maintenance runtime and verify an incident in its affected project runtime. Changing or disabling supervision revokes queued automatic actions. A deliberately paused session is never replaced or automatically resumed.

## Because you said…

Companion's writes are tied to your own words. Creating a goal, adopting work, starting a project or maintenance session, sending a session instructions and continuing paused work each carry a basis: a short quote of what you asked for. The server checks the quote, after folding case, accents and typographic quotes, against one of two sources:

- **Your message.** On a turn you started, the quote must appear in one of your recent messages in the Companion conversation. Assistant replies, tool output, session reports and background check-in prompts never count.
- **The goal's saved words.** Background check-ins cannot cite chat. They can quote only the words saved with the goal when it was created: what you typed into the goal form, or, for a goal Companion created from chat, your messages from that conversation. Goals saved before this change keep their request, outcome and criteria as their saved words.

Some changes need your words from the message that started the current turn: a new goal, raising a goal's token budget (or removing it), cancelling or resuming a goal and retrying an escalated incident. Background check-ins can lower a budget but never raise it, and cannot cancel or resume a goal. A goal Companion creates from chat saves only the message that asked for it as the goal's words, so background work cannot borrow authority from your other requests.

For session starts, maintenance starts and instructions, the verified quote is saved with the action and shown under **Activity** as “Because you said …”. Other bases (goal creation, adoption, resume, budget changes, incident retries) are checked but not shown yet. Only your visible messages in the current conversation count: clearing the Companion conversation retires earlier words.

A basis records where authority came from; it does not grant any. Autonomy, approvals, permission policy and the flow guard still decide what runs. The check matches text, not meaning: a real quote can still be attached to an action that stretches it, which is why the quote is shown with the action.

Messages Companion sends to project sessions start with a line saying they come from Companion, not from you, and that they cannot approve actions, raise limits or widen permissions. One visible effect: a Companion message such as “go” no longer confirms a plan that is waiting for your go-ahead; confirm it yourself. Memory extraction after a turn runs only for turns you sent yourself, so Companion handoffs, monitors and schedules are not extracted as memories. The separate session-learning review still reads Companion-run sessions for lessons and skill proposals.

## When Companion tells you something

Background check-ins are private. Their working text stays out of your Companion conversation and does not notify you. To tell you something, Companion files a report naming the matter, its impact, how strong the evidence is, any deadline and what changed. The server decides whether it reaches you:

- Only reports with **strong evidence** and **normal or high impact** are sent.
- A matter you were already told about is sent again only for a material change: the condition changed, a new option appeared, it was resolved, or a deadline moved earlier. An unanswered report is never repeated because time passed.
- At most twelve reports a day are sent across your workspaces; beyond that only high-impact reports go through.
- A check-in that cannot run (no model, a spending limit, an error) sends at most one high-impact report a day saying so.

During your Companion quiet hours a report that passes the gate is held and sent when they end, unless nothing new needs it by then (the gate runs again). A high-impact report whose deadline falls before quiet hours end is sent at once.

A sent report appears as a Companion message and triggers the usual presence notification. Reports that were held back stay under **Reports** on the Companion page (per goal, or at the top for reports about no goal) with the reason. Status updates from background check-ins are not sent. Matters are identified by the key Companion gives them; a different key for the same thing can still produce a second report. The deterministic notices for completed goals, verified repairs, failed pipelines and stalled handoffs are separate and unchanged.

## Notices and decisions away from the app

Companion's notices (a goal passed its checks, a repair passed its runtime check, a supervised pipeline failed, a queued handoff has not started) go through the regular notification service: they appear in the bell and live in every open tab, once per event. Turn on **Also send notices and decisions to my linked chats** under **Background supervision** to have them, and sent reports, delivered to your linked Telegram, Slack, Teams or WhatsApp chats as well.

When a repair reaches its limit, Companion asks whether to try one more, different fix as an approval with the options **Try another fix** and **Leave it**. It shows in the app, reaches a paired phone, and with chat notices on is posted to your linked chats, where a typed reply answers it. The answer is tied to the incident as it was when asked: if the incident changed meanwhile, nothing is retried. The question stays answerable for 24 hours (and is lost if the server restarts); after that, or if you prefer, decide on the Companion page as before. Notices and questions wait during quiet hours.

## Todo inbox and heartbeat

In the Companion conversation, ask “Put this idea on my todo list for the next heartbeat.” Companion can directly list todos and create an item or backlog on an owner-requested turn. It assigns deferred work to the requested role (`general` when unspecified), keeps the idea in the task notes and checks heartbeat readiness. Parking an idea does not start a project session immediately. Background supervision reads the board but does not create, edit, complete or check out todos; the role heartbeat owns task execution and its checkout lease.

Automatic pickup needs the heartbeat master switch, the selected role's agent and the owner's `tasks/write` ALLOW permission. Role agents are configured on the To-Do List page. A saved item is considered on the next **eligible scheduled role heartbeat**, rather than necessarily the next cron tick: quiet hours, budgets, active checkouts, blockers and higher-priority work can defer it. Creating the item does not silently enable automation or change permissions. Source protection levels and flow labels are snapshotted with parked tasks and inherited before heartbeat or task-pipeline model routing, including when the original conversation is deleted.

## Existing conversations and status questions

On an owner-requested turn, Companion can find personal conversations by title with `find_sessions` and read their workers, pipelines, remaining items, saved plan and recent messages with `read_session`. Existing conversations do not need to be enrolled first. The enrolled-goal list is not the session list; an empty goal list never proves that a named conversation is missing. Conversation status and pipeline status are distinct.

A status question only reads evidence. An explicit request to unblock or continue work uses the existing action tools: reuse or create a supervision goal, adopt the existing session/pipeline, investigate the blocker, repair within configured authority, verify and continue the same execution. It preserves the original plan and completed work. Background supervision still watches enrolled work only; it cannot browse unrelated conversations. Discovery reads inherit source protection levels and flow labels before returning content.

## When Companion looks at sessions

Companion watches sessions and pipelines enrolled through a goal; its execution links are durable subscriptions. Database triggers record meaningful goal, worker, pipeline and action changes in the same transaction as the source update. A lightweight service checks pending events every five seconds. It coalesces changes and wakes the controller model for relevant completion, failure, pause, decision/approval or uncertain-outcome events; ordinary progress does not require a model call on every check.

A separate scan runs at most once per minute for suspected stalls. It considers recorded progress, running command receipts, provider waits and approval waits; about thirty minutes without evidence of progress can request inspection. A stall suspicion does not itself stop or replay work. Events and consumption receipts survive backend restart and work with the browser closed. Budgets, concurrency and explicit pauses still control dispatch.

This supervision mechanism is separate from the periodic heartbeat that consumes role-assigned todos. It also does not require the generic monitor tool to poll each conversation.

## Recovery and evidence

Incidents preserve the affected execution, observed evidence, classification, repair strategies and current verification. Classifications are investigation hints; an authentication error does not prove that a sandbox lacks a key. A repair needs a fresh passing check in the affected runtime before resolution. Resolving a repair does not complete the goal: each acceptance criterion needs current scoped verification evidence.

The controller records a strategy before repair dispatch. Reusing a strategy or exhausting the configured limit stops automatic repair and creates one visible decision. The owner can explicitly allow one additional distinct strategy; earlier attempts and that decision remain recorded. Existing maintenance sessions can receive the new strategy without starting another agent solely to repeat approval.

Interrupted receipts are inspected rather than replayed. Unknown observations reconcile against live roots and current journals. Unknown external effects require a fresh check of the exact receipt before later work proceeds. Historical failures remain historical records after recovery.

Full requests and acceptance criteria remain available through bounded source paging. Attached document references are validated against their source scope, retained on the goal and initial action, and forwarded to project workers. Only the named source files are added to delegated file access; their directory is not implicitly opened. Protection levels and flow labels follow the source and subsequent results.

## Resource controls

Settings expose concurrent supervised sessions, daily tokens, tokens per background turn, repair strategies and quiet hours. Direct owner-driven Companion chats inherit the normal configured agent token and iteration limits, including an unlimited token budget when configured. Reserved action and wake budgets remain enforced; unattended supervision retains its configured per-turn cap. Goal scheduling supports dependencies and an optional goal budget. Dependencies must belong to the same workspace and cannot form a cycle.

Turn, observation and pipeline-stage reservations share workspace locking. Stage workers and their native child pools receive the available token slice. Timestamped usage charges the UTC day in which it occurred; legacy agent totals are a conservative fallback. Calls already in progress can exceed an estimate. Budget contention pauses at a saved checkpoint instead of classifying the project as failed.

Persistent claims serialize supervised checkout work and overlapping maintenance directories, including adopted active work. They coordinate enrolled work; unrelated external processes are not enrolled automatically. Quiet hours delay routine app notifications while authorized background work can continue. Recovery decisions and evidence remain visible on the Companion page.

## Managed activation

Maintenance source changes need passing tests, build and an independent child review bound to the current source fingerprint before managed activation. A source edit invalidates those proofs. The dedicated reviewer receives source inspection and verdict tools rather than maintenance write or activation tools.

Activation uses a durable intent and a detached launcher. The default policy waits for active work. A database admission gate closes the race with newly starting workers while the handoff runs. Completed activation, its event and captured pipeline-resume intents commit atomically. Resumes recheck owner, authority, session generation and live pipeline state; completed or already running work is not resumed again.

The managed-activation switch controls this handoff. Approved arbitrary maintenance scripts still have the server account's OS capabilities and can affect services themselves; this switch is not an OS privilege boundary. An uncertain launcher outcome is reconciled with fresh service-state evidence, without claiming that a restart happened merely because the service is healthy.

## Rollout and validation

Supervision is disabled by default, autonomy defaults to observation, and maintenance/managed activation are separately disabled. Existing chats and pipelines are not enrolled or replayed on upgrade. Shared-workspace supervision is outside this first release.

The acceptance suite exercises a deterministic agent-service boundary with a real embedded database and required Linux process sandbox: goal intake, dispatch, persisted failure, database close/reopen, automatic incident diagnosis, maintenance repair, fresh affected-runtime verification, exactly one original-session continuation and evidence-backed goal completion. Separate fixtures cover external launcher outcomes and durable resume intents. Browser scenarios cover intake, retry keys, settings, goal-wide approval/revocation and verification display.

Run the focused checks with:

```sh
npx vitest run src/core/companion src/db/repositories/companion-supervision-repository.test.ts src/core/agent/worker-spawner-metadata.test.ts scripts/companion-activate.test.ts
npx playwright test tests/web/companion-supervision.spec.ts
npm run typecheck
npm run lint
npm run catalog:check
npm run build
```

Required-sandbox acceptance cases explicitly skip where bubblewrap/firejail is unavailable; they never fall back to an unconfined execution and claim sandbox verification. Cross-connection PostgreSQL lock ordering has been code reviewed; embedded tests exercise persistent claims and transaction outcomes rather than independent PostgreSQL connections. Production service restart and a physical USB device are not exercised by the isolated fixtures.
