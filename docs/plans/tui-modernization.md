# Terminal chat and editor: modernization plan

Status: in progress (2026-11-22). Phase 0 shipped with this document;
Phases 1 and 2 are on the modernization branch (Phase 2: §7, "Shipped").

Scope: `octi tui` (`src/tui-pi/`, 5.4k lines with tests) and `octi edit`
(`src/tui-editor/`, 6.5k lines with tests), their shared pieces, the
`@mariozechner/pi-tui` dependency (now `@earendil-works/pi-tui`), and `tests/tui/`.

Goal: the terminal is a first-class way to use Octipus, comparable with Claude
Code, Codex CLI, Grok Build and the pi coding agent in how it reads, scrolls,
selects and stays out of the way.

How to read the evidence: **[code]** means read in this repository or in the
installed pi-tui 0.73.1 source; **[run]** means reproduced in the PTY harness
or a unit test; **[upstream]** means taken from npm registry metadata, the
upstream changelog or a vendor's documentation and not exercised here;
**[unverified]** means reported but not confirmed.

## 1. Summary

1. The vanishing composer was a real bug with one cause, now fixed (§2).
2. It was possible because of how the screen is drawn today: a full-height
   frame painted into the terminal's normal buffer by a renderer built for
   growing documents. That mismatch is behind most of the remaining roughness —
   Shift-to-select, lost scrollback on resize, a frame left behind on exit — and
   no amount of patching on the current base removes it (§3).
3. `@mariozechner/pi-tui` is deprecated; development continues as
   `@earendil-works/pi-tui` (1.6.0), which has since added exactly what is
   missing here: an alternate-screen renderer, pinned layout regions, mouse,
   in-app selection (§4).
4. Recommendation: **keep pi-tui, move to the maintained package, adopt its
   alternate-screen renderer behind a thin module of our own**, and decide by
   a time-boxed spike with written exit criteria. Do not write our own
   terminal layer unless the spike fails; if it does, replace only the screen
   layer and keep pi-tui's editor, Markdown and key parsing (§4).
5. The editor needs correctness work before features: several basic
   behaviours are wrong or unreachable today (§5.2).
6. Work is ordered in six phases; each is shippable on its own (§7).

## 2. Phase 0 — shipped with this plan

| Fix | Cause | Commit |
| --- | --- | --- |
| Composer and status scroll out of the window during a turn | A rendered row containing `\n`, `\r`, a tab or an escape sequence occupies more than one terminal row. pi-tui moves the cursor relatively and assumes one row per rendered line, so every later row is painted one row low and the bottom of the frame leaves the window. It returned on a full repaint: turn end (the activity row disappears) or a resize — and broke again on the next spinner tick, which is why resizing only helped "sometimes". A tool call with a multi-line shell command was enough. **[run]** | `ea95cba` |
| Escape sequences in tool output reached the terminal (a result containing `ESC[2J` cleared the screen) | Same path. **[run]** | `ea95cba` |
| A multi-line agent question was cut to its first line and could break its box | Same class, in the overlay. **[run]** | `ea95cba` |
| Editor: Down onto a shorter line skipped a line; Up stayed on the current line | Vertical moves took the end-of-line overflow branch meant for Right. **[run]** | `d82427e` |
| Editor: a control byte in a file (CRLF `\r`, an escape sequence in a log) corrupted the screen | File content was written raw. Now drawn as a control picture (`␍`, `␛`); the file is unchanged. **[run]** | `6f7062e` |

What the composer fix consists of (`src/tui-pi/terminal-text.ts`):

- `displayText` / `displayLine` reduce outside text to printable text where it
  enters the transcript, activity line, subagent panel, status bar and the
  decision prompts.
- `frameRow` in the shared `renderChatFrame` is the backstop: whatever a
  component was handed, one rendered row is one terminal row. Both surfaces
  use that frame.
- `tests/tui/composer-sticky.e2e.test.ts` drives the real entry point in a PTY
  and asserts the composer, status line and transcript positions.

Not covered by the fix, and listed as work below: pi-tui overlays are composited
after our frame, so the backstop does not see them (each prompt sanitizes its
own input instead); and width disagreements between pi-tui and the terminal
(§3.3) can still wrap a row.

## 3. Why the current base is fragile

### 3.1 What is drawn today

pi-tui 0.73.1 has one renderer **[code: `dist/tui.js` `doRender`]**. It treats
the UI as a document that grows downwards in the terminal's normal buffer,
remembers the previous lines, and rewrites the changed range with relative
cursor movement (`ESC[nA` / `ESC[nB`). It has no alternate screen, no absolute
positioning, no pinned region and no mouse support.

Octipus wants a fixed frame: transcript above, composer and status pinned
below. It gets one by rendering exactly `terminal.rows` lines every time
(`renderChatFrame`, and `.slice(0, rows)` in the editor's root) and scrolling
the transcript inside the app (`MessagesPane`). Mouse wheel is added by writing
`ESC[?1000h ESC[?1006h` directly and parsing SGR mouse reports by regex
(`terminal-actions.ts`, `messages-pane.ts`).

So the app runs a full-screen layout on a renderer that does not know the
screen is full. Consequences, all **[code]**:

| Consequence | Mechanism |
| --- | --- |
| Any cursor movement pi-tui does not know about corrupts the frame until the next full repaint | Relative positioning from a remembered row. The Phase 0 bug was one instance; a stray `console.log`, a row the terminal wraps, or a write from a child process are others. |
| Resizing erases the user's terminal history from before launch | A width or height change calls `fullRender(true)`, which writes `ESC[2J ESC[H ESC[3J`. `3J` clears scrollback. |
| Quitting leaves a dead frame in the scrollback | `stop()` moves below the content and prints a newline; there is no screen to restore. |
| Click-drag does not select text without Shift | Wheel events only arrive with mouse reporting on (mode 1000), and mode 1000 also takes clicks. There is no mode that reports the wheel but not buttons in the normal buffer. |
| A row wider than the terminal ends the program | `doRender` throws "Rendered line exceeds terminal width" after stopping the terminal. `renderChatFrame` truncates; overlays and the editor's root do not go through it. |
| A crash can leave the shell in raw mode with mouse reporting on | `runtime.ts` restores the terminal on SIGINT and SIGTERM only; there is no handler for an uncaught exception, an unhandled rejection or a plain `process.exit`. |

### 3.2 The selection and scrolling conflict

This is the constraint the previous attempts ran into, stated once:

- Normal buffer, no mouse reporting: selection is native, the wheel scrolls the
  terminal's own scrollback, which holds painted frames rather than the
  conversation.
- Normal buffer, mouse reporting: the wheel reaches the app, and so does every
  click. Native selection needs the terminal's override key (Shift in xterm
  and most others, Option in iTerm2/Terminal.app, Fn in some).
- Alternate screen, alternate-scroll mode (`ESC[?1007h`), no mouse reporting:
  the wheel arrives as Up/Down keys, selection stays native. The app cannot
  tell a wheel notch from an arrow key. Codex CLI defines this mode
  **[upstream]**.
- Alternate screen, mouse reporting, selection drawn by the app: drag selects,
  release copies (OSC 52 or a native clipboard tool), the override key still
  gives native selection. Selection can follow the transcript past the
  viewport and can leave out the rail, borders and line numbers. Claude Code's
  fullscreen mode, pi 1.x fullscreen and opencode work this way **[upstream]**.

There is no fifth option. "Native selection and wheel scrolling together, no
modifier" exists only in the two alternate-screen rows, and both need a
renderer that owns the screen.

### 3.3 Width

pi-tui measures with `get-east-asian-width` plus its own rules; terminals use
their own tables. Where they disagree a row wraps and the frame shifts — the
same failure as Phase 0 from a different cause. Known disagreements **[code]**:
tabs are counted as three cells (handled now by expanding them); the app
strips variation selectors from chat text (`sanitize` in `app.ts`) for this
reason. Not yet handled: emoji ZWJ sequences, regional-indicator flags and
ambiguous-width characters in CJK locales **[unverified]**. An
alternate-screen renderer that positions every row absolutely confines such
an error to the row it happens on.

## 4. pi-tui: stay, upgrade or replace

### 4.1 Facts

- Installed: `@mariozechner/pi-tui` 0.73.1, about 9,000 lines of JavaScript,
  MIT. Dependencies: `chalk`, `marked`, `mime-types`, `get-east-asian-width`,
  optional `koffi`. **[code]**
- The npm package is deprecated: "please use @earendil-works/pi-tui instead
  going forward". 0.73.1 is the last release under the old name.
  **[upstream: `npm view`]**
- `@earendil-works/pi-tui` 1.6.0 (2026-11-20), MIT, Node >= 22.19. About 65
  releases since 0.74; breaking changes still land in minor versions after
  1.0. It vendors prebuilt native helpers for clipboard and modifier keys.
  **[upstream]**
- Since 0.84 it ships two renderers, `TuiMainScreen` (the model we have) and
  `TuiAltScreen`, with `VStack` / `HStack` / `ScrollView` layouts, sticky
  regions, scrollbars, SGR mouse, drag selection with OSC 52 copy, and
  transcript search. **[upstream: changelog, 1.6.0 tarball]**

What Octipus uses from pi-tui **[code]**:

| Used | From pi-tui | Own code that duplicates or works around it |
| --- | --- | --- |
| Chat composer | `Editor`, `CombinedAutocompleteProvider` (2.5k lines) | — |
| Markdown | `Markdown` (0.7k) | — |
| Keys | `matchesKey`, `KeybindingsManager` (1.2k) | Editor's vim layer compares raw bytes (`toVimKey`) |
| Width and wrapping | `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi` (1k) | `sliceByColumn` imported from `dist/utils.js`, a private path |
| Overlays, focus | `showOverlay`, `setFocus` | Seven hand-drawn boxes with their own `padTo` |
| Frame and diffing | `TUI`, `Container`, `ProcessTerminal` | Full-height frame, viewport budgeting, in-app scrolling, split panes, mouse enable and parsing — all ours |
| File editing | — | Buffer, cursor, undo, vim, search, diff, highlighting — all ours |

So the custom code is concentrated in exactly the layer where pi-tui 0.73 is
weakest (screen ownership, layout, mouse), and the parts pi-tui does well
(composer, Markdown, key decoding) are used as shipped.

### 4.2 Options

| | A. Stay on 0.73.1 | B. Move to `@earendil-works/pi-tui` 1.x | C. Own screen layer, keep pi-tui widgets | D. Own everything |
| --- | --- | --- | --- | --- |
| Fixes §3.1 | No | Yes, if `TuiAltScreen` does what its changelog says | Yes | Yes |
| New code to write | None | Migration across ~65 releases of API change | Est. 1.5–2.5k lines: cell buffer and diff, alt screen, mouse, layout, selection | Est. 7–9k lines, including a key decoder (kitty protocol, modifyOtherKeys, IME) — the riskiest part |
| Ongoing cost | A dead dependency | A fast-moving one, driven by one product, breaking in minors | Our own renderer to maintain; still on pi-tui for widgets | Everything is ours |
| Supply chain | Unmaintained | Prebuilt native binaries enter the tree | As B, or stay on 0.73 for widgets only | None |
| Other agent TUIs | — | The pi coding agent itself | Claude Code and Gemini CLI built their own layer over Ink **[upstream]** | Codex, Grok Build (Rust) |

### 4.3 Recommendation

**B, behind a seam, with C as the fallback. Not A, not D.**

- A is not an option: the package is dead and cannot deliver §3.2.
- D rebuilds 4–5k lines that already work (composer, Markdown, keys) for no
  user-visible gain, and the key decoder is where terminal apps accumulate
  bugs for years.
- B gets the missing layer from the people who needed the same thing for the
  same kind of product. Its risk is churn, which the seam and an exact version
  pin contain.

The seam: one module, `src/tui-kit/`, is the only place that imports pi-tui.
Today 46 files import it directly, one of them from a private path. With the
seam, an upgrade, a fork or a swap of the screen layer touches one directory.
It also becomes the home of what the two apps duplicate (box drawing, text
fields, the overlay open/close pattern).

### 4.4 The spike that decides it

Time-boxed to a few days, on a branch, chat surface only. Port `octi tui` to
1.6.0 with `TuiAltScreen`, a `ScrollView` transcript and sticky composer and
status.

Go if all hold:

1. The existing `tests/tui/*.e2e` suites pass, with the Phase 0 test, at 80×24
   and 200×60, through 50 random resizes.
2. Drag selects transcript text and copies it; the terminal's override key
   still gives native selection; the wheel scrolls with nothing held.
3. A 5,000-message transcript scrolls and streams without visible lag
   (measure: frame time under 16 ms at 200×60).
4. Works in: a VTE terminal, Kitty or Ghostty, iTerm2, Windows Terminal,
   tmux, and over SSH. Degrades without corruption in the Linux console.
5. An uncaught exception restores the terminal.
6. The prebuilt native helpers can be disabled or are acceptable to ship
   (review what they do; check the Docker image and Windows).

No-go on any of 1–3 → option C: write the screen layer in `src/tui-kit/`
against the same component contract (`render(width): string[]`,
`handleInput`), which is already what every Octipus component implements, and
stay on pi-tui for the composer, Markdown and keys.

Open questions the spike answers: whether `TuiAltScreen`'s selection can
exclude decorations (rail, line numbers); whether the 1.x `Editor` still
supports the autocomplete and paste-marker behaviour the composer relies on;
whether overlays take part in layout or are still composited afterwards.

#### Spike result (2026-11-22): go, option B

`@earendil-works/pi-tui` 1.6.0 (exact pin) replaced 0.73.1, and both
surfaces run on `TuiAltScreen`. The port was small: `TUI` became an
interface (`TuiMainScreen` / `TuiAltScreen` are the renderers),
`Component.render` returns `readonly string[]`, `sliceByColumn` is public,
and `chalk` is no longer a pi-tui dependency (it was ours all along, now
declared). Typecheck errors after the swap: four in `src/`, seven in the
setup wizard. `Editor`, `CombinedAutocompleteProvider`, `Markdown`,
`SelectList`, `Input` and the keybindings manager kept the API the app uses;
the composer's autocomplete, history and paste markers pass their tests
unchanged. **[code, run]**

| Criterion | Result |
| --- | --- |
| 1. e2e suites at 80×24 and 200×60 through 50 random resizes | Pass. Every pre-existing suite passes on the alternate screen; the expectations that changed are the ones the plan changes (mouse mode `any` instead of `vt200`, a scrollbar beside the rows, no PgUp hint row). `screen.e2e` adds the two sizes with 50 resizes each; the invariant fuzzer ran 150 seeds clean, a quarter of them `--inline`. **[run]** |
| 2. Drag selects and copies; override key; wheel with nothing held | Pass in the harness: a drag with no modifier selects across transcript rows, copies on release (rail left out through the `copySelection` hook) and the wheel scrolls. The Shift/Option override is the terminal's own and cannot be exercised in xterm-headless; the app uses standard SGR any-motion reporting (button-motion inside tmux/screen), which xterm, VTE, Kitty and Windows Terminal override with Shift **[upstream]**. |
| 3. 5,000 messages, frame time < 16 ms at 200×60 | Pass: p95 about 1 ms per streaming frame, about 7 ms per page scroll that pages older messages into the window (`frame-time.e2e`, real app on the real renderer over a counting terminal). **[run]** |
| 4. Terminal matrix | Approximated only: xterm-headless for every suite, plus the chat inside a real tmux 3.4 (`tmux.e2e`: layout through resizes, copy to the tmux buffer, clean quit). VTE, Kitty/Ghostty, iTerm2, Windows Terminal, SSH and the Linux console were not available and are **not verified**. |
| 5. Uncaught exception restores the terminal | Pass, alternate and inline: `exit-paths.e2e` checks the normal buffer is back with the pre-launch text, mouse and bracketed paste off, cursor shown, cooked mode, and the error printed after `?1049l`. **[run]** |
| 6. Native helpers | Acceptable. Prebuilt `.node` files (16–72 kB each, C/Objective-C sources shipped beside them, no install script) for clipboard reads and modifier-key state on macOS, Windows and Linux/X11. They load lazily: Linux only through `getNativeClipboard()`, which Octipus never calls, so the Docker image and Linux never load one; on macOS only to tell Shift+Enter apart in Terminal.app; on Windows to enable VT input and for Shift+Enter. There is no switch to disable them short of patching the package; each load is wrapped in `try`, so a missing or blocked binary degrades to the plain behaviour. Windows itself was not run. **[code]** |

Open questions: selection cannot leave out decorations by itself — it copies
the source rows — but its `copySelection` hook lets the app strip the rail,
which is what the chat does; the editor's line numbers and tree are not
stripped. The 1.x `Editor` keeps autocomplete and paste markers. Overlays are
still composited over the layout, so `FramedOverlay` stays the backstop.

Two costs of the renderer, accepted: a `ScrollView` needs every row of its
content, so the transcript renders a window of the newest messages and grows
it as the reader reaches its top (`transcript-view.ts`); and the alternate
screen consumes viewport keys (PageUp, Ctrl+Home, Ctrl+Up/Down) before the
app sees them, so the editor, which scrolls its own panes, unbinds them.

## 5. Findings

### 5.1 Chat (`src/tui-pi/`)

Structure is sound: a gateway adapter that turns protocol events into a small
event type, a presenter shared by both surfaces, and components that render
strings. Tests are good for this size (unit tests per component, three PTY
suites). The problems are in what it does not yet do, and in a few places
where the code has drifted. All **[code]** unless marked.

Defects and risks

- No terminal restore on crash (§3.1).
- Overlays bypass the frame backstop (§2) and can still throw on an over-wide
  row.
- Mouse press and release reports that are not wheel events fall through to
  the focused component; the regex also matches presses only (`M`), so
  releases (`m`) always fall through. Effect on the composer **[unverified]**.
- `MessagesPane` keeps every message and rebuilds the full line list on each
  change. Per-message rendering is cached, but the concatenation is
  O(total rows) per frame and history is unbounded.
- The plan status is polled every 4 s over the socket rather than pushed.
- `app.ts`: orphaned doc comments left by earlier extractions (lines 195,
  268–273, 412–418, 528–540), and comments that describe an alternate screen
  that does not exist (lines 44–47, 238–240). `status-bar.ts` documents a
  "one-line top status bar"; it is multi-row and at the bottom.
- `handleCommand` and the `command.result` handling exist in near-identical
  form in `tui-pi/app.ts` and `tui-editor/app.ts`.

Experience gaps against current agent TUIs

| Area | Today | Expected |
| --- | --- | --- |
| Stop a turn | `/abort` typed into the composer | Esc interrupts; second Esc clears the draft |
| Typing during a turn | Sent immediately as a new message | Queue shown above the composer; edit or remove before it is sent |
| Streaming | Plain text until the reply completes, then re-rendered as Markdown (visible jump) | Markdown while streaming, stable block by block |
| Tool calls | One flat `→ tool → preview` system line each; result preview is 80 characters | Grouped per turn, collapsed by default, expandable; duration and status; diffs for edits; full output on demand |
| Thinking / reasoning | Pre-tool text becomes an ordinary message | Dim, collapsible block |
| Selection and copy | Shift+drag; `/copy last` | Drag to select, copy on release; copy a code block with one key |
| Search | None | `/` or Ctrl+F in the transcript; Ctrl+R in input history |
| Sessions, models, skills | Text lists and `/resume <n>` | Pickers with fuzzy filter and preview |
| Mentions | `@` file completion via `fd` | Also agents, skills, sessions; pasted paths become chips |
| Images | Attach from clipboard or path | Also show images and diagrams inline where the terminal can (pi-tui has Kitty and iTerm2 support that is unused) |
| Links | Printed as text | OSC 8 hyperlinks for URLs and `file:line` |
| Attention | Nothing when the window is in the background | Bell or OSC 9/777 notification when a turn ends or a decision is waiting; title shows state |
| Theme | One dark palette | Follows terminal background (OSC 11), light and high-contrast variants, `NO_COLOR` |
| Exit | Frame left in scrollback | Screen restored; a short summary and the resume command printed |
| Long sessions | Unbounded | Virtualised transcript; older turns loaded on demand |

### 5.2 Editor (`src/tui-editor/`)

The editor has more surface than its correctness supports. Several features
exist in code and cannot be reached or seen. Before adding anything, it needs
the first two groups below fixed. Items marked **[run]** were reproduced; the
rest are **[code]**.

Wrong today

- Columns are UTF-16 units: Backspace after an emoji leaves half a character;
  Left/Right split graphemes. **[run]**
- Replace-all records one undo step per match; with more matches than the
  200-step limit, the rest cannot be undone. **[run]**
- Backspace at the start of the file marks the buffer dirty and clears redo.
  **[run]**
- Dirty is a flag, not a comparison with what was saved; undoing back to the
  saved text still shows unsaved changes.
- Save is `writeFileSync` straight onto the file: not atomic, no check that
  the file changed on disk since it was opened. Invalid UTF-8 is rewritten on
  save.
- Syntax highlighting is parsed when a file is opened and not after edits; the
  parse cache is per language, so two TypeScript files evict each other.
- The Tab key inserts two spaces; tabs in a file display four wide.
- Find does not highlight matches in the buffer and hides the cursor while its
  box is open; it always starts from the top of the file.
- The diff overlay is 25 rows tall and is clipped on terminals of about 29
  rows or fewer.
- Double-pressing the workspace or MCP picker key while the first request is
  in flight opens two overlays and loses the handle to one; the request has
  no timeout.
- The file picker shows the first 1,000 files alphabetically to depth 6,
  ignores `.gitignore`, and walks the tree synchronously.
- Subscriptions (stores, input listeners, the adapter) are never released.

Present but unreachable or invisible

- Vim mode: the mode can only be set by a persisted layout file; there is no
  command or key to turn it on. In NORMAL mode Ctrl+S is swallowed and there
  is no `:w`. With the kitty keyboard protocol active, Escape may arrive as
  `ESC[27u`, which the vim layer does not recognise **[unverified]**.
- Selection: the buffer tracks one, the renderer never draws it. VISUAL mode
  is invisible.
- Merge lock mode, `AgentStore`, the persisted `theme`, `LayoutStore.overlay`:
  code with no caller.
- Scratch buffers cannot be saved: there is no Save As.

Missing for a usable editor

- Mouse: click to place the cursor, drag to select, click tabs and tree rows,
  drag the pane divider, wheel in the focused pane.
- Selection with Shift+arrows, cut/copy/paste to the system clipboard.
- PageUp/PageDown, Ctrl+Home/End, go to line, soft wrap, auto-indent, bracket
  matching, a scrollbar.
- New file, rename, delete, reload on external change.
- In-buffer search highlights, replace one at a time, search across the
  project.
- Agent edits: accept or reject per hunk rather than per file; edits to files
  that are not open are skipped silently today.
- Diagnostics (LSP), git change markers.

Structure

- `app.ts` (728 lines) wires everything: stores, gateway, eight overlays,
  persistence, hotkeys. Eight near-identical overlay open/close pairs.
- Three hand-written text fields accept one byte at a time (no paste, no
  emoji, no IME) while pi-tui's `Input` goes unused.
- `walk` and its skip list are duplicated between the tree and the picker.
- Untested: `FileTree`, `TabStrip`, `ModeBar`, the hotkeys and unsaved-changes
  overlays, `ChatPane`, the API client, the file bridge, two stores.

A question to settle before Phase 4: what the editor is for. It will not
compete with an IDE, and should not try. Its distinctive job is **reviewing
and steering what the agent changes** — open the file the agent touched, see
the diff, accept or reject hunks, make a small correction, hand back. The plan
below builds that well and keeps general editing basic but correct.

### 5.3 Dependencies

| Package | Use | Note |
| --- | --- | --- |
| `@mariozechner/pi-tui` ~0.73.1 | Both surfaces | Deprecated (§4) |
| `chalk` | Colour | Fine. pi-tui 1.x no longer depends on it; we do directly |
| `web-tree-sitter` + grammars | Editor highlighting | Grammar packages run install scripts (`node-gyp-build`); only useful once re-parsing after edits works |
| `@xterm/headless` (dev) | PTY tests | Good; keep |
| `python3` (test only) | PTY relay `tests/tui/pty.py` | POSIX only: the PTY suites are skipped on Windows, so Windows has no end-to-end coverage |
| `fd` (optional, runtime) | File completion | Probed at four fixed paths, not on `PATH` |

### 5.4 Tests

The PTY harness is the most valuable asset here: it runs the shipped entry
point in a real pseudo-terminal, parses the screen with xterm, and can save
screenshots. What is missing is tests that state invariants rather than
scenarios. The Phase 0 bug would have been caught by one property: "after any
sequence of gateway events, the screen has exactly one status line on the last
row and the composer above it".

## 6. Target design

One screen model for both surfaces:

```
┌──────────────────────────────────────────────┐
│ transcript (ScrollView, virtualised)         │  grows upward, app-scrolled
│   turn → message / tool group / diff / image │
├──────────────────────────────────────────────┤
│ queued messages (0..n rows)                  │  sticky
│ activity row (0..1)                          │  sticky
│ composer (1..40% of height)                  │  sticky, never clipped below 1 row
│ status row(s)                                │  sticky
└──────────────────────────────────────────────┘
```

- Alternate screen, absolute positioning per row. A bad row damages itself
  only.
- Mouse: wheel scrolls the pane under the pointer; drag selects in the app and
  copies on release; the terminal's override key gives native selection;
  click focuses a pane, places the editor cursor, expands a tool group.
- `tui.mouse` setting: `app` (default), `native` (no mouse reporting,
  alternate-scroll mode: wheel scrolls, selection is the terminal's, no click
  targets), `off`.
- Clipboard chain: native tool when local (`pbcopy`, `wl-copy`, `xclip`,
  `clip.exe`), tmux buffer inside tmux, OSC 52 otherwise; report which one was
  used, and say plainly when none is available.
- Leaving the alternate screen must not lose the conversation: on exit, print
  the last exchange and `octi tui --session <id>` to the normal buffer;
  `/export` writes the transcript to a file; a key dumps the transcript to
  scrollback for terminals where people want native search.
- `--inline` keeps a main-screen mode (the current behaviour, with the Phase 0
  guard) for terminals and habits where the alternate screen is unwelcome.
- Transcript is a list of typed items (message, tool group, diff, notice,
  image), each rendering itself and caching by width. Tool calls and results
  pair by call id instead of by name.
- Everything from outside passes through `terminal-text.ts` at the boundary;
  the frame backstop stays.

## 7. Phases

Sizes are relative: S is days, M is one to two weeks, L is several weeks for
one person. Each phase ends with the PTY suites green and a `CHANGELOG.md`
entry.

### Phase 1 — Safety net (S)

No visible change; makes the rest safe to do.

1. Restore the terminal on every exit path: uncaught exception, unhandled
   rejection, `process.exit`, SIGHUP. Print the error after the screen is
   restored.
2. Sanitize inside the overlay registry so every overlay is covered, not each
   prompt by itself; truncate overlay rows to the terminal width.
3. Invariant tests in the PTY harness: random gateway event sequences
   (including control bytes, wide characters, 10 kB single lines) and random
   resizes; assert status on the last row, composer above it, no row wider
   than the terminal, cursor inside the composer.
4. Swallow non-wheel mouse reports before they reach a component; match
   release reports.
5. Remove dead code and stale comments listed in §5.1 and §5.2.
6. Width audit: a table-driven test of `visibleWidth` against xterm's cell
   count for emoji sequences, flags, CJK and combining marks; expand or
   replace what disagrees in `displayText`.

Done when: the invariant suite runs 500 seeds clean in CI.

### Phase 2 — Foundation (M)

1. Create `src/tui-kit/`; route every pi-tui import through it; delete the
   private-path import.
2. Run the §4.4 spike; record the result in this file; take B or C.
3. Move the chat surface to the alternate-screen layout of §6, with `--inline`
   as the fallback mode.
4. Mouse and selection as in §6, with the clipboard chain.
5. Exit behaviour as in §6.
6. Virtualise the transcript; cap what is kept in memory and page older turns
   from the server on scroll.

Done when: the §4.4 criteria hold on `main`; the user-reported symptoms
(composer off screen, Shift to select, history lost on resize) are each
covered by a PTY test.

**Shipped** on the modernization branch (not yet on `main`), option B:

| Item | Commit | Covered by |
| --- | --- | --- |
| 1. `src/tui-kit/` seam | `97b6705`; package move `4456ebd` | `seam.test.ts` (either package name) |
| 2. Spike | this section, §4.4 "Spike result" | — |
| 3. Alternate screen, sticky footer, `--inline` | `79a2c66`, `a23dc70` | `screen.e2e` (scrollback through resizes, both modes; 50 resizes at 80×24 and 200×60), `composer-sticky.e2e`, `invariants.e2e` |
| 4. Mouse, selection, clipboard chain, `tui.mouse` | `4456ebd`, `79a2c66`, `a23dc70` | `selection.e2e` (drag without modifier, wheel, native/off, fake `xclip`, OSC 52), `tmux.e2e`, `clipboard.test.ts`, `settings.test.ts` |
| 5. Exit summary, `/export`, `/scrollback` / `Alt+O` | `a23dc70` | `screen.e2e`, `exit-paths.e2e` (crash restores the screen), `transcript-export.test.ts` |
| 6. Virtualised, capped transcript | `a23dc70` | `transcript-view.test.ts`, `frame-time.e2e` |

Tests: `af190f7`; docs `2f05c4e`; `MouseRegion` in the seam `e28b2db`. Server paging of older turns is **not done**: the
gateway's `history` command returns the last 50 messages and takes no
cursor, so it needs a gateway change (a `before` message id or offset on
`history`) before the transcript can load older turns on scroll. Until then
the client keeps up to 5,000 messages and says when it dropped older ones.

API for the next phases:

- Mouse click targets: implement `handleMouse(event: TuiMouseEvent)` on a
  component, or wrap one in `MouseRegion` from `@/tui-kit`; return
  `{ handled: true }` for a click, `{ capture: true }` to receive the drag
  and release. Unhandled drags fall through to text
  selection, unhandled wheels to the scroll view under the pointer.
- A sticky row above the composer: pass a component as `sticky` in the
  `ChatFooterParts` the app hands `ChatFooter` / `renderChatFrame`
  (`components/chat-frame.ts`). It gets up to a quarter of the screen, the
  newest rows kept, and gives way to the composer and status first.
- Transcript item types: add a member to `TranscriptItem` in
  `components/messages-pane.ts`, a case in `renderItem`, and decide what
  `entries()` (copy, export, exit summary) takes from it; add it with
  `pushItem`. Rendering is cached per item and width.

### Phase 3 — Chat experience (L)

In the order users will feel them:

1. Esc interrupts the turn; messages typed during a turn queue visibly.
2. Tool groups: collapsed summary per turn, expand for arguments and full
   output, durations, error state; edits shown as diffs.
3. Markdown while streaming.
4. Transcript search; input history search.
5. Pickers (sessions, models, skills, commands) from one fuzzy list component.
6. Notifications and terminal title state.
7. Themes: detect background, light and high-contrast palettes, `NO_COLOR`.
8. Hyperlinks; inline images where supported.
9. Plan status pushed by the gateway instead of polled.

Done when: each row of the table in §5.1 reads "Expected".

### Phase 4 — Editor correctness (M)

1. Grapheme-aware cursor, deletion and selection; one width function shared
   with the renderer.
2. Undo as grouped operations (one step per replace-all, per paste, per typing
   burst) instead of whole-buffer snapshots per key.
3. Dirty state from comparison with the saved text.
4. Atomic save (write temp, rename), external-change detection, Save As,
   preserve line endings and report non-UTF-8 files instead of rewriting them.
5. Re-parse highlighting after edits, cache per buffer.
6. Draw the selection; make vim mode switchable, give it `:w`, decode Escape
   through the key layer.
7. Fix the overlay race, the diff overlay height and the picker's file limit
   (index with `git ls-files` where available, asynchronously).
8. Release subscriptions on shutdown.
9. Tests for the untested components.

Done when: every item under "Wrong today" in §5.2 has a failing-then-passing
test.

### Phase 5 — Editor as the review surface (L)

1. Mouse in the editor: cursor, selection, tabs, tree, divider.
2. Hunk-level accept and reject of agent edits, with context folding and
   jump to next change; edits to unopened files open a review tab instead of
   being dropped.
3. In-buffer search highlights, replace one by one, project search.
4. Navigation basics: paging, go to line, soft wrap, scrollbar, auto-indent.
5. Files: new, rename, delete, reload.
6. Split `app.ts` by responsibility; overlays share one frame and one text
   field from `tui-kit`.
7. Later, separately decided: diagnostics through LSP, git change markers.

### Phase 6 — Reach (M)

1. Windows: a PTY relay that does not need Python (ConPTY through a small
   Node helper) so the suites run there; fix what they find.
2. tmux, SSH, Linux console and screen readers: documented behaviour and a
   test where a harness can express it.
3. Screenshot-based visual regression from `saveScreen` for the main states.
4. Startup time budget (first frame under 150 ms on the reference machine);
   lazy-load voice and tree-sitter, which are already deferred or should be.

## 8. Risks

| Risk | Handling |
| --- | --- |
| pi-tui 1.x keeps breaking in minors | Exact pin, the `tui-kit` seam, upgrades as their own PRs with the PTY suites as the gate |
| The spike shows `TuiAltScreen` cannot do selection or layout as needed | Option C, sized in §4.2; the component contract does not change, so Phase 3 onward is unaffected |
| People who rely on terminal scrollback dislike the alternate screen | `--inline` mode, dump-to-scrollback, exit summary, `tui.mouse: native` |
| OSC 52 is refused by the terminal or by tmux | Clipboard chain with a native tool first; state what happened instead of claiming success |
| Phase 3 grows without end | The §5.1 table is the scope; anything else is a new item |
| Editor ambition outruns its users | §5.2's question is answered first; Phase 5 items 1–3 are the product, the rest is hygiene |

## 9. Not planned

- Writing a key decoder or a Markdown renderer of our own.
- Moving to Ink, OpenTUI or a Rust front end. OpenTUI needs Bun or Node 26
  with experimental FFI **[upstream]**; Ink would replace the component model
  for both surfaces; a second language would split the codebase.
- Multi-cursor editing, a plugin system for the editor, or a debugger.
