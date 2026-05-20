# Chat Commands

Chat commands are slash commands you can use in any channel (WebChat, Telegram, Slack, Teams, WhatsApp, TUI) to control Octipus.

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

### Persona (Orchestrator Identity)

| Command | Description |
|---------|-------------|
| `/persona` | Show the active persona (name, tone, narration, self-facts) |
| `/persona name <X>` | Rename the orchestrator (default: `Octipus`) |
| `/persona tone <X>` | Set tone: `dry`, `playful`, `neutral`, `professional`, `terse`, `verbose` |
| `/persona narration <X>` | Set live swarm narration volume: `off`, `minimal`, `chatty` |
| `/persona say <fact>` | Append a free-form self-fact ("always summarize in bullets") |
| `/persona use <preset_id>` | Switch preset (keeps custom name; see Personas below) |
| `/persona reset` | Restore Octipus default |
| `/persona personas` | List available preset personas |

### TUI / Gateway Commands (Additional)

| Command | Description |
|---------|-------------|
| `/cost` | Show cumulative token usage and cost |
| `/diff` | Show `git diff --stat` for workspace changes |
| `/version` | Show Octipus version and Bun version |
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

## Personas (Orchestrator Identity)

The orchestrator's identity is a per-user setting, distinct from experts. By default it's **Octipus** — an octopus-machine that refers to itself in the third person, uses "we" for the swarm, and gives short dry replies. You can rename it, change tone, control how chatty its live swarm narration is, and add free-form facts that survive across sessions and channels.

```
/persona                       → Show current
/persona name Adam             → Rename
/persona tone playful          → Switch tone
/persona narration chatty      → More live swarm narration
/persona say always use bullets  → Add a self-fact
/persona personas              → List presets
/persona use mentor            → Switch preset (keeps the custom name)
/persona reset                 → Back to Octipus default
```

Six presets ship by default — `octipus` (default, dry octopus-machine), `terse-engineer`, `mentor`, `nautilus` (maritime), `concierge`, `verbose-academic`. Each is a YAML file under `personas/` you can edit or copy as a new preset.

The persona applies across **every channel** (TUI, web, Telegram, Slack, …) — it's per-user, not per-channel. The web UI surface for the same controls is at `/persona`. Full spec in [`docs/plans/ux-personality-revamp.md`](plans/ux-personality-revamp.md).

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

On external channels (Telegram, Slack, WhatsApp), Octipus provides real-time emoji reactions on your message:

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
