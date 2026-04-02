# Chat Commands

Chat commands are slash commands you can use in any channel (WebChat, Telegram, Slack, Teams, WhatsApp, TUI) to control the assistant.

## Available Commands

### All Channels (Orchestrator Commands)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check session status, running agents |
| `/expert [name]` | List experts or switch to a specific expert |
| `/experts [name]` | Alias for `/expert` |
| `/stop` | Stop all running agents in the session |
| `/clear` | Clear conversation context and start fresh |
| `/models` | List available models |
| `/plan` | Start an interactive project planning questionnaire |
| `/cost` | Show token usage and cost for the session |
| `/cancel` | Abort a multi-step command (e.g., active `/plan`) |

### TUI / Gateway Commands (Additional)

| Command | Description |
|---------|-------------|
| `/cost` | Show cumulative token usage and cost |
| `/diff` | Show `git diff --stat` for workspace changes |
| `/version` | Show assistant version and Bun version |
| `/compact` | Compact session context (summarize old messages) |
| `/exit` | Exit the TUI |

### Channel-Specific

| Command | Where | Description |
|---------|-------|-------------|
| `/start` | Telegram | Initialize bot connection |
| `/link` | Telegram, Slack, Teams, WhatsApp | Get a 6-character code to link your channel account to your web account |

---

## Expert Switching

Switch between pre-built expert personas from any channel:

```
/expert                    → List all available experts
/expert Technical Writer   → Switch to Technical Writer
/expert reset              → Return to auto-routing
```

When an expert is active, all your messages bypass the orchestrator's classifier and go directly to that expert's agent with its specialized system prompt, domain knowledge (skills), critical rules, and deliverable template.

Expert selection persists across messages in the session. Use `/expert reset` to return to automatic classification.

---

## Permission Prompts

When an agent needs to use a tool that requires approval, you'll see a permission prompt:

**Telegram/Slack/WhatsApp:**
```
🔒 Permission required: the agent wants to use "shell".
Command: docker compose up -d
Reply "yes" to allow or "no" to deny.
```

**TUI:**
```
⚠ Permission: shell → docker compose up -d  (y/n)
```

Type `yes`/`y` to approve or `no`/`n` to deny. If denied, the agent is stopped and the orchestrator asks what to do next.

---

## Channel Feedback (Emoji Reactions)

On external channels (Telegram, Slack, WhatsApp), the assistant provides real-time emoji reactions on your message:

| Phase | Emoji | Meaning |
|-------|-------|---------|
| Received | 👀 | Message received |
| Working | 💻🔍✍️⏰🔒🐳🎨📊🧪🧠 | Role-specific (coding, research, etc.) |
| Tool use | 📖💻🔍🐳💬⏰🔌🔧 | Tool-specific during execution |
| Permission | ⏳ | Waiting for user approval |
| Soft stall | 😐 | 15s without progress |
| Hard stall | 😬 | 45s without progress |
| Done | ✅ | Success |
| Failed | ❌ | Error |

A typing indicator is also sent while the agent works (refreshes every 4 seconds on Telegram).

---

## How Commands Work

Commands go through the **orchestrator command registry** (`src/core/commands/`), not directly to agents. They execute immediately without an LLM call.

```
User sends "/expert Technical Writer"
    │
    ▼
Channel receives message → starts with "/"
    │
    ▼
Orchestrator handleCommand() → looks up "expert" in registry
    │
    ▼
Expert command handler → finds expert in DB → stores in session context
    │
    ▼
Response: "Switched to expert: Technical Writer"
```

The TUI has an additional set of commands via the **gateway command registry** (`src/core/gateway/commands.ts`) which include `/cost`, `/diff`, `/version`, and other local operations.

---

## Troubleshooting

### Command not recognized
- Ensure you include the `/` prefix (e.g., `/help` not `help`)
- Commands are case-insensitive for the command name, case-sensitive for arguments
- Unknown commands return an error message listing available commands

### `/expert` not switching
- Use the exact expert name (e.g., `/expert Technical Writer`, not `/expert writer`)
- Check available experts with `/expert` (no arguments)
- Expert selection is per-session — starts a new session to reset

### `/clear` didn't help
- `/clear` resets session context including active plans and expert selection
- In TUI, `/clear` also clears the terminal screen and scrollback
- For a completely fresh start, create a new session in the web UI
