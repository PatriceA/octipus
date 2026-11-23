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

User turns have a **You** heading and a vertical rail on every wrapped line. Replies have an **Octipus** heading and render as Markdown while they stream, block by block: the blocks already written keep their rows, an unfinished code block is drawn closed at the end of what arrived, and a finished reply occupies exactly the rows it streamed into. System notices use a muted dot; errors have a visible `! Error` marker as well as an error colour.

A turn's tool calls are one row: `▸ 3 tool calls · 1 running · 1 failed · 4.2s — shell, read_file`, marked `!` when one failed. Click it, or press `Ctrl+O` (every group at once), to see each call with its arguments, its whole output as the server sent it, and an edit as a diff. Calls and results are matched by the call id where the server sends one. Text the agent wrote before calling tools is a dim, folded **Thinking** row, opened the same way. Subagents' calls stay in the subagent panel. The editor's chat pane shows the same rows, collapsed (`Ctrl+O` opens a file there).

Where the terminal shows links (kitty, Ghostty, WezTerm, iTerm2, Windows Terminal, VS Code, Alacritty, GNOME Terminal and other VTE terminals, tmux when it forwards them), URLs and `path:line` references in replies and tool output are links; a path links its file, resolved from the project. Only `http`, `https` and `file` links of this machine (no host, `localhost` or its own name) are made, and a reply's `[text](link)` to anything else stays plain text. With the app's mouse, a click on a web link opens it with the desktop's opener (not over SSH: there Shift+click lets the terminal open it); a click on a file link copies the file's path and says so — a file is never handed to the opener, which would run a script or a `.command` file. The terminal's own Ctrl+click on a file link follows the terminal's policy. An image you attach is shown in the transcript where the terminal draws images (Kitty graphics; iTerm2's with `--inline`), and named in one line elsewhere.

- The mouse wheel scrolls the transcript; `PageUp` and `PageDown` scroll by a page, including within one long answer. A scrollbar appears while you scroll.
- `Ctrl+Home` jumps to the oldest retained output; `Ctrl+End` — or `End`, while reading history — returns to the latest. A **↓ End: latest** marker shows while you are away from it; clicking it also returns.
- `Ctrl+F` (or `Ctrl+Shift+F`, or `/search`) searches the transcript — every message still in memory, not only the ones drawn: the count shows as `2/5`, the current match is highlighted, `Enter` / `Shift+Enter` (`Ctrl+G` / `Ctrl+Shift+G`) go to the next / previous one, `Escape` closes the search and puts you back where you were reading, and the search key again closes it on the match. Search needs the alternate screen; with `--inline` use `/scrollback` and the terminal's own search. In the chat, `Ctrl+F` no longer moves the composer's cursor right (the Right arrow does).
- While reading history, new messages and streaming text do not move the rows being read.
- In the editor, the wheel scrolls the pane under the pointer (editor, tree or chat) whatever has the focus; the transcript keys apply when the chat pane has focus.
- Resizing reflows the messages and keeps the reading position.

Long sessions stay fast: only the newest 200 messages are rendered, and scrolling up past them brings older ones in. At most 5,000 messages are kept in memory; beyond that the oldest are dropped and a notice at the top of the transcript says how many. The server keeps the whole session. `/history`, `/resume` and `--session` replay its latest 50 messages; scrolling up past the oldest of them loads earlier ones from the server, 100 at a time, as the web does (`GET /api/sessions/:id/messages?page=true&before=…`), with a notice at the top while there are more, while loading, or when a load failed (it is asked again on the next scroll up). Older turns stop loading once the 5,000-message limit is reached, or after messages were dropped from memory.

The activity line shows thinking, elapsed time, model and current tool activity; it disappears when the turn ends, so the status bar keeps the model of the current or last turn at the end of its line, and drops it on `/resume`. `Alt+S` / `F7` expands the subagent panel in either surface; `Alt+Up` / `Alt+Down` scroll its entries when expanded. Completed children remain available for inspection until the session is cleared or reset, including their model, iteration count and last tool activity.

Text from the agent, tools and the server is reduced to what a terminal draws predictably before it is shown: control characters and escape sequences are removed, tabs become spaces, invisible format characters (variation selectors, soft hyphens, bidi controls) are dropped, and joined emoji (families, skin tones) are shown as their separate emoji. `/copy` copies the original text. Scripts with spacing vowel signs (Devanagari, Tibetan and similar) can still be measured narrower than the terminal draws them; on the alternate screen that shifts only the rest of that row.

## Turns: stopping, queueing, history

`Esc` stops the running turn (the root agent is stopped, and with it the messages the server queued behind it; before the agent is known it stops the turn of this session — `session.stop` — and, if nothing had started yet, stops the root as soon as it starts). It never stops your agents in other sessions, as `/abort` does. Disconnected, `Esc` says the turn could not be stopped instead of claiming to. With no turn running, `Esc` twice within a second and a half clears the draft; the first press says so.

A message you send while a turn runs is not pushed into that turn: it waits in the rows above the composer (`⧗ queued 1 · …`) and is sent, as its own turn, when the turn ends — after its reply, which the transcript, `/export` and the exit summary show first; with several, one per turn. A turn ends on its own answer only (the gateway echoes the `turnId` each message carries): a rate limit, an expired approval or a late failure of a turn you stopped is shown without ending the running one. A message typed while the connection is down waits there too (`not connected: sent when the connection is back`) and goes out when it is back. `Alt+E` or a click on its row takes it back into the composer to edit or delete. Stopping a turn with `Esc` puts every queued message back into the composer instead of sending it. Slash commands run at once, turn or not.

`Ctrl+R` lists what you sent in this run, newest first, with a filter; `Enter` puts the chosen message back in the composer. `Up` / `Down` still step through the composer's history.

## Pickers

Sessions, models, skills, commands, themes and input history are chosen from the same list: type to filter (letters in order, `hdr` finds `header`; words separated by spaces must all match), `Up` / `Down` / `PageUp` / `PageDown` to move, `Enter` or a click to choose, `Escape` to close. The box below the list says what the highlighted entry is.

| Opens it | Lists | Choosing |
| --- | --- | --- |
| `/sessions` or `/resume` alone | Your recent sessions (title, last update, messages) | Resumes it here |
| `/model` alone | The enabled models you may use, the default and this session's choice marked | Switches the root agent to it for this session (`/model <name>`; agents it delegates to keep their lane's model); with a choice set, the first entry, **Configured default**, drops it (`/model clear`) |
| `/skills` alone | Your skills and how each is used now | Then pick Automatic, Always or This session; sent as `/skills <id> <mode>` |
| `Ctrl+P` / `F4` | Every command, with what it does and where it runs | Runs it |
| `/theme` alone | `auto`, `dark`, `light`, `high-contrast` | Switches and saves |
| `Ctrl+R` | What you sent | Puts it in the composer |

The text forms keep working: `/sessions list`, `/resume <n|id>`, `/skills <id> always`, `/model <name>`, `/model clear`, `/model list`. The session's model choice is the same one the chat's `/model` sets: yours only, kept in the server's memory until it restarts.

## Attention and the window title

The window title says what the chat is doing: `Octipus — <project>`, `· working…` during a turn, `· waiting for you` while a question or permission is open (terminals that support the OSC 7501 program status get the same). The title you had before is saved on the terminal's title stack at start and put back on exit. When the terminal window is not focused, a turn ending or a decision arriving raises a notification. Set how in `~/.octipus/tui.json`:

```json
{ "notify": "auto" }
```

| Value | Effect |
| --- | --- |
| `auto` (default) | OSC 9 in iTerm2, WezTerm, Ghostty, kitty and Windows Terminal; OSC 777 in VTE terminals (GNOME Terminal, Tilix); the bell elsewhere and inside tmux or screen |
| `bell`, `osc9`, `osc777` | That one |
| `off` | None |

Focus comes from the terminal's focus reports (`?1004`); a terminal that sends none is treated as focused and never notified.

## Prompts and decisions

Both surfaces display streamed responses, identity, backend session usage, permission prompts and agent questions. Questions are queued: answering one reveals the next. Escape explicitly declines an agent question; it does not silently dismiss it and leave the agent waiting. A question taller than the window scrolls inside its box with `Up` / `Down`; the choices and the keys to answer stay visible.

## Selecting and copying text

**Drag** with the left button to select transcript text — no modifier needed. (In the editor, a drag in the file selects the file's text and one in the chat pane selects only the chat's; see [Working in the editor](#working-in-the-editor).) Dragging at the top or bottom edge keeps scrolling and extends the selection past what is on screen. The selection is copied when you release the button; the rail in front of each row is left out. A short message says how the text was copied. Double-click selects a word, triple-click a line.

Your terminal's own selection is still there behind its override key: **Shift**+drag in xterm, GNOME Terminal, Konsole, Kitty, Windows Terminal and most others; **Option**+drag in iTerm2 and Terminal.app. Then use the terminal's Copy command. **Ctrl+C** remains the app's quit/cancel key.

`/copy` or `/copy last` copies the latest assistant response, including text outside the viewport. `/copy code` or `Alt+C` copies the last code block of the latest reply that has one, without its fences. `/copy transcript` copies all loaded user, assistant and system messages. Both preserve raw Markdown and Unicode; during streaming they copy the text received so far.

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

A persistent plan summary shows progress once the agent publishes a plan. The server announces every change to the plan (`session.plan_updated`), and the summary is fetched then and on connecting; there is no polling.

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
| `Esc` | Stop the running turn; with none, twice clears the draft |
| `Alt+E` | Take the newest queued message back into the composer |
| `Ctrl+O` | Expand or collapse tool calls and thinking |
| `Ctrl+R` | Search input history |
| `Up` / `Down` in composer | Input history |
| `Tab` | Completion |
| `\` then `Enter` | Newline when the terminal does not support Shift+Enter |
| `Alt+T` / `F8` | Chat shell voice input, when configured |
| `Alt+O` | Transcript into the terminal scrollback |
| `Ctrl+F` / `Ctrl+Shift+F` | Search the transcript |

Typing `/` opens command completion. `/help` lists available commands. Common gateway commands include `/status`, `/abort`, `/cost`, `/changes`, `/persona`, `/skills` and `/compact`.

The standalone chat shell also handles `/login`, `/logout` (sign out and disconnect), `/whoami`, `/project`, `/workspace`, `/resume`, `/theme`, `/search`, `/export` and `/scrollback` locally. These local commands are not all implemented by the editor; its palette includes the shared gateway commands, plan controls and editor shortcuts.

To resume a chat session:

```text
octi tui --session <id>
```

Or use `/sessions` (a picker) inside the chat shell, or `/sessions list` followed by `/resume <n|id>`. The editor currently starts a new agent session on launch; restoring local editor buffers does not resume an agent conversation.

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
| `Ctrl+G` | Go to a line (`line` or `line:column`) |
| `Alt+Z` | Soft wrap on or off |
| `Ctrl+Shift+F` / `Alt+G` | Search the project |
| `Alt+N` | New file |
| `Alt+Y` | Resolve what is waiting: a file changed on disk under unsaved edits, an agent edit to review |
| `Ctrl+Q` | Quit, with unsaved-change protection |

In the file:

| Key | Action |
| --- | --- |
| `PageUp` / `PageDown`, `Ctrl+Home` / `Ctrl+End` | By a page; to the start or end of the buffer |
| `Shift` + any motion | Select (arrows, `Home`/`End`, pages, `Ctrl+Left`/`Right`, `Ctrl+Home`/`End`) |
| `Ctrl+X` / `Ctrl+V` | Cut / paste; `Ctrl+C` copies a selection (with nothing selected it is still the quit key) |
| `Enter` | New line with the same indentation, one step deeper after an opening bracket |

Long lines scroll horizontally to keep the cursor visible, or break into rows with soft wrap (`Alt+Z` or `/wrap [on|off]`, remembered per project; a wide character is never split); with it on, `Up` and `Down` move one row on screen, so a long line is walked row by row — vim's `j` and `k` still move by line). The view keeps three lines between the cursor and its top or bottom while the cursor moves. When the file is longer than the pane a scrollbar is drawn on its right edge. The bracket matching the one at the cursor is underlined. Tabs advance to the next stop of four cells, and wide characters are measured in terminal cells. The cursor moves and deletes by whole characters: an emoji with a skin tone, a flag or a letter with its accent is one step. Tab inserts what the file indents with — a tab, or its step of spaces (two in a file with no indentation yet). Bracketed multiline paste inserts text without inserting the terminal control markers.

Undo (`Ctrl+Z`, redo `Ctrl+Y`) works in steps you would expect: a burst of typing, a paste, a replace-all or an accepted agent edit is one step. The unsaved marker (`●`) compares the buffer with the file as last opened or saved, so undoing back to it clears the marker.

Editor commands, typed in the chat composer: `/new` opens a scratch buffer, `/save-as [path]` saves the active buffer under a path (relative to the project, or absolute; without a path it asks), `/vim [on|off]` switches vim mode, `/wrap [on|off]` soft wrap, `/goto <line[:column]>` goes to a line, `/search [query]` searches the project, and `/new-file`, `/rename`, `/delete` and `/revert` work on files (below). A command's argument is taken as typed after the first space, so a path can hold runs of spaces.

### The mouse

| Where | Click | Drag | Wheel |
| --- | --- | --- | --- |
| The file | Places the cursor; double click selects a word, triple click the line; Shift+click extends the selection | Selects, scrolling at the edges, and copies on release — the file's text, without line numbers or the tree | Scrolls the file without moving the cursor |
| The scrollbar | Scrolls there | Scrolls | — |
| A tab | Switches to it; its `×` closes it (asking about unsaved changes) | — | — |
| The tree | Opens the file, or expands/collapses the folder | — | Scrolls the tree |
| The chat | Focuses the composer | Selects inside the chat pane only and copies on release, without the rail | Scrolls the transcript |
| A pane's title | Focuses the pane | — | — |
| A divider | — | Resizes the side pane | — |

The wheel scrolls the pane under the pointer, whatever has the focus. While a box is open, the panes behind it take no clicks. Copying uses the clipboard chain described above and says which way the text went; pasting with `Ctrl+V` reads the clipboard with `pbpaste`, PowerShell, `wl-paste`, `xclip`, `xsel` or the tmux buffer, and otherwise pastes what you last copied in the editor (your terminal's own paste, `Ctrl+Shift+V` or `Cmd+V`, always works).

### Files

| Command / key | Action |
| --- | --- |
| `Alt+N`, `/new-file [path]`, `n` in the tree | Create an empty file and open it; refuses a path that exists or a folder that does not |
| `/rename [path]`, `m` in the tree | Rename (move) the file — or, from the tree, a folder — taking its open tabs with it, unsaved edits included |
| `/delete [path]`, `d` or `Delete` in the tree | Delete the file (the path given, else the active tab's) after asking (`y` deletes, Enter or Escape cancel; it says when the tab has unsaved changes). Folders are not deleted from the editor |
| `/revert` | Put the file on disk back into the buffer (one undo step) |

Open files are watched. When a file changes on disk — another editor, a formatter, switching branches — a tab without unsaved edits is reloaded and the bottom bar says so (`Ctrl+Z` brings the old text back); a tab with unsaved edits is left alone, and nothing opens over what you are typing: the bottom bar says `⚑ <file> changed on disk — press alt+y to resolve` until you do. `Alt+Y` (or saving that tab) asks: **r** reload, **o** overwrite with yours, Enter or Escape keep editing (saving asks again). Each version of the file is offered once. A file deleted on disk is reported once; the tab keeps its text and `Ctrl+S` writes it again.

### Saving

Saving writes a temporary file next to the original and renames it into place, so a crash or a full disk leaves the old file rather than half of the new one. The file keeps its permissions, its owner and group, its line endings (a CRLF file is shown without `␍` and saved as CRLF) and its byte-order mark. A file that mixes CRLF and LF is saved with the more common one, and the editor says so when it opens. A file reached through a symlink is written at its target; a file with several hard links is written in place, and so is a file whose owner the editor may not give back to the temporary file, or whose folder does not let one be created there.

If the file changed on disk after you opened or last saved it — another editor, a formatter, the agent — saving asks first: **r** reloads the file (one undo step brings your version back), **o** overwrites it with yours, Enter or Escape cancels. A file deleted on disk can be written again with **o**.

The editor does not open a file it could not save back unchanged: a file that is not valid UTF-8, a binary file (it contains NUL bytes), a folder, a file over 5 MB, or anything that is not a regular file (a named pipe, a device, a socket) is refused with the reason.

Scratch buffers are saved with Save As: Ctrl+S on one asks for a path. Save As refuses a folder that does not exist and a path already open in another tab, and asks for a second Enter before replacing an existing file.

When closing a dirty buffer or quitting, choose **Save**, **Discard**, or **Cancel**. Enter and Escape cancel by default. Failed saves retain the buffer and report an error; a buffer that has no file yet or whose file changed on disk is not saved from this prompt — cancel, then use Save As or Ctrl+S.

### Finding and replacing

`Ctrl+F` searches from the cursor: the first match shown is the first one after it. Matches are highlighted in the buffer, the current one distinct, and the current one is selected. Enter and Shift+Enter move between matches; **Escape** closes the box and puts the cursor back where it was; **Alt+Enter** closes it with the cursor on the match. `Alt+C`, `Alt+R` and `Alt+W` toggle case sensitivity, regular expressions and whole words; an invalid regular expression is reported in the box.

`Alt+R` opens find and replace: Tab switches fields. The matches are drawn in the file and the current one is previewed in the box — its line with the match struck through and what replaces it. **Alt+Enter** replaces the current match (one undo step) and moves to the next one after it; Up and Down move between matches without replacing; **Enter** replaces every match as one undo step. Escape closes the box and says how many were replaced. With regular expressions on, the replacement can use `$1`, `$<name>`, `$&` and `$$`, and the preview shows what they expand to.

`Ctrl+Shift+F` or `Alt+G` (or `/search [query]`) searches the whole project: type the query and press Enter. Matches arrive while the search runs, one row per match with its file and line, and a preview of the selected one with the lines around it; Up/Down choose and Enter opens the file with the match selected. `Alt+C`, `Alt+R` and `Alt+W` work as in find. With [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) installed it does the search — `.gitignore` is respected and binary files are skipped, and regular expressions are ripgrep's dialect; without it the editor searches the files the file picker lists, one at a time so the screen stays responsive. The first 1,000 matches are shown, and the box says when there were more.

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

As in vim, outside INSERT the cursor stands on a character, never after the last one (`$a` appends on the same line, `h` and `l` stay on the line, `x` on an empty line does nothing); VISUAL selections include the character under the cursor, and `d` / `y` there delete or yank exactly that; a line yanked or deleted with `yy` / `dd` is put below the current line by `p`, other text after the cursor.

`Ctrl+S` saves in every mode. Escape is recognised however the terminal sends it, including the kitty keyboard protocol's `ESC[27u`. It is a small subset of vim, not a replacement for it.

Layout, open paths, cursor positions and unsaved drafts are checkpointed to:

```text
~/.octipus/projects/<project-hash>/tui-editor.json
```

The state file is private to its owner. Changes are checkpointed after a short debounce and flushed during orderly shutdown, including SIGTERM. Reopening the editor restores drafts as unsaved buffers for review. A forced kill or machine failure can lose edits since the last successful checkpoint. A checkpoint failure is reported in the mode bar.

### Reviewing the agent's edits

When the agent writes a file, its edit is shown as a diff before it reaches the buffer. The review does not open on its own — its single-letter keys would take whatever you were typing as an answer — and it does not switch tabs: the bottom bar says `⚑ agent edit to <file> ready for review — press alt+y to resolve` (with how many more are waiting), and `Alt+Y`, or saving that tab, opens it. Edits to several files wait in order; a newer edit to the same file replaces the waiting one. An edit that replaces one fragment (`str_replace_editor`'s `str_replace`, `edit` with `old_string`) is made in the text the agent works from — its edit still waiting, else the open tab, else the file on disk — and reviewed as the whole file; if the fragment it replaces is not there, or is there more than once, the bottom bar and the transcript say so and nothing is guessed. While the review is open the buffer is locked. A file that is not open is opened in a background tab for the review (a new file is compared with nothing); a change to a file the agent names relative to the project reaches its tab too.

The diff is split into **hunks** — runs of changed lines — marked with the current one (`▌`) and your decision (`✓` / `✗`):

| Key | Action |
| --- | --- |
| `y` / `n` | Accept / reject this hunk, then go to the next |
| `]` or Tab, `[` or Shift+Tab | Next / previous hunk |
| Space | Flip this hunk between accepted and rejected |
| `z` | Fold or unfold unchanged lines (three lines of context are kept around each hunk) |
| Enter | Apply: every hunk you did not reject |
| `a` / `r` or Escape | Accept / reject every hunk and apply |
| Up/Down, PageUp/PageDown, Home/End | Scroll |

If the tab has unsaved edits, only the agent's changes are hunks — the agent wrote against the file, not against your unsaved text — and accepting them keeps your edits; the tab stays unsaved while it differs from the file. A change of the agent's that overlaps or touches lines you changed is a **conflict**, marked `!`: it starts rejected (Enter keeps your lines), and accepting it replaces your lines in that block with the agent's.

Within a changed line and its replacement, the words that changed are drawn inverted. The result — the accepted hunks from the agent, the rest as they were — replaces the buffer as one undo step. The agent's text is compared without the CRs of a CRLF file, so only the lines that really changed show, and the file is saved CRLF again. A change too large to compare line by line (a file rewritten throughout) is shown as one replacement, and the box says so.

The review controls the editor buffer; it does not undo a filesystem write the agent already performed. If the agent has already written the file when you decide, the tab says so: after accepting everything it is clean (buffer and disk agree), after rejecting or a partial accept it shows as unsaved, and Ctrl+S writes your version back over the agent's. If you rejected some of the agent's edit and the agent writes the file only afterwards, the file is not reloaded over your choice: the tab keeps your version, shown as unsaved against the agent's file, and the bottom bar says so. If the file changed on disk by something other than the agent while you reviewed, the transcript says so and Ctrl+S asks before overwriting it.

Opening the workspace picker (`Ctrl+K`) or the MCP list (`Ctrl+E`) again while it loads does nothing; a workspace request that gets no answer within 5 seconds, or fails, is shown in the picker with the reason.

## Connection and appearance

Both clients connect to the gateway, normally `ws://localhost:3005/gateway`, signed in as your Octipus account. The login is stored in `~/.octipus/session.json` (mode 0600). When there is none — first run, after `/logout`, or once the server rejects it (expired, revoked, account deactivated) — the chat shell opens the login prompt once and does not connect until you sign in; `/login` reopens it. There is no machine account: a terminal sees only your sessions and events, like the browser, and an admin account gets no further than any other. The editor uses the same stored login; sign in from the chat shell first. Override the port with `API_PORT` or the checkout's `.env`:

```bash
API_PORT=3015 octi edit --project ~/code/myapp
```

### Themes

Three palettes: `dark` (the Deep Sea colours), `light` and `high-contrast` (white on black). By default (`auto`) the chat asks the terminal for its background colour (OSC 11) and takes `light` on a light background, `dark` on a dark one or when the terminal does not answer. `/theme <name>` switches at once and saves the choice as `theme` in `~/.octipus/tui.json`, keeping the file's other settings; a fixed theme applies to the editor too. Every role of every palette is checked against the backgrounds it is made for (4.5:1 for text, 3:1 for borders; 7:1 and 4.5:1 in high contrast). `NO_COLOR` set to anything turns colour off; bold, italics and underlines still tell roles apart.

Glyph availability depends on the terminal and font. File/status icons have an ASCII fallback:

```bash
OCTIPUS_TUI_ICONS=ascii octi edit
OCTIPUS_TUI_ICONS=emoji octi tui
```

Keybindings can be overridden in `~/.octipus/keybindings.json` (the editor's own include `app.file.saveAs`, `app.vim.toggle` and `app.pending.open`, the key that resolves a waiting prompt). The editor's `/reload` reloads those bindings; `/hotkeys` (`F5`) displays them, with vim mode's keys and commands.

If either surface stops on an error, or the terminal closes under it, it first turns mouse reporting off, shows the cursor and leaves raw mode, then prints the error and exits with a non-zero status, so the shell you return to works normally.

## Terminal compatibility

Both clients write ANSI sequences directly (pi-tui does not read terminfo): the alternate screen, cursor addressing, SGR mouse reports, bracketed paste, 24-bit colour. Any terminal that understands xterm's sequences can run them.

### What is tested, and how

Every terminal test runs the shipped entry point in a real pseudo-terminal on Linux and reads the screen with xterm's own model (`@xterm/headless`). So the outer terminal is always "xterm"; what varies is what sits between it and the program, and the environment the program sees.

| Environment | Covered by | What is checked |
| --- | --- | --- |
| xterm (the model) | every suite in `tests/tui/` | Layout, scrolling, selection, mouse, clipboard, resizes, exit paths, golden screens |
| tmux 3.4 | `terminals.e2e`, `tmux.e2e` | Both clients inside a real tmux: the frame sits above tmux's status line through resizes; clicks, drags and the wheel reach the client through tmux; a copy lands in the tmux buffer and tmux passes it on to the outer terminal as OSC 52. Run with the settings below and with tmux's defaults |
| SSH | `terminals.e2e` (environment only) | With `SSH_CONNECTION` / `SSH_TTY` set, a copy goes out as OSC 52 to your local terminal, not to a clipboard tool on the remote host. No real SSH connection is made |
| Linux console | `terminals.e2e` (`TERM=linux`, no `COLORTERM`) | Both clients draw, keep their last row and quit cleanly. The kernel console itself is not run |
| `TERM=dumb`, pipes | `terminals.e2e`, `terminal-check.test` | Both clients refuse to start, exit 2 and say why, writing no screen |
| Small windows | `terminals.e2e` (20×5, 30×6), the invariant suites (random sizes) | No row wraps; the chat keeps its status line last and the composer above it, the editor its mode bar last |

Not tested: real terminal emulators (GNOME Terminal and other VTE terminals, Konsole, Kitty, Ghostty, WezTerm, Alacritty, iTerm2, Terminal.app, Windows Terminal, conhost), GNU screen, Zellij, mosh, a real SSH session, the Linux kernel console, macOS, Windows, and screen readers. Emoji width follows Unicode 6 in the test model, so an emoji that a terminal draws wider than Octipus measures would not be caught.

### tmux

```tmux
set -g mouse on
set -g set-clipboard on
set -g allow-passthrough on
```

- `mouse on`: tmux's own mouse features (selecting panes, resizing them) work beside Octipus's. A pane that asks for mouse reports gets them either way; with tmux 3.4's default (`off`) clicks and the wheel still reached the client in our tests.
- `set-clipboard on`: copies reach your terminal's clipboard. Octipus copies into the tmux buffer (`tmux load-buffer -w`), and tmux forwards it as OSC 52; that also worked with the default (`external`), but `on` lets programs' own clipboard requests through as well. Your terminal must accept OSC 52 too.
- `allow-passthrough on`: lets sequences tmux would otherwise drop reach the terminal (inline images). Octipus does not depend on it today.

Inside tmux, GNU screen or Zellij the clients ask for mouse reports only while a button is held (`?1002`), not on every movement, so there is no hover highlighting (the scrollbar) there. tmux needs its RGB feature for 24-bit colour (`set -as terminal-features ',xterm-256color:RGB'` if colours look wrong).

### SSH

Run the clients on the remote host as usual. A clipboard tool there would copy on the remote machine, so over SSH the copy goes to your local terminal as an OSC 52 request; allow clipboard writes in your terminal. Shift+drag (Option+drag on macOS) is your terminal's own selection and always works. Mouse reports are ordinary input and travel over SSH with the keys.

### Linux console

`TERM=linux` works, with limits that come from the console itself: it has 16 colours (24-bit colours are approximated or ignored), its font may lack the box-drawing, braille spinner and `●` glyphs (set `OCTIPUS_TUI_ICONS=ascii` for the file and status icons), and it has no clipboard for OSC 52 — use `/export` or `/scrollback`. It sends no mouse reports to programs (`gpm` serves them through its own library), so use the keyboard; set `tui.mouse` to `off`.

### Windows

The clients themselves need no Python or other extra runtime on Windows: they read the console through Node's own TTY support (ConPTY in Windows Terminal and conhost). Copy uses `clip.exe`, paste `Get-Clipboard`. `octi tui` and `octi edit` from `bin/octi.cmd` still go through `npm run`. None of this has been run as part of this work; native Windows rendering is untested.

The terminal test suites need a POSIX pseudo-terminal (`tests/tui/pty.py`, Python's `pty`, `termios`, `fcntl`). On Windows they are skipped, and the harness refuses with a message pointing at WSL; run `npm run test:tui` under WSL, Linux or macOS. A relay that drives ConPTY from Node would need a native module (`node-pty`) and has not been added.

### Screen readers and reduced motion

The alternate screen redraws rows in place, which screen readers follow poorly. For a screen reader:

- `octi tui --inline --mouse off` draws in the terminal's normal buffer and leaves the mouse and selection to the terminal;
- `/scrollback` (`Alt+O`) prints the whole transcript into the terminal's scrollback as plain text, and `/export` writes it to a Markdown file;
- the exit summary prints the last exchange to the normal buffer.

The activity line animates a spinner (every 80 ms) while a tool or the model is working; there is no setting to stop it yet. Nothing else moves on its own.

### Startup

Time from the launch command to the first full frame, in a PTY on a shared Linux container (load average about 2–3), median of 12 runs: chat about 0.5 s, editor about 0.55 s (before this release: 0.9–1.0 s and 2.0 s). The plan's 150 ms target is not met when running from source: starting Node with the TypeScript loader and loading pi-tui (about 0.1 s) and zod (about 0.06 s, for `tui.json`) make up most of what is left. `src/tui-kit/startup-imports.test.ts` fails if something heavy (the server logger, tree-sitter, a model SDK, the database, voice, MCP) is imported before the first frame.

## Testing

```bash
npm run test:tui
```

This runs component, application and terminal regression tests. The terminal tests use **Python 3's standard-library PTY support** (`tests/tui/pty.py`; `TUI_PTY_PYTHON` picks the interpreter) plus a Node terminal emulator. Without a Python that can open a PTY they fail at once with a message saying what is missing, rather than hanging. They launch the shipped entry points against a controlled local WebSocket fixture, so no running Octipus server, provider credentials or paid model calls are required.

The tests assert current screen contents, including streaming Markdown, tool groups, stopping and queueing turns, search, pickers, notifications and the title, themes (OSC 11, `/theme`, `NO_COLOR`), links and images, pushed plan status, approvals, plan feedback, resize/focus and save/quit flows, the alternate screen (scrollback kept through resizes, the screen restored on every way out), drag selection and the clipboard chain, and a frame-time budget for a 5,000-message transcript. Two suites run the clients inside a real tmux when it is installed; `terminals.e2e.test.ts` covers the cases in [Terminal compatibility](#terminal-compatibility). Golden screens (`tests/tui/golden.e2e.test.ts`) compare five states of both clients — chat idle, mid-turn with tool output, the command palette, the editor with a file and the tree, a hunk review — with text-and-style snapshots in `tests/tui/goldens/`; a mismatch prints the rows that differ, and `UPDATE_TUI_GOLDENS=1` rewrites the files after an intended change (review the diff). `TUI_SCREENSHOTS_DIR=<dir>` also writes HTML pictures of them. An invariant suite (`tests/tui/invariants.e2e.test.ts`) drives the chat through random gateway events and resizes and checks after every step that the status line is the last row, the composer is above it with the cursor, and no row wraps (its random mix includes tool groups, thinking items, queued messages, pickers and link-carrying rows), and — against a model of the turn, with worker events in the server's real shapes, error frames that are and are not the turn failing, and the connection dropped and restored — that the messages sent and the window title's turn state are the model's and every message typed goes out once, in order; its editor counterpart (`tests/tui/editor-invariants.e2e.test.ts`) drives the editor through random keys, clicks, drags, wheel notches, resizes, agent edits and files changed on disk, and checks that no row wraps, the mode bar stays on the last row, the cursor stays in the editor pane (or an open box), and no control byte reaches the terminal outside an escape sequence. The chat suite runs 8 seeds by default and the editor's 6; `TUI_FUZZ_SEEDS=500` runs more and `TUI_FUZZ_SEED=<n>` reruns the seed a failure names. They run in the normal Vitest suite and Linux CI. The real-PTY portion is explicitly skipped on Windows; native Windows terminal rendering still needs separate verification. The screen model is xterm's: real terminal emulators are not exercised (see [Terminal compatibility](#terminal-compatibility)). Tests do not establish compatibility with every terminal or font.

See [TUI architecture](../architecture/TUI-EDITOR.md) for implementation details.
