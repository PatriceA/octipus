# Interactive answers (inline UI)

An interactive answer is a small widget inside the agent's reply: a form
that sends your choice back, a sortable table of results, a chart of given or
retrieved numbers, a calculator, a stepper through a process, a diagram. It
appears in the web chat and in rooms, next to the text that introduces it,
and it still works after a reload. It comes in two kinds:

- a **view**: a JSON description of ready-made components (forms, tables,
  charts, stats, steps) that the web app draws with its own components. No
  generated code runs, and its buttons send your answer back to the agent.
  This is what the agent reaches for first;
- an **HTML block**: HTML, CSS and a script in a sandboxed frame, for
  free-form visuals the components cannot express (a custom diagram, an
  animation, a game).

The design and its review history are in [the spec](plans/inline-ui-spec.md)
(HTML blocks) and [the views spec](plans/inline-ui-views-spec.md); this page
describes how it works today.

The idea, and parts of the frame protocol, come from
[CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
(MIT). Its framework is not used.

## For users

- **Where it shows.** In the web app: your personal chats, your chats in a
  space, and rooms (including rooms of a space on another install). Telegram,
  Slack and the other channels, the OpenAI-compatible API, `/api/chat` and
  notifications get a view as text (its headings, values, tables and choices,
  with the answer you gave), under "▸ Interactive answer “Title”:". An HTML
  block, and every interactive answer in the terminal UIs and MCP clients,
  gets one line instead: "▸ Interactive answer “Title” — open this
  conversation in the Octipus web app to use it." Voice leaves them out.
- **Answering a view.** A button of a view sends your answer as your own
  message: its text (what the button says, or a sentence the agent wrote for
  it) with the values you picked or typed. The agent reads them as the values
  of your answer, never as instructions. The message shows "from an
  interactive answer" and the values. After a reload the view shows the
  answer as you gave it, its buttons off, with **Change answer** to send
  another. When the conversation had read content from outside when the view
  was written, the click opens the suggestion strip (**Send**, **Edit in
  composer**, **Dismiss**) instead of sending at once. Buttons are off while
  an admin acts as you. In a room the message is yours, addressed to
  Octipus.
- **When an HTML block's script runs.** A view runs no generated code, so it
  never waits for a click. An HTML block's script runs at once, for an answer that arrives while you
  watch. It waits for **Run interactive answer** when:
  - you open it from history;
  - it is in a room;
  - the conversation had read content from outside (web pages, mail, other
    people's messages) — and, with a red warning, credentials or private
    data together with such content;
  - an admin is acting as you;
  - the page froze while it was open last time;
  - your browser is not Chromium-based: the safeguard that stops a widget
    from navigating itself to another site is verified on Chromium only.

  An answer without a script never waits.
- **Links and suggestions.** A widget cannot open a link or send a message by
  itself. A link it offers appears as a chip under it; a follow-up it
  suggests appears as a strip with **Send**, **Edit in composer** and
  **Dismiss**. Nothing is sent or opened without your click on the chat page.
  A message sent from a strip shows "from an interactive answer".
- **Header buttons.** View source (read-only), Restart, and **Save as
  artifact** (HTML blocks only: a view has no page to copy).
- **Save as artifact** makes a static copy in your workspace: private, or for
  everyone in the workspace. The copy reaches no network and has no data
  refresh. Its buttons that would send a message or open a link say "not
  available here", and its links show their address. An answer made after
  the conversation read content from outside cannot be saved. Saving is off
  while an admin acts as you.
- **Don't enter passwords or keys** into a widget. Password and file inputs
  are removed from HTML blocks, and views have none.
- **Switching them off or asking for more.** The operator setting
  `agent.interactiveAnswers` (Settings → Configuration → Agent): `auto`
  (default), `prefer` (the agent uses one whenever an answer has structure),
  `off` (never offered). Environment variable: `AGENT_INTERACTIVE_ANSWERS`.

## How the model writes one

The root agent's prompt gains a section (`inlineUiPrompt`,
`src/core/inline-ui/offer.ts`, at most 1 000 tokens, held by a test) when the
turn offers interactive answers. It opens with when to use one — the user
must choose, confirm or give values; several items with several attributes;
numbers over time or across categories; a result that depends on inputs; a
process — then the view format (the component catalog as compact
signatures, expressions, the event round trip, two examples that a test
lints), then HTML as the fallback for free-form visuals. The model writes the
answer in its final reply as a fenced block. A body that starts with `{` is a
view:

````text
```octi-ui title="Pick a plan"
{"data":{"plan":"pro"},"root":{"component":"Column","children":[
 {"component":"ChoicePicker","label":"Plan","value":{"@path":"/plan"},"options":[{"label":"Basic","value":"basic"},{"label":"Pro","value":"pro"}]},
 {"component":"Button","label":"Confirm","variant":"primary","action":{"event":{"name":"plan_chosen","context":{"plan":{"@path":"/plan"}}}}}]}}
```
````

`data` is the data model, `computed` names expressions (`"total": "qty *
price"`), `root` the component tree; inputs write into the data model, and
`{"@path": …}`, `{"@expr": …}` and `"${…}"` read it. The catalog, the
expression language and the limits are in [the views
spec](plans/inline-ui-views-spec.md) §2. Anything else is an HTML block:

````text
```octi-ui title="Orbit" height=360
<style>…</style>
<div>…</div>
<script>…</script>
```
````

Limits (`src/shared/inline-ui/limits.ts`): title 80 characters; an HTML
block's markup 24 000, CSS 6 000, script 12 000, together 36 000 characters;
a view's JSON 24 000 characters, 200 components, data 16 000 characters; 4
blocks per reply; 200 per session. A block whose code contains a line of
three backticks is fenced with four.

**Offered when** (`inlineUiOffered`): a root agent, not a small model,
no stored DENY on tool `inline-ui` action `render`, `agent.interactiveAnswers`
not `off`, and:

| Conversation | Offered |
|---|---|
| Room | always (members read it in the web app) |
| Personal chat, member's chat in a space | when the client sent `renders: ["inline_ui"]` with the message (the web app does, over the gateway) |
| Group thread, remote-space session | never |

**Repair.** If a block in the final reply cannot be shown as written (cut
off, too large, a script that does not parse, JSON that does not parse, an
unknown component, a missing prop, a bad expression) or would lose parts
(inline `onclick`, remote images, forms; an unknown prop of a view), the
reply goes back to the model once, in the same turn, with what is wrong and
what is accepted. A block that still cannot be shown becomes a visible
notice in the reply.

**Changing an earlier answer.** Earlier answers appear in the conversation
as `[[octi-ui:<id>|<title>]]`. The tool `inline-ui__source` returns one of
the session's answers by id — `{ id, title, kind, body }`, a view's body
being the JSON the model would write, an HTML block's its markup (with
`height`) — and the model writes a new block.

**Answers.** A view's answer reaches the model as one line in the turn's
volatile part, after the provenance line: `(system note: the user answered
interactive answer <uuid> — event "<name>", values: <json>)`.

## How it works

1. **Extraction** (`src/core/inline-ui/extract.ts`). When the root agent
   finishes, before anything keeps a copy of the reply, each fence is
   checked, stored in `inline_ui_blocks` and replaced by a marker line. A
   view is linted (`lintInlineUiView`) and stored normalized with `kind =
   view` (`view` holds it; `css`/`html`/`js` stay empty). The
   row records the session's flow label at that moment: `tainted` (it had
   read content from outside, private data or a secret) and `risk = high`
   (a secret, or private data together with outside content).
2. **History.** The reply that is saved, replayed and shown holds the marker,
   not the source. Fences in earlier iterations of the turn are replaced by
   their one-line form, and the provider's own copy of a changed message
   (`providerRaw`) is dropped, so Anthropic and Gemini do not replay the
   source.
3. **Other surfaces** apply `inlineUiFallbackTextResolved`
   (`src/core/inline-ui/fallback.ts`: a view as text with its stored answer,
   an HTML block as the line) where the server knows the session — channel
   replies, monitors, the group bridge, hooks, room notifications,
   `/api/chat` without `renders`, the OpenAI-compatible API — and
   `inlineUiFallbackText` (the line) where only the marker is known: both
   terminal UIs, MCP `octipus_get_messages`. Voice uses `inlineUiSpeechText`.
   A status update keeps only the line. The output guard reads a reply
   together with the sources of its blocks (a view's JSON included).
4. **The web app** renders a marker line as a block
   (`web/components/chat/inline-ui/`; a view with its own components under
   `view/`), fetching its source from
   `GET /api/sessions/:id/inline-ui/:blockId` (rooms of a remote space:
   `GET /api/remote-spaces/:id/rooms/:roomId/inline-ui/:blockId`, federation
   op `room.inline_ui`). While a reply streams, a fence being written shows
   as a static preview.
5. **Client reports.** What happened to a block in the browser (script error
   with its error class and line, blank, stopped, froze) travels with the
   user's next message as enums and numbers only, and reaches the model as
   one line naming the block id. No text from an HTML widget reaches the
   model.
6. **Answers.** A view's button sends `chat.send` with `inlineUi.action =
   { blockId, name, componentId, context, data? }` (rooms: `room.post` or
   `POST …/rooms/:roomId/messages` with `inlineUi.action`).
   `resolveInlineUiTurnNotes` checks it against the stored view of this
   session (`validateViewAction`; `data` must be a JSON object, and one over
   16 000 characters is dropped for the view's own); a failed check refuses
   the send (an `error` frame `INVALID_MESSAGE`; a room post answers
   `INVALID_INPUT`, or 400 over REST) instead of dropping the values. An
   accepted answer becomes the model's note, `metadata.inlineUiAction =
   { blockId, name, context }` on the user row (steered messages too), and
   the block's `state = { data, action: { name, componentId, at } }`.

### The frames

HTML blocks only. Two nested frames, both `sandbox="allow-scripts"` (an opaque origin: no
cookies, storage or app origin) and built from `srcdoc`
(`src/shared/inline-ui/frames.ts`):

- **Host frame**: our code only. It creates the content frame, watches it
  from outside (a second load means the content navigated; a flood of
  messages), and relays validated messages to the chat page. Its CSP has
  `frame-src 'none'`, which on Chromium stops the content frame from
  navigating itself anywhere (tested with 200 and 204 responses).
- **Content frame**: our runtime runs first, caches what it needs, parses
  the markup inertly, removes refused elements and attributes, turns links
  into chips, then attaches the answer's script with a nonce.

Both CSPs deny every fetch and every remote image, font, stylesheet,
script, frame and worker. The content frame inherits the host's CSP, so the
host allows exactly what the content needs and nothing more. CSP does not
govern WebRTC, so the content runtime removes its constructors before the
answer's script runs, and keeps the script nonce out of reach so that a
nested frame cannot run script in a fresh realm. DNS resource hints
(`dns-prefetch`, `preconnect`) are outside CSP too; prefetching is switched
off, and what remains is a low-bandwidth residual.

The chat page listens to the host frame only, checks every message's shape,
channel and rate, and unmounts a frame that floods. Buttons it draws next to
a frame ignore input for 800 ms after they appear. A block that takes the
keyboard focus while you type (a page keystroke within the last second, or
no user activation) is stopped and the focus goes back. A link chip or a
suggestion strip also waits again when its link changes or anything above it
moves, and the frame's height is held while either is shown. At most 6 frames run
at once (3 on narrow screens); a marker in `localStorage` notices a block
that was mounted when the tab died.

## Operations

- **Kill switch.** A stored DENY on tool `inline-ui` action `render` — per
  user, or for everyone — stops the offer: no prompt section, nothing to
  fail at run time. `agent.interactiveAnswers: off` does the same for the
  whole install; `prefer` adds one line asking for one whenever an answer
  has structure.
- **Logs.** `Interactive answer stored` (info: block id, mode —
  `view`, `scripted` or `static` —, sizes, `tainted`, `risk`, removed
  parts) and `Interactive answer refused` (warn: kind, the refusal codes),
  both with the turn's `runId`; `Interactive answer needs repair — asking
  the model once` (info); one `Interactive answer offer` (info: `offered`,
  `used`, `kinds`, `refused`, `setting`) per root turn that was offered
  them, whether or not it used one — the measure of unprompted use;
  `Interactive answer refused at send` (info) for an answer that failed a
  check.
- **Storage.** Session content: `inline_ui_blocks` rows go with their session
  (cascade) and are covered by backups of the database.
- **API.** `GET /api/sessions/:id/inline-ui/:blockId` (whoever may read the
  conversation; 404 otherwise; never cached; `kind`, `view` and `state`
  besides the HTML fields) and
  `POST /api/sessions/:id/inline-ui/:blockId/promote`
  (`{ title, slug, visibility: "private" | "workspace" }`; the caller's own
  chat; 409 for a view, for an answer made after reading outside content,
  or for a taken slug). `/api/chat` accepts `renders: ["inline_ui"]` to keep markers in
  the response.
- **Evals.** `eval/inline-ui.yaml` measures how often the model uses an
  interactive answer when it helps and when it does not, including
  `unprompted` positives whose request never asks for a widget:
  `npm run eval -- --suite inline-ui --integration` (unit mode refuses these
  cases: it never builds the root prompt that offers the format).

## For contributors

| Where | What |
|---|---|
| `src/shared/inline-ui/` | fence parsing, markers and fallbacks, lint, limits, theme tokens, frame documents and runtimes, bridge validation |
| `src/shared/inline-ui/view/` | views: types, the catalog, expressions, normalizing, lint, actions, the text form, streaming heal |
| `src/core/inline-ui/` | extraction and history stubs, the offer and prompt, turn notes and answers, read access, the resolved fallback text, checking a remote view, saving as an artifact (server sanitizer) |
| `src/tools/inline-ui/` | `inline-ui__source` |
| `src/api/routes/inline-ui.ts` | block read and promote |
| `web/components/chat/inline-ui/` | block, frame, streaming preview, save dialog; `view/` renders views |
| `tests/web/inline-ui*.spec.ts` | frames in a real browser, the chat, saved copies |

A change to the refused elements or attributes goes in one list
(`INLINE_UI_REFUSED_ELEMENTS`, `INLINE_UI_DROPPED_ATTRIBUTES`): the content
runtime and the server sanitizer for saved copies both read it.

CLI roots support interactive answers and start these turns from Octipus history instead of resuming vendor transcripts, so previous widget source is not replayed.
