# Chat Commands

Chat commands are slash commands you can use in any channel (WebChat, Telegram, Slack, Teams, WhatsApp) to control the assistant, manage sessions, and get information.

## Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot and get a welcome message |
| `/help` | Show available commands |
| `/link` | Get a 6-character code to link your channel account to your web account |
| `/status` | Check bot status and connection info |
| `/clear` | Clear your conversation history and start fresh |

---

## Command Details

### `/start`

Initializes the bot connection. Sends a welcome message with a brief overview of what the assistant can do.

**Where it works:** All channels

**Example:**
```
/start
→ Welcome! I'm your AI assistant. Send me any task and I'll route it to the right specialist agent...
```

### `/help`

Lists all available commands with descriptions.

**Where it works:** All channels

### `/link`

Generates a one-time 6-character linking code that binds your channel identity (e.g., Telegram user ID) to your web account. This enables:

- Shared sessions across channels and the web UI
- Unified permissions and tool access
- Consistent conversation history

**Where it works:** Telegram, Slack, Teams, WhatsApp

**How to use:**
1. Send `/link` in the channel
2. Copy the 6-character code (e.g., `A3F9K2`)
3. Open the web UI at **Settings > Channels**
4. Paste the code and click Link

**Notes:**
- Codes expire after **5 minutes**
- Each code can only be used once
- You can re-link at any time by generating a new code
- Link codes are stored in Redis (or in-memory cache in embedded mode)

### `/status`

Shows the current bot status including:
- Connection state
- Active session info
- Channel type

**Where it works:** All channels

### `/clear`

Clears your conversation history for the current session. Useful when:
- The context has become too long or confused
- You want to start a completely new topic
- Agent responses seem to reference old/irrelevant context

**Where it works:** All channels

**Note:** This only clears the message history. Your account linking, permissions, and settings are preserved.

---

## How Commands Work

### Channel-Level Processing

Commands are intercepted at the channel layer **before** messages reach the orchestrator. Each channel (Telegram, Slack, Teams, WhatsApp, WebChat) checks incoming messages for the `/` prefix and handles recognized commands directly.

```
User sends "/help"
    │
    ▼
Channel receives message
    │
    ├── Starts with "/"? ──► Yes ──► Handle command locally
    │                                 (no orchestrator involved)
    │
    └── Regular message ──► Route to Orchestrator ──► Agent(s)
```

This means commands are fast — they don't require an LLM call or agent spawn. The response is immediate.

### Implementation

Commands are implemented in each channel's message handler:

| Channel | Source |
|---------|--------|
| Telegram | `src/channels/telegram/index.ts` |
| Slack | `src/channels/slack/index.ts` |
| Teams | `src/channels/teams/index.ts` |
| WhatsApp | `src/channels/whatsapp/index.ts` |
| WebChat | `src/channels/webchat/index.ts` |

All channels share the same command set. The Unified Message Interface (UMI) in `src/channels/index.ts` provides the common routing layer.

---

## Interacting Without Commands

For regular tasks, just type naturally. The orchestrator classifies your message and routes it to the appropriate specialist:

- **Casual messages** → Direct LLM response (fast, no agent)
- **Tasks** → Specialist agent (coding, research, design, etc.)
- **Complex requests** → Agent team or pipeline (parallel or sequential)

Examples:
```
"fix the login bug in auth.ts"           → Coding agent with filesystem/shell/git tools
"research best practices for caching"    → Research agent with web search/browser
"audit the API for security issues"      → Security agent with OWASP knowledge
"deploy the staging environment"         → DevOps agent with Docker/shell tools
```

---

## Troubleshooting

### Command not recognized

- Ensure you include the `/` prefix (e.g., `/help` not `help`)
- Commands are case-sensitive — use lowercase
- If using Slack, the command may be interpreted as a Slack slash command. Use `link` without the slash prefix instead

### `/link` code not working

- Codes expire after 5 minutes — generate a new one with `/link`
- Make sure you're logged into the web UI before entering the code
- Check that Redis is running if using external mode

### `/clear` didn't help

- If agent responses are still confused after clearing, the issue may be with the session context summary. Create a new session in the web UI for a completely fresh start
