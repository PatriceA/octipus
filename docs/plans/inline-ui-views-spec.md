# Interactive answers, part 2 — declarative views

> **Status: as built (server), 2026-11-22.** The shared core
> (`src/shared/inline-ui/view/`) and the server side (storage, extraction,
> REST, the source tool, answers, the setting, the prompt, measuring, other
> surfaces, evals) are in; the web renderer is built against this contract.
> Extends
> [`inline-ui-spec.md`](inline-ui-spec.md) (the HTML/CSS/JS block, referred to
> as "part 1"; its section and invariant numbers — D4, S6, T13 — are used
> here). The model for the format is Google's
> [A2UI](https://github.com/a2ui-project/a2ui) (v1.0: a catalog of components,
> a flat component list, a data model with bindings, structured actions back
> to the agent). Its packages are **not** used: the renderer, the validator
> and the expression evaluator are ours.

## 1. Why

Agents offered part 1 almost never choose it unprompted. Reading the code:

1. The prompt section reads as a restriction ("Use one only when…", nine lines
   of prohibitions, filed under guardrails), and other prompt parts contradict
   it ("Your final answer is plain text", fenced blocks "ONLY for code").
2. A widget costs 1–3.5 k output tokens of hand-written HTML/CSS/JS.
3. The use cases it allows (calculators, steppers) are rare in daily work;
   the common ones (choose, confirm, fill in values, triage a list) are
   refused (`form`) or have no way back to the agent.
4. Scripts wait for a click in history, in rooms, after any outside read and
   on every engine that is not Chromium.
5. Unprompted use was never measured: every positive eval case asks for a
   widget.

A **view** is a second kind of interactive answer: a JSON description of
catalog components, rendered by the web app as its own React components. It
costs a few hundred tokens, runs no generated code (so it never waits for a
click), and its buttons send structured answers back to the agent.

## 2. Format

### 2.1 Fence

The same fence as part 1. A body whose first non-blank character is `{` is a
view; anything else is a part-1 HTML block.

````text
```octi-ui title="Pick a plan"
{ "data": {…}, "computed": {…}, "root": {…} }
```
````

`title` as in part 1. `height` is ignored for a view.

### 2.2 Authored document

```jsonc
{
  "data": { "usage": 10, "plans": [ { "name": "S", "price": 10 } ] },  // optional: the data model
  "computed": { "extra": "max(0, usage - 5) * 2" },                   // optional: named expressions
  "root": { "component": "Column", "children": [ … ] }                // required
}
```

A node is `{ "component": "<Name>", …props }`, with an optional `id`
(1–64 letters, digits, `_`, `-`). Children are written inline (nested
nodes). The A2UI flat form is accepted too: `"components": [ { "id": "root",
… }, … ]` with children given as ids, instead of `root`; every entry needs an
`id` and the root is the one with id `root`. The two can be combined: any
child may be a node or the id of a node written elsewhere (in `components`
or nested with an `id`), and `root` may itself be an id.

Every component has exactly one parent: an id used twice is refused
(`shared-child`; a shared node would render as many times as it is reached,
which a chain of them makes exponential), as is a cycle. An entry of
`components` that no parent reaches is ignored (repairable). Other top-level
keys are ignored (repairable).

### 2.3 Stored document (normalized)

`normalizeView` turns either form into the A2UI adjacency list, with
deterministic ids for nodes that have none: the root is `root`, the i-th
child (or tab, or step) of `p` is `p_i`, a template of `p` is `p_template`. A
generated id that a written id already holds gets `-2`, `-3`, …. Unknown
props are dropped.

```ts
interface InlineUiView {
  version: 1;
  root: string;                          // id of the root, also components[0]
  components: InlineUiViewComponent[];   // depth-first, root first; children are ids
  data: JsonObject;
  computed: Record<string, string>;
}
```

`viewToAuthored` writes the nested form back (for `inline-ui__source`),
leaving out ids that normalizing would generate again, so
`normalizeView(viewToAuthored(v))` is `v`.

### 2.4 Dynamic values

Any prop documented as dynamic takes:

| Form | Meaning |
|---|---|
| a literal | itself |
| `{"@path": "/a/b/0"}` | JSON Pointer into the data model. Without a leading `/` it is relative to the template item (§2.6) |
| `{"@expr": "price * qty"}` | an expression (§2.5) |
| a string containing `${…}` | each `${expr}` is replaced by the expression's value as text (`\${` is a literal) |

An input's `value` (and `Table.selected`) must be `{"@path": …}`: the input
writes there. A ref is exactly that one key; anything else with an `@` key is
refused. Resolution is shallow: a literal list or object is used as written,
and where the catalog declares dynamic fields inside one (`KeyValue.items`),
each field is resolved on its own. A relative path outside a template is
refused. `__proto__`, `constructor` and `prototype` segments are refused in
every path.

### 2.5 Expressions

A small pure language, parsed by our own parser — never `eval`/`Function`.

- Literals: numbers, `'single'` or `"double"` quoted strings, `true`, `false`, `null`.
- Names: `usage`, `plan.price`, `plans[0].name`. Resolution order: a
  `computed` name, then a key of the template item, then a key of the data
  model. `$item` is the template item, `$index` its index (using either
  outside a template is a validation error). Unknown name → `null`. Own
  properties only; `__proto__`, `constructor`, `prototype` are never read;
  `.length` works on lists and strings. There are no list or object
  literals. A computed name sees the data model and other computed names,
  never a template item, so it has one value per evaluation (and is
  evaluated once per evaluation).
- Operators: `+ - * / % ^`, unary `-` and `!`, `== != < <= > >=`, `&& ||`,
  `c ? a : b`, parentheses. `+` concatenates when either side is a string.
  Precedence, loosest first: `?:`, `||`, `&&`, `== !=`, `< <= > >=`,
  `+ -`, `* / %`, unary `- !`, `^` (right-associative; `-2^2` is -4).
  Arithmetic reads numbers as they are, booleans as 1/0, numeric strings as
  numbers, everything else (null included) as NaN. `==` is structural
  equality. `<` on two strings compares text, otherwise numbers. Truthiness
  and `&&`/`||` are JavaScript's (they return an operand; empty lists are
  true).
- Functions (fixed table): `min max round(x, digits?) floor ceil abs sqrt
  pow sum(list, key?) avg(list, key?) count(list) len(x) if(c, a, b)
  contains(listOrString, v) lower upper formatNumber(x, digits?)
  formatCurrency(x, code) formatPercent(x, digits?) formatDate(x, style?)`.
  `min`/`max` take numbers or one list; they, `sum` and `avg` skip
  non-numbers. `formatPercent` takes a ratio (0.25 → 25%). `formatDate` takes
  an ISO string or epoch milliseconds and a style `short`, `medium`
  (default), `long`, `full`, `time` or `datetime`; a date-only string is a
  calendar date and never shifts with the time zone. A bad currency code or
  style is an evaluation error. Formatting uses a locale and time zone the
  caller passes, default `en-US` and `UTC` (server text and tests are
  deterministic; the web passes the viewer's). A value written as text
  (interpolation, `+`) uses the locale without grouping; lists join with
  `, `; null is empty.
- Bounds: source ≤ 500 characters per expression, nesting ≤ 32
  (parentheses, brackets, calls, unary operators, `?:`), 10 000 steps per
  evaluation (one per node, one per list item a function reads), computed
  names may reference each other without cycles (a cycle is a validation
  error). A number that is not finite renders as `—`. Inside `${…}`, a `}`
  in a quoted string does not end the expression.

### 2.6 Catalog

Every component also takes `visible` (dynamic boolean, default true).
`?` marks optional props; *dyn* marks dynamic ones.

**Layout**

| Component | Props |
|---|---|
| `Column` | `children`, `gap?` (`sm`/`md`/`lg`), `align?` (`start`/`center`/`end`/`stretch`) |
| `Row` | `children`, `gap?`, `align?`, `justify?` (`start`/`center`/`end`/`between`), `wrap?` (default true) |
| `Card` | `title?` *dyn*, `children` |
| `Tabs` | `tabs`: `[{ title, child }]` |
| `Steps` | `steps`: `[{ title, child }]` — one at a time, Back / Next, "Step i of n" |
| `Divider` | — |

`children` is a list of nodes (or ids), or a template:
`{"path": "/plans", "template": <node or id>}` — one copy per item of the
list at `path`, at most 200, and at most 2 000 components rendered in all
(so a template whose copy has 20 components shows 100 items; the renderer
says how many are hidden). Templates do not nest: a template inside a
template's subtree is refused.

**Display**

| Component | Props |
|---|---|
| `Text` | `text` *dyn*, `variant?` (`body` default — rendered as markdown; `heading`, `subheading`, `caption`, `label` — plain) |
| `Stat` | `label` *dyn*, `value` *dyn*, `hint?` *dyn*, `tone?` (`neutral`/`good`/`warn`/`bad`) *dyn* |
| `Badge` | `text` *dyn*, `tone?` *dyn* |
| `Progress` | `value` *dyn*, `max?` (default 100), `label?` *dyn* |
| `KeyValue` | `items`: `[{ label, value }]` (both *dyn*) |
| `Table` | `columns`: `[{ key, label, align?, format?, sortable? }]`, `rows` *dyn* (list of objects), `filter?` (search box), `pageSize?` (default 10), `selectable?` (`single`/`multiple`), `selected?` (`@path`, receives the selected row or rows), `rowKey?` |
| `Chart` | `type` (`bar`/`line`/`area`/`pie`), `data` *dyn* (list of objects), `x` (key), `series`: `[{ key, label? }]`, `stacked?`, `height?` |
| `Link` | `text` *dyn*, `url` *dyn* (`https:` only) |

A column `format` is `text`, `number`, `currency:EUR`, `percent` or `date`;
a column `align` is `start`, `center` or `end`. Limits: 200 table rows, 500
chart points (checked on literals and on the initial data at a `@path`; the
renderer caps live data). A choice `value` is a string, number or boolean.

**Input** (`value` is a `@path`)

| Component | Props |
|---|---|
| `TextField` | `label`, `value`, `variant?` (`short`/`long`/`number`), `placeholder?`, `min?`, `max?`, `required?` |
| `Slider` | `label`, `value`, `min`, `max`, `step?`, `format?` |
| `CheckBox` | `label`, `value` |
| `ChoicePicker` | `label?`, `options` *dyn*: `[{ label, value, description? }]`, `value`, `multiple?`, `display?` (`radio`/`chips`/`select`) |
| `DateTimeInput` | `label`, `value`, `enableDate?` (default true), `enableTime?`, `min?`, `max?` (ISO 8601 strings) |
| `Button` | `label` *dyn*, `action`, `variant?` (`primary`/`default`/`borderless`/`danger`), `disabled?` *dyn* |

There is no password or file input, and none will be added (S12).

### 2.7 Actions

`action` is one action or a list of at most 4, run in order:

| Action | Effect |
|---|---|
| `{"set": {"path": "/step", "value": <dyn>}}` | writes the data model, locally |
| `{"openUrl": "<https url, dyn>"}` | opens the link the way a markdown link in a reply opens |
| `{"event": {"name": "plan_chosen", "context": { "plan": <dyn>, … }, "userMessage"?: "I'll take ${plan.name}"}}` | answers the agent (§4) |

`name` matches `^[a-z][a-z0-9_]{0,39}$`. `context` has at most 20 keys.
Steps run in order on one click: each `set` sees the writes before it (a
template item is read again from its path), and an event's context is
resolved after them. A link that does not resolve to an `https:` URL stops
the click with an error. Only `Button` carries `action`.

### 2.8 Limits

View JSON ≤ 24 000 characters; ≤ 200 components; nesting ≤ 12 (the root is
level 1); `data` ≤ 16 000 characters serialized; ≤ 20 computed names;
per-reply and per-session caps as in part 1. All numbers are
`INLINE_UI_VIEW_LIMITS` in `src/shared/inline-ui/limits.ts`.

## 3. Validation and repair

`lintInlineUiView(body)` (shared, pure) returns part 1's `InlineUiIssue[]`,
so the existing repair round and notices apply unchanged.

- **fatal**: JSON that does not parse (with line and column), no root, an
  unknown component (the message lists the catalog), a missing required prop,
  a prop of the wrong type, an unknown child id, a cycle, an input whose
  `value` is not a `@path`, an expression that does not parse (with the
  expression and position), a bad event name, a URL literal that is not
  `https:`, a limit exceeded, a `Slider` whose `value` is an absolute path
  with no finite number at it in `data` (`bad-data`: "Slider "<id>": set an
  initial number at /tb in data, between min and max"; it would show `min`
  while expressions and the answer read null; a template's relative path is
  not checked).
- **repairable**: an unknown prop or top-level key (named; it is ignored), a
  component no parent reaches, a name an expression outside a template reads
  that is neither a data key, a computed name, nor a key an input or `set`
  writes (`unknown-name`; it would be null).

Issue codes: `cut-off`, `too-large`, `invalid-json`, `not-object`,
`no-root`, `bad-node`, `bad-id`, `duplicate-id`, `unknown-component`,
`unknown-child`, `cycle`, `shared-child`, `too-deep`,
`too-many-components`, `bad-data`, `bad-computed`, `missing-prop`,
`bad-prop`, `input-binding`, `bad-path`, `bad-expr`, `bad-action`,
`bad-event-name`, `bad-url`, `nested-template` (fatal); `unknown-prop`,
`unknown-key`, `unused-component`, `unknown-name` (repairable). At most 20
issues are listed, then one `more-issues` line.

Messages are written for the model: what is wrong, where (component id and
prop), and what is accepted.

## 4. Events: the answer goes back to the agent

A `Button` with an `event` action sends a message in the conversation:

- **Content** — `userMessage` with its `${…}` resolved, or the button's label.
- **`inlineUi.action`** on `chat.send` — `{ blockId, name, componentId,
  context, data? }`, `context` being the event's context with every value
  resolved against the data model at the click, `data` the data model then
  (`InlineUiActionSchema` in `src/core/gateway/protocol.ts`). In a room the
  same object rides on `room.post` as `inlineUi.action` (and on its REST
  fallback, `POST /api/spaces/:id/rooms/:roomId/messages`, and a remote
  room's `POST /api/remote-spaces/:id/rooms/:roomId/messages`). `POST
  /api/chat` carries no `inlineUi`.

Server (`resolveInlineUiTurnNotes`): the block must be a view of this
session, the component must exist and carry an event of that name, the
context keys must be the declared ones, the context is JSON of at most 4 000
characters and depth 4 (a flat object is depth 1) — `validateViewAction`
in the shared module; `data`, when sent, must be a JSON object (anything else
refuses the answer). A `data` over 16 000 characters (`validateViewData`; a
selectable Table copies whole rows into the data model) does not refuse it:
it is dropped with a debug log and the view's own `data` is stored, as when
none is sent. The web builds the payload with `runViewActions` /
`resolveEventAction`: context values resolved, numbers that are not finite
sent as null, `userMessage` (else the label, else the event name) cleaned
like a suggestion and capped at 1 000 characters. A request that fails any check is refused with a
specific message (fail loud), not silently stripped: `chat.send` gets an
`error` frame, code `INVALID_MESSAGE`, message `The interactive answer was
not sent: <reason>`, and nothing is steered, queued or stored; a room post is
refused with `INVALID_INPUT` (gateway) or 400 (REST), same message. Then:

- the model reads one line in the volatile part, after the provenance line:
  `(system note: the user answered interactive answer <uuid> — event "<name>", values: <json>)`;
- the user row stores `metadata.inlineUiAction` (`blockId`, `name`,
  `context`), on the steer path, a CLI root's row and a room post too; the
  message list (`GET /api/sessions/:id/messages`) returns it with the rest of
  the metadata, and a room message's view (`RoomMessageView.metadata`) keeps
  it; the bubble shows "from an interactive answer" and the values;
- the block row stores `state = { data, action: { name, componentId, at } }`
  when the user row is written (a room: when the post is). The web sends
  `data` (the data model at the click) with the action and leaves it out
  when it is over 16 000 characters; without it, or over the limit, the
  view's own `data` is stored. A reload shows the answer as
  given, its event buttons disabled, with **Change answer** to enable them
  again.
- In a room the post is addressed to Octipus whatever `addressed` says (so
  an API token needs `api:chat` for it, here and through a remote room, and
  it runs with the member's companion like any addressed post), and the room
  turn reads the same note line from the post's `metadata.inlineUiAction`.
- The context's string values reach the prompt, so they pass the input guard
  with the message content, wherever the content does (a turn, a steer, a
  post from another install): a value it blocks refuses the message as
  blocked content would be. The note is one line whatever the values hold
  (JSON-encoded; U+2028/U+2029 escaped; control, bidi and zero-width
  characters stripped).

**What a click may send (S6, T7, T13).** A view's button is drawn by the chat
page, and the bubble shows exactly what was sent. The values are the user's
own input or data the agent wrote itself; they reach the model labelled as
values of an answer, never as instructions. Where the block is `tainted` (the
session had read outside content, private data or a secret when it was
written), the click opens part 1's suggestion strip (full text, **Send** /
**Edit in composer** / **Dismiss**) instead of sending at once. Events are
off while an admin acts as the user: a REST room post with one, local or
remote, answers 403 (the gateway socket never acts as another user). In a
room the message is the clicking member's own, addressed to the agent, as
for a suggestion.

For a blocking yes/no in the middle of a task, `request_user_approval`
stays the tool; a view is for structured answers at the end of a reply.

## 5. Rendering

- **Web** (`web/components/chat/inline-ui/view/`): React components, text
  nodes only — no `dangerouslySetInnerHTML`, no frame, no script. The block
  keeps part 1's chrome: border, header (title, "Interactive answer"),
  footer ("Made by the agent"). Charts use `recharts` (already a
  dependency). No click-to-run, no live-frame cap, no freeze marker: no
  generated code runs. **View source** shows the JSON. **Save as artifact**
  is not offered for a view.
- **Streaming preview**: the fence body so far is healed (`healPartialJson`:
  open strings, arrays and objects closed; a trailing incomplete key,
  literal or number dropped with its key; null when there is nothing usable)
  and linted as closed, then rendered with inputs disabled when it
  validates; otherwise the "Building “T”…" line alone. A string still being
  written is kept (text streams), so a half-written component name fails
  the lint for a chunk; the preview keeps its last good render.
- **Other surfaces**: `inlineUiViewText(view)` writes a view as plain
  markdown (headings, text, `label: value`, tables of at most 20 rows, a
  chart as its table, inputs with their current value, buttons as a list of
  choices; locale `en-US` and `UTC` unless given; `opts.data` shows a stored
  answer's data; an expression that fails at render shows as `⚠ <reason>`;
  a date past the range of a JavaScript date shows as `—`).
  `inlineUiFallbackTextResolved(text, sessionId)`
  (`src/core/inline-ui/fallback.ts`) writes a view's marker as
  `▸ Interactive answer “T”:`, a blank line and that text (with the stored
  answer's data), and keeps part 1's line for an HTML block, a block of
  another session, a stray fence and a view whose text rendering throws
  (logged per block: the reply is never lost to it). Server-side surfaces that know the
  session use it: channel replies, monitor delivery, the group bridge relay,
  hook owner notifications, room notifications, `POST /api/chat` without
  `renders`, the OpenAI-compatible API. Clients that only hold the marker
  (the terminal UIs, MCP `octipus_get_messages`) keep the line; voice drops
  blocks; a status update keeps the line (`stubInlineUiFences`).

## 6. Storage

Migration `0198_inline_ui_views.sql` on `inline_ui_blocks`:

| Column | Type | Notes |
|---|---|---|
| `kind` | text, not null, default `'html'` | `'html'` or `'view'` |
| `view` | jsonb, null | the normalized view (§2.3) |
| `state` | jsonb, null | the last answer (§4) |

A check constraint holds `kind` to `html`/`view` and a view to a non-null
`view`. For a view: `html`/`css`/`js` are empty, `scripts` false,
`heightHint` the default, `tainted`/`risk` recorded as in part 1.
`GET …/inline-ui/:blockId` returns `kind`, `view`, `state` (`null` where
unset) besides part 1's fields; so does the federation op `room.inline_ui`,
and the visitor accepts a view from the host only when it is one this
install would have stored (`storedViewProblem`: written back, linted and
normalized, it is itself) and its answer data is within the limit.
`inline-ui__source` returns `{ id, title, kind: 'view', body }`, `body` the
compact JSON of `viewToAuthored` (an HTML block: `{ id, title, kind: 'html',
height, body }`). The output guard reads a view's JSON with the reply.
Promotion refuses a view (409). Repository: `create` with `kind`/`view`,
`setState(id, sessionId, state)` (views only).

## 7. Offer and prompt

- The offer predicate (D4) is unchanged, with one input more: the setting
  `agent.interactiveAnswers` (env `AGENT_INTERACTIVE_ANSWERS`) — `off`
  (never offered), `auto` (default), `prefer` (the section adds one line:
  "Prefer one whenever the answer has any structure.").
- `INLINE_UI_PROMPT` is rewritten: when to use one, in positive terms (the
  user must choose, confirm or give values; several items with several
  attributes; numbers across time or categories; a result that depends on
  inputs; a process); the view format with compact component signatures and
  two short examples; the event round trip; then HTML as the fallback for
  free-form visuals, with only the rules the lint does not already enforce
  in the repair round. Budget: at most 1 000 tokens; `offer.test.ts` holds
  it to 1 000 tokens (`estimateTokens`) and 3 800 characters as the model
  reads it, and lints every example. It is no longer filed under
  guardrails: label "Interactive answers", category `role`. It is
  `inlineUiPrompt(setting)` in `src/core/inline-ui/offer.ts`.
- Contradictions removed: `delegation-prompt.md` ("plain text on your LAST
  iteration"; dashboards → `data`), `OUTPUT_FORMATTING_RULES` (fenced blocks
  "ONLY for…").
- No regex-driven per-turn hint: the root reads the message better than a
  keyword table does (see `buildTopicHint`).

## 8. Measuring

- One info log per offered root turn, `Interactive answer offer`:
  `{ offered: true, used: <count>, kinds: [...], refused: <count>, setting }`.
  Root-runner opens a tally for the run when it offers them
  (`noteInlineUiOffer`); every store pass of the run adds to it (the
  worker's, a CLI root's, the service's); the service logs it after its own
  pass, the last before the reply is saved (`logInlineUiOffer`, main and
  plan paths, rooms included).
- `eval/inline-ui.yaml` gains unprompted positives (the request does not ask
  for a widget: option choices, comparisons of several items, parameter
  collection, numbers over time) and view-specific negatives. The gate and
  its "not yet run" status are as in part 1 (it needs a live model).

## 9. Shared module

`src/shared/inline-ui/view/` (exported from `src/shared/inline-ui`), pure
TypeScript with no runtime imports outside `src/shared/inline-ui`:
`types.ts` (documents, components, actions, state), `catalog.ts` (the one
table the normalizer, the lint and `inlineUiViewCatalogPrompt()` are built
from), `expr.ts`, `format.ts`, `json.ts`, `data.ts`, `normalize.ts`,
`lint.ts`, `actions.ts`, `text.ts`, `partial.ts`.

## 10. Not in this change

Native channel widgets (Telegram keyboards, Slack blocks, terminal selects);
views written by child agents; binding a tool result into the data model
without retyping it; saving a view as an artifact; A2UI wire compatibility
(`createSurface`/`updateComponents` messages, catalog negotiation).
