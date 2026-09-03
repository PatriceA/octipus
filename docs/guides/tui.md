# TUI (Terminal User Interface)

Two terminal surfaces ship with Octipus and connect to the gateway over
the same WebSocket protocol the web UI uses:

| Surface | Entry | Use it for |
|---|---|---|
| **Chat shell** (`src/tui-pi/`) | `octi tui` | Conversational chat with the agent — single composer + scrolling messages, slash commands, command palette. |
| **Editor** (`src/tui-editor/`) | `octi edit` | Multi-pane workspace: file tree + buffer editor + agent chat side-by-side, with file picker, find/replace, diff overlay, etc. |

Both surfaces require the backend to be running (`octi start`).

## What this is built on

The terminal surfaces are written on top of
[`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui),
a small differential-rendering TUI library. We use it for:

- **Component model + differential renderer** — `Component`, `Container`,
  `TUI`, with screen diffs so only changed cells are written.
- **Editor primitive** — pi-tui's `Editor` is the underlying composer
  for both the chat input and the file editor. It ships with paste
  markers, kill ring, undo stack, history navigation, fuzzy file
  completion, and slash-command autocomplete out of the box.
- **Overlay system** — `tui.showOverlay(...)` for modal palettes,
  permission prompts, file pickers, hotkeys, and diff views.
- **Keybinding manager** — `getKeybindings()` + the `Keybindings`
  interface; we extend it with our own ids (`app.palette.open`,
  `app.tree.toggle`, …) and let users override via
  `~/.octipus/keybindings.json`.
- **Glyph helpers** — `truncateToWidth`, `visibleWidth`,
  `wrapTextWithAnsi`, OSC-aware width measurement (so markdown
  hyperlinks don't shrink panes).

What we layer on top, under `src/tui-pi/` and `src/tui-editor/`:

- Gateway adapter (WebSocket + auth + reconnect).
- Octipus-specific components: status bar, activity line, messages
  pane, file tree, tab strip, mode bar, file picker, find / replace,
  diff overlay, hotkeys overlay, workspace picker, MCP server list.
- Theme + glyph table with terminal-aware emoji fallback.

The previous TUI was based on Ink (React for the terminal). Replaced
in May 2026 — pi-tui's diff renderer is dramatically faster on long
chats and the shared `Editor` primitive lets the chat composer and
the file editor evolve in lockstep.

---

## Chat shell — `octi tui`

```
● Octipus  · workspace          connected     17.3k tok · 3 turns · $0.0024
                                                              ┐
· Welcome to Octipus. Project: my-repo   Type a message or
  /help for commands.

❯ what's the weather in Berlin?
  Agent spawned: research

  The current weather in Berlin is …
─────────────────────────────────────────────────────────────
                                                              │ composer
─────────────────────────────────────────────────────────────
```

### Slash commands (chat shell)

The composer's autocomplete pops up after `/`. Local commands are
intercepted before reaching the gateway:

| Command | Handled by | Description |
|---|---|---|
| `/exit`, `/quit` | TUI | Quit |
| `/cost` | TUI | Show cumulative tokens / turns / cost |
| `/project [path]` | TUI | Show or set the active project path |
| `/help` (`/h`, `/?`) | gateway | List available commands |
| `/status` (`/s`) | gateway | Session + agents + expert |
| `/expert <name\|reset>` | gateway | Switch / list experts |
| `/abort` (`/stop`, `/cancel`) | gateway | Cancel running agents |
| `/compact [focus]` | gateway | Compact session context |
| `/clear` (`/cls`, `/reset`) | gateway | Reset root agent + clear chat |
| `/diff` | gateway | Workspace git diff |
| `/changes [file]` | gateway | Review workspace changes — list, or a file diff |
| `/reload-extensions` (`/reload`) | gateway | Re-discover and reload user extensions |
| `/persona` | gateway | Configure the root agent persona |
| `/version` (`/v`) | gateway | Build info |

### Keybindings (chat shell)

| Key | Action |
|---|---|
| `Ctrl+P` / `F4` | Command palette |
| `F5` | Hotkeys overlay |
| `Alt+T` / `F8` | Push-to-talk: start/stop voice input |
| `Ctrl+Q` | Quit |
| `Up` / `Down` (in composer) | Navigate chat input history |
| `Tab` (in composer) | Accept completion / fuzzy file completion |
| `\` then `Enter` | Newline in chat input (terminals without `Shift+Enter`) |

---

## Editor — `octi edit`

```
● Octipus  · workspace                              connected
[+] my-repo            │  README.md                │· Welcome to Octipus.
  [+] src              │ 1  # Octipus              │  Type /help for cmds.
        index.ts       │ 2                         │
  [+] tests            │ 3  > **alpha**            │ ❯ open src/index.ts
        a.test.ts      │ 4                         │   opening...
        b.test.ts      │ 5  ## What it is          │
                       │                           │ ──────────────────
INS  README.md  markdown  L1:1                     │                   │
                                                   │ ──────────────────
```

Three independently togglable panes:

- **Left** — file tree, rooted at `--project` (default: cwd).
- **Center** — buffer area: tab strip + editor body. Multiple files
  can be open; switching tabs preserves cursor and undo stacks.
- **Right** — chat (same composer as the chat shell, same gateway
  adapter, same slash commands).

Persisted state at `~/.octipus/tui-editor.json` (open buffers,
cursors, pane visibility, theme, vim-mode toggle).

### Keybindings (editor)

App-level. Overridable via `~/.octipus/keybindings.json` — see
[`docs/architecture/TUI-EDITOR.md`](../architecture/TUI-EDITOR.md) for
the full list and the reasoning behind which terminal-collision-prone
combos are avoided (e.g. no `Ctrl+M` because that's `Enter` in non-Kitty
terminals, no `Ctrl+H` because that's `Backspace`).

| Key | Action |
|---|---|
| `Ctrl+O` | File picker (type to filter, Enter to open) |
| `Ctrl+S` | Save active buffer |
| `Ctrl+W` | Close active buffer |
| `Alt+,` / `F2` | Previous buffer |
| `Alt+.` / `F3` | Next buffer |
| `Ctrl+B` | Toggle file tree |
| `Alt+J` | Toggle chat pane |
| `Ctrl+\` / `F6` | Cycle pane focus (tree → editor → chat) |
| `Ctrl+F` | Find in buffer |
| `Alt+R` | Find & replace |
| `Ctrl+K` | Switch workspace |
| `Ctrl+E` | MCP server list |
| `Ctrl+P` / `F4` | Command palette |
| `F5` | Hotkeys overlay |
| `Ctrl+Q` | Quit |

Chat-side fallbacks (typing in the chat composer always works, even
if a key is hijacked by the host terminal):

- `/quit`, `/exit`, `/q` — exit
- `/keys` (`/hotkeys`) — open hotkeys overlay
- `/palette` — open command palette
- `/reload` — reload `~/.octipus/keybindings.json`

---

## Glyphs / emoji

The tree, status bar, and message bullets default to ASCII glyphs
(`[+]`, `·`, `❯`) on Linux terminals because most distro-default
fonts don't ship the emoji subset (`📁` then renders as a tofu box).
Emoji turn on automatically for known emoji-capable terminals
(`kitty`, `wezterm`, `iTerm.app`, `vscode`, `ghostty`).

Force either way:

```bash
OCTIPUS_TUI_ICONS=emoji octi tui
OCTIPUS_TUI_ICONS=ascii octi edit
```

---

## Authentication

Both surfaces use **local-token authentication** — no password or
browser login needed.

On first launch, a token file is created at `~/.octipus/local-token`
(chmod 600). The gateway accepts this token only from `127.0.0.1`
connections, so it cannot be used remotely.

To regenerate the token:

```bash
rm ~/.octipus/local-token   # next launch creates a fresh one
```

## Connection status

The status bar dot reflects the WebSocket state:

| Status | Color | Meaning |
|---|---|---|
| `connected` | green | authenticated and ready |
| `connecting` | yellow | opening WebSocket |
| `authenticating` | yellow | sending auth handshake |
| `disconnected` | red | not connected |
| `error` | red | connection error |

Drops auto-reconnect with exponential backoff (1s → 30s, 10 attempts).

## Configuration

The TUI connects to `ws://localhost:$API_PORT/gateway`. Override the
port via the `.env` file (`API_PORT=…`) or the env var:

```bash
API_PORT=3015 octi tui
API_PORT=3015 octi edit --project ~/code/myapp
```

## End-to-end tests

A harness drives both surfaces under a fixed terminal size and verifies
launch, focus cycling, slash commands, the file picker, and `/quit`. Skipped
automatically when the gateway isn't running. This suite still runs on
`bun:test` (not yet migrated to Vitest with the rest of the test suite), so
it needs the `bun` binary on PATH:

```bash
bun test tests/tui/
```

See `tests/tui/harness.ts` for the keystroke + ANSI-stripping helper
that other TUI tests can build on.
