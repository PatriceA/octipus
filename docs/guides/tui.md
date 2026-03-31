# TUI (Terminal User Interface)

The TUI provides a terminal-based chat interface that connects to the assistant via the Gateway WebSocket protocol.

## Quick Start

```bash
# Start the assistant server first
bun run dev

# In another terminal, launch the TUI
bun run src/tui/index.tsx
```

## Authentication

The TUI uses **local-token authentication** — no password or browser login needed.

On first launch, a token file is created at `~/.assistant/local-token` (chmod 600). The gateway accepts this token only from `127.0.0.1` connections, so it cannot be used remotely.

To regenerate the token (if compromised):
```bash
rm ~/.assistant/local-token
# Next TUI launch generates a new token automatically
```

## Interface

```
┌─ Assistant TUI ─────────────── connected ─┐
│                                            │
│  Welcome to the Assistant TUI.             │
│  Type a message or use /help for commands. │
│                                            │
│  > What is the weather in Berlin?          │
│    Agent spawned: research                 │
│    The current weather in Berlin is...     │
│                                            │
│  > /status                                 │
│    /status: Session: ... Running agents: 0 │
│                                            │
├────────────────────────────────────────────┤
│ > Type a message or /command...            │
└────────────────────────────────────────────┘
```

## Commands

All gateway commands are available in the TUI:

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/status` | Show session status |
| `/expert [name]` | Switch expert or list available |
| `/abort` | Cancel running agents |
| `/clear` | Clear chat display |
| `/think [level]` | Set thinking depth (off/low/medium/high) |
| `/verbose [on\|off]` | Toggle verbose output |
| `/usage [mode]` | Set usage footer (off/tokens/full) |
| `/exit` | Quit TUI |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Ctrl+C` | Exit TUI |

## Connection Status

The status bar shows the current connection state:

| Status | Color | Meaning |
|--------|-------|---------|
| `connected` | Green | Authenticated and ready |
| `connecting` | Yellow | Opening WebSocket |
| `authenticating` | Yellow | Sending auth handshake |
| `disconnected` | Red | Not connected |
| `error` | Red | Connection error |

## Auto-Reconnect

If the connection drops unexpectedly, the TUI automatically reconnects with exponential backoff (1s, 2s, 4s, ... up to 30s, max 10 attempts).

## Configuration

Set a custom gateway URL via environment variable:

```bash
PORT=3015 bun run src/tui/index.tsx
```

The TUI connects to `ws://localhost:$PORT/gateway` (default port: 3007).
