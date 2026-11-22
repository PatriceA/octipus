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

The editor frame sizes itself from the terminal's row count and the rendered status height. The central region contains the tab strip and `TextEditor`; chat reuses the shared frame and subagent panel.

| Component / store | Responsibility |
| --- | --- |
| `BufferStore` | Open buffers, saved text and disk state per buffer, dirty (by comparison), active buffer, agent locks, Save As rebinding |
| `editor/buffer.ts` | Text, grapheme-aware cursor and selection, grouped undo/redo |
| `editor/columns.ts` | Grapheme boundaries and the one width function the cursor maths and the renderer share |
| `editor/indent.ts` | What Tab inserts, detected from the file |
| `TextEditor` | Keyboard editing, Vim adapter, paste handling, highlighting, selection and find-match drawing, vertical/horizontal viewports |
| `workspace-fs-bridge.ts` | Reading (encoding, line endings, BOM), atomic writing, external-change checks |
| `project-files.ts` | The shared skip list, one folder for the tree, the async project index for the picker |
| `FileTree`, `FilePicker` | Local project navigation |
| `FindOverlay`, `ReplaceOverlay` | Buffer search and replacement |
| `TextField` | The one text field of the overlays (pi-tui `Input`) |
| `DiffOverlay` | Review proposed changes to an open buffer |
| `UnsavedPrompt`, `ExternalChangePrompt`, `SaveAsPrompt` | Save/discard/cancel; reload/overwrite/cancel; a path for Save As |
| `WorkspaceStore`, `ApiClient` | Workspace metadata and HTTP requests (5 s timeout, failures reported) |

Columns are UTF-16 offsets that only ever fall on grapheme boundaries (`Intl.Segmenter`): Left/Right, Backspace and Delete step over a whole grapheme, and a position inside one snaps to its start. Width has one definition, `columns.ts`: tabs advance to the next multiple of four cells, control bytes are drawn as one-cell control pictures, and pi-tui's `visibleWidth` measures the rest. Up/Down aim for the drawn cell, not the code-unit column. ANSI-aware slicing preserves token styling. The focused character carries the cursor marker and contrasting colours.

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

Agent proposals for open files are queued as diffs; a relative path is resolved against the project. Resolving one releases its buffer lock and presents the next. Unrelated palette shortcuts cannot discard pending diffs or approvals. Accept replaces the buffer text as one undo step. After either choice the buffer's baseline is moved to the file's content if the agent has already written it, so `dirty` says whether buffer and disk agree. It does not imply a filesystem transaction or undo an agent write already made on disk. The diff overlay sizes its body to the rows the overlay frame gives it (`setMaxRows`).

`stop()` releases what the app subscribed to — store listeners, the global input listener, the adapter listener — and clears the persist, MCP and parse timers. `start()` that fails to connect calls `stop()` (which restores the terminal through `onShutdown`) before rethrowing; the entry point prints the error and exits 1. The workspace and MCP overlays are guarded against a second open while the first is still loading.

## Highlighting

`installTreeSitterHighlighter()` installs a lazy tree-sitter adapter. `setSource(bufferId, language, text)` parses one buffer and caches tokens by line; `hintLine(bufferId, row)` precedes each lookup and `dropSource` frees a closed buffer. Parsers are shared per language; parses are per buffer, so two files of a language do not evict each other. The app parses a buffer when it opens and again 150 ms after its last edit; a parse that finishes after a newer one is discarded. Each parse is a full parse: incremental parsing would need the old tree edited with the edit's byte offsets first, and an unedited old tree reuses nodes at wrong offsets. Until a re-parse lands, a line whose text differs from the parse is drawn by the line-based highlighter. Missing grammars fall back to it too. Tokens are taken from the stored line (tabs are expanded per piece afterwards), so lines with tabs hit the cache. The packages and grammar assets are resolved from the source installation's dependencies.

The file editor is deliberately smaller in scope than an IDE; it has no language server, debugger or full Vim compatibility.

## Verification

`npm run test:tui` runs the component/application tests and `tests/tui/*.e2e.test.ts`. The default Vitest run includes them as well.

The terminal harness launches the actual Node entry points under a POSIX PTY using Python 3, connects them to a controlled WebSocket fixture, and feeds output to `@xterm/headless`. Assertions inspect the current terminal buffer, not an ANSI-stripped history of everything ever printed. Each test uses an isolated home and project directory.

Coverage includes role distinction, long-answer scrolling, stable reading positions, cursor width, multiline paste, shared event handling, approval queues, plan feedback, dirty-buffer protection, recovery and resized layouts. The PTY tests run on Linux CI and skip explicitly on Windows. They do not establish rendering compatibility across all terminal emulators, fonts or operating systems.

Optional screen artifacts:

```bash
TUI_SCREENSHOTS_DIR=/tmp/tui-screens npm run test:tui
```

This writes HTML/text representations of captured terminal cells for inspection. The HTML uses a chosen dark background; the user's actual terminal controls its own default background and fonts.

## Remaining limits

- Native Windows terminal verification is separate from POSIX PTY tests.
- External changes are detected when saving and after agent edits, not watched: a file changed on disk while open is only noticed at the next save.
- Spacing marks (Devanagari and similar) can be measured narrower than terminals draw them (the width audit in `src/tui-kit/terminal-text.width.test.ts`).
- Mouse interactions and draggable pane sizing are not implemented.
- Local commands such as chat login/resume are not fully shared with the editor.
