# Interactive answers (inline UI)

An interactive answer is a small widget inside the agent's reply: a
calculator, a chart of given or retrieved numbers, a diagram, a stepper
through a mechanism, a comparison with controls. It appears in the web chat
and in rooms, next to the text that introduces it, and it still works after a
reload. The design and its review history are in
[the spec](plans/inline-ui-spec.md); this page describes how it works today.

The idea, and parts of the frame protocol, come from
[CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
(MIT). Its framework is not used.

## For users

- **Where it shows.** In the web app: your personal chats, your chats in a
  space, and rooms (including rooms of a space on another install). Telegram,
  Slack and the other channels, the terminal UI, voice, MCP clients, the
  OpenAI-compatible API and notifications get one line instead: "▸
  Interactive answer “Title” — open this conversation in the Octipus web app
  to use it."
- **When its script runs.** At once, for an answer that arrives while you
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
  artifact**.
- **Save as artifact** makes a static copy in your workspace: private, or for
  everyone in the workspace. The copy reaches no network and has no data
  refresh. Its buttons that would send a message or open a link say "not
  available here", and its links show their address. An answer made after
  the conversation read content from outside cannot be saved. Saving is off
  while an admin acts as you.
- **Don't enter passwords or keys** into a widget. Password and file inputs
  are removed anyway.

## How the model writes one

The root agent's prompt gains a section (`INLINE_UI_PROMPT`,
`src/core/inline-ui/offer.ts`, about 550 tokens) when the turn offers
interactive answers. The model writes the widget in its final reply as a
fenced block:

````text
```octi-ui title="Loan calculator" height=360
<style>…</style>
<div>…</div>
<script>…</script>
```
````

Limits (`src/shared/inline-ui/limits.ts`): title 80 characters; markup
24 000, CSS 6 000, script 12 000, together 36 000 characters; 4 blocks per
reply; 200 per session. A block whose code contains a line of three
backticks is fenced with four.

**Offered when** (`inlineUiOffered`): a root agent, not a small model, not a
vendor CLI root, no stored DENY on tool `inline-ui` action `render`, and:

| Conversation | Offered |
|---|---|
| Room | always (members read it in the web app) |
| Personal chat, member's chat in a space | when the client sent `renders: ["inline_ui"]` with the message (the web app does, over the gateway) |
| Group thread, remote-space session | never |

**Repair.** If a block in the final reply cannot be shown as written (cut
off, too large, a script that does not parse) or would lose parts (inline
`onclick`, remote images, forms), the reply goes back to the model once, in
the same turn, with what is wrong. A block that still cannot be shown
becomes a visible notice in the reply.

**Changing an earlier answer.** Earlier answers appear in the conversation
as `[[octi-ui:<id>|<title>]]`. The tool `inline-ui__source` returns one of
the session's answers by id; the model writes a new block.

## How it works

1. **Extraction** (`src/core/inline-ui/extract.ts`). When the root agent
   finishes, before anything keeps a copy of the reply, each fence is
   checked, stored in `inline_ui_blocks` and replaced by a marker line. The
   row records the session's flow label at that moment: `tainted` (it had
   read content from outside, private data or a secret) and `risk = high`
   (a secret, or private data together with outside content).
2. **History.** The reply that is saved, replayed and shown holds the marker,
   not the source. Fences in earlier iterations of the turn are replaced by
   their one-line form, and the provider's own copy of a changed message
   (`providerRaw`) is dropped, so Anthropic and Gemini do not replay the
   source.
3. **Other surfaces** apply `inlineUiFallbackText` (channels, monitors, the
   group bridge, hooks, room notifications, `/api/chat` without `renders`,
   the OpenAI-compatible API, the TUI) or `inlineUiSpeechText` (voice).
4. **The web app** renders a marker line as a block
   (`web/components/chat/inline-ui/`), fetching its source from
   `GET /api/sessions/:id/inline-ui/:blockId` (rooms of a remote space:
   `GET /api/remote-spaces/:id/rooms/:roomId/inline-ui/:blockId`, federation
   op `room.inline_ui`). While a reply streams, a fence being written shows
   as a static preview.
5. **Client reports.** What happened to a block in the browser (script error
   with its error class and line, blank, stopped, froze) travels with the
   user's next message as enums and numbers only, and reaches the model as
   one line naming the block id. No text from the widget reaches the model.

### The frames

Two nested frames, both `sandbox="allow-scripts"` (an opaque origin: no
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
host allows exactly what the content needs and nothing more.

The chat page listens to the host frame only, checks every message's shape,
channel and rate, and unmounts a frame that floods. Buttons it draws next to
a frame ignore input for 800 ms after they appear. A block that takes the
keyboard focus while you type (a page keystroke within the last second, or
no user activation) is stopped and the focus goes back. At most 6 frames run
at once (3 on narrow screens); a marker in `localStorage` notices a block
that was mounted when the tab died.

## Operations

- **Kill switch.** A stored DENY on tool `inline-ui` action `render` — per
  user, or for everyone — stops the offer: no prompt section, nothing to
  fail at run time.
- **Logs.** `Interactive answer stored` (info: block id, mode, sizes,
  `tainted`, `risk`, removed parts) and `Interactive answer refused` (warn:
  the refusal codes), both with the turn's `runId`; `Interactive answer
  needs repair — asking the model once` (info).
- **Storage.** Session content: `inline_ui_blocks` rows go with their session
  (cascade) and are covered by backups of the database.
- **API.** `GET /api/sessions/:id/inline-ui/:blockId` (whoever may read the
  conversation; 404 otherwise; never cached) and
  `POST /api/sessions/:id/inline-ui/:blockId/promote`
  (`{ title, slug, visibility: "private" | "workspace" }`; the caller's own
  chat; 409 for an answer made after reading outside content or a taken
  slug). `/api/chat` accepts `renders: ["inline_ui"]` to keep markers in
  the response.
- **Evals.** `eval/inline-ui.yaml` measures how often the model uses an
  interactive answer when it helps and when it does not:
  `npm run eval -- --suite inline-ui --integration` (unit mode refuses these
  cases: it never builds the root prompt that offers the format).

## For contributors

| Where | What |
|---|---|
| `src/shared/inline-ui/` | fence parsing, markers and fallbacks, lint, limits, theme tokens, frame documents and runtimes, bridge validation |
| `src/core/inline-ui/` | extraction and history stubs, the offer and prompt, turn notes, read access, saving as an artifact (server sanitizer) |
| `src/tools/inline-ui/` | `inline-ui__source` |
| `src/api/routes/inline-ui.ts` | block read and promote |
| `web/components/chat/inline-ui/` | block, frame, streaming preview, save dialog |
| `tests/web/inline-ui*.spec.ts` | frames in a real browser, the chat, saved copies |

A change to the refused elements or attributes goes in one list
(`INLINE_UI_REFUSED_ELEMENTS`, `INLINE_UI_DROPPED_ATTRIBUTES`): the content
runtime and the server sanitizer for saved copies both read it.
