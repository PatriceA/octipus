# Group chat bot — Octipus as a member of a team channel

> **Design plan, 2026-10-01.** All four phases are implemented: Slack
> mention mode, taking up work and channel budgets, Teams and Telegram groups,
> and listen / proactive modes with reaction feedback. User-facing behaviour
> is documented in [CHANNELS.md → Group channels](../CHANNELS.md#group-channels). Paths and line numbers in "What breaks today"
> reflect `main` at v0.6.0, before phase 1.

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
   channel's **owner**.

Enrolling from inside the channel is the membership check: only a member can
post there, and it needs no extra platform scopes (`conversations.members`
would need `channels:read` / `groups:read`). The channel is not attached to a
workspace: every request runs in the asking member's own default workspace
(§3), so a channel-level workspace would have had no effect. Enrolment rules:

- A channel has one owner at a time; `join` on a channel held by an active
  owner is refused privately, naming the owner.
- The owner can remove it under **Settings → Channels → Group channels**, or
  type `@Octipus leave`.
- Instance admins see every enrolment under **Admin → Group channels** and can
  revoke one, but do not approve them.
- If the owner is deactivated the channel is **paused** (one notice). Any
  linked member can take it over with `@Octipus join` — the in-channel rule
  again proves membership, so there is no separate admin transfer.
- On enrolment the bot posts one message in the thread: who enrolled it, how
  to address it, and how to remove it.

Until enrolled, the bot posts nothing in that channel. A member who mentions it
gets one private (ephemeral) hint a day explaining `join`. DMs keep today's
behaviour.

Enrolment is a new table rather than overloading notification destinations
(migrations `0121_group_channels.sql`, `0122_group_channels_unlink.sql`):

```
group_channels
  id               uuid pk
  channel_type     text          -- slack | teams | telegram
  channel_id       text          -- platform conversation id
  label            text          -- #name when readable
  owner_user_id    uuid          -- who enrolled it; controls the enrolment
  created_at, updated_at
  unique (channel_type, channel_id)
```

Phase 4 added `mode`, quiet hours and the unprompted-post rate limit
(migration 0124). `guest_access` and `default_role` were never needed: guests
get no answers, and every turn runs as the member who asked.

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

No transcript is stored by Octipus for Slack: reading the thread at turn time
is accurate, needs no retention policy, and costs one API call per addressed
message. Teams and Telegram bots cannot read a conversation back, so there the
adapter keeps what it saw in an in-memory buffer (`src/channels/group-buffer.ts`:
40 messages per thread, one day, gone on restart) and renders the transcript
from it.

The session indexes: migration 0121 rewrites 0028's one-active-session-per-chat
index to skip group sessions and adds one active session per
`(user, group channel, thread)`. The 1:1 session lookup and the transcript
aggregation in the sessions API exclude group sessions.
`sessions.group_channel_id` has no foreign key on purpose (0122 drops the one
0121 created): when an enrolment is removed, the members' thread sessions must
stay group sessions. With `ON DELETE SET NULL`, several thread sessions of one
member became colliding 1:1 rows and the delete failed.

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

- **Approvals stay with the requester.** The thread gets a prompt naming who
  must answer, without the tool arguments; the arguments (a path, a command,
  an email body) go to the requester as an ephemeral message
  (`BaseChannel.sendPrivate`), and are never posted publicly even when that
  fails. A reply resolves only prompts asked of that user in that chat and
  thread; prompts are queued per user + chat + thread, so waiting prompts in
  two threads or a DM do not displace each other. A reply answers the newest
  prompt, and the confirmation names the tool it decided; prompts resolved in
  the web UI or expired are dropped from the queue. In a thread only a bare
  yes/no answers (members also talk to each other there), and nothing is
  posted once the channel's enrolment is removed or paused: a permission
  request is denied (it does not expire; left pending it would hold the
  session forever), an approval waits in the web app (it expires after an
  hour). A thread reply only answers an approval waiting in that thread. Only session controls run as commands
  in a thread. Transcripts of earlier turns are not replayed. The flow
  guard's group rule is checked from the stored session before any tool
  call (`ensureSharedAudienceKnown`), so hook- or API-started runs get it;
  a failed lookup fails closed. The transcript is not passed through the
  input guard: its flags drive the output guard, which would let one member
  silence the bot for the whole thread. A prompt only becomes
  answerable once it has been posted. Pipeline approvals are posted the same
  way (details privately), by a listener keyed by the session
  (`src/channels/approval-prompts.ts`), so approvals raised by monitors and
  other background runs in a thread are posted there too. Slack group
  messages carry their `ts` as the platform message id, which the reactions
  need.
- **The request stays as typed.** The group framing (notice, transcript,
  attribution) is handed to `handleMessage` separately (`GroupTurn`) and
  delivered as per-turn context (`groupTurnContext`, stored in the message's
  `metadata.promptContext` like the memory block), so the stored message,
  commands, plan `go`, approval replies and the input guard all see the
  member's own text. Every turn in a group-thread session —
  monitors and wake-ups included — gets the shared-audience notice. Pipeline
  approvals, like permission prompts, are answered in a thread only by a bare
  yes/no (`bareReply`) and only for an approval posted in that thread or
  waiting in that session.
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

Two ways to hand the bot work in an enrolled channel:

- **Ask:** `@Octipus take this — draft the release notes for 0.6.1`. Alone in
  a thread, `@Octipus take this` takes the thread's first message.
- **React:** add 🐙 (`:octopus:`) to any message; that message is the request.

Either one, from a linked member:

1. **Puts a task on the member's own board** (their default workspace): the
   title from the request, notes naming who asked, where, and whose message
   it was, with a link back. `source = 'channel'`, and `sourceRef.sessionId`
   is the member's session for that thread — that is the task ↔ thread link,
   so no new column is needed. The member typed the command, so the task is
   created without the tasks tool's ASK, as in the web app. Taking the same
   message twice finds the first task.
2. **Says so in the thread:** "On it — added *Draft the release notes* to
   Anna's tasks."
3. **Works it now, in the member's thread session** — the session a mention
   in that thread uses, so every §3/§4 rule holds: the turn runs as the
   member, private reads ask, prompts go to the member in the thread,
   memories stay out, and the reply is posted in the thread. While the task
   is open, every turn in that thread sees it, with the member's newest board
   comments (so a note the member leaves on the board reaches the work
   without being posted in the channel). Titles and notes are fenced like the
   transcript and marked private; agents' comments are left out, and the
   tool's description lists task ids only.
4. **Finishes it:** while the thread has an open task, the root agent has one
   more tool, `complete_taken_task(taskId, result)`. It closes that task — and
   only a task taken in this thread — with the result as a board comment. It
   is not the tasks tool's general write, which stays ASK. When the agent
   needs input it asks in its reply and the task stays open; the member
   answers in the thread.

Closing the task by any route (that tool, the board, the tasks tool) posts one
line in the thread: "✅ Done: *title*", or that it was archived or removed.
Nothing is posted once the enrolment is removed or paused.

**Why not role agents** (the first draft assigned the task to a role and
mirrored the role agent's comments into the thread): a role agent works the
board unattended, in its own session, with all of the owner's tools. Posting
its comments in the channel would publish whatever it read for other tasks in
the same run, and the flow guard would not know the audience is shared.
Working the task in the member's thread session reuses every phase 1
protection instead. A member can still hand the task to a role on the board;
those comments are not posted in the channel.

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

A spend budget with scope `group_channel` (`scopeRef` = the enrolment id)
counts every `cost_log` row whose session belongs to the channel, whoever the
acting member is (`cost_log.session_id` → `sessions.group_channel_id`; no new
column, migration 0123 adds the index). Admins set it on **Admin → Group
channels**. It is filed under the channel's owner, who gets the warning and
pause notifications, and it moves with the enrolment on takeover; removing the
enrolment removes it.

- `checkSpend` applies it to every invocation in one of the channel's
  sessions (agent spawn, each LLM call, CLI start), next to the member's own
  budgets.
- Before starting a turn the channel checks it; while it is paused the bot
  posts one notice a day in the channel and starts no turns.
- A refusal posted in a thread names the channel's budget. A refusal for the
  member's own budget names no amounts there; the details are in the web app.

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
- `group_channels` table and `sessions.group_channel_id` (migrations 0121, 0122);
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
the channel as a notification destination on enrolment (hooks still need an
admin-approved destination to post there; a monitor set up in a thread
answers in it, see below).

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

### Phase 2 — Taking up work — done

Built:
- `@Octipus take this …` and the 🐙 reaction (`src/channels/slack/group.ts`)
  → a task on the member's board, linked to their thread session and worked
  there (`src/core/channels/taken-tasks.ts`, `src/channels/take-work.ts`);
  `complete_taken_task` for the root agent while the thread has open tasks.
- Task → thread: open tasks and the member's newest board comments reach every turn
  in the thread (and are dropped from replays, like transcripts); closing a
  task by any route posts one line there (`onTaskClosed`,
  `src/channels/taken-task-notices.ts`).
- `group_channel` spend budget (migration 0123): counted through the
  sessions, checked on every run in the channel, one notice a day in the
  channel while paused; set on Admin → Group channels; follows the owner.
- A refusal for a member's own budget or quota is posted in a thread without
  its figures.

Slack needs the `reactions:read` scope and the `reaction_added` event for the
🐙 trigger.

Acceptance (each has a test):
- `take this — x` creates the task on the member's board in progress, linked
  to their thread session, and announces it; taking the same message twice
  does not (`taken-tasks.test.ts`, `take-work.test.ts`).
- `take this` alone in a thread takes its first message, attributed; the 🐙
  reaction takes the reacted message, in its thread, as the reacting member;
  unenrolled channels stay silent and unlinked members get a private hint
  (`slack/group.test.ts`).
- Only tasks taken in that thread can be closed by `complete_taken_task`
  (`taken-tasks.test.ts`, `complete-taken-task.test.ts`).
- Closing a taken task by any route posts one line in its thread, not in a
  removed or paused channel (`take-work.test.ts`, `taken-tasks.test.ts`).
- A group channel budget counts every member's spend in the channel only, is
  enforced for members' runs there, notifies the owner, and stops turns with
  one notice (`spend-budgets.test.ts`, `slack/group.test.ts`).

### Phase 3 — Teams and Telegram groups — done

Built:
- The rules moved into a platform-neutral handler (`src/channels/group-handler.ts`);
  each adapter maps its events onto it (`slack/group.ts`, `teams/group.ts`,
  `telegram/group.ts`) and supplies the platform calls.
- Teams: mention entity for `recipient.id`; a team channel is keyed by its
  conversation id without `;messageid=`, the root post is the thread and
  replies are sent to `<channel>;messageid=<root>`; a group chat is one
  thread. Private messages go to the member's 1:1 chat (opened with
  `createConversationAsync` when needed). `link` in the 1:1 chat gives a link
  code. No greeting when added to a group chat or channel.
- Telegram: `group` / `supergroup` chats; `@botname`, a text mention, a
  command for this bot (`/leave@botname`; bare commands go to every bot) or a
  reply to the bot addresses it; a supergroup upgrade moves the enrolment and
  sessions to the new chat id; a
  group is one thread, a forum topic its own; `take this` replying to a
  message takes that message. `/link` is never answered in a group (it used to
  post the code there). `allowedUsers` applies per sender, silently.
- Transcripts from an in-memory buffer of what the bot saw (§3).
- Text the bot repeats gets a word joiner after an `@` that starts a word,
  so Telegram does not turn a member's `@username` into a mention.
- Prompts say how to answer on each platform (`answerHow`): Teams only
  delivers mentions, Telegram (privacy mode) mentions and replies; with the
  budget used up, a bare yes/no in an existing thread or chat still reaches
  the prompt.

Not built: reactions as a take trigger on Teams (no custom emoji) and
Telegram (the bot cannot read the reacted message), permalinks for Teams.

Acceptance (each has a test):
- The Slack rules hold unchanged on the shared handler (`slack/group.test.ts`).
- A reply to the bot addresses it; a chat without threads is never
  "followed"; `take this` takes the replied-to message
  (`group-handler.test.ts`).
- Teams thread / group-chat mapping and mention detection
  (`teams/group.test.ts`); Telegram mentions, commands, replies, forum topics
  (`telegram/group.test.ts`); the buffer's bounds (`group-buffer.test.ts`).

### Phase 4 — Listen and proactive — done

Built:
- Migration 0124: `group_channels.mode` (`mention` / `listen` / `proactive`),
  quiet hours and time zone, daily cap and minimum gap, the claimed slot
  (`last_unprompted_at`, `unprompted_day`, `unprompted_count`); the
  `group_channel_feedback` table. Set by the owner (`PATCH
  /api/me/group-channels/:id`) or an admin (`PATCH
  /api/admin/group-channels/:id`) on the settings pages.
- `groupChannels.unpromptedEnabled` (off by default) is the global switch.
- `src/channels/group-listen.ts`, on the cron tick: the gate (switch, active
  enrolment, quiet hours, cap, gap, channel and owner budgets), a probe
  without a model (the newest member question still last in its thread, 10
  minutes to 3 hours old, after the last unprompted post, not seen before),
  then one `background` call — `none` or a draft. `listen` posts an offer
  with the platform's handover; `proactive` a short answer. The slot is
  claimed after the draft by a conditional UPDATE.
- Slack records listening channels in the group buffer, like Teams and
  Telegram; the bot's own posts are recorded so an answered question is not
  "unanswered".
- ✅ / ❌ (👍 / 👎) on the bot's messages: `handleGroupFeedback`, from Slack
  `reaction_added` / `reaction_removed` and Teams `messageReaction`; counts on
  Admin → Group channels.
- Teams RSC and Telegram privacy-mode setup in CHANNELS.md.

Decisions:
- **The unprompted call has no tools and no requester.** Nobody asked, so no
  member's permissions or data may be used; running it as the owner with
  tools would repeat the problem §3 rejected. It sees only the channel's
  recent messages, which every member can already read, and its cost is the
  owner's (the owner chose the mode) and the channel's budget.
- **An offer, not an answer, in listen mode.** The member who wants the help
  hands it over with a mention or 🐙, and then every phase 1–2 rule applies.
- **The slot is claimed after the draft.** A `none` costs one model call but
  no slot; a race between processes costs at most one extra call, never two
  posts.
- **Feedback is recorded, nothing more.** It is input for evaluation and
  session learning later; it changes no behaviour now.

Not built: feedback from Telegram reactions (the bot must be an admin and
request `message_reaction` updates); unprompted posts about monitors and task
updates (those already post in every mode).

Acceptance (each has a test):
- The gate spends nothing on a paused, quiet, capped, too-soon or
  out-of-budget channel, or without an unanswered question; `none` posts
  nothing; the bot never posts twice in a row; a lost claim posts nothing
  (`group-listen.test.ts`).
- The slot honours the gap, the daily cap and the local day, and never in
  mention mode; settings are owner/admin only and validated; feedback is one
  per member and message (`group-channels.test.ts`).
- Reactions on the bot's replies are recorded, others ignored
  (`slack/group.test.ts`); the settings form saves the mode and quiet hours
  (`tests/web/group-channels.spec.ts`).

## Fixed after the phase 1 review

The review found two problems that were not specific to group channels:

- **Approvals rode on per-message subscriptions.** The dispatcher posted
  `approval_required` only for a turn started by an inbound message with a
  platform message id, so approvals raised by background runs (monitors,
  resumed pipelines) reached no chat, and Teams, whose messages carry no
  message id, never showed them (nor progress messages). Approvals are now
  posted by one listener keyed by the session
  (`src/channels/approval-prompts.ts`), like permission prompts: in a group
  thread by the rules of §4; with their details where the bot may message the
  user unattended (`resolveTarget`); as a prompt without details in another
  shared chat the user is talking in. Progress no longer needs a message id;
  only reactions do.
- **"yes" in any chat answered the user's single pending approval, wherever it
  was raised.** A reply now answers only an approval posted in that chat (and
  thread), or one waiting in the same session; everything else is answered in
  its own chat or the web app. An option's exact label chooses it, as the web
  app's buttons do (only in the user's own chat). On a go / no-go gate an
  option worded as a refusal declines; for a pipeline's question
  (`ApprovalKind 'question'`) the option is the answer.

The review of that fix also tightened what counts as an answer ("Cancel my
3pm" is a request; a message with a file never answers), made a late reply to
an expired approval say so instead of starting a turn, answers whichever of a
permission prompt and an approval was posted last, and lets a monitor set up
in a group thread answer there (its reply was refused as an unapproved
destination, so approving its step led nowhere).

## Open questions

1. **Guest answers** — should unlinked members ever get read-only answers?
   Phase 1: no.
2. **Transcript retention** — Slack stores none in mention mode; Teams,
   Telegram and listening Slack channels keep an in-memory buffer (§3). A
   restart forgets it, so a question asked just before one is not offered
   help; a stored buffer would need a retention policy.
3. **Shared notifications** — should enrolment also let members' hooks post
   to the channel without an admin-approved destination? (A monitor set up in
   a thread already answers there.)

## Decisions

- **2026-10-01 — Who enrols:** any linked member of the channel (originally
  "workspace owners into their own workspaces"; the workspace link was dropped
  after review, see §1); admins can revoke and
  transfer.
- **2026-10-01 — Who owns group sessions:** first decided as "the workspace
  owner who enrolled the channel". **Revised during phase 1:** each member owns
  their own session per thread and turns run as them; the owner holds only the
  enrolment. Owner-held sessions would have exposed the owner's tools and data
  to every member (§3).
- **2026-10-01 — Enrolment happens in the channel** (`@Octipus join`), which
  proves membership without extra Slack scopes; takeover of a paused channel
  uses the same command instead of an admin transfer.
- **2026-10-01 — Taken work runs in the member's thread session**, not as a
  role assignment (§5): role agents work unattended with all of the owner's
  tools, so their comments could not be posted in a shared channel safely.
