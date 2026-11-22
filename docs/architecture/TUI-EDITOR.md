# Terminal UI architecture

Octipus's chat shell (`src/tui-pi/`) and editor (`src/tui-editor/`) use `@mariozechner/pi-tui` for differential terminal rendering, the chat composer and overlays. They reach it only through `src/tui-kit/`, which re-exports by name what the code uses and also holds `terminal-text.ts`, the boundary that reduces outside text to what a terminal draws predictably; `src/tui-kit/seam.test.ts` fails when another file imports pi-tui. The file editor uses Octipus's own `Buffer` and `TextEditor` components.

## Shared conversation presentation

`ChatSessionPresenter` handles streaming iterations, completed replies, thinking/tool activity, subagent events, identity, session usage and plan status in both surfaces. Application-specific responsibilities such as chat login/resume and editor file operations stay in their respective apps.

`GatewayAdapter` scopes event decoding to the active session, including final responses. Commands carry that session ID. The editor creates a fresh session per launch; buffer recovery is separate from agent-session resumption.

`MessagesPane` renders role labels, user rails, Markdown replies and distinct errors. Historical message rendering is cached by message and width; a live delta does not reparse historical Markdown. The viewport scrolls in terminal rows. While reading history, it freezes rendered rows so new events cannot move the reading position. Resizing clips that frozen view; returning to the live tail reflows at the current width.

`renderChatFrame` allocates rows among transcript, activity, subagents, composer and optional status. Multiline input is cropped around pi-tui's `CURSOR_MARKER`. The plan summary, actions and connection line take priority over expanded details on short screens.

`StatusBar` displays plan progress and optionally steps around the active one. `/work-plan` opens details and adds the full report to the transcript; automatic refreshes update the details without duplicating the transcript entry. `/plan-feedback` uses the existing gateway command. Plans and costs retain the backend's semantics; a displayed step completion is not independent verification.

`DecisionQueue` serializes permission and approval prompts. Each decision is answered through its corresponding gateway channel. Escape declines. Other global shortcuts do not dismiss a pending modal. Shutdown declines queued requests before disconnecting.

## Editor composition

`SplitPane` displays Files, Editor and Chat with a visible focus marker. At widths below 80 columns it renders the focused pane at full width. `LayoutStore` moves focus to the editor when a focused side pane is hidden. Resize callbacks run before child rendering.

The editor frame sizes itself from the terminal's row count and the rendered status height. The central region (`EditorPane`) contains the tab strip and `TextEditor`; chat reuses the shared frame and subagent panel.

`app.ts` is the composition root: it builds the stores, panes and gateway connection and hands an `EditorContext` (stores, overlay slots, notice and transcript functions) to the parts of the shell in `src/tui-editor/shell/`:

| Module | Responsibility |
| --- | --- |
| `overlay-slots.ts` | Which overlays are open, one per name; closing one gives the focus back (always, or only when no other is open) |
| `overlay-actions.ts` | Opening the palette, shortcuts, file picker, find, replace, project search, workspace and MCP overlays |
| `file-ops.ts` | Open, save, Save As, reload, the unsaved and changed-on-disk prompts, syncing the baseline after a review |
| `file-commands.ts` | New file, rename, delete (asking), revert |
| `file-watcher.ts` | Watching open files for external changes |
| `agent-review.ts` | The agent's edits, waiting for the resolve key and reviewed hunk by hunk |
| `pending-prompts.ts` | Background questions (changed on disk, agent edit) waiting for `app.pending.open` (Alt+Y) or a save of their buffer, shown in the mode bar |
| `commands.ts` | Composer commands and global hotkeys |
| `persistence.ts`, `highlight-parses.ts` | The per-project checkpoint; debounced re-parsing |

The overlays draw their boxes with `drawBox` from `src/tui-kit/overlay-frame.ts` and take text through `src/tui-kit/text-field.ts` (pi-tui `Input`); one-field questions use `InputPrompt`, yes/no ones `ConfirmPrompt`.

### Mouse

On the alternate screen the renderer parses SGR mouse reports and dispatches them by position. The editor's root swallows every event while a modal is open. `SplitPane.handleMouse` finds the pane (or divider) under the pointer from the column layout of its last render, forwards the event in that pane's coordinates, and keeps a press's drag, release and click with the pane that took it, even outside its bounds; a divider press drags `LayoutStore.treeWidth` / `chatWidth`; a press on the title row focuses the pane. `EditorPane` sends the first row to `TabStrip` (tab cells recorded at render; `×` closes through the unsaved prompt) and the rest to `TextEditor`. `FileTree` opens or toggles on click and scrolls on the wheel. `ChatPane` scrolls its transcript on the wheel and keeps its own selection, drawn inverted and cut to the pane, so a copy never takes the tree or the editor beside it.

`TextEditor.handleMouse` maps a cell to a buffer position from the current view (`editor/view.ts`: rows of a line, soft-wrapped or not, and the column under a cell), so a selection is buffer text, never the gutter. The wheel moves the view without the cursor; the view follows the cursor only when the cursor, the text or the size changed since it last did, so a scrolled view is not pulled back at the next render.

| Component / store | Responsibility |
| --- | --- |
| `BufferStore` | Open buffers, saved text and disk state per buffer, dirty (by comparison), active buffer, agent locks, Save As rebinding |
| `editor/buffer.ts` | Text, grapheme-aware cursor and selection, grouped undo/redo |
| `editor/columns.ts` | Grapheme boundaries and the one width function the cursor maths and the renderer share |
| `editor/indent.ts` | What Tab inserts, detected from the file |
| `TextEditor` | Keyboard editing (paging, Shift selection, auto-indent, cut/paste), Vim adapter, paste handling, highlighting, selection, find-match and matching-bracket drawing, the view with scrolloff and soft wrap, the scrollbar, the mouse |
| `editor/view.ts` | Rows of a line (soft wrap breaks between graphemes), the column under a cell, stepping and counting rows |
| `editor/brackets.ts` | The bracket matching the one at the cursor (bounded scan) |
| `editor/diff.ts`, `editor/hunks.ts` | Myers line diff with a work budget; hunks, applying a subset, intra-line spans |
| `project-search.ts` | Project search: ripgrep (`--json`), else the project index searched file by file |
| `workspace-fs-bridge.ts` | Reading (encoding, line endings, BOM), atomic writing, external-change checks |
| `project-files.ts` | The shared skip list, one folder for the tree, the async project index for the picker |
| `FileTree`, `FilePicker` | Local project navigation |
| `FindOverlay`, `ReplaceOverlay`, `ProjectSearchOverlay` | Buffer search; replacement one at a time or all, with a preview; search across the project with results and a preview |
| `TextField` (`tui-kit/text-field.ts`) | The one text field of the overlays (pi-tui `Input`) |
| `DiffOverlay` | Review of an agent edit, hunk by hunk, with folding and intra-line highlighting |
| `UnsavedPrompt`, `ExternalChangePrompt`, `SaveAsPrompt`, `InputPrompt`, `ConfirmPrompt` | Save/discard/cancel; reload/overwrite/cancel; a path for Save As; one-field questions (go to line, new file, rename); delete confirmation |
| `TabStrip`, `EditorPane`, `ChatPane`, `SplitPane` | Tabs with close markers; the middle pane; the chat with its own selection; the three panes, dividers and mouse routing |
| `WorkspaceStore`, `ApiClient` | Workspace metadata and HTTP requests (5 s timeout, failures reported) |

Columns are UTF-16 offsets that only ever fall on grapheme boundaries (`Intl.Segmenter`): Left/Right, Backspace and Delete step over a whole grapheme, and a position inside one snaps to its start. Width has one definition, `columns.ts`: tabs advance to the next multiple of four cells, C0 control bytes are drawn as one-cell control pictures and C1 controls (U+0080–U+009F) as U+FFFD, and pi-tui's `visibleWidth` measures the rest. Up/Down aim for the drawn cell, not the code-unit column. ANSI-aware slicing preserves token styling. The focused character carries the cursor marker and contrasting colours.

Undo records, per step, what each edit removed and inserted and where, with the cursor and selection before and after. A step is one action: consecutive typing or deleting at the same place (until a newline, a cursor move or a one-second pause), a paste, a replace-all, an agent edit, or anything wrapped in `Buffer.transact`. An edit that changes nothing records nothing and keeps redo. The stack holds 200 steps.

The editor's keys beyond the shared set live in `tui-editor/keybindings.ts` (`app.file.saveAs`, `app.vim.toggle`), installed over the shared manager without dropping user overrides. In vim mode, input goes through `toVimKey`, which decodes with `matchesKey` and the kitty printable decoder (so `ESC[27u` is Escape); several keys arriving in one chunk are stepped one by one. `:` commands are parsed in `vim.ts` and carried out by the app.

## Saving, recovery and agent edits

Each buffer keeps the text it was loaded from or last saved as, and `DiskInfo` (mtime, size, line ending, BOM, mode). `dirty` is `buffer.text() !== savedText`, re-evaluated on every text change through `Buffer.onChange`.

Reading refuses binary, non-UTF-8 (a fatal `TextDecoder`), folder and over-5 MB files with a reason. CRLF pairs become `\n` in the buffer; the majority line ending and the BOM are written back. A lone CR stays in the text and is drawn as `␍`.

Saving checks the file first (`checkDisk`): unchanged mtime and size, or a different mtime with the same content, is no change; anything else — or a deleted file, or an existing file the buffer never read — opens the reload/overwrite/cancel prompt. The write goes to a temporary file in the same folder, is flushed, takes the original mode and is renamed over the target; a symlink is resolved to its target first, and a file with more than one hard link is written in place so its other names keep seeing it. The unsaved prompt saves only what needs no further question; a scratch buffer or a changed file is reported there, to be handled after cancelling.

Save As resolves a path against the project, refuses a missing folder or a path open in another tab, needs a second Enter to replace an existing file, and rebinds the buffer (path, label, language, baseline) without changing its id.

Close and quit check dirty buffers. Enter/Escape cancel the unsaved prompt. Save errors keep the buffer open. Discard reverts the buffer to its saved text.

`persist.ts` stores per-project state at `~/.octipus/projects/<hash>/tui-editor.json`. It checkpoints paths, cursor positions, pane settings and dirty text using a temporary file and rename with owner-only file permissions. Drafts restore as dirty buffers. Checkpoints are debounced during editing and flushed by `stop()`; failed checkpoints are reported in the mode bar. This is recovery support, not a guarantee against forced termination or disk failure.

The runtime delegates SIGINT to the editor's quit flow. SIGTERM checkpoints and shuts down without waiting for interaction. The normal editor quit path uses the same cleanup for timers, gateway connection and terminal state.

Agent proposals never open on their own: they wait in `PendingPrompts` (one per buffer, the newest text replacing an older one), the mode bar shows the oldest with the resolve key, and the review opens on that key or when the user saves the buffer — no focus change, no tab switch, so a single-letter answer can never come from typing. A relative path is resolved against the project, and a file that is not open is opened in a background tab for review (a missing file as a tab with the path and no file yet). The agent's text is compared with CRLF pairs reduced to `\n`, like the buffer. The buffer is locked only while its review is open; resolving it releases the lock. Unrelated palette shortcuts cannot discard pending diffs or approvals. The diff (`editor/diff.ts`) trims the common prefix and suffix and runs Myers on interned lines with a work budget (4 M steps, 2,000 edits); past it the changed middle is one replacement and the overlay says so. Hunks are runs of changed lines; `applyHunks` rebuilds the text from the ops, the accepted hunks from the agent and the others from the buffer, and the result replaces the buffer text as one undo step. Intra-line spans come from the same diff over word tokens, and are left out when the lines have less than a third in common. After the review the buffer's baseline moves to the file's content only when the disk holds exactly the agent's text (`syncWithDisk`), so `dirty` says whether buffer and disk agree; a file changed by something else keeps its old baseline and saving asks. It does not imply a filesystem transaction or undo an agent write already made on disk. The diff overlay sizes its body to the rows the overlay frame gives it (`setMaxRows`).

`FileWatcher` stats every open file once a second and compares size and mtime with the buffer's `DiskInfo`; a difference is confirmed by content (`checkDisk`), so a touch only refreshes the `DiskInfo`. A clean buffer is reloaded through `reloadFromDisk` (one undo step); for a dirty one the external-change prompt waits in `PendingPrompts` once per file version (never opened over typing); a deletion is reported once. A buffer under agent review, or with a review waiting, is skipped, and one whose file now holds exactly its text is marked saved. Polling rather than `fs.watch`: an atomic save replaces the file by rename, which `fs.watch` loses track of.

Project search runs `rg --json` with the tree's skip list as globs and `--hidden`, converts ripgrep's byte offsets to UTF-16 columns, and stops at 1,000 hits by killing it; without ripgrep (`ENOENT`) it searches the files of `indexProjectFiles` with the find expression, skipping files over 5 MB and binary ones, yielding to the event loop between files. A new query or closing the overlay cancels the running search.

`stop()` releases what the app subscribed to — store listeners, the global input listener, the adapter listener — and clears the persist, MCP and parse timers. `start()` that fails to connect calls `stop()` (which restores the terminal through `onShutdown`) before rethrowing; the entry point prints the error and exits 1. The workspace and MCP overlays are guarded against a second open while the first is still loading.

## Highlighting

`installTreeSitterHighlighter()` installs a lazy tree-sitter adapter. `setSource(bufferId, language, text)` parses one buffer and caches tokens by line; `hintLine(bufferId, row)` precedes each lookup and `dropSource` frees a closed buffer. Parsers are shared per language; parses are per buffer, so two files of a language do not evict each other. The app parses a buffer when it opens and again 150 ms after its last edit; a parse that finishes after a newer one is discarded. Each parse is a full parse: incremental parsing would need the old tree edited with the edit's byte offsets first, and an unedited old tree reuses nodes at wrong offsets. Until a re-parse lands, a line whose text differs from the parse is drawn by the line-based highlighter. Missing grammars fall back to it too. Tokens are taken from the stored line (tabs are expanded per piece afterwards), so lines with tabs hit the cache. The packages and grammar assets are resolved from the source installation's dependencies.

The file editor is deliberately smaller in scope than an IDE; it has no language server, debugger or full Vim compatibility.

## Verification

`npm run test:tui` runs the component/application tests and `tests/tui/*.e2e.test.ts`. The default Vitest run includes them as well.

The terminal harness launches the actual Node entry points under a POSIX PTY using Python 3, connects them to a controlled WebSocket fixture, and feeds output to `@xterm/headless`. Assertions inspect the current terminal buffer, not an ANSI-stripped history of everything ever printed. Each test uses an isolated home and project directory.

Coverage includes role distinction, long-answer scrolling, stable reading positions, cursor width, multiline paste, shared event handling, approval queues, plan feedback, dirty-buffer protection, recovery and resized layouts, and for the editor: SGR mouse clicks, drags and double clicks (`editor-mouse.e2e`), hunk review of a CRLF file and a review tab (`editor-review.e2e`), project search with and without ripgrep and replace one at a time (`editor-search.e2e`), new file, rename, delete and the external-change reload (`editor-files.e2e`), and an invariant fuzzer over random keys, mouse, resizes, agent edits and disk changes (`editor-invariants.e2e`: no wrapped row, the mode bar on the last row, the cursor in the editor pane or an overlay, no control byte outside an escape sequence; 6 seeds by default, `TUI_FUZZ_SEEDS` / `TUI_FUZZ_SEED` / `TUI_FUZZ_STEPS`). The PTY tests run on Linux CI and skip explicitly on Windows. They do not establish rendering compatibility across all terminal emulators, fonts or operating systems.

Optional screen artifacts:

```bash
TUI_SCREENSHOTS_DIR=/tmp/tui-screens npm run test:tui
```

This writes HTML/text representations of captured terminal cells for inspection. The HTML uses a chosen dark background; the user's actual terminal controls its own default background and fonts.

## Remaining limits

- Native Windows terminal verification is separate from POSIX PTY tests.
- External changes are polled once a second, not pushed: a change and its revert within that second are not noticed until saving.
- Up and Down move by buffer lines, also with soft wrap on (as vim's `j`/`k`), not by screen rows.
- Project search regular expressions are ripgrep's dialect when ripgrep runs and JavaScript's otherwise.
- Divider positions are kept for the session, not across launches.
- Spacing marks (Devanagari and similar) can be measured narrower than terminals draw them (the width audit in `src/tui-kit/terminal-text.width.test.ts`).
- Local commands such as chat login/resume are not fully shared with the editor.
