# TUI editor — design

A full-screen terminal editor that doubles as the agent's
collaborator. Inspired by [pi-mono](https://github.com/badlogic/pi-mono):
the user lives inside a multi-pane editor while the agent edits
files alongside, and approval gates / chat messages appear inline.

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
  palette (Ctrl+P).
- **Agent integration** routes through the existing gateway
  client; no fork in the auth / session model.
- **Multi-user aware**: respects the `X-Octipus-Workspace`
  header (Phase 4) so the file tree + agent context match the
  selected workspace.

## Non-goals (this iteration)

- Full LSP integration (defer to a later phase — we'll mark
  spots where it would slot in).
- Mouse support beyond Ink's default click-to-focus (Ink doesn't
  ship robust mouse APIs; defer).
- Full vim emulation. We'll provide vim-like motion (h/j/k/l,
  w/b, gg/G) under a toggle, but the default mode is "modeless
  text-input" matching pi-mono's editor component.

## Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Octipus  ●  default workspace          claude-sonnet-4.5  $0.0024   │  status bar
├──────────────┬───────────────────────────────────┬──────────────────┤
│ ▾ src/       │ ➜ src/api/server.ts  [modified]  │ Chat              │
│   ▸ api/     │                                  │                   │
│   ▸ tools/   │   1  import { cors } from ...    │ > how do I add a  │
│   ▸ tui/     │   2  import { swagger } ...      │   new route?      │
│ ▸ tests/     │   3  import { eq } ...           │                   │
│ ▸ docs/      │   4  import { Elysia, } ...      │ Add a route by    │
│              │   5  import { getConfig } ...    │ creating a new    │
│              │   6                              │ Elysia subapp...  │
│              │   …                              │                   │
│              │ ─────────────────────────────────│ ─────────────     │
│              │ tabs: server.ts  routes/auth.ts  │ tools: read       │
├──────────────┴──────────────────┬───────────────┴──────────────────┤
│ NORMAL  src/api/server.ts:42:8  │  ⚠ Permission: write src/foo.ts   │  status / prompt bar
└─────────────────────────────────┴───────────────────────────────────┘
```

Three pane regions, each independently mountable:

- **Left** — workspace file tree (collapsible, lazy-loaded
  directories). Toggleable with `Ctrl+B`.
- **Center** — editor + tab strip. Multiple buffers can be open;
  one is focused. Tab strip at the bottom.
- **Right** — chat with the agent. Message stream + input at the
  bottom. Toggleable with `Ctrl+J`.
- **Status bar** (top) — global state: workspace, model, cost.
- **Mode bar** (bottom) — current cursor position, dirty marker,
  active permission prompt.

When only the center pane is active the layout reduces to just
the editor + status — pi-mono's "fullscreen edit" feel.

## Component inventory

Built from Ink primitives so we don't have to ship a new
renderer. Reuses everything in `node_modules/ink` plus a small
set of custom widgets under `src/tui-editor/components/`.

### Layout primitives

- `<Layout>` — root flex container. Routes keyboard to focused
  pane; manages pane visibility.
- `<Pane>` — bordered region with title + focus indicator.
- `<StatusBar>` / `<ModeBar>` — top/bottom one-line strips.
- `<Overlay>` — modal layer for the command palette / dialogs.

### Widgets

- `<TextEditor>` — multi-line editor with cursor, selection,
  scrolling, line numbers, basic syntax highlighting, undo/redo.
- `<FileTree>` — hierarchical tree with lazy directory loading,
  filter input, expand/collapse.
- `<TabStrip>` — buffer tab list with dirty markers and close
  buttons.
- `<ChatPane>` — scrollable message stream + input.
- `<DiffOverlay>` — renders an in-buffer diff (additions /
  deletions) with `[a]ccept` / `[r]eject` keys.
- `<CommandPalette>` — fuzzy-search overlay over a registered
  command list.
- `<PermissionPrompt>` — inline yellow strip in the mode bar
  that interrupts input until the user hits y/n.

### Stores (Zustand-style or plain React state)

- `BufferStore` — open files → buffer state (text, cursor,
  selection, dirty flag, language hint).
- `AgentStore` — chat messages, current tool, pending permissions,
  cumulative cost.
- `LayoutStore` — pane visibility, focused pane.
- `WorkspaceStore` — the user's current workspace + project root.

## Key bindings

Modeled on pi-mono's coding-agent shortcuts where they make
sense. Discoverable via `Ctrl+P` → "show all shortcuts".

| Shortcut | Action |
|----------|--------|
| `Ctrl+P` | Command palette (fuzzy search over commands + files) |
| `Ctrl+O` | Open file (file picker overlay) |
| `Ctrl+S` | Save current buffer |
| `Ctrl+W` | Close current buffer (prompts on dirty) |
| `Ctrl+B` | Toggle file tree |
| `Ctrl+J` | Toggle chat pane |
| `Ctrl+\` | Toggle focus between center / chat panes |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle buffers |
| `Ctrl+G` | Goto line |
| `Ctrl+F` | Find in buffer |
| `Ctrl+H` | Find + replace |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+L` | Model selector (overlay) |
| `Ctrl+K` | Clear chat |
| `Ctrl+T` | Toggle tool-output collapse |
| `Esc` | Cancel current overlay; double-tap to abort agent |
| `Enter` (chat focus) | Send message |
| `Shift+Enter` (chat focus) | New line in chat input |
| `y` / `n` (permission prompt active) | Approve / deny |
| `Ctrl+]` / `Ctrl+[` | Approve / reject diff hunk |
| `Ctrl+C` (no selection) | Clear input; double-tap to quit |

## Phases

### Phase 1 — Foundations
- `<Layout>`, `<Pane>`, `<StatusBar>`, `<ModeBar>`, `<Overlay>`,
  `<CommandPalette>` primitives.
- Focus manager (which pane is focused; key routing).
- Theme module with a light + dark palette.
- Tests on layout / focus.

### Phase 2 — File system + buffers
- `BufferStore`: open(path) → buffer; save / close / dirty flag.
- `<FileTree>` reading from `WorkspaceFS` (multi-user aware via
  the resolved workspace).
- `<TabStrip>` showing open buffers.
- File picker overlay (Ctrl+O) reusing `file-completer.ts`.
- Tests on the buffer store and tree expansion.

### Phase 3 — Editor primitive
- `<TextEditor>` with cursor + selection + horizontal/vertical
  scrolling, line numbers, undo/redo via a transactional buffer.
- Pattern-based syntax highlighting (no tree-sitter dependency
  initially — a small set of language patterns covers ts/tsx/sh/md/json).
- Find / replace overlay.
- Goto line overlay.
- Tests on the buffer ops and rendering.

### Phase 4 — Chat + agent integration
- `<ChatPane>` reusing the existing gateway client.
- `<DiffOverlay>` — when the agent emits a tool_call writing to
  an open buffer, intercept and show as a diff overlay that the
  user accepts / rejects.
- Inline `<PermissionPrompt>` replaces the chat input until
  resolved.
- Cumulative cost / tokens in status bar.
- Tests on the diff overlay state machine.

### Phase 5 — Polish + extension
- Command palette commands (open file, show shortcuts, switch
  model, clear chat, change theme, switch workspace).
- Workspace picker overlay reading `/api/me/workspaces`.
- Skill / slash-command palette: `/skills`, `/orgs`,
  `/workspace <slug>`, `/quit`.
- Settings persisted in `~/.octipus/tui-editor.json`.
- Tests for command palette dispatch and workspace switching.

## File layout

```
src/tui-editor/
├── index.tsx                    # Entry; bin/octipus-tui-edit symlink
├── app.tsx                      # Root <App>
├── theme.ts                     # Color tokens
├── stores/
│   ├── buffer-store.ts
│   ├── layout-store.ts
│   ├── agent-store.ts
│   └── workspace-store.ts
├── components/
│   ├── layout.tsx
│   ├── pane.tsx
│   ├── status-bar.tsx
│   ├── mode-bar.tsx
│   ├── overlay.tsx
│   ├── command-palette.tsx
│   ├── text-editor.tsx
│   ├── file-tree.tsx
│   ├── tab-strip.tsx
│   ├── chat-pane.tsx
│   ├── diff-overlay.tsx
│   ├── permission-prompt.tsx
│   └── workspace-picker.tsx
├── editor/
│   ├── buffer.ts                # transactional text buffer + undo/redo
│   ├── highlight.ts             # pattern-based syntax highlighting
│   ├── search.ts                # incremental find
│   └── lang.ts                  # language detection from extension
├── keybindings.ts
├── commands.ts                  # registered command list for palette
└── workspace-fs-bridge.ts       # talks to WorkspaceFS for file ops
```

## Coexistence with the chat TUI

The current `src/tui/` (chat-style Ink app) stays put; it ships
as `bun run src/tui/index.tsx` for users who prefer the
chat-first surface. The editor ships as
`bun run src/tui-editor/index.tsx`. A future "default TUI"
decision can swap the `bin/octipus-tui` entry once the editor
proves out.

Both share the same `GatewayClient` (`src/tui/gateway-client.ts`)
so the auth / session / agent-event protocol is identical.

## Open questions — resolved

1. **Tree-sitter parity.** Done as a pluggable interface:
   `highlight.ts` exposes `setHighlighter(fn)` so a future
   tree-sitter (or LSP) integration registers itself at app
   start. The pattern-based default ships zero new dependencies
   and the swap-in is one line.
2. **Mouse wheel scrolling.** Deferred (Ink has no mouse API).
3. **Live agent typing in the editor.** Both modes shipped:
   `lockMode: 'lock' | 'merge'` per buffer (default `'lock'`).
   Lock mode = diff overlay (existing). Merge mode applies the
   agent's edit directly through the buffer's undo stack so
   `Ctrl+Z` rolls it back; the user keeps typing without an
   interrupting overlay. Toggle via the command palette
   ("Toggle agent-edit mode").
4. **Persistent layout state.** Done. `~/.octipus/tui-editor.json`
   stores open buffer paths, active path, pane visibility,
   theme, and editor mode (modeless / vim). Loaded on launch,
   saved on every layout / buffer change with a 500ms debounce.

## Future iterations — landed in this slice

- **Vim mode.** `editorMode: 'modeless' | 'vim'` toggle in
  LayoutStore + a command palette entry. The vim handler covers
  hjkl / w / b / 0 / $ / gg / G / i / a / o / O / v / x / dd / yy
  / p / u / Ctrl+R, with VISUAL-mode delete + yank. INSERT mode
  falls through to the modeless code path so typing feels
  identical. Pure handler tested in `editor/vim.test.ts`.
- **Workspace header propagation.** `GatewayClient.getWorkspace`
  callback adds `?workspace=<slug>` to the WS connect URL on
  every connect; new `ApiClient` wraps `fetch` and injects
  `X-Octipus-Workspace` on every HTTP request.
- **`bin/octi-tui-edit` shim.** One-shot launcher in `bin/`
  registered under `package.json#bin`. New `tui:edit` script too.

## Future iterations — still open

- Tree-sitter / LSP-backed highlighter (the slot is ready).
- Mouse wheel scrolling (pending Ink support).
- VIM IME-aware INSERT mode + register (`"a` etc.).
- Workspace picker → instantly reconnect WS so the new slug
  applies without a manual restart.
