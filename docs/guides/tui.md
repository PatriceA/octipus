# Terminal chat and editor

Octipus has two terminal surfaces:

| Surface | Command | Purpose |
| --- | --- | --- |
| Chat | `octi tui` | Work with an agent through a conversation, visible plan and activity |
| Editor | `octi edit` | Edit local files alongside agent chat, with file navigation and diff review |

Use Node **24.19 or newer**. Start the backend with `octi start`, then open either surface. `octi start tui` starts the backend and chat together. Use `--project /path/to/project` to choose a directory; the default is the current directory.

Both surfaces use pi-tui for terminal rendering, overlays and the chat composer. The file editor uses Octipus's own buffer, cursor and undo implementation. It is a lightweight editor, not a replacement for a complete IDE.

## Reading a conversation

User turns have a **You** heading and a vertical rail on every wrapped line. Replies have an **Octipus** heading and render Markdown when complete. Streaming text remains plain until completion. System notices use a muted dot; errors have a visible `! Error` marker as well as an error colour.

- `PageUp` and `PageDown` scroll by screen rows, including within one long answer.
- While reading history, new messages and streaming text do not move the rows being read.
- `End` returns to the latest output when scrolled back. Otherwise it retains its normal composer behaviour.
- In the editor, transcript scrolling applies when the chat pane has focus.
- Resizing while reading history clips the frozen rows to the new width. Returning to the latest output restores wrapping at the new width.

The activity line shows thinking, elapsed time, model and current tool activity. `Alt+S` / `F7` expands the subagent panel in either surface; `Alt+Up` / `Alt+Down` scroll its entries when expanded.

Both surfaces display streamed responses, identity, backend session usage, permission prompts and agent questions. Questions are queued: answering one reveals the next. Escape explicitly declines an agent question; it does not silently dismiss it and leave the agent waiting.

## Plans and feedback

A persistent plan summary shows progress once the agent publishes a plan. It refreshes while connected.

| Command | Action |
| --- | --- |
| `/work-plan` | Expand the persistent plan details and put the full plan, evidence and feedback in the transcript |
| `/plan-hide` | Collapse the persistent details |
| `/plan-feedback <change>` | Send a correction or suggestion for the current plan |
| `/plan on` / `/plan off` | Toggle the gateway's planning mode |

The compact details show steps near the active step. The full transcript entry remains available with PageUp. Plan progress is agent-reported, not independent verification. Feedback is recorded as pending; tools already running may finish first. If a turn has ended, send a message to continue with the feedback.

## Chat shortcuts and commands

| Key | Action |
| --- | --- |
| `Ctrl+P` / `F4` | Command palette |
| `F5` | Show shortcuts |
| `Ctrl+Q` | Quit |
| `Up` / `Down` in composer | Input history |
| `Tab` | Completion |
| `\` then `Enter` | Newline when the terminal does not support Shift+Enter |
| `Alt+T` / `F8` | Chat shell voice input, when configured |

Typing `/` opens command completion. `/help` lists available commands. Common gateway commands include `/status`, `/abort`, `/cost`, `/changes`, `/expert` and `/compact`.

The standalone chat shell also handles `/login`, `/logout`, `/whoami`, `/project`, `/workspace` and `/resume` locally. These local commands are not all implemented by the editor; its palette includes the shared gateway commands, plan controls and editor shortcuts.

To resume a chat session:

```text
octi tui --session <id>
```

Or use `/sessions` followed by `/resume <n|id>` inside the chat shell. The editor currently starts a new agent session on launch; restoring local editor buffers does not resume an agent conversation.

## Working in the editor

At 80 columns and wider, the editor shows a file tree, buffer editor and chat. Below 80 columns, it shows the focused pane at full width. Switching focus switches the visible pane too. Hiding a focused side pane returns focus to the editor.

| Key | Action |
| --- | --- |
| `Ctrl+O` | Find and open a file |
| `Ctrl+S` | Save the active file |
| `Ctrl+W` | Close a buffer, with unsaved-change protection |
| `Alt+,` / `F2`, `Alt+.` / `F3` | Previous / next buffer |
| `Ctrl+B` | Toggle file tree |
| `Alt+J` | Toggle chat |
| `Ctrl+\` / `F6` | Cycle focus: editor → chat → tree |
| `Ctrl+F` | Find |
| `Alt+R` | Find and replace |
| `Ctrl+K` | Workspace picker |
| `Ctrl+E` | MCP server list |
| `Ctrl+Q` | Quit, with unsaved-change protection |

Long lines scroll horizontally to keep the cursor visible. Tabs and wide characters are measured in terminal cells. Bracketed multiline paste inserts text without inserting the terminal control markers.

When closing a dirty buffer or quitting, choose **Save**, **Discard**, or **Cancel**. Enter and Escape cancel by default. Failed saves retain the buffer and report an error. Scratch buffers do not yet have a Save As dialog; they remain recoverable drafts until discarded.

Layout, open paths, cursor positions and unsaved drafts are checkpointed to:

```text
~/.octipus/projects/<project-hash>/tui-editor.json
```

The state file is private to its owner. Changes are checkpointed after a short debounce and flushed during orderly shutdown, including SIGTERM. Reopening the editor restores drafts as unsaved buffers for review. A forced kill or machine failure can lose edits since the last successful checkpoint. A checkpoint failure is reported in the mode bar.

Agent file changes to open buffers are queued for diff review in the default lock mode. Accept updates the in-memory buffer; save it to write that buffer to disk. Reject keeps the current buffer. This review controls the editor buffer; it does not undo a filesystem write the agent already performed.

## Connection and appearance

Both clients connect to the gateway, normally `ws://localhost:3005/gateway`, using a stored CLI login or local-token authentication. Override the port with `API_PORT` or the checkout's `.env`:

```bash
API_PORT=3015 octi edit --project ~/code/myapp
```

The default palette uses the Deep Sea accent colours. Actual background colour and glyph availability depend on the terminal and font. File/status icons have an ASCII fallback:

```bash
OCTIPUS_TUI_ICONS=ascii octi edit
OCTIPUS_TUI_ICONS=emoji octi tui
```

Keybindings can be overridden in `~/.octipus/keybindings.json`. The editor's `/reload` reloads those bindings; `/hotkeys` displays them.

## Testing

```bash
npm run test:tui
```

This runs component, application and terminal regression tests. The terminal tests use **Python 3's standard-library PTY support** plus a Node terminal emulator. They launch the shipped entry points against a controlled local WebSocket fixture, so no running Octipus server, provider credentials or paid model calls are required.

The tests assert current screen contents, including streaming, approvals, plan feedback, resize/focus and save/quit flows. They run in the normal Vitest suite and Linux CI. The real-PTY portion is explicitly skipped on Windows; native Windows terminal rendering still needs separate verification. Tests do not establish compatibility with every terminal or font.

See [TUI architecture](../architecture/TUI-EDITOR.md) for implementation details.
