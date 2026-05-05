# TUI editor — design

A full-screen terminal editor that doubles as the agent's
collaborator. The user lives inside a multi-pane editor while the
agent edits files alongside, and approval gates / chat messages
appear inline.

> **Implementation update (May 2026).** The editor (and chat shell)
> were rewritten on top of [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui)
> after an initial Ink-based prototype. Pi-tui is a small differential-
> rendering TUI library — `Component` / `Container` / `TUI` plus a
> built-in `Editor`, overlay system, and keybindings manager. The
> sections below reflect the shipping pi-tui implementation.

## What pi-tui gives us

| Pi-tui primitive | Used for |
|---|---|
| `TUI` + `Container` | Root + pane composition with differential rendering |
| `Editor` | Both the chat composer **and** the file-buffer editor; ships paste markers, kill ring, undo, history nav, fuzzy file completion, slash-command autocomplete |
| `tui.showOverlay()` | Modal layer for command palette, file picker, find/replace, diff, hotkeys, permission prompts, workspace picker, MCP list |
| `KeybindingsManager` | App-level binding ids (`app.palette.open`, …) + user overrides at `~/.octipus/keybindings.json` |
| `Markdown` component | Assistant message rendering (headings, code fences, links) |
| `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` | OSC-aware width math (markdown hyperlinks don't break pane padding) |

What we layer on top, under `src/tui-editor/`:

- Gateway adapter (WebSocket auth + reconnect; reused from the chat shell).
- App-level components: file tree, tab strip, mode bar, file picker,
  find/replace overlay, diff overlay, workspace picker, MCP server list,
  hotkeys overlay.
- Stores: `BufferStore`, `LayoutStore`, `WorkspaceStore`, `AgentStore`.
- Theme + glyph helper with terminal-capability emoji fallback.

## Goals

- **Editor-first**, not chat-first. The center pane is a real text
  editor with cursor + selection + scrolling. The agent's
  conversation lives in a side pane.
- **Multi-buffer** with explicit file backing — open files become
  buffers; agent edits show up as live in-buffer diffs the user
  can accept / reject inline.
- **Pane composition** — left file tree, center editor, right
  chat. Each pane can be hidden / focused / resized.
- **Keyboard-first** with discoverable shortcuts via a command
  palette (`Ctrl+P` / `F4`) and a hotkeys overlay (`F5`).
- **Agent integration** routes through the existing gateway
  client; no fork in the auth / session model.
- **Multi-user aware**: respects the `X-Octipus-Workspace`
  header so the file tree + agent context match the active workspace.

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● Octipus  · workspace          connected     17.3k tok · 3 turns    │  status bar
├──────────────┬──────────────────────────────┬───────────────────────┤
│ [+] src/     │  README.md  index.ts         │ Chat                  │
│   index.ts   │  1  # Octipus                │                       │
│   foo.ts     │  2                           │ ❯ open src/index.ts   │
│ [+] tests/   │  3  > alpha                  │   opening …           │
│              │  …                           │ ────────────────────  │
│              │                              │                       │
│              │                              │ ────────────────────  │
├──────────────┴──────────────────────────────┴───────────────────────┤
│ INS  README.md  markdown  L1:1                                       │  mode bar
└──────────────────────────────────────────────────────────────────────┘
```

Three pane regions, each independently mountable:

- **Left** — workspace file tree (toggleable with `Ctrl+B`).
- **Center** — editor + tab strip. Multiple buffers can be open;
  one is focused. Tabs cycle with `Alt+,` / `Alt+.` (or `F2` / `F3`).
- **Right** — chat with the agent. Same composer + slash registry as
  the chat shell. Toggleable with `Alt+J`.
- **Status bar** (top, single line) — global state.
- **Mode bar** (bottom, single line) — cursor position, focus pane,
  active buffer, active permission prompt.

When the tree and chat are hidden the layout reduces to "fullscreen
edit": status + tabs + editor + mode bar.

## Component inventory

Under `src/tui-editor/components/`:

- `SplitPane` — three-column layout primitive. Reads `LayoutStore`
  for pane visibility on every render and sizes panes from the
  terminal's true row count (`tui.terminal.rows`) — important: an
  earlier version fed the editor's previous render height back as
  its setHeight target and the panes collapsed to the floor (5 rows)
  after a few cycles.
- `TextEditor` — multi-line buffer editor with cursor, selection,
  vertical scroll, line numbers, pattern-based syntax highlighting,
  vim mode (modeless / vim toggle), undo/redo via a transactional
  buffer.
- `FileTree` — directory walk with depth + entry caps, selectable,
  ASCII / emoji glyphs.
- `TabStrip` — buffer tab list with dirty markers.
- `ModeBar` — vim mode + filename + language + cursor position +
  focus pane indicator (`focus:editor` / `focus:chat` / `focus:tree`).
- `ChatPane` — wraps the chat shell's `MessagesPane` + `ActivityLine`
  + `Composer`. Pinned-bottom layout: composer at the foot,
  messages flow up.
- `FilePicker` — overlay; case-insensitive substring filter on the
  relative path (pi-tui's built-in `SelectList.setFilter` is a
  prefix match on `value`, which would be the absolute path —
  unhelpful, so we rebuild the list per keystroke).
- `FindOverlay`, `ReplaceOverlay` — incremental find / replace.
- `DiffOverlay` — `[a]ccept` / `[r]eject` agent edits applied to a
  locked buffer.
- `HotkeysOverlay` — paginated, scrollable hotkeys list (Up / Down /
  PageUp / PageDown / Home).
- `WorkspacePicker`, `MCPServerList`, `PermissionPrompt`.

Reused from `src/tui-pi/`:

- `StatusBar`, `MessagesPane`, `ActivityLine`, `Composer`,
  `CommandPalette`, `PermissionPrompt`.
- `GatewayAdapter` (WebSocket client wrapper).
- `Keybindings` definitions + `installOctipusKeybindings()`.
- Theme + glyph helpers.

## Stores

- `BufferStore` — open files → buffer state (text, cursor,
  selection, dirty flag, language, lock mode).
- `AgentStore` — chat messages, current tool, pending permissions,
  cumulative cost.
- `LayoutStore` — pane visibility, focused pane, editor mode
  (modeless / vim).
- `WorkspaceStore` — active workspace slug + project root, fed by
  `/api/me/workspaces`.

Each store is a tiny pub-sub container; components subscribe via
`bindStore(store, component, tui)` so a state change schedules a
single render.

## Key bindings

User-overridable at `~/.octipus/keybindings.json`. Defaults:

| Shortcut | Action | Notes |
|---|---|---|
| `Ctrl+O` | File picker | |
| `Ctrl+S` | Save current buffer | |
| `Ctrl+W` | Close current buffer | |
| `Alt+,` / `F2` | Previous buffer | `Ctrl+Tab` was unreliable in non-Kitty terminals |
| `Alt+.` / `F3` | Next buffer | |
| `Ctrl+B` | Toggle file tree | |
| `Alt+J` | Toggle chat pane | `Ctrl+J` collides with `LF` |
| `Ctrl+\` / `F6` | Cycle focused pane | |
| `Ctrl+F` | Find in buffer | |
| `Alt+R` | Find & replace | `Ctrl+H` collides with `Backspace` |
| `Ctrl+K` | Switch workspace | |
| `Ctrl+E` | MCP server list | `Ctrl+M` collides with `Enter` |
| `Ctrl+P` / `F4` | Command palette | |
| `F5` | Hotkeys overlay | `F1` is hijacked by many terminals |
| `Ctrl+Q` | Quit | |
| `Esc` | Cancel current overlay | Inside the editor: leave INSERT mode (vim) |

### Bindings we deliberately don't use

`Ctrl+M`, `Ctrl+H`, `Ctrl+J`, `Ctrl+I`, `Ctrl+[` — these are
indistinguishable from `Enter`, `Backspace`, `LF`, `Tab`, `Esc` on
terminals without the Kitty keyboard protocol. Binding any of them
would silently hijack normal text input. `Ctrl+-` / `Ctrl+=` are
zoom in/out for most terminal emulators.

## Chat fallbacks

Every overlay-opening keybinding has a slash-command equivalent in
the chat composer, in case a key is hijacked by the host terminal:

- `/quit`, `/exit`, `/q`
- `/keys`, `/hotkeys` — open the hotkeys overlay
- `/palette` — open the command palette
- `/reload` — reload `~/.octipus/keybindings.json`

## Persisted state

`~/.octipus/tui-editor.json`:

- `openPaths` — currently open buffers
- `activePath` — focused buffer
- `cursorByPath` — cursor position per file
- `treeVisible`, `chatVisible`
- `editorMode` — `'modeless'` or `'vim'`

Loaded on launch; saved 500 ms after every layout / buffer change.

## Coexistence with the chat TUI

`src/tui-pi/` (chat shell) and `src/tui-editor/` (editor) ship
side-by-side and share:

- `GatewayAdapter` for the WebSocket protocol
- `Composer`, `MessagesPane`, `ActivityLine`, `StatusBar`
- The keybinding registry
- The theme + glyph table

Entry points:

- `octi tui` → `src/tui-pi/index.ts` (chat shell)
- `octi edit` → `src/tui-editor/index.ts` (editor)
- `bun run tui:edit` and `./bin/octi-tui-edit.mjs` are equivalent
  to `octi edit` for scripting.

## Tests

- Unit tests next to each component / store under `src/tui-pi/**`
  and `src/tui-editor/**`.
- E2E harness: `tests/tui/harness.ts` spawns the entry script under
  fixed `COLUMNS` / `LINES`, drives stdin, strips ANSI, exposes
  `waitFor(needle)`.
- `tests/tui/chat.e2e.test.ts` and `tests/tui/editor.e2e.test.ts`
  cover launch, focus cycling, slash commands, the file picker
  filter, the command palette, and `/quit`.

```bash
bun test tests/tui/
```

Skipped when the gateway isn't running on `API_PORT`.

## Open follow-ups

- Tree-sitter (or LSP) implementation of the pluggable highlighter
  slot for ts/tsx/py/rust/go.
- Workspace switch → instant reconnect so the new slug applies
  without a manual restart.
- VIM IME-aware INSERT mode + named registers (`"a` etc.).
- Mouse wheel scrolling once pi-tui exposes mouse APIs.
