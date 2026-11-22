# Terminal chat and editor

Octipus has two terminal surfaces:

| Surface | Command | Purpose |
| --- | --- | --- |
| Chat | `octi tui` | Work with an agent through a conversation, visible plan and activity |
| Editor | `octi edit` | Edit local files alongside agent chat, with file navigation and diff review |

Use Node **24.22.1 or newer**. Start the backend with `octi start`, then open either surface. `octi start tui` starts the backend and chat together. Use `--project /path/to/project` to choose a directory; the default is the current directory.

Both surfaces use [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) (`@earendil-works/pi-tui`, pinned to an exact version) for terminal rendering, overlays and the chat composer. The file editor uses Octipus's own buffer, cursor and undo implementation. It is a lightweight editor, not a replacement for a complete IDE.

## The screen

Both surfaces open on the terminal's **alternate screen**, like `less` or `vim`: what you had in the terminal before launch is left alone, resizing never erases it, and quitting puts it back. Every row is drawn at its own position, so a row the terminal measures differently from Octipus damages only itself.

The transcript scrolls inside the app. Below it the activity row, subagents, composer and status rows stay pinned; the composer never drops below one row.

When you quit the chat, the screen is restored and the last exchange is printed to your terminal, followed by the command that reopens the conversation:

```text
Resume this conversation: octi tui --session <id>
```

`--inline` draws in the terminal's normal buffer instead, for people who want the previous behaviour; the transcript is still scrolled by the app there, and resizing no longer erases the terminal's scrollback either.

```bash
octi tui --inline
```

## Reading a conversation

User turns have a **You** heading and a vertical rail on every wrapped line. Replies have an **Octipus** heading and render Markdown when complete. Streaming text remains plain until completion. System notices use a muted dot; errors have a visible `! Error` marker as well as an error colour.

- The mouse wheel scrolls the transcript; `PageUp` and `PageDown` scroll by a page, including within one long answer. A scrollbar appears while you scroll.
- `Ctrl+Home` jumps to the oldest retained output; `Ctrl+End` — or `End`, while reading history — returns to the latest. A **↓ End: latest** marker shows while you are away from it; clicking it also returns.
- `Ctrl+Shift+F` searches the transcript.
- While reading history, new messages and streaming text do not move the rows being read.
- In the editor, the wheel and the transcript keys apply when the chat pane has focus.
- Resizing reflows the messages and keeps the reading position.

Long sessions stay fast: only the newest 200 messages are rendered, and scrolling up past them brings older ones in. At most 5,000 messages are kept in memory; beyond that the oldest are dropped and a notice at the top of the transcript says how many. The server keeps the whole session. `/history` reloads its latest 50 messages; loading older turns from the server while scrolling needs a gateway change and is not available yet.

The activity line shows thinking, elapsed time, model and current tool activity; it disappears when the turn ends, so the status bar keeps the model of the current or last turn at the end of its line, and drops it on `/resume`. `Alt+S` / `F7` expands the subagent panel in either surface; `Alt+Up` / `Alt+Down` scroll its entries when expanded. Completed children remain available for inspection until the session is cleared or reset, including their model, iteration count and last tool activity.

Text from the agent, tools and the server is reduced to what a terminal draws predictably before it is shown: control characters and escape sequences are removed, tabs become spaces, invisible format characters (variation selectors, soft hyphens, bidi controls) are dropped, and joined emoji (families, skin tones) are shown as their separate emoji. `/copy` copies the original text. Scripts with spacing vowel signs (Devanagari, Tibetan and similar) can still be measured narrower than the terminal draws them; on the alternate screen that shifts only the rest of that row.

Both surfaces display streamed responses, identity, backend session usage, permission prompts and agent questions. Questions are queued: answering one reveals the next. Escape explicitly declines an agent question; it does not silently dismiss it and leave the agent waiting. A question taller than the window scrolls inside its box with `Up` / `Down`; the choices and the keys to answer stay visible.

## Selecting and copying text

**Drag** with the left button to select transcript text — no modifier needed. Dragging at the top or bottom edge keeps scrolling and extends the selection past what is on screen. The selection is copied when you release the button; the rail in front of each row is left out. A short message says how the text was copied. Double-click selects a word, triple-click a line.

Your terminal's own selection is still there behind its override key: **Shift**+drag in xterm, GNOME Terminal, Konsole, Kitty, Windows Terminal and most others; **Option**+drag in iTerm2 and Terminal.app. Then use the terminal's Copy command. **Ctrl+C** remains the app's quit/cancel key.

`/copy` or `/copy last` copies the latest assistant response, including text outside the viewport. `/copy transcript` copies all loaded user, assistant and system messages. Both preserve raw Markdown and Unicode; during streaming they copy the text received so far.

Selection and `/copy` use the same clipboard chain, and say which way the text went:

1. a clipboard tool, when the terminal is on this machine: `pbcopy` (macOS), `clip.exe` (Windows, WSL), `wl-copy` (Wayland), `xclip` or `xsel` (X11). Not over SSH, where it would copy on the remote machine;
2. the tmux paste buffer, inside tmux (paste with prefix `]`; tmux passes it to your terminal's clipboard when its `set-clipboard` option allows);
3. an OSC 52 request to the terminal. Terminals do not confirm it, so Octipus says it was sent, not that it worked. If pasting gives nothing, allow OSC 52 clipboard writes in your terminal or use its own selection.

Text over 75,000 UTF-8 bytes cannot go through OSC 52; when no tool took it either, Octipus says it was not copied rather than truncating it.

### Mouse setting

`tui.mouse` sets how the app uses the mouse. Set it in `~/.octipus/tui.json`, next to `keybindings.json`, or per run with `--mouse`:

```json
{ "mouse": "native" }
```

| Value | Wheel | Selection |
| --- | --- | --- |
| `app` (default) | Scrolls the pane under the pointer | Drag selects in the app; Shift (Option) for the terminal's |
| `native` | Arrives as Up/Down (alternate-scroll mode), which scroll the transcript while the composer is empty | The terminal's own, no modifier; no click targets |
| `off` | Whatever the terminal does on the alternate screen | The terminal's own |

An unknown value is an error at launch naming the choices; it is not silently replaced by the default. With `--inline`, `app` reports only the wheel and Shift+drag is the selection, as before.

### Taking the conversation out

| Command / key | Action |
| --- | --- |
| `/export [path]` | Write the transcript as Markdown (default `octipus-<session>-<time>.md` in the project directory). Refuses to overwrite an existing file. |
| `/scrollback` / `Alt+O` | Leave the screen and print the transcript into the terminal's own scrollback, for its search and selection. Any key returns. |
| Quit | The last exchange and the resume command are printed after the screen is restored. |

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
| `Alt+O` | Transcript into the terminal scrollback |
| `Ctrl+Shift+F` | Search the transcript |

Typing `/` opens command completion. `/help` lists available commands. Common gateway commands include `/status`, `/abort`, `/cost`, `/changes`, `/persona`, `/skills` and `/compact`.

The standalone chat shell also handles `/login`, `/logout` (sign out and disconnect), `/whoami`, `/project`, `/workspace`, `/resume`, `/export` and `/scrollback` locally. These local commands are not all implemented by the editor; its palette includes the shared gateway commands, plan controls and editor shortcuts.

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

Both clients connect to the gateway, normally `ws://localhost:3005/gateway`, signed in as your Octipus account. The login is stored in `~/.octipus/session.json` (mode 0600). When there is none — first run, after `/logout`, or once the server rejects it (expired, revoked, account deactivated) — the chat shell opens the login prompt once and does not connect until you sign in; `/login` reopens it. There is no machine account: a terminal sees only your sessions and events, like the browser, and an admin account gets no further than any other. The editor uses the same stored login; sign in from the chat shell first. Override the port with `API_PORT` or the checkout's `.env`:

```bash
API_PORT=3015 octi edit --project ~/code/myapp
```

The default palette uses the Deep Sea accent colours. Actual background colour and glyph availability depend on the terminal and font. File/status icons have an ASCII fallback:

```bash
OCTIPUS_TUI_ICONS=ascii octi edit
OCTIPUS_TUI_ICONS=emoji octi tui
```

Keybindings can be overridden in `~/.octipus/keybindings.json`. The editor's `/reload` reloads those bindings; `/hotkeys` displays them.

If either surface stops on an error, or the terminal closes under it, it first turns mouse reporting off, shows the cursor and leaves raw mode, then prints the error and exits with a non-zero status, so the shell you return to works normally.

## Testing

```bash
npm run test:tui
```

This runs component, application and terminal regression tests. The terminal tests use **Python 3's standard-library PTY support** plus a Node terminal emulator. They launch the shipped entry points against a controlled local WebSocket fixture, so no running Octipus server, provider credentials or paid model calls are required.

The tests assert current screen contents, including streaming, approvals, plan feedback, resize/focus and save/quit flows, the alternate screen (scrollback kept through resizes, the screen restored on every way out), drag selection and the clipboard chain, and a frame-time budget for a 5,000-message transcript. One suite runs the chat inside a real tmux when it is installed. An invariant suite (`tests/tui/invariants.e2e.test.ts`) drives the chat through random gateway events and resizes and checks after every step that the status line is the last row, the composer is above it with the cursor, and no row wraps. It runs 8 seeds by default; `TUI_FUZZ_SEEDS=500` runs more and `TUI_FUZZ_SEED=<n>` reruns the seed a failure names. They run in the normal Vitest suite and Linux CI. The real-PTY portion is explicitly skipped on Windows; native Windows terminal rendering still needs separate verification. The screen model is xterm's: VTE, Kitty, Ghostty, iTerm2, Windows Terminal, SSH and the Linux console are not exercised. Tests do not establish compatibility with every terminal or font.

See [TUI architecture](../architecture/TUI-EDITOR.md) for implementation details.
