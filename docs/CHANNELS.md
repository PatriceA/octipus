# Channels

Octipus supports multiple messaging channels so you can interact with your agents from wherever you work. All channels are optional except WebChat, which is always available.

## Where settings live

Every channel setting lands in one of three places — know which before you go looking:

- **Secrets** (bot tokens, app/client secrets, signing secrets) → the **encrypted vault**, at **system scope**. Set them on the **Settings → Channels** page (or the **Secrets** page); never paste them into a config file. The vault is the source of truth for credentials.
- **Non-secret settings** (allowed-users lists, webhook URLs, polling timeouts, tenant IDs) → the **DB `settings` table**. Edit them in the Settings UI or via `PUT /api/settings/:key`.
- **`.env`** → a **first-boot seed only**. On first boot the values below are migrated into the DB/vault once; after that the **DB wins** and editing `.env` does nothing. Use the UI to change anything at runtime.

The env vars listed in each table below are therefore bootstrap hints, not the live config. See [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) for the full precedence rules.

## Architecture

Every channel extends `BaseChannel` and plugs into the **Unified Message Interface (UMI)**. The UMI normalizes messages from all channels into a common `UnifiedMessage` format and routes them to the root agent. Replies flow back through the same channel.

```
User ─── Telegram ──┐
User ─── Slack ─────┤
User ─── Teams ─────┼──► UMI ──► Root agent ──► Worker(s) ──► UMI ──► Channel ──► User
User ─── WhatsApp ──┤
User ─── WebChat ───┘
```

Channels are registered at startup in `src/channels/index.ts` and **hot-reload on save** — change a setting in the web UI and the channel picks it up without a full restart. If a channel doesn't reconnect after a token change, restart the backend.

### Attachment Processing

All channels support automatic file attachment processing. When a user sends a file (image, PDF, document), the UMI:
1. Downloads the file via the channel's API
2. Enqueues it for OCR processing (glm-ocr via Ollama)
3. Categorizes and indexes the content into the knowledge base

Supported file types: images (PNG, JPG, WEBP), PDFs, Office documents (DOCX, XLSX), and text files. Processing happens asynchronously — the user gets an immediate acknowledgment while the document pipeline runs in the background.

### Persona narration

Live swarm events (`swarm.node_spawned`, `swarm.node_completed`, `swarm.budget_warning`) are mirrored as a separate `swarm.narration` event with the active persona's rendered text — e.g., "Octipus dispatches a research arm.", "qa arm failed. Predictable." Channels subscribe independently; default volume (`persona.narration: minimal`) keeps it from flooding chats. Per-user setting; the user controls it via `/persona narration off|minimal|chatty` or the web `/persona` page. See [PROMPTING.md](PROMPTING.md#root-agent-persona).

### Side-channel messages

`chat.interject` is a gateway message type that routes a user message directly through the persona-aware `directResponse` without going through the root agent queue. The reply lands as a `chat.message` event with `sideChannel: true` and persona attribution ("Octipus — side question: …") so UIs can render it distinctly from the main thread. Useful when the user wants a quick aside while a swarm is running. The running root agent is neither cancelled nor blocked.

## Account Linking

All external channels (Telegram, Slack, Teams, WhatsApp) use the same account linking flow:

1. Send `/link` in the channel
2. You receive a 6-character code (valid for 5 minutes)
3. Enter the code in the web UI at **Settings > Channels**

Once linked, your channel identity is bound to your web account. This enables shared sessions, unified permissions, and consistent agent access across all channels.

### Outbound notifications

Hooks, scheduled tasks, monitors, notifications and agents (the `messaging` tool) may always message your own linked chats, including your 1:1 conversation with the bot. Shared channels, groups and Teams group chats or channels are different: the bot only posts there when an admin has approved the chat under **Admin → Notification destinations**, for everyone or for your org. Other targets are refused, or skipped when a hook runs. For Teams, the bot must also have received a message from the conversation once (for your personal chat: message the bot in Teams once). See [Who a hook may notify](HOOKS.md#who-a-hook-may-notify).

---

## Telegram

**Protocol:** Long polling (no public URL required)
**Library:** [grammY](https://grammy.dev/)
**Source:** `src/channels/telegram/index.ts`

### Setup

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token

### Configuration

| Setting | Env Var | Store | Description |
|---------|---------|-------|-------------|
| `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | Vault | Bot token from BotFather (secret, stored in vault) |
| `telegram.allowedUsers` | `TELEGRAM_ALLOWED_USERS` | DB-settings | Comma-separated Telegram user IDs to allow (empty = all) |

> **Finding your numeric Telegram user ID** (for `telegram.allowedUsers`): message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID. Alternatively, send `/start` to your own bot and read the backend logs (`tail -f ~/.octipus/backend.log`); the incoming update logs the sender's numeric `id`. Telegram IDs are numbers, not @usernames.

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot |
| `/help` | Show available commands |
| `/link` | Get a code to link your account |
| `/status` | Check bot status |
| `/clear` | Clear conversation history |

### Features

- Text, photo, document, voice, and video messages
- Reply-to message context
- Automatic message chunking (4096 char limit)
- Markdown formatting in responses
- Allowed-users whitelist

---

## Slack

**Protocol:** Socket Mode (no public URL required)
**Library:** [Bolt.js](https://slack.dev/bolt-js/)
**Source:** `src/channels/slack/index.ts`

### Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, name your app, select your workspace
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `chat:write` — Send messages
   - `channels:history` — Read channel messages
   - `groups:history` — Read private channel messages
   - `im:history` — Read DM messages
   - `mpim:history` — Read group DM messages
   - `users:read` — Read user profile info
   - `files:read` — Access shared files
   - `app_mentions:read` — Listen for @mentions
   - `commands` — only needed if you add the `/link` slash command (step 7)
4. Under **Socket Mode**, enable it and generate an **App-Level Token** (`xapp-…`) with `connections:write` scope. With Socket Mode on, Event Subscriptions and Interactivity are delivered over the WebSocket — **no Request URL / event endpoint is configured anywhere** (that's why Octipus settings don't ask for one; the bot connects outbound).
5. Under **Event Subscriptions**, enable events and subscribe to these **bot events**:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - `app_mention`
6. Under **App Home**, enable the **Messages Tab** and check "Allow users to send Slash commands and messages from the messages tab" — required for users to DM the bot.
7. (Optional) Under **Slash Commands**, create `/link` (the Request URL field is ignored in Socket Mode — put any placeholder). Octipus also accepts the plain message `link`. Requires the `commands` scope.
8. **Install / Reinstall to Workspace.**

> ⚠️ **The `xoxb-…` token is only valid after the app is installed to the workspace.** After installing, copy the **Bot User OAuth Token** from *OAuth & Permissions* and save it as the Slack Bot Token secret (system-scoped). If the bot fails every event with `invalid_auth` (Bolt authorizes each event via `auth.test`) and silently never replies, the loaded token is wrong/stale — re-copy and re-save. The save hot-reloads the token; if Slack still doesn't reconnect, restart the backend so it's re-read. Verify the value you save:
> ```
> curl -H "Authorization: Bearer xoxb-…" https://slack.com/api/auth.test   # expect "ok":true
> ```

### Configuration

| Setting | Env Var | Store | Description |
|---------|---------|-------|-------------|
| `slack.botToken` | `SLACK_BOT_TOKEN` | Vault | Bot token (`xoxb-...`) (secret, stored in vault) |
| `slack.appToken` | `SLACK_APP_TOKEN` | Vault | App-level token (`xapp-...`) (secret, stored in vault) |
| `slack.signingSecret` | `SLACK_SIGNING_SECRET` | Vault | Signing secret from app settings (secret, stored in vault) |
| `slack.userToken` | `SLACK_USER_TOKEN` | Vault | Optional user token (`xoxp-...`). **Only needed for `channel_search`** — Slack does not expose `search.messages` to bot tokens at all. Add the `search:read` User Token Scope under *OAuth & Permissions*, reinstall, and copy the **User** OAuth Token. Without it, `channel_search` scans one named channel's history instead and says so in its result. |

Optional scopes: `reactions:write` lets the bot mark progress on messages
with emoji (👀, ✅); without it those calls fail silently. `im:read` lets the
bot confirm that a DM belongs to you after a restart, before you have written
to it again; without it, approvals and monitor replies from background runs
reach your Slack DM only once you have sent it a message since the restart.
`channels:read` and `groups:read` let the bot read a channel's
name when it is enrolled as a [group channel](#group-channels) (otherwise the
settings pages show the channel id). `reactions:read`, with the
`reaction_added` bot event, lets members of a group channel hand the bot work
with the 🐙 reaction (without them only `@Octipus take this` does) and rate
its replies with ✅ / ❌; add the `reaction_removed` event too so a withdrawn
reaction is withdrawn as feedback.

### Features

- Direct messages and @mentions
- [Group channels](#group-channels): answers in a shared channel only when enrolled and addressed
- Thread-based conversations
- File attachments (images, documents)
- Rich message blocks with Markdown
- Socket Mode (no public endpoint needed)
- Account linking via `link` keyword
- Reading history and searching messages — see [Reading a conversation back](#reading-a-conversation-back)

### Group channels

Invite the bot to a channel and it stays **silent** there until a linked
member enrols the channel by typing `@Octipus join` in it. Typing it in the
channel is what proves the member belongs there, so there is no form for it.
The member who enrols becomes the channel's **owner**: they can remove the bot
under **Settings → Channels → Group channels** or with `@Octipus leave`.

Once enrolled, the bot:

- **answers only when addressed** — an @mention, or a reply in a thread it is
  already part of. Every other message is ignored, and costs nothing. A
  thread idle past the session retention window (`sessions.retentionDays`,
  14 days by default) is forgotten, unless it has a taken task still open:
  mention the bot to pick it up again;
- **replies in a thread** on the message that addressed it;
- **runs each turn as the member who asked**, with that member's permissions,
  tools, budgets, workspace and session — never as the owner. Each member has
  their own session per thread; what others said reaches the turn as a
  transcript of the thread (or of the latest channel messages for a new
  mention), read back with the bot token, one message per line inside a
  tagged block that members' text and display names cannot close or imitate.
  The member's own text is passed on — and stored — unchanged, so commands
  (`/stop`), plan `go` and approval replies work in threads as in a DM; the
  framing and transcript travel beside it as turn context;
- **keeps personal context out**: the requester's memories are neither loaded
  nor extracted (also not on compaction), the thread is never used for
  learning, and reading their private data (mail, drive, chat, `data`
  queries) asks for approval first, because the answer is posted where
  everyone can read it ([flow guard](FLOW-GUARD.md));
- **asks permission of the requester only** — the thread gets a prompt without
  details, the details (file, command, recipient, message) go to the requester
  as an ephemeral message only they can see, and another member's "yes" does
  not count. Prompts waiting in different threads or chats are answered where
  they were asked; a reply answers the newest one, and the confirmation names
  the tool it decided. In a thread only a bare `yes` / `no` counts — for
  permission prompts and pipeline approvals alike — so talk with colleagues
  ("no, let me check with Dana first") never answers one. A reply cannot
  answer a prompt that has not appeared yet. For a channel that has been
  removed or paused nothing is posted and a permission request is denied
  (requests do not expire, so it would otherwise hold the conversation). A
  reply in a thread only answers an approval waiting in that thread;
- **posts pipeline approvals in the thread the same way** — a prompt without
  details, the stage summary privately to the requester — including those
  raised by a monitor or another background run in that thread. In a
  removed or paused channel they are not posted and wait in the web app
  (they expire after an hour);
- **answers in the thread from a monitor** a member set up there, while the
  channel is enrolled and active;
- **takes work on** when asked: `@Octipus take this — draft the release
  notes` (alone in a thread, `@Octipus take this` takes the thread's first
  message), or a 🐙 (`:octopus:`) reaction on any message. The request
  becomes a task on the member's own board, the bot says so in the thread
  ("On it — added *Draft the release notes* to Anna's tasks") and starts on it
  there, as the member, under every rule above. While the task is open, each
  turn in that thread sees it and the member's own newest board comments, so
  a note added on the board reaches the work without being posted in the
  channel (the turn is told not to quote them; agents' comments are left
  out). `take this` must be followed by a separator (`—`, `:`, a line break)
  or nothing, so "take it easy on the wording" stays an ordinary request. The bot
  closes it when the work is done; closing it anywhere posts one line in the
  thread. Taking the same message twice finds the first task. See
  [TASK-BOARD.md](TASK-BOARD.md#tasks-taken-on-in-a-group-channel);
- **goes quiet when the channel's spend budget is used up** — one notice a day
  in the channel and no turns, until the period resets or an admin raises it
  ([SPEND-BUDGETS.md](SPEND-BUDGETS.md)). A refusal for a member's own budget
  or quota is posted in the thread without its figures. A bare `yes` / `no`
  in a thread still goes through, so a prompt raised before the budget ran
  out can be answered;
- **keeps document results in the thread** when a member shares a file with it;
- **runs only session controls** (`/stop`, `/status`, `/clear`, `/cancel`,
  `/help`) in a channel — other commands answer with the member's account
  data and must be sent in a DM.

Other members' messages are not run through the input guard (its flags make
the output guard replace replies, which would let one member silence the bot
for everyone); they are fenced as untrusted text and the session starts
`suspicious` in the flow guard. Earlier turns' transcripts are not replayed
into later ones; each turn reads the thread afresh.

Members without a linked account get one private (ephemeral) hint a day to
link; the bot never answers `link` in a channel, since a link code posted where
others can read it could be redeemed by someone else — send `link` in a DM.

If the owner's account is deactivated, the channel is paused (one notice) until
another linked member types `@Octipus join` to take it over. Admins see every
enrolment under **Admin → Group channels** and can revoke one.

#### Teams and Telegram groups

The same rules hold in Teams team channels and group chats and in Telegram
groups; the platforms differ in how the bot is addressed, where it answers and
what it can read back:

| | Slack | Teams | Telegram |
|---|---|---|---|
| Enrol / remove | `@Octipus join` / `leave` | `@Octipus join` / `leave` | `@yourbot join`, or `/join@yourbot` / `/leave@yourbot` |
| Addressed by | a mention, or a reply in a thread it is in | a mention (Teams delivers nothing else without RSC) | a mention, a `/command@yourbot`, or a reply to one of its messages |
| Answer a prompt | `yes` in the thread | `@Octipus yes` | `yes` as a reply to the prompt, or `@yourbot yes` |
| Answers in | the message's thread | the post's thread; a group chat as a whole | a reply to the message; a forum topic's own thread |
| Transcript | the thread, read back | what the bot saw (below) | what the bot saw (below) |
| Private messages | ephemeral, in the channel | the member's 1:1 chat with the bot | the member's private chat with the bot |
| Take work on | `take this …`, 🐙 | `take this …` | `take this …`; alone, as a reply, the message replied to |

- **Transcript.** Bots cannot read a Teams or Telegram conversation back
  (Teams would need Graph resource-specific consent, Telegram's Bot API has no
  history), so the transcript is built from the messages the bot saw in the
  enrolled chat — members' messages that reached it and its own replies. It is
  kept in memory only: at most 40 messages per thread, none older than a day,
  emptied by a restart and when the chat is enrolled again or left. With Telegram's privacy mode on (the default) the
  bot sees only messages addressed to it and the messages they reply to.
- **Private messages.** Hints and approval details go to the member's 1:1
  chat with the bot. Teams opens one if needed; Telegram can only write to
  someone who has started a chat with the bot (every linked member has, to
  `/link`). A hint for someone the bot cannot reach privately is posted as a
  reply to their message — hints never carry a link code. Approval details
  are never posted in the group.
- **Linking.** Teams members send `link` to the bot in a 1:1 chat for a code;
  Telegram members send `/link` in a private chat. Neither is answered in a
  group.
- **Telegram `allowedUsers`** applies to the sender: in a group, a message
  from anyone else is ignored without a reply. A bare `/command` goes to every
  bot in a group, so Octipus only takes `/command@yourbot`.
- **Telegram supergroup upgrade.** When a group becomes a supergroup it gets a
  new chat id; the enrolment and the members' sessions move with it.
- `link` and refused `join`s get their private answer once a day.
- Taken-task notices and other text the bot repeats never mention anyone: an
  `@name` from a member's message is posted with a word joiner after the `@`.

#### Listen and proactive modes

By default a group channel is in **mention** mode: the bot speaks only when
addressed. Its owner (Settings → Channels → Group channels) or an admin
(Admin → Group channels) can switch it to:

- **listen** — when a member's question has gone unanswered for 10 minutes,
  the bot may *offer* help, in the question's thread: "I could look into why
  the staging DB is slow. Mention me, or add :octopus: to the question, to
  hand it to me." It never answers the question itself.
- **proactive** — the bot may post a short answer instead, marked "Nobody
  asked me — mention me to go further."

Nothing is posted unprompted until the operator allows it:
`groupChannels.unpromptedEnabled` (`GROUP_CHANNELS_UNPROMPTED_ENABLED`, off by
default). Then, every minute, each listening channel goes through a gate that
spends no tokens — the enrolment is active, the channel is outside its quiet
hours (whole hours in its time zone; none by default), under its daily cap
(8 by default) and its minimum gap (60 minutes), and its spend budget and the
owner's own are not used up — and a probe without a model: the newest member
question (a `?` and some substance) that is still the last message of its
thread, at least 10 minutes and at most 3 hours old, posted after the bot's
last unprompted post, and not looked at before. A message that mentioned or
replied to the bot is never a candidate (a turn, or for an unlinked member a
private hint, handles it), nor is anything in a thread the bot is part of, nor
a top-level question someone else has since followed with a newer top-level
post. Only then does one call to the
model bound to the `background` topic decide: `none`, or a draft. At most one
such call per channel every 5 minutes.

That call has **no tools and sees only the channel's own recent messages**
(fenced as untrusted text): no member's data can reach it, and it acts for
nobody. It runs in the owner's "unprompted posts" session for the channel
(pinned, so retention never removes it and its cost keeps counting), so it
costs the owner's account and counts against the channel's spend budget.
Its post pings nobody, and a draft with a link in it is dropped: nobody asked
for it, and a crafted question could ask for one. A member who takes over a
paused channel finds it back in mention mode — they pay for unprompted posts
from then on, so they opt in again. The bot never posts twice in a row: an unprompted post
always answers a member message newer than its last one. A slot is claimed in
the database after the draft, so two server processes never both post.

The probe reads the conversation from the in-memory buffer (above): Slack
channels in listen or proactive mode are recorded there too. The buffer lives
in the server process that runs the chat adapter, so run Octipus as one
process (the default) when channels listen; with several, a process may not
see that a question was answered. Each platform
must deliver the messages that nobody addressed to the bot:

- **Slack** — the bot already receives every message in channels it is in.
- **Teams** — only with resource-specific consent: add the
  `ChannelMessage.Read.Group` (team channels) and `ChatMessage.Read.Chat`
  (group chats) RSC permissions to the app manifest's `authorization.permissions.resourceSpecific`
  and reinstall the app in the team or chat. Without it Teams delivers only
  mentions, and listen mode finds nothing.
- **Telegram** — turn privacy mode off in BotFather (`/setprivacy` →
  Disable), then remove and re-add the bot to the group: with privacy mode on
  it receives only commands, mentions and replies to itself.

#### Feedback on the bot's replies

A ✅ or ❌ (also 👍 / 👎) a linked member puts on one of the bot's messages
in an enrolled channel is recorded as feedback on that reply
(`group_channel_feedback`: channel, message, thread, member, ±1), one per
member and message — a second reaction replaces the first, and taking off
the reaction that is currently counted withdraws it. Admin → Group
channels shows the counts. Nothing else happens. Slack needs the
`reaction_removed` event besides `reaction_added`; Teams counts 👍 / ❤️ and
😢 / 😠. Telegram reactions are not recorded (the bot would need to be an
admin and request `message_reaction` updates).

---

## Microsoft Teams

**Protocol:** Webhook (requires public URL)
**Library:** [Bot Framework](https://dev.botframework.com/)
**Source:** `src/channels/teams/index.ts`

### Setup

1. Go to the [Azure Portal](https://portal.azure.com)
2. Create a new **Bot Channels Registration** resource
3. Note the **Microsoft App ID** and generate a **Client Secret**
4. Under Channels, add **Microsoft Teams**
5. Set the messaging endpoint to `https://your-domain.com/api/channels/teams/webhook`

### Configuration

| Setting | Env Var | Store | Description |
|---------|---------|-------|-------------|
| `teams.appId` | `TEAMS_APP_ID` | DB-settings | Microsoft App ID from Azure |
| `teams.appPassword` | `TEAMS_APP_PASSWORD` | Vault | Client secret (secret, stored in vault) |
| `teams.tenantId` | `TEAMS_TENANT_ID` | DB-settings | Azure AD tenant ID (optional, for single-tenant) |

### Features

- Message and conversation update handling
- Bot mention removal from text
- Proactive messaging via conversation references
- File attachments
- Adaptive card support

---

## Reading a conversation back

Channels are two-way. Besides replying when addressed, an agent can read what
was said — which is what makes "what did the team decide yesterday"
answerable. Two tools on the `messaging` group, behind a new `read` permission
(default ALLOW):

| Tool | What it does |
|---|---|
| `channel_history` | Recent messages from a channel or chat, newest first. Optional `after` / `before` (ISO-8601) and `thread` (a message id) to read one thread. |
| `channel_search` | Messages matching a query. Quote a phrase to match it whole. |

**Slack** reads on the bot token, so the bot must be a member of the channel —
`channel_history` says so, and names similar channels it can see, rather than
returning nothing. `target` is the channel name (with or without the `#`) or
its id. Message text is un-escaped and mentions are resolved to real names, so
a quoted decision reads as prose rather than `<@U123>`.

Search is the one asymmetric case: Slack does not allow bot tokens to call
`search.messages`. With `slack.userToken` set, `channel_search` uses Slack's
own index. Without it, pass a `target` and it scans that channel's recent
history instead, reporting `method: "scan"` and how many messages it looked
at — never an empty list that reads like "nothing matched".

**Teams** reads through Microsoft Graph on the **signed-in user's** delegated
token (the same one the `microsoft365` tool group uses), not through the bot.
The Bot Framework credential the Teams channel holds cannot read history at
all, and reading as the user is also the right privacy answer: an agent sees
exactly the conversations its user can see. `target` is `Team/Channel` (e.g.
`Engineering/General`) or a chat id — a bare channel name is refused, because
the same name exists in many teams and guessing would answer a question about
the wrong one. Search uses the Graph search API across everything the user can
see, so it needs no channel.

Transcripts are capped and trimmed by whole messages, never mid-sentence: half
a quote attributed to a named person is worse than a shorter transcript.

---

## WhatsApp

**Protocol:** Webhook (requires public URL)
**API:** [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) v21.0
**Source:** `src/channels/whatsapp/index.ts`

### Setup

#### 1. Create a Meta Business App

1. Go to [developers.facebook.com](https://developers.facebook.com) > **My Apps** > **Create App**
2. Select **Business** type > Next
3. Fill in the app name, select your Business Account > Create

#### 2. Add WhatsApp Product

1. In the app dashboard, click **Add Product** > find **WhatsApp** > **Set up**
2. This creates a test phone number and gives you a temporary access token

#### 3. Get Your Credentials

From the **WhatsApp > API Setup** page in the Meta developer dashboard:

- **Phone Number ID**: Listed under the test number
- **Access Token**: Click "Generate" for a temporary token
- **App Secret**: Go to **Settings > Basic > App Secret**

#### 4. Configure the Webhook

Your Octipus instance must be reachable from the internet. Use a reverse proxy (Cloudflare Tunnel, ngrok, etc.).

1. In Meta's **WhatsApp > Configuration > Webhook**:
   - **Callback URL**: `https://your-domain.com/api/channels/whatsapp/webhook`
   - **Verify Token**: Same value as your `whatsapp.verifyToken` setting
2. Click **Verify and Save**
3. Subscribe to the **messages** field

#### 5. For Production: Create a Permanent Token

The temporary token expires after 24 hours. For production:

1. Go to **Meta Business Suite > Settings > Business Settings > System Users**
2. Create a System User (Admin type)
3. Add assets: your WhatsApp Business Account with full control
4. Generate Token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions
5. Use this token as your `whatsapp.accessToken`

### Configuration

| Setting | Env Var | Store | Description |
|---------|---------|-------|-------------|
| `whatsapp.accessToken` | `WHATSAPP_ACCESS_TOKEN` | Vault | Cloud API access token (secret, stored in vault) |
| `whatsapp.phoneNumberId` | `WHATSAPP_PHONE_NUMBER_ID` | DB-settings | Phone Number ID from Meta dashboard |
| `whatsapp.verifyToken` | `WHATSAPP_VERIFY_TOKEN` | DB-settings | Webhook verification token (default: `octipus-whatsapp-verify`) |
| `whatsapp.appSecret` | `WHATSAPP_APP_SECRET` | Vault | Meta App Secret for signature verification (secret, stored in vault) |

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot |
| `/help` | Show available commands |
| `/link` | Get a code to link your account |
| `/status` | Check bot status |
| `/clear` | Clear conversation history |

### Features

- Text, image, document, audio, video, and location messages
- Reply-to context (quoted messages)
- Webhook signature verification (`X-Hub-Signature-256`)
- Automatic message chunking (4096 char limit)
- Media download via Graph API
- Message delivery status tracking (sent, delivered, read)
- Account linking via `/link` command

### Webhook Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/whatsapp/webhook` | Meta verification (hub.challenge) |
| POST | `/api/channels/whatsapp/webhook` | Incoming messages |

---

## WebChat

**Protocol:** WebSocket
**Source:** `src/channels/webchat/index.ts`

The built-in WebSocket chat is always available and is the primary interface through the web UI.

### Features

- Real-time bidirectional messaging via WebSocket
- Persistent sessions across page reloads
- Typing indicators
- Agent activity tracking (spawned workers, progress, completion)
- Permission request/approval flow
- Voice input support
- No configuration required

---

## Environment Variable Quick Reference

These are **first-boot seeds only** (see [Where settings live](#where-settings-live)) — set them before the first start, then manage everything from **Settings → Channels** afterward. Secrets seeded here are migrated into the vault on first boot.

```env
# ─── Telegram ────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=                    # From @BotFather
TELEGRAM_ALLOWED_USERS=                # Comma-separated user IDs

# ─── Slack ───────────────────────────────────────────────────
SLACK_BOT_TOKEN=                       # xoxb-...
SLACK_APP_TOKEN=                       # xapp-...
SLACK_SIGNING_SECRET=                  # From app settings

# ─── Microsoft Teams ────────────────────────────────────────
TEAMS_APP_ID=                          # Azure App ID
TEAMS_APP_PASSWORD=                    # Azure Client Secret
TEAMS_TENANT_ID=                       # Azure AD Tenant (optional)

# ─── WhatsApp ───────────────────────────────────────────────
WHATSAPP_ACCESS_TOKEN=                 # Meta Cloud API token
WHATSAPP_PHONE_NUMBER_ID=             # From Meta dashboard
WHATSAPP_VERIFY_TOKEN=                 # Your chosen verify token
WHATSAPP_APP_SECRET=                   # Meta App Secret
WHATSAPP_BUSINESS_ACCOUNT_ID=         # Business Account ID (optional)
```

## Troubleshooting

### Channel not connecting

- Check Settings > Channels in the web UI to verify your credentials are saved
- Check the backend logs: `tail -f ~/.octipus/backend.log`
- Ensure secrets are stored in the vault (not as plain text in env vars)

### Messages not arriving

- **Telegram**: Verify the bot token is valid by visiting `https://api.telegram.org/bot<TOKEN>/getMe`
- **Slack**: Ensure Socket Mode is enabled and the app is installed to the workspace
- **Teams**: Verify the messaging endpoint URL is reachable from Azure
- **WhatsApp**: Check that the webhook is verified (green checkmark in Meta dashboard) and subscribed to `messages`

### Account linking fails

- Link codes expire after 5 minutes — generate a new one
- Ensure the web account is logged in before entering the code
- Check that the database is reachable (link codes live in the `kv_store` table)

### Permission requests and approvals in channels

When an agent needs permission (e.g., to run a shell command), the request is forwarded to the channel where the conversation originated. Reply `yes` or `no` directly in the channel to approve or deny.

Approvals — a pipeline waiting for sign-off before its next stage, a QA
escalation, or an agent's `request_user_approval` — are posted in the chat of
the conversation that raised them, also when nobody is chatting at the time (a
monitor's wake-up, a resumed pipeline) and on Teams:

- in your own chat with the bot, or a shared chat an admin approved (see
  [Outbound notifications](#outbound-notifications)), with the details. Reply
  `yes` / `no`, or type one of the listed options to choose it. On a go /
  no-go step an option worded as a refusal ("No", "Stop Pipeline") declines,
  as a plain "no" does; when the approval asks a question, the option is the
  answer;
- in a shared chat you are talking to the bot in right now (a Telegram group,
  a Teams group chat or channel), as a prompt without the details, which can
  quote your files or mail. Only a bare `yes` / `no` from you answers it;
- in a [group channel](#group-channels) thread, by that section's rules;
- anywhere else not at all: the approval waits in the web app, which shows
  every approval along with notifications and push.

A reply answers an approval posted in that chat, or one waiting in that chat's
own conversation; a "yes" typed somewhere else does not release it. A reply
that only starts with "cancel" or "stop" ("Cancel my 3pm with Bob") is a
request, not an answer, and a message with a file is never an answer. A reply
to an approval that expired or was answered in the web app is told so once.
When a permission request and an approval wait in the same chat, a reply
answers the one posted last.

---

## Related

- [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) — how env, DB settings, and the vault interact (env is a first-boot seed; DB/vault win at runtime)
- [CONFIGURATION.md](CONFIGURATION.md) — full environment-variable reference, ports, and services
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — diagnosing connection, auth, and delivery problems
