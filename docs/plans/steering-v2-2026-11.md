# Steering v2: messages sent while a CLI turn runs (2026-11)

Date: 2026-11-25, updated 2026-11-28
Status: planned, queued after the backend port to Rust. 0.8.0 is the last
Node.js release; this work starts on the Rust backend
([roadmap](../../ROADMAP.md#big-break-the-backend-moves-to-rust)). Nothing here is started.
File references (`src/...`) point to the Node.js backend as of 0.7.0. They move
with the port; the behaviour they describe remains the requirement.
Builds on §3 "Explicit send modes" of
[orchestration-gaps-2026-11](orchestration-gaps-2026-11.md),
which shipped `mode: auto | queue | steer | restart` and the `chat.delivery`
outcome. Companion plan: [ecosystem-learnings-2026-11.md](ecosystem-learnings-2026-11.md).

We compared how T3 Code, Orca, OpenBot and OpenMausBot deliver a message into a
running agent turn with how Octipus does it, reading code on both sides.

## Where Octipus stands

What works and stays:

- One server path for every send, four modes, an honest outcome
  (`steered | queued | restarted | refused`) with a reason
  (`src/core/gateway/protocol.ts:351-362`, `message-handler.ts:369-410`).
- Steers pass the input guard like a normal turn (`message-handler.ts:116`).
  None of the four projects do this.
- Only the running root is steered; it decides on `steer_child`. A waiting
  `collect_children` wakes without cancelling children
  (`src/core/agent/steering-target.ts`).
- Room turns and Companion briefings are never steered.
- Claude: waits for the running tool, sends a streaming `interrupt`, then one
  user message per batch; `--replay-user-messages` gives `steering_submitted`
  and `steering_delivered`; 30 s fallback; unacknowledged input is kept for up
  to two follow-up runs, then a visible note and `guidance_pending`
  (`src/core/cli-agent-worker.ts:265-350`, `docs/CLI-AGENTS.md:620-648`).

Gaps:

| # | Gap | Where | What the others do |
|---|---|---|---|
| G1 | Codex runs as `codex exec`: no live input. Guidance waits for an Octipus tool call or a follow-up run. | `src/core/cli-adapters.ts:1132-1150` | All four use app-server `turn/steer` with `expectedTurnId` |
| G2 | Claude steering uses `interrupt`, which aborts the model's current generation. | `cli-agent-worker.ts:287` | T3 sends a user frame with `priority: "next"` (moved off `"now"` after #21895; #25796 shows steers can abort compaction) |
| G3 | A steer waits behind a long foreground tool (subagent, long shell command). | same | Orca and T3 move foreground subagents and Bash to the background first (5 s cap); OpenMausBot stops the turn after 60 s |
| G4 | Possible duplicate: the message is pushed, the worker may write it to the CLI at once, then a status check that fails re-routes it as a new turn. Not reproduced. | `message-handler.ts:129-136` | OpenMausBot returns `indeterminate` and never re-queues it |
| G5 | Queued messages live in an in-memory map; lost on restart; `/stop` drops all. | `src/core/session-turn-lock.ts` | All four store queued messages durably |
| G6 | No per-message actions: edit, cancel, reorder, promote to steer. | — | All four (reorder: Orca, OpenBot; API-only at T3) |
| G7 | Web composer always sends `auto`; no choice, no queued cards, no delivery badge. `steering_*` events are not shown. | `web/app/chat/page.tsx:1778` | Enter = default, Mod+Enter = other, Mod+Shift+Enter = steer the first queued message; "Steer · waiting to be read" badge |
| G8 | Messages with files are never steered. | `message-handler.ts:387` | Claude accepts images in a steer (OpenMausBot); T3 restarts the turn |
| G9 | No steer before the vendor turn exists; no steer to buffered CLIs (Vibe, Antigravity) or ACP agents. | `steering-target.ts:40` | T3 and OpenBot park the steer until the turn starts; ACP strategies per agent |

## Principles

1. The client sends an intent; the server resolves it against live state when
   the message arrives (already true; keep it).
2. A steer has three results: `steered` (in the live turn), `refused` (provably
   not delivered, safe to queue), `indeterminate` (maybe delivered, never
   re-queued, shown as "delivery not confirmed").
3. Every message gets a stable id before any delivery attempt; retries are
   keyed on it.
4. People's messages may wake a waiting model. Messages from Companion,
   monitors, schedules and other agents wait for running tools and never
   interrupt.
5. Steers keep passing the input guard and stay root-only.
6. Each adapter declares its capabilities; nothing is decided by adapter name.

---

## S1. Three-state steer result (fixes G4)

Change:
1. `SteerableRoot.steer()` returns `'steered' | 'refused' | 'indeterminate'`.
   The CLI worker returns `indeterminate` when the message was written to the
   CLI's input and the turn ended before acknowledgement.
2. `steerRunningRootAgent` falls back to the queue only on `refused`. On
   `indeterminate` it stores the user message as steered, marked unconfirmed,
   and the delivery says so.
3. Test: a worker that finishes between `steer()` and the status check; the
   message runs once.

Effort: low. First, because it is a correctness fix.

## S2. Adapter capability contract (supports G1, G8, G9)

Change: each adapter declares:

| Flag | Meaning |
|---|---|
| `midTurn` | `native` / `interruptRestart` / `none` |
| `steerWaitsForTools` | the steer is read after running tools finish |
| `steerAcceptsImages` | images can ride a steer |
| `readReceipts` | the adapter can confirm the model read it |
| `steerDuringCompaction` | a steer does not abort compaction |

`findSteeringTarget` and `auto` resolve from these flags:
- `native`: steer.
- `interruptRestart`: queue in `auto`; restart only in an explicit `restart`.
- `none`: queue.

Replaces the `bufferOutput` check in `acceptsMidTurnSteering`.

Effort: low.

## S3. Codex through the app-server (fixes G1), decided 2026-11-25

Exists: `codex app-server` already runs for compaction
(`src/core/cli-compaction.ts:97`). The TypeScript Codex SDK is not an option:
it spawns `codex exec` and gains nothing.

Steps:
1. Spike against the Codex version Octipus pins:
   - record `thread/start`, `turn/start`, `turn/steer` (`expectedTurnId`),
     `turn/interrupt`, approvals and event shapes;
   - save the runs as replay fixtures.
2. A Codex app-server adapter for root runs:
   - map events, approvals and sandbox flags to what `codex exec` does today;
   - resume uses the thread id.
3. Steering:
   - `turn/steer` with `expectedTurnId` and the message id;
   - on error or "no active turn", retry once against a newly started turn,
     then `turn/start` (Orca's order).
4. Keep `codex exec` as a fallback behind a setting only until the adapter
   has run the acceptance workflows in `docs/plans/cli-agent-compatibility.md`,
   then remove it.
5. Use the app-server for limits too:
   - read rate limits with `account/rateLimits/read` and feed them into the
     quota tracker (`resetsAt`);
   - log in to a ChatGPT account through `account/login/start` for personal rows.
6. Steering must not change model or effort; a queued message that changes
   them waits for a new turn.

Acceptance:
- A steer sent during a long Codex turn reaches the same turn.
- Approvals still reach the user.
- `/stop` interrupts.
- Resume after a restart works.

Effort: medium–high. Largest item; do the spike first.

## S4. Claude delivery without an interrupt (fixes G2, eases G3)

Steps:
1. Measure today's path on the pinned CLI, using recorded fixtures plus one
   live check:
   - time from send to read;
   - aborted generations;
   - aborted compactions.
2. Try a user frame with `priority: "next"` instead of `interrupt` + frame.
   Keep the 30 s fallback and the replay acknowledgement. If `"next"` is not
   honoured by the pinned version, keep `interrupt`.
3. Before steering a person's message, move foreground subagents and shell
   commands to the background if the CLI exposes it (Orca
   `claude-structured-message-options.ts:176-206`, 5 s cap).
4. If a person's steer is still unread after 60 s while a tool runs, show
   "Stop & send" in the UI. Do not stop automatically: OpenMausBot's automatic
   stop can run a message twice (#7459).
5. Allow images in a Claude steer (`steerAcceptsImages`).

Effort: medium.

## S5. Durable queue (fixes G5)

Change:
1. Table `session_followups`:
   - `id`, `session_id`, `owner_id`, `content`, file refs, `mode`, `position`;
   - `status`: `pending | dispatching | dispatched | cancelled | interrupted`;
   - `created_at`, `source`: web, tui, channel, companion, monitor, hook.
2. `withSessionTurn` waiters for user messages reference a row; the row is
   written before the waiter is created.
3. On boot:
   - `pending` rows are restored in order;
   - `dispatching` rows become `interrupted` and are shown, never replayed.
4. `/stop` cancels the user's `pending` rows and the reply lists them.
5. A steer that arrives before the vendor turn has an id is parked on its row
   and promoted when the turn starts (G9).

Effort: medium.

## S6. Queue operations (fixes G6)

Change: gateway messages `chat.queue.list`, `chat.queue.edit`,
`chat.queue.cancel`, `chat.queue.reorder`, `chat.queue.promote` (steer the
item now).

Edit places a hold that blocks dispatch. Saving replaces the text. Cancelling
the edit restores the original. A message that already went out is never sent
twice: edit returns `dispatched` and the draft gets the text back. Slash
commands are never promoted to a steer. Each answer is `done | dispatched |
missing`.

Effort: medium.

## S7. Composer UX (fixes G7)

Web, TUI and PWA, same conventions as the other four.

Keys:
- Enter sends using the default.
- Mod+Enter does the other one while a turn runs.
- Mod+Shift+Enter steers the first queued message.
- Holding the modifier for 150 ms changes the Send button to show what will
  happen.
- Long-press on touch devices.

Queued cards above the composer:
- Edit, Delete, Steer now, and drag to reorder.
- "Stop & send" for adapters with `midTurn: none`.

Badges:
- "Sent mid-turn".
- "Steer · waiting to be read", until `steering_delivered`.
- "Delivery not confirmed" for `indeterminate`.

Settings:
- Default follow-up behaviour (steer or queue), per device and per session.
- The copy never says "interrupt" for a steer (OpenMausBot #6204).

Stop: the text of any unread steer is quoted so it is not lost (T3).

Tests: Playwright for keys, cards, badges and Stop & send.

Effort: medium.

## S8. Unread steers at turn end

Change: keep today's follow-up runs. When none is possible, the unread steer
goes back into the queue at its original position instead of only producing a
note. Count a steer as read only once the agent acts after it (OpenBot's ACP
rule) where the adapter has no replay acknowledgement. Transcript order inside
a turn with steers follows time (OpenBot #7717).

Effort: low–medium.

## S9. Other senders

- Channels keep `queue` as the default. Add `/steer <text>` in Telegram, Slack,
  Teams and WhatsApp for an explicit steer; the reply says what happened.
- Companion, monitors and hooks keep steering through
  `AgentService.steer`, marked `waitsForTools` (principle 4).
- `octipus_chat` and the MCP server get `mode` and return the delivery outcome
  (T3 `t3_thread_send`).

Effort: low.

## S10. ACP agents (generic ACP adapter, decided 2026-11-25)

The adapter itself is planned in
[ecosystem-learnings F3](ecosystem-learnings-2026-11.md#f3-generic-acp-adapter).
Antigravity moves to it (F4), which ends the "buffered, no mid-turn input"
state of G9 for agy ≥1.5.0.

ACP has no standard steer. Strategies per agent, declared through S2:

1. An extension method (`_session/steering`); an error code means `refused`.
2. A second `session/prompt` on the same session, serialised; wait for the
   turn's first update. Antigravity ≥1.5.0, Devin
   (`cognition.ai/midTurnPrompts`).
3. `session/cancel` once per prompt, then resend with the steer
   (`interruptRestart`).

Images are refused until an agent declares support.

Unknown agents start as `midTurn: none` (queue) until their `initialize`
response or a flavor entry says otherwise.

Effort: medium, inside the ACP work.

---

## Testing

- The resolution from intent and capabilities to an outcome is a pure
  function with a table test (OpenMausBot `admission.ts` style).
- Race tests: turn ends during steer; steer before turn start; edit during
  dispatch; `/stop` with a queue.
- Replay fixtures recorded from real Claude and Codex runs for S3 and S4.
- Restart test: queued messages survive, dispatching ones become interrupted.
- Playwright for S7.

## Order

1. S1: correctness, small.
2. S2: the contract the rest uses.
3. S4 step 1 and S3 step 1: measurement and spike, in parallel.
4. S5 and S6: durable queue and operations.
5. S7: composer UX on top of S5/S6.
6. S3 steps 2–6 and S4 steps 2–5.
7. S8 and S9.
8. S10 together with the generic ACP adapter (ecosystem F3) and Antigravity
   on ACP (F4).

## Not doing

- Automatically stopping a turn because a steer is unread.
- Steering room turns.
- A model choosing between queue and steer (OpenMausBot #1809 proposal).
- Steering from channels by default.

## Open questions

1. Default follow-up behaviour: keep `auto` (steer) or switch to queue as Orca
   does?
2. Is `/stop` dropping queued messages still wanted once they are visible and
   cancellable one by one?

Decided 2026-11-25: Codex moves to the app-server and `codex exec` is removed
once proven; Antigravity and other ACP agents go through the generic ACP
adapter; Claude stays on the CLI.

## Appendix: how the five apps compare (2026-11-25)

Read from the code of each project (T3 Code, Orca, OpenBot and OpenMausBot,
shallow clones of 2026-11-25) and of Octipus 0.7.0.

| | Octipus | T3 Code | Orca | OpenBot | OpenMausBot |
|---|---|---|---|---|---|
| Default while a turn runs | `auto` (steer if possible, else queue) | steer | queue | steer, per-agent override | steer |
| Per-message choice | none in the web UI | Mod+Enter | Mod+Enter, 150 ms preview | Tab steers | Mod+Enter, double Enter |
| Queued messages | in memory; `/stop` drops all | stored; edit, cancel, send now | stored; edit, reorder, delete, steer, pause | stored; edit, reorder, steer, side thread | stored; edit, delete |
| Claude | interrupt after the running tool, then a user frame; replay receipt; 30 s fallback | SDK, `priority: "next"` | stream-json, `priority: "now"` after backgrounding foreground work | SDK, `"now"` for people, agents wait | plain user frame; result held 2 s |
| Codex | `codex exec`, no live input | `turn/steer` | `turn/steer`, retry, then `turn/start` | `turn/steer` | `turn/steer` |
| ACP agents | none | cancel + re-prompt or native | one cancel, then resend | three strategies | three strategies |
| Files in a steer | never steered | forces restart | queued | text only (Claude) | images to Claude |
| Read receipt | events exist, not shown | badge "waiting to be read" | dispatch state | read once the agent acts | steered / refused / indeterminate |
| Channels | always queue | n/a | Slack and Linear steer | never automatically | Slack always queues |

Octipus is ahead in three places:
- **Input guard:** steers pass the same input guard as a normal turn.
- **Root-only steering:** user steering goes to the root, which decides on
  `steer_child`.
- **One targeting rule:** Companion and monitors use the same rule as user
  messages.

Vendor SDKs (checked 2026-11-25) change little here:
- **Codex:** the TS Codex SDK spawns `codex exec`.
- **Claude:** the Agent SDK spawns the same binary as the CLI. It documents
  `priority`, `interrupt()` and `setModel()`, which the raw stream-json
  protocol leaves undocumented.
- **Antigravity:** the Python SDK has no Google-account login. Steering and
  approval relay come from `agy acp`.

See [ecosystem-learnings F1](ecosystem-learnings-2026-11.md#f1-sdks-give-little-the-vendors-interactive-protocols-give-the-most).

## References

| Topic | Where |
|---|---|
| Intent resolved on the server, capability flags | T3 `apps/server/src/orchestration-v2/CommandPolicy.ts:130-340` |
| Claude `priority: "next"`, read receipts | T3 `ClaudeAdapterV2.ts:14585-14710`, `ProviderAdapter.ts:164-172` |
| Re-queue an unread steer in place | T3 `Orchestrator.ts:3600-3700` |
| Codex `turn/steer` with retry and fallback | Orca `codex-structured-turn-steer.ts`, `codex-structured-turn-start.ts` |
| Background foreground work before a steer | Orca `claude-structured-message-options.ts:176-240` |
| Queued message wire (edit hold, reorder, delete) | Orca `agent-session-queued-message-wire.ts` |
| Chord preview | Orca `use-native-chat-steer-chord-preview.ts` |
| Three-state result, admission table | OpenMausBot `server/contracts.ts:327-385`, `admission.ts:102-131` |
| Durable follow-ups, no replay of uncertain dispatch | OpenMausBot `steer-queue.ts`, `chat-followups-restart.test.ts` |
| Steers replayed as "you may already have it" | OpenMausBot `server/delta-context.ts` |
| Read only after the agent acts, `unreadSteers` | OpenBot `acp-client.ts`, `turn-lifecycle.ts` (ideas only, PolyForm NC) |
| Issues | T3 #231, #21895, #25796, #15611; Orca #22887, #44833, #14832; OpenBot #10053, #9841, #7717; OpenMausBot #6204, #3207, #7459 |
