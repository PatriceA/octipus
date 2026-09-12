# Terminal UI architecture

Octipus's chat shell (`src/tui-pi/`) and editor (`src/tui-editor/`) use `@mariozechner/pi-tui` for differential terminal rendering, the chat composer and overlays. The file editor uses Octipus's own `Buffer` and `TextEditor` components.

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
| `BufferStore` | Open buffers, dirty flags, active buffer, agent locks and edit application |
| `editor/buffer.ts` | Text, cursor, selection and undo/redo |
| `TextEditor` | Keyboard editing, Vim adapter, paste handling, highlighting and vertical/horizontal viewports |
| `FileTree`, `FilePicker` | Local project navigation |
| `FindOverlay`, `ReplaceOverlay` | Buffer search and replacement |
| `DiffOverlay` | Review proposed changes to an open buffer |
| `UnsavedPrompt` | Save/discard/cancel before dirty close or quit |
| `WorkspaceStore`, `ApiClient` | Workspace metadata and HTTP requests |

The editor's horizontal position is measured in terminal cells after tab expansion. ANSI-aware slicing preserves token styling. The focused character carries the cursor marker and contrasting colours.

## Saving, recovery and agent edits

Close and quit check dirty buffers. Enter/Escape cancel the unsaved prompt. Save errors keep the buffer open. Scratch buffers currently lack a Save As interaction.

`persist.ts` stores per-project state at `~/.octipus/projects/<hash>/tui-editor.json`. It checkpoints paths, cursor positions, pane settings and dirty text using a temporary file and rename with owner-only file permissions. Drafts restore as dirty buffers. Checkpoints are debounced during editing and flushed by `stop()`; failed checkpoints are reported in the mode bar. This is recovery support, not a guarantee against forced termination or disk failure.

The runtime delegates SIGINT to the editor's quit flow. SIGTERM checkpoints and shuts down without waiting for interaction. The normal editor quit path uses the same cleanup for timers, gateway connection and terminal state.

Agent proposals for open files are queued as diffs. Resolving one releases its buffer lock and presents the next. Unrelated palette shortcuts cannot discard pending diffs or approvals. Accept changes the local buffer and marks it dirty. It does not imply a filesystem transaction or undo an agent write already made on disk. The optional merge mode replaces buffer text through its undo stack.

## Highlighting

`installTreeSitterHighlighter()` installs a lazy tree-sitter adapter. `setSource(language, text)` parses an opened buffer and caches tokens by line. Missing grammars or changed text fall back to the line-based highlighter. The packages and grammar assets are resolved from the source installation's dependencies.

This is not yet a complete incremental editor parser: the cache is per language, and source updates can fall back to regex highlighting. The file editor is deliberately smaller in scope than an IDE; it has no language server, debugger or full Vim compatibility.

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
- Scratch buffers need a Save As workflow.
- Mouse interactions and draggable pane sizing are not implemented.
- Local commands such as chat login/resume are not fully shared with the editor.
