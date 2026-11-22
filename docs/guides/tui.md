# Terminal chat and editor

Octipus has two terminal surfaces:

| Surface | Command | Purpose |
| --- | --- | --- |
| Chat | `octi tui` | Work with an agent through a conversation, visible plan and activity |
| Editor | `octi edit` | Edit local files alongside agent chat, with file navigation and diff review |

Use Node **24.22.1 or newer**. Start the backend with `octi start`, then open either surface. `octi start tui` starts the backend and chat together. Use `--project /path/to/project` to choose a directory; the default is the current directory.

Both surfaces use pi-tui for terminal rendering, overlays and the chat composer. The file editor uses Octipus's own buffer, cursor and undo implementation. It is a lightweight editor, not a replacement for a complete IDE.

## Reading a conversation

User turns have a **You** heading and a vertical rail on every wrapped line. Replies have an **Octipus** heading and render Markdown when complete. Streaming text remains plain until completion. System notices use a muted dot; errors have a visible `! Error` marker as well as an error colour.

- `PageUp` and `PageDown` scroll by screen rows, including within one long answer. The mouse wheel always scrolls the same transcript while the composer and status stay fixed.
- `Ctrl+Home` jumps to the oldest retained output; `Ctrl+End` jumps to the latest. History controls appear when output exceeds the viewport.
- While reading history, new messages and streaming text do not move the rows being read.
- `End` returns to the latest output when scrolled back. Otherwise it retains its normal composer behaviour.
- In the editor, transcript scrolling applies when the chat pane has focus.
- Resizing while reading history reflows the retained messages and keeps the reading position within the same message.

The activity line shows thinking, elapsed time, model and current tool activity; it disappears when the turn ends, so the status bar keeps the model of the current or last turn at the end of its line, and drops it on `/resume`. `Alt+S` / `F7` expands the subagent panel in either surface; `Alt+Up` / `Alt+Down` scroll its entries when expanded. Completed children remain available for inspection until the session is cleared or reset, including their model, iteration count and last tool activity.

Text from the agent, tools and the server is reduced to what a terminal draws predictably before it is shown: control characters and escape sequences are removed, tabs become spaces, invisible format characters (variation selectors, soft hyphens, bidi controls) are dropped, and joined emoji (families, skin tones) are shown as their separate emoji. `/copy` copies the original text. Scripts with spacing vowel signs (Devanagari, Tibetan and similar) can still be measured narrower than the terminal draws them, which may wrap a row.

The terminal's native scrollbar contains previously painted terminal output, not the full chat history. Use the keyboard controls or mouse wheel for the transcript. Resizing reflows history without dropping text beyond the right edge.

Both surfaces display streamed responses, identity, backend session usage, permission prompts and agent questions. Questions are queued: answering one reveals the next. Escape explicitly declines an agent question; it does not silently dismiss it and leave the agent waiting. A question taller than the window scrolls inside its box with `Up` / `Down`; the choices and the keys to answer stay visible.

## Selecting and copying text

Mouse-wheel scrolling and native text selection are available together, without a mode switch. Hold **Shift** while dragging with the left mouse button to select visible text, then use your terminal's Copy command (usually **Ctrl+Shift+C** on Linux). **Ctrl+C** remains the app's quit/cancel key. Alt+M and `/mouse` have been removed.

Shift+drag is the native selection override in xterm and many compatible terminals ([xterm mouse documentation](https://invisible-island.net/xterm/manpage/xterm.html)). Terminal key mappings can differ; configure the terminal's selection override if needed. In the editor, focus chat to scroll its transcript. Selection itself works across the visible terminal, including the editor pane.

`/copy` or `/copy last` requests a copy of the latest assistant response, including text outside the viewport. `/copy transcript` requests all currently loaded user, assistant and system messages. Both preserve raw Markdown and Unicode; during streaming they copy the text received so far. These commands work in both chat composers and do not send a gateway request.

Clipboard requests use OSC 52 without installing dependencies. Your terminal must allow OSC 52 clipboard writes; Octipus reports that it sent a request because terminals do not confirm success. If pasting produces nothing, use Shift+drag and your terminal’s Copy command instead. Requests over 75,000 UTF-8 bytes are refused without truncating; copy an individual response or select sections instead.

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

Typing `/` opens command completion. `/help` lists available commands. Common gateway commands include `/status`, `/abort`, `/cost`, `/changes`, `/persona`, `/skills` and `/compact`.

The standalone chat shell also handles `/login`, `/logout` (sign out and disconnect), `/whoami`, `/project`, `/workspace` and `/resume` locally. These local commands are not all implemented by the editor; its palette includes the shared gateway commands, plan controls and editor shortcuts.

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
| `Ctrl+S` | Save the active file (a scratch buffer asks for a path) |
| `F12` | Save As: save the active buffer under a new path |
| `Alt+M` | Switch vim mode on or off |
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

Long lines scroll horizontally to keep the cursor visible. Tabs advance to the next stop of four cells, and wide characters are measured in terminal cells. The cursor moves and deletes by whole characters: an emoji with a skin tone, a flag or a letter with its accent is one step. Tab inserts what the file indents with — a tab, or its step of spaces (two in a file with no indentation yet). Bracketed multiline paste inserts text without inserting the terminal control markers.

Undo (`Ctrl+Z`, redo `Ctrl+Y`) works in steps you would expect: a burst of typing, a paste, a replace-all or an accepted agent edit is one step. The unsaved marker (`●`) compares the buffer with the file as last opened or saved, so undoing back to it clears the marker.

Editor commands, typed in the chat composer: `/new` opens a scratch buffer, `/save-as [path]` saves the active buffer under a path (relative to the project, or absolute; without a path it asks), `/vim [on|off]` switches vim mode.

### Saving

Saving writes a temporary file next to the original and renames it into place, so a crash or a full disk leaves the old file rather than half of the new one. The file keeps its permissions, its line endings (a CRLF file is shown without `␍` and saved as CRLF) and its byte-order mark. A file that mixes CRLF and LF is saved with the more common one, and the editor says so when it opens. A file reached through a symlink is written at its target; a file with several hard links is written in place.

If the file changed on disk after you opened or last saved it — another editor, a formatter, the agent — saving asks first: **r** reloads the file (one undo step brings your version back), **o** overwrites it with yours, Enter or Escape cancels. A file deleted on disk can be written again with **o**.

The editor does not open a file it could not save back unchanged: a file that is not valid UTF-8, a binary file (it contains NUL bytes), a folder, or a file over 5 MB is refused with the reason.

Scratch buffers are saved with Save As: Ctrl+S on one asks for a path. Save As refuses a folder that does not exist and a path already open in another tab, and asks for a second Enter before replacing an existing file.

When closing a dirty buffer or quitting, choose **Save**, **Discard**, or **Cancel**. Enter and Escape cancel by default. Failed saves retain the buffer and report an error; a buffer that has no file yet or whose file changed on disk is not saved from this prompt — cancel, then use Save As or Ctrl+S.

### Finding and replacing

`Ctrl+F` searches from the cursor: the first match shown is the first one after it. Matches are highlighted in the buffer, the current one distinct, and the current one is selected. Enter and Shift+Enter move between matches; **Escape** closes the box and puts the cursor back where it was; **Alt+Enter** closes it with the cursor on the match. `Alt+C`, `Alt+R` and `Alt+W` toggle case sensitivity, regular expressions and whole words; an invalid regular expression is reported in the box.

`Alt+R` opens find and replace: Tab switches fields, Enter replaces every match as one undo step. With regular expressions on, the replacement can use `$1`, `$<name>`, `$&` and `$$`.

The query, replacement, file filter and Save As fields accept paste, emoji and input-method text.

### Opening files

`Ctrl+O` lists the project's files: in a git repository, the files `git ls-files` reports (tracked and untracked, without what `.gitignore` excludes); otherwise a walk of the folder that skips `.git`, `node_modules`, `dist`, `build`, `.next`, `.cache` and `.octipus`. The list is built in the background, and typing filters it by fuzzy match over every file — letters in order, so `hdr` finds `header.ts`. The best 500 matches are listed. Typing a name and Enter before the list is ready opens the best match when it is.

### Vim mode

`Alt+M` or `/vim` switches vim mode; the setting is remembered per project. The bottom bar shows `EDIT`, or `VIM NORMAL` / `VIM INSERT` / `VIM VISUAL`, and the `:` command while you type it. The selection is drawn in VISUAL mode, as everywhere else.

| Key | Action |
| --- | --- |
| `h` `j` `k` `l`, arrows, `w` `b`, `0` `$`, `gg` `G` | Move (in VISUAL, extend the selection) |
| `i` / `a` / `o` / `O` | INSERT at, after, on a new line below / above |
| `v` | VISUAL |
| `x`, `dd`, `yy`, `p`, `u`, `Ctrl+R` | Delete character, delete line, yank line, paste, undo, redo |
| `"` + register | Use that register for the next yank, delete or paste |
| `:w` | Save |
| `:q` / `:q!` | Close the buffer (asking if it has unsaved changes) / close it discarding them |
| `:wq` / `:x` | Save and close the buffer |
| `:qa` / `:qa!` | Quit the editor (asking) / quit discarding changes |
| `Esc` | Back to NORMAL; closes the `:` line |

`Ctrl+S` saves in every mode. Escape is recognised however the terminal sends it, including the kitty keyboard protocol's `ESC[27u`. It is a small subset of vim, not a replacement for it.

Layout, open paths, cursor positions and unsaved drafts are checkpointed to:

```text
~/.octipus/projects/<project-hash>/tui-editor.json
```

The state file is private to its owner. Changes are checkpointed after a short debounce and flushed during orderly shutdown, including SIGTERM. Reopening the editor restores drafts as unsaved buffers for review. A forced kill or machine failure can lose edits since the last successful checkpoint. A checkpoint failure is reported in the mode bar.

Agent file changes to open buffers are queued for diff review in the default lock mode; a change to a file the agent names relative to the project reaches its tab too. The diff box fits the terminal's height and scrolls with Up/Down and PageUp/PageDown. Accept updates the in-memory buffer as one undo step; Reject keeps the current buffer. This review controls the editor buffer; it does not undo a filesystem write the agent already performed. If the agent has already written the file when you decide, the tab says so: after Accept it is clean (buffer and disk agree), after Reject it shows as unsaved, and Ctrl+S writes your version back over the agent's.

Opening the workspace picker (`Ctrl+K`) or the MCP list (`Ctrl+E`) again while it loads does nothing; a workspace request that gets no answer within 5 seconds, or fails, is shown in the picker with the reason.

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

Keybindings can be overridden in `~/.octipus/keybindings.json` (the editor's own are `app.file.saveAs` and `app.vim.toggle`). The editor's `/reload` reloads those bindings; `/hotkeys` (`F5`) displays them, with vim mode's keys and commands.

If either surface stops on an error, or the terminal closes under it, it first turns mouse reporting off, shows the cursor and leaves raw mode, then prints the error and exits with a non-zero status, so the shell you return to works normally.

## Testing

```bash
npm run test:tui
```

This runs component, application and terminal regression tests. The terminal tests use **Python 3's standard-library PTY support** plus a Node terminal emulator. They launch the shipped entry points against a controlled local WebSocket fixture, so no running Octipus server, provider credentials or paid model calls are required.

The tests assert current screen contents, including streaming, approvals, plan feedback, resize/focus and save/quit flows. An invariant suite (`tests/tui/invariants.e2e.test.ts`) drives the chat through random gateway events and resizes and checks after every step that the status line is the last row, the composer is above it with the cursor, and no row wraps. It runs 8 seeds by default; `TUI_FUZZ_SEEDS=500` runs more and `TUI_FUZZ_SEED=<n>` reruns the seed a failure names. They run in the normal Vitest suite and Linux CI. The real-PTY portion is explicitly skipped on Windows; native Windows terminal rendering still needs separate verification. Tests do not establish compatibility with every terminal or font.

See [TUI architecture](../architecture/TUI-EDITOR.md) for implementation details.
