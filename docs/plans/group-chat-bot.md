# Group chat bot — Octipus as a member of a team channel

> **Design proposal, 2026-10-01.** Not implemented. Paths and line numbers
> reflect `main` at v0.6.0. This records the problem, the intended behaviour
> and the phased work; it is not current architecture documentation.

## Goal

A team can invite Octipus into a shared channel (Slack first, then Teams and
Telegram groups) where it:

- **answers** when addressed, with the conversation around it in view;
- **reacts** to what happens in the channel (acknowledge, flag, summarise);
- **takes up work** — turns a request in the channel into a task, works it, and
  reports back in the same thread.

Everyone in the channel sees the same bot with the same context. Each person's
own permissions still decide what the bot may do on their behalf.

Non-goals for this plan: replacing the web UI, letting unknown people drive
tools, cross-organisation channels (Slack Connect, Teams external chats), and
voice in group calls.

## What exists today

Most of the building blocks are already shipped:

| Need | Existing piece |
|---|---|
| Channel transport | `BaseChannel` + UMI (`src/channels/interface.ts`, `src/channels/index.ts`); Slack Socket Mode, Teams Bot Framework, Telegram long polling |
| Reading the channel back | `channel_history` / `channel_search` (`src/core/channels/`, [CHANNELS.md](../CHANNELS.md#reading-a-conversation-back)) |
| Admin approval of a shared chat | Notification destinations (`src/channels/notification-destinations.ts`, Admin → Notification destinations) |
| Taking up work | Task board — role assignment, checkout leases, comment threads, wake on close ([TASK-BOARD.md](../TASK-BOARD.md)) |
| Proactive turns with gating | Heartbeat — quiet hours, daily cap, quota, cheap-first probe ([HEARTBEAT.md](../HEARTBEAT.md)) |
| Progress feedback | 👀 / stall emoji reactions and typing indicator in the UMI dispatch loop |
| Data-flow safety | Flow guard — per-session `suspicious` / `private` / `secret` labels ([FLOW-GUARD.md](../FLOW-GUARD.md)) |
| Cost control | Spend budgets ([SPEND-BUDGETS.md](../SPEND-BUDGETS.md)) |

## What breaks when the bot is invited into a channel today

Verified against the code on `main`:

1. **Slack answers every message.** The single `app.message()` listener
   (`src/channels/slack/index.ts:82`) handles every message event in every
   joined channel and only *strips* a bot mention. There is no
   "was I addressed?" check, so a busy channel gets a reply to everything.
2. **Unlinked members get nagged.** An unlinked sender receives the welcome /
   link prompt on every message (`slack/index.ts:219`, `telegram/index.ts:181`,
   `teams/index.ts:177`). In a channel that is spam for everyone.
3. **No shared context.** The channel session key is
   `${channelType}-${channelId}` (`src/channels/index.ts:549`), but
   `resolveSession` looks it up per `(userId, channelType, channelId)`
   (`src/core/agent/session-resolver.ts:58`). Each person in the channel has a
   private session with the bot; it does not know what a colleague just asked.
4. **Messages carry no speaker.** The text reaching the root agent has no
   author attribution, so a shared transcript would be ambiguous.
5. **Replies are not threaded consistently.** Slack replies use the inbound
   `thread_ts` only when the message was already in a thread, so a top-level
   mention gets a top-level reply.
6. **Budgets are per user.** A `workspace` budget narrows one user's spend; it
   is not shared ([SPEND-BUDGETS.md](../SPEND-BUDGETS.md)). There is no way to
   cap what one channel costs.

Permission prompts are *currently* safe: pending approvals are keyed by the
requesting user (`src/channels/index.ts:309-343`), so only that user's "yes"
counts. Item 3's fix (a shared session) must keep that property explicitly.

## Design

### 1. Inviting the bot — channel enrolment

A channel becomes a **group channel** only after two steps:

1. Someone adds the bot to the channel in the chat platform.
2. An Octipus admin (or a workspace owner, see open questions) enrols it under
   **Admin → Group channels**, picking the channel from those the bot can see.

Until enrolled, the bot stays **silent** in that channel — no replies, no link
prompts, no reactions. DMs keep today's behaviour.

Enrolment is a new table rather than overloading notification destinations,
because it carries more than an allow bit:

```
group_channels
  id               uuid pk
  channel_type     text          -- slack | teams | telegram
  channel_id       text          -- platform conversation id
  label            text
  workspace_id     uuid          -- whose knowledge, tasks and roles apply
  owner_user_id    uuid          -- service owner; budget and fallback identity
  mode             text          -- mention | listen | proactive
  guest_access     text          -- none | answer   (unlinked members)
  default_role     text null     -- role used for "take this"
  settings         jsonb         -- rate limits, quiet hours, trigger emoji
  created_by, created_at, updated_at
  unique (channel_type, channel_id)
```

Enrolling a channel also adds it as a notification destination for its org, so
hooks, monitors and task completions can post there without a second approval.

### 2. When the bot speaks — addressing

`mention` mode (the default) responds when:

- the bot is @mentioned (Slack `<@BOT_ID>`, Teams mention entity for
  `recipient.id`, Telegram `@botname` entity or a reply to a bot message); or
- a message arrives in a thread the bot has already replied in; or
- the configured trigger emoji is added to a message (see §5).

Everything else in an enrolled channel is recorded (§3) but does not start a
turn. The addressing check lives in each channel adapter, which sets
`metadata.addressed: boolean` and `metadata.groupChannelId` on the
`UnifiedMessage`; the UMI dispatcher only starts a root-agent turn when
`addressed` is true.

Replies always go into a thread: the inbound `thread_ts` when present, else the
triggering message's own `ts` (Slack); the reply chain for Teams and Telegram.

### 3. Shared context

**Session ownership.** A group channel thread maps to one session owned by the
channel, not by a member:

- session key `group-<groupChannelId>-<threadId>` (top-level mentions start a
  new thread, hence a new session);
- `sessions.user_id` = the channel's `owner_user_id` (the column is NOT NULL);
- a new `sessions.group_channel_id` column marks it as shared;
- `resolveSession` gains a group path that skips the per-user lookup and checks
  the sender is allowed in that channel instead of matching `user_id`.

**Speaker attribution.** Each message entering a group session is stored and
sent to the model as `Anna Schmidt: can we ship on Friday?`. The display name
comes from the platform; the linked Octipus user id (or `guest`) goes into
message metadata for permission checks, never into the prompt.

**Channel transcript.** Non-addressed messages in an enrolled channel are
appended to a rolling, capped `group_channel_messages` buffer (text, author,
ts, thread) — no model call. When a turn starts, the last *N* messages of that
thread (and, for a top-level mention, the last *N* of the channel) are injected
as context, using the same whole-message trimming as `channel_history`. Older
context stays reachable through `channel_history` / `channel_search`.

Retention follows the workspace's data settings; the buffer is pruned to the
cap on write, and dropping the enrolment drops the buffer.

### 4. Who may do what

The **acting user** for a turn is the person who addressed the bot, not the
channel owner:

| Sender | Turn runs as | Tools |
|---|---|---|
| Linked member | that user | that user's permissions and role, intersected with the channel's workspace |
| Unlinked, `guest_access=answer` | `guest` principal | read-only: workspace knowledge search, `channel_history`; no write, shell, browser or outbound tools |
| Unlinked, `guest_access=none` | — | ignored silently; one ephemeral (Slack) or DM hint per person per day to `link` |

Rules that must hold:

- **Approvals stay with the requester.** A permission prompt in a group thread
  names who it is for ("@Anna, allow `shell`…?") and only that user's reply
  resolves it. Keying `pendingChannelPermissions` by `(userId, sessionId)`
  instead of `userId` alone keeps this when several members share a session.
  Channel admins may *deny* any pending request, never approve on someone's
  behalf.
- **No personal context in shared answers.** Group turns do not load the
  acting user's personal memories, persona facts or private notes. Knowledge
  retrieval is limited to the channel's workspace.
- **Flow guard is per session, so it is shared.** Once any member's turn sets
  `private` (e.g. reads their mail), later outbound calls in that thread need
  approval — including another member's. That is the conservative behaviour we
  want. In addition, `private` reads in a group session require ASK even when
  the user's own policy is ALLOW, because the result is posted to everyone.
- **The channel is `suspicious` from the start.** Messages from other members
  are text the acting user does not control, so group sessions start with the
  `suspicious` flag set.

### 5. Taking up work

Two ways to hand the bot work:

- **Ask:** "@octipus take this — draft the release notes for 0.6.1".
- **Emoji:** add the channel's trigger emoji (default `:octipus:` / 🐙) to any
  message.

Either creates a task on the board:

- title / description from the message (and its thread, summarised if long);
- `assigneeKind=role`, `assigneeRef` = the role the request names or the
  channel's `default_role`;
- requester = the acting user; workspace = the channel's;
- a back-reference to `(groupChannelId, threadId)` in task metadata.

The bot replies in the thread: "Took it — task #142, assigned to *writer*."
Comments on the task (progress, hand-off, the result) are mirrored into the
thread; replies in the thread from the requester are added as task comments.
Closing the task posts the outcome and any artifact links.

This reuses checkout leases, wake-on-close and role agents from the task board.
New code is the task ↔ thread link and the mirroring hook.

### 6. Reactions

Already present: 👀 on receipt, stall emoji, terminal state. In group channels:

- reactions are applied only to messages that addressed the bot;
- a ✅ / ❌ on the bot's own reply is recorded as feedback on that turn
  (input for session learning and future evaluation), nothing more.

### 7. Listening and proactive modes (later)

`listen` and `proactive` reuse the heartbeat's cheap-first gating:

1. global switch, enrolment mode, quiet hours, per-channel daily cap, budget;
2. pending-work probe without a model: unanswered questions older than *X*
   minutes, a task linked to this channel changed, a monitor fired;
3. only then one call to the `background` lane: "is there something useful to
   add? answer `none` or a draft".

`listen` posts nothing unprompted except task / monitor updates; it uses the
probe to *offer* ("I can take the question about the staging DB — react 🐙").
`proactive` may post the draft directly, rate-limited (default: at most one
unprompted message per channel per hour, never twice in a row without a human
message in between).

### 8. Cost

A new budget scope `group_channel` (scopeRef = `group_channels.id`) counts all
spend attributed to the channel's sessions regardless of acting user, and is
checked alongside the acting user's own budgets. At the cap the bot replies
once that it is paused for the period and goes quiet. `cost_log` rows for group
sessions need the `group_channel_id` attributed (via the session).

## Platform notes

- **Slack.** Needs the bot user id (`auth.test` on connect) to detect mentions
  reliably instead of stripping every `<@…>`. Ephemeral messages
  (`chat.postEphemeral`) give a quiet way to tell an unlinked member how to
  link. Scopes already requested cover this; `reactions:read` and the
  `reaction_added` event are new for the emoji trigger.
- **Teams.** In channels a bot only receives messages that @mention it unless
  resource-specific consent (`ChannelMessage.Read.Group`) is granted. Mention
  mode works without it; listen mode needs RSC and the app manifest change.
  History reads stay on the user's Graph token as documented.
- **Telegram.** With privacy mode on (the default) the bot only sees commands,
  mentions and replies to itself — enough for mention mode. Listen mode needs
  privacy mode off via BotFather. `chat.type` (`group` / `supergroup`)
  distinguishes groups from DMs; `allowedUsers` should apply to the *sender*,
  not block the whole group.
- **WhatsApp.** The Cloud API does not support bots in group chats; out of
  scope.

## Phases

### Phase 1 — Slack, mention mode (fixes today's problems)

- `group_channels` table, admin API and Admin page; enrolment also registers a
  notification destination.
- Slack: bot user id on connect; `addressed` detection; silent in unenrolled
  channels; no link prompts in channels (ephemeral hint, rate-limited).
- Always reply in thread.
- Group sessions: channel-owned session per thread, `sessions.group_channel_id`,
  group path in `resolveSession`.
- Speaker attribution and the capped channel transcript buffer.
- Acting-user permissions; guest principal (read-only); approvals keyed by
  `(userId, sessionId)` with the requester named in the prompt.
- Group turns skip personal memory / persona facts; start `suspicious`;
  `private` reads forced to ASK.

Acceptance:
- In an enrolled channel, an un-mentioned message produces no reply, no
  reaction and no model call (asserted in the UMI dispatch test).
- Two linked members mentioning the bot in one thread share a session; the
  second sees the first's question in context.
- Member B cannot approve member A's pending permission; A can.
- An unlinked member's mention with `guest_access=none` produces no channel
  message.
- An unenrolled channel produces no output at all.

### Phase 2 — Taking up work

- "take this" intent and emoji trigger → task creation with thread link.
- Task comment ↔ thread mirroring; completion post.
- `group_channel` budget scope and attribution.

### Phase 3 — Teams and Telegram groups

- Teams mention detection via entities, Telegram `chat.type` and mention / reply
  detection; per-platform thread mapping.
- Telegram `allowedUsers` applied per sender in groups.

### Phase 4 — Listen and proactive

- Heartbeat-style probe and background-lane check; per-channel rate limits and
  quiet hours; Teams RSC and Telegram privacy-mode docs.
- ✅ / ❌ feedback recorded for learning.

## Open questions

1. **Who may enrol a channel** — instance admins only, or workspace owners for
   their own workspace? Proposal: admins in phase 1, workspace owners later.
2. **Owner identity** — should the session owner be a real user or a dedicated
   service user per workspace? A service user avoids a group's history showing
   up in one person's session list, but needs a user row and permissions of its
   own.
3. **Visibility in the web UI** — should group sessions appear in members'
   session pickers (read-only) so the thread can be continued from the web?
4. **Transcript retention** — default cap and age for
   `group_channel_messages`, and whether it is indexed into workspace knowledge.
5. **Guest default** — `none` (safest) or `answer`? Proposal: `none`.
