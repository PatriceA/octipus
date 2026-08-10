# Chat Commands

Chat commands are slash commands you can use in any channel (WebChat, Telegram, Slack, Teams, WhatsApp, TUI) to control Octipus.

## Available Commands

### All Channels (Orchestrator Commands)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/docs <query>` | Search the product documentation (setup, channels, providers, configuration) — returns matching sections directly, no LLM call |
| `/status` | Check session status, running agents |
| `/expert [name]` | List experts or switch to a specific expert |
| `/experts [name]` | Alias for `/expert` |
| `/stop` | Stop all running agents in the session |
| `/clear` | Clear conversation context and start fresh |
| `/model [name]` | Switch to a specific model for the session |
| `/models` | List available models |
| `/plan` | Start an interactive project planning questionnaire |
| `/capture <text>` | Append a timestamped line to today's daily note; `[[wikilinks]]` and `#tags` in the text are wired into the [knowledge graph](KNOWLEDGE-GRAPH.md) immediately |
| `/cost` | Show token usage and cost for the session |
| `/cancel` | Abort a multi-step command (e.g., active `/plan`); works during any command |
| `/eval` | Run evaluation scenarios or compare models |

### Persona

Persona controls (name, tone, narration, self-facts, presets) are accessible via the **web UI** at `/persona`, or via the `/persona` gateway command in the TUI (see [TUI / Gateway Commands](#tui--gateway-commands-additional) — not available from web/channel clients). Once set, your chosen persona applies across all channels.

**Available persona controls** (in the `/persona` page or via the `/persona` gateway command):

| Control | Options | Description |
|---------|---------|-------------|
| Name | Text | Rename the orchestrator (default: `Octipus`) |
| Tone | `dry`, `playful`, `neutral`, `professional`, `terse`, `verbose` | Personality of the orchestrator's responses |
| Narration | `off`, `minimal`, `chatty` | Volume of live swarm narration during agent execution |
| Facts | Free-form text | Add custom self-facts ("always use bullets"; persists across sessions) |
| Preset | Dropdown | Switch preset persona (keeps custom name) |
| Reset | Button | Restore Octipus default |

Six presets ship by default: `octopus` (default, dry octopus-machine), `terse-engineer`, `mentor`, `nautilus` (maritime), `concierge`, `verbose-academic`. Each is a YAML file under `personas/` you can edit or copy as a new preset.

Full spec in [`docs/plans/ux-personality-revamp.md`](plans/ux-personality-revamp.md).

### TUI / Gateway Commands (Additional)

These commands are available in the TUI and gateway clients (not web/channel clients).

| Command | Aliases | Description |
|---------|---------|-------------|
| `/abort` | `/stop`, `/cancel` | Stop running agents (gateway version; `/stop` is orchestrator version) |
| `/expert` | `/e` | Switch expert or list available experts (gateway version) |
| `/status` | `/s` | Show session status, agents, and active expert (gateway version) |
| `/cost` | — | Show cumulative token usage and cost |
| `/compact` | — | Compact session context (summarize old messages); optional: `/compact <focus instructions>` |
| `/clear` | `/cls`, `/reset` | Reset orchestrator context and clear TUI display |
| `/diff` | — | Show `git diff --stat` for workspace changes |
| `/changes` | — | Review git changes in the workspace — `/changes` for the list, `/changes <path>` for a file diff |
| `/help` | `/h`, `/?` | List available commands |
| `/reload-extensions` | `/reload` | Re-discover and reload user extensions from `.octipus/extensions/` (local trust only) |
| `/persona` | — | Configure the orchestrator persona — name, tone, narration, free-form facts |
| `/version` | `/v` | Show Octipus version and build info |

### Channel-Specific

| Command | Where | Description |
|---------|-------|-------------|
| `/start` | Telegram, WhatsApp | Initialize bot connection |
| `/link` | Telegram, Slack, WhatsApp | Get a 6-character code to link your channel account to your web account |

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

## Searching the Docs (`/docs`)

`/docs <query>` searches Octipus's own product documentation — which is
auto-indexed into the knowledge base at boot (see [`docs/RAG.md`](RAG.md) →
*Product docs auto-index at boot*) — and returns the top matching sections
directly:

```
/docs how do I set up Telegram
/docs add a model provider
/docs configure Slack
```

It is a deterministic lookup (no LLM call), so it works even when no chat
model is configured. Each hit shows the section heading, a short snippet, and
the source file. To get a synthesized answer instead of raw sections, just ask
in plain language ("how do I connect Telegram?") — knowledge-tool agents are
instructed to consult the same docs and cite them.

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
    |
    v
Channel receives message -> starts with "/"
    |
    v
Orchestrator handleCommand() -> looks up "expert" in registry
    |
    v
Expert command handler -> finds expert in DB -> stores in session context
    |
    v
Response: "Switched to expert: Technical Writer"
```

The TUI has an additional set of commands via the **gateway command registry** (`src/core/gateway/commands.ts`) which include `/cost`, `/diff`, `/compact`, and other local operations.

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
