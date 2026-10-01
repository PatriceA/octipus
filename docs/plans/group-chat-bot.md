# Group chat bot — Octipus as a member of a team channel

> **Design plan, 2026-10-01.** Phase 1 (Slack, mention mode) is implemented;
> user-facing behaviour is documented in
> [CHANNELS.md → Group channels](../CHANNELS.md#group-channels). Phases 2–4 are
> not built. Paths and line numbers in "What breaks today" reflect `main` at
> v0.6.0, before phase 1.

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
2. A linked member types **`@Octipus join`** in the channel. They become the
   channel's **owner**, and it is attached to their default workspace.

Workspaces belong to exactly one user today (`workspaces.user_id`,
`src/db/schema/organizations.ts`), so the member who enrols is the owner of the
workspace the channel is attached to. Enrolling from inside the channel is the
membership check: only a member can post there, and it needs no extra platform
scopes (`conversations.members` would need `channels:read` / `groups:read`).
Enrolment rules:

- A channel belongs to one workspace at a time; `join` on a channel held by an
  active owner is refused privately, naming the owner.
- The owner can move it to another of their workspaces or remove it under
  **Settings → Channels → Group channels**, or type `@Octipus leave`.
- Instance admins see every enrolment under **Admin → Group channels** and can
  revoke one, but do not approve them.
- If the owner is deactivated the channel is **paused** (one notice). Any
  linked member can take it over with `@Octipus join` — the in-channel rule
  again proves membership, so there is no separate admin transfer.
- On enrolment the bot posts one message in the thread: whose workspace it
  joined for, how to address it, and how to remove it.

Until enrolled, the bot posts nothing in that channel. A member who mentions it
gets one private (ephemeral) hint a day explaining `join`. DMs keep today's
behaviour.

Enrolment is a new table rather than overloading notification destinations
(migration `0120_group_channels.sql`):

```
group_channels
  id               uuid pk
  channel_type     text          -- slack (teams | telegram later)
  channel_id       text          -- platform conversation id
  label            text          -- #name when readable
  owner_user_id    uuid          -- who enrolled it; controls the enrolment
  workspace_id     uuid          -- one of the owner's workspaces
  created_at, updated_at
  unique (channel_type, channel_id)
```

Columns for later phases (`mode`, `guest_access`, `default_role`, rate-limit
settings) are added when those phases land, not ahead of them.

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

**Session ownership.** Each member has **their own session per thread**
(`sessions.group_channel_id` + `sessions.thread_id`), and every turn runs as
that member. The owner holds the enrolment, not the conversations.

This replaces the first draft, in which the enrolling owner owned one shared
session per thread. Building it showed why that does not work: sessions,
permissions, tools, memories, knowledge and spend are all scoped to the session
owner (`handleMessage` refuses a turn whose user is not the session's owner).
Running members' requests in the owner's session would give everyone in the
channel the owner's tools and data. Per-member sessions keep every existing
boundary as it is.

**Shared context without a shared session.** When a turn starts, the adapter
reads the thread back from the platform (or the latest channel messages for a
new top-level mention) and renders it as a fenced transcript — oldest first,
whole messages only, capped at 6,000 characters, the bot's own replies marked
as "you" (`src/channels/group-context.ts`). Because the bot's replies to other
members are in the thread, the second member sees the first member's question
and the answer. The request itself is attributed: `Anna Schmidt: can we ship on
Friday?`.

No transcript is stored by Octipus in phase 1: reading the thread at turn time
is accurate, needs no retention policy, and costs one API call per addressed
message. A buffer becomes necessary only for listen mode (§7).

The session indexes: migration 0120 rewrites 0028's one-active-session-per-chat
index to skip group sessions and adds one active session per
`(user, group channel, thread)`. The 1:1 session lookup and the transcript
aggregation in the sessions API exclude group sessions.

### 4. Who may do what

The **acting user** for a turn is the person who addressed the bot, not the
channel owner:

| Sender | Turn runs as | Tools |
|---|---|---|
| Linked member | that user | that user's own permissions, tools and budgets |
| Unlinked | — | no turn; one private hint per person per day to link (in a DM — never a link code in the channel) |

Guest answers for unlinked members need a guest principal with its own
read-only tool set; that is deferred until there is a request for it.

Rules that must hold:

- **Approvals stay with the requester.** A permission prompt is posted in the
  thread, names who must answer, and resolves only on that user's reply in that
  chat and thread (`tryResolvePermissionFromChannel`); another member's "yes"
  is ignored.
- **No personal context in shared answers.** Group turns neither load nor
  extract the requester's long-term memories, and session learning skips group
  threads (other members' words must not become the requester's facts). The
  prompt tells the model the reply is visible to the whole channel. The
  persona is the requester's (it is the bot's voice, not personal data).
- **Private reads need approval.** In a group session, a call that reads the
  requester's private data (mail, drive, chat, `data`) is raised from ALLOW to
  ASK by the flow guard (`markSharedAudience` / `sharedAudienceReason`),
  because the result can end up in a reply everyone reads.
- **The channel is `suspicious` from the start.** The transcript is text the
  requester does not control, so group sessions start with the `suspicious`
  flag set; the existing trifecta rule then applies to any private read
  followed by a write.

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

### Phase 1 — Slack, mention mode (fixes today's problems) — done

Built:
- `group_channels` table and `sessions.group_channel_id` (migration 0120);
  `src/channels/group-channels.ts`.
- Enrolment with `@Octipus join` / `@Octipus leave` in the channel; takeover
  of a paused channel; owner section under Settings → Channels; Admin → Group
  channels with revoke. Routes `/api/me/group-channels`,
  `/api/admin/group-channels`.
- Slack (`src/channels/slack/group.ts`): bot ids from `auth.test`; silent in
  unenrolled channels; acts only when mentioned or in a thread it is part of;
  `link` never answered in a channel; private, rate-limited hints.
- Replies, status messages and permission prompts in the thread.
- Per-member thread sessions; thread transcript as context
  (`src/channels/group-context.ts`); attributed request.
- Approvals only from the requester in that thread; memories and learning
  skipped; group sessions start `suspicious`; private reads raised to ASK.

Deferred from the first draft: guest answers for unlinked members, and adding
the channel as a notification destination on enrolment (hooks and monitors
still need an admin-approved destination to post there).

Acceptance (each has a test):
- In an enrolled channel, an un-mentioned message produces no reply and no
  turn (`slack/group.test.ts`).
- Two members in one thread get separate sessions; the second sees the first's
  question and the bot's answer through the thread transcript
  (`group-channels.test.ts`, `group-context.test.ts`).
- Member B cannot approve member A's pending permission; A can, only in that
  thread (`permission-forward.test.ts`).
- An unlinked member's mention produces no channel message, only a private
  hint (`slack/group.test.ts`).
- An unenrolled channel produces no channel message.
- A channel enrolled by an active owner cannot be taken; a deactivated owner
  pauses it and another member's `join` resumes it (`group-channels.test.ts`).
- Private reads in a group session ask; the same read in a 1:1 session does
  not (`flow-guard-shared.test.ts`).

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

1. **Guest answers** — should unlinked members ever get read-only answers?
   Phase 1: no.
2. **Transcript retention** — only relevant once listen mode needs a stored
   buffer (§7); phase 1 stores none.
3. **Shared notifications** — should enrolment also let the owner's hooks and
   monitors post to the channel without an admin-approved destination?

## Decisions

- **2026-10-01 — Who enrols:** workspace owners enrol channels into their own
  workspaces, provided they are members of the channel; admins can revoke and
  transfer.
- **2026-10-01 — Who owns group sessions:** first decided as "the workspace
  owner who enrolled the channel". **Revised during phase 1:** each member owns
  their own session per thread and turns run as them; the owner holds only the
  enrolment. Owner-held sessions would have exposed the owner's tools and data
  to every member (§3).
- **2026-10-01 — Enrolment happens in the channel** (`@Octipus join`), which
  proves membership without extra Slack scopes; takeover of a paused channel
  uses the same command instead of an admin transfer.
