# Channels

Octipus supports multiple messaging channels so you can interact with your agents from wherever you work. All channels are optional except WebChat, which is always available.

## Where settings live

Every channel setting lands in one of three places — know which before you go looking:

- **Secrets** (bot tokens, app/client secrets, signing secrets) → the **encrypted vault**, at **system scope**. Set them on the **Settings → Channels** page (or the **Secrets** page); never paste them into a config file. The vault is the source of truth for credentials.
- **Non-secret settings** (allowed-users lists, webhook URLs, polling timeouts, tenant IDs) → the **DB `settings` table**. Edit them in the Settings UI or via `PUT /api/settings/:key`.
- **`.env`** → a **first-boot seed only**. On first boot the values below are migrated into the DB/vault once; after that the **DB wins** and editing `.env` does nothing. Use the UI to change anything at runtime.

The env vars listed in each table below are therefore bootstrap hints, not the live config. See [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) for the full precedence rules.

## Architecture

Every channel extends `BaseChannel` and plugs into the **Unified Message Interface (UMI)**. The UMI normalizes messages from all channels into a common `UnifiedMessage` format and routes them to the orchestrator. Replies flow back through the same channel.

```
User ─── Telegram ──┐
User ─── Slack ─────┤
User ─── Teams ─────┼──► UMI ──► Orchestrator ──► Worker(s) ──► UMI ──► Channel ──► User
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

Live swarm events (`swarm.node_spawned`, `swarm.node_completed`, `swarm.budget_warning`) are mirrored as a separate `swarm.narration` event with the active persona's rendered text — e.g., "Octipus dispatches a research arm.", "qa arm failed. Predictable." Channels subscribe independently; default volume (`persona.narration: minimal`) keeps it from flooding chats. Per-user setting; the user controls it via `/persona narration off|minimal|chatty` or the web `/persona` page. See [PROMPTING.md](PROMPTING.md#orchestrator-persona).

### Side-channel messages

`chat.interject` is a gateway message type that routes a user message directly through the persona-aware `directResponse` without going through the orchestrator queue. The reply lands as a `chat.message` event with `sideChannel: true` and persona attribution ("Octipus — side question: …") so UIs can render it distinctly from the main thread. Useful when the user wants a quick aside while a swarm is running. The running orchestrator is neither cancelled nor blocked.

## Account Linking

All external channels (Telegram, Slack, Teams, WhatsApp) use the same account linking flow:

1. Send `/link` in the channel
2. You receive a 6-character code (valid for 5 minutes)
3. Enter the code in the web UI at **Settings > Channels**

Once linked, your channel identity is bound to your web account. This enables shared sessions, unified permissions, and consistent agent access across all channels.

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

### Features

- Direct messages and @mentions
- Thread-based conversations
- File attachments (images, documents)
- Rich message blocks with Markdown
- Socket Mode (no public endpoint needed)
- Account linking via `link` keyword

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

### Permission requests in channels

When an agent needs permission (e.g., to run a shell command), the request is forwarded to the channel where the conversation originated. Reply `yes` or `no` directly in the channel to approve or deny.

---

## Related

- [CONFIGURATION-PRECEDENCE.md](CONFIGURATION-PRECEDENCE.md) — how env, DB settings, and the vault interact (env is a first-boot seed; DB/vault win at runtime)
- [CONFIGURATION.md](CONFIGURATION.md) — full environment-variable reference, ports, and services
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — diagnosing connection, auth, and delivery problems
