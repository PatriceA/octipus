# Channels

The Assistant supports multiple messaging channels so you can interact with your agents from wherever you work. All channels are optional except WebChat, which is always available.

## Architecture

Every channel extends `BaseChannel` and plugs into the **Unified Message Interface (UMI)**. The UMI normalizes messages from all channels into a common `UnifiedMessage` format and routes them to the orchestrator. Replies flow back through the same channel.

```
User ─── Telegram ──┐
User ─── Slack ─────┤
User ─── Teams ─────┼──► UMI ──► Orchestrator ──► Worker(s) ──► UMI ──► Channel ──► User
User ─── WhatsApp ──┤
User ─── WebChat ───┘
```

Channels are registered at startup in `src/channels/index.ts` and support **hot-reload** — change a setting in the web UI and the channel reconnects automatically.

### Attachment Processing

All channels support automatic file attachment processing. When a user sends a file (image, PDF, document), the UMI:
1. Downloads the file via the channel's API
2. Enqueues it for OCR processing (glm-ocr via Ollama)
3. Categorizes and indexes the content into the knowledge base

Supported file types: images (PNG, JPG, WEBP), PDFs, Office documents (DOCX, XLSX), and text files. Processing happens asynchronously — the user gets an immediate acknowledgment while the document pipeline runs in the background.

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

| Setting | Env Var | Description |
|---------|---------|-------------|
| `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | Bot token from BotFather (stored in vault) |
| `telegram.allowedUsers` | `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs to allow (empty = all) |
| `telegram.webhookUrl` | `TELEGRAM_WEBHOOK_URL` | Webhook URL (leave empty for polling mode) |
| `telegram.pollingTimeout` | `TELEGRAM_POLLING_TIMEOUT` | Polling timeout in seconds (default: 30) |

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
4. Under **Socket Mode**, enable it and generate an **App-Level Token** with `connections:write` scope
5. Under **Event Subscriptions**, enable events and subscribe to:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - `app_mention`
6. Install the app to your workspace

### Configuration

| Setting | Env Var | Description |
|---------|---------|-------------|
| `slack.botToken` | `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) (stored in vault) |
| `slack.appToken` | `SLACK_APP_TOKEN` | App-level token (`xapp-...`) (stored in vault) |
| `slack.signingSecret` | `SLACK_SIGNING_SECRET` | Signing secret from app settings (stored in vault) |

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

| Setting | Env Var | Description |
|---------|---------|-------------|
| `teams.appId` | `TEAMS_APP_ID` | Microsoft App ID from Azure |
| `teams.appPassword` | `TEAMS_APP_PASSWORD` | Client secret (stored in vault) |
| `teams.tenantId` | `TEAMS_TENANT_ID` | Azure AD tenant ID (optional, for single-tenant) |

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

Your assistant must be reachable from the internet. Use a reverse proxy (Cloudflare Tunnel, ngrok, etc.).

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

| Setting | Env Var | Description |
|---------|---------|-------------|
| `whatsapp.accessToken` | `WHATSAPP_ACCESS_TOKEN` | Cloud API access token (stored in vault) |
| `whatsapp.phoneNumberId` | `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from Meta dashboard |
| `whatsapp.verifyToken` | `WHATSAPP_VERIFY_TOKEN` | Webhook verification token (default: `assistant-whatsapp-verify`) |
| `whatsapp.appSecret` | `WHATSAPP_APP_SECRET` | Meta App Secret for signature verification (stored in vault) |
| `whatsapp.businessAccountId` | `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account ID (optional) |

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

```env
# ─── Telegram ────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=                    # From @BotFather
TELEGRAM_ALLOWED_USERS=                # Comma-separated user IDs
TELEGRAM_WEBHOOK_URL=                  # Leave empty for polling

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
- Check the backend logs: `tail -f ~/.assistant/backend.log`
- Ensure secrets are stored in the vault (not as plain text in env vars)

### Messages not arriving

- **Telegram**: Verify the bot token is valid by visiting `https://api.telegram.org/bot<TOKEN>/getMe`
- **Slack**: Ensure Socket Mode is enabled and the app is installed to the workspace
- **Teams**: Verify the messaging endpoint URL is reachable from Azure
- **WhatsApp**: Check that the webhook is verified (green checkmark in Meta dashboard) and subscribed to `messages`

### Account linking fails

- Link codes expire after 5 minutes — generate a new one
- Ensure the web account is logged in before entering the code
- Check that Redis is running (link codes are stored in Redis)

### Permission requests in channels

When an agent needs permission (e.g., to run a shell command), the request is forwarded to the channel where the conversation originated. Reply `yes` or `no` directly in the channel to approve or deny.
