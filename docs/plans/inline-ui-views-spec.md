# Interactive answers, part 2 — declarative views

> **Status: contract for implementation, 2026-11-22.** Extends
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

A node is `{ "component": "<Name>", …props }`, with an optional `id`.
Children are written inline (nested nodes). The A2UI flat form is accepted
too: `"components": [ { "id": "root", … }, … ]` with children given as ids,
instead of `root`.

### 2.3 Stored document (normalized)

`normalizeView` turns either form into the A2UI adjacency list, with
deterministic ids for nodes that have none (`root`, `root_0`, `root_0_1`, …):

```ts
interface InlineUiView {
  version: 1;
  components: Array<{ id: string; component: string; [prop: string]: unknown }>; // children are ids
  data: Record<string, unknown>;
  computed: Record<string, string>;
}
```

### 2.4 Dynamic values

Any prop documented as dynamic takes:

| Form | Meaning |
|---|---|
| a literal | itself |
| `{"@path": "/a/b/0"}` | JSON Pointer into the data model. Without a leading `/` it is relative to the template item (§2.6) |
| `{"@expr": "price * qty"}` | an expression (§2.5) |
| a string containing `${…}` | each `${expr}` is replaced by the expression's value as text (`\${` is a literal) |

An input's `value` must be `{"@path": …}`: the input writes there.

### 2.5 Expressions

A small pure language, parsed by our own parser — never `eval`/`Function`.

- Literals: numbers, `'single'` or `"double"` quoted strings, `true`, `false`, `null`.
- Names: `usage`, `plan.price`, `plans[0].name`. Resolution order: a
  `computed` name, then a key of the template item, then a key of the data
  model. `$item` is the template item, `$index` its index. Unknown name →
  `null`. Own properties only; `__proto__`, `constructor`, `prototype` are
  never read.
- Operators: `+ - * / % ^`, unary `-` and `!`, `== != < <= > >=`, `&& ||`,
  `c ? a : b`, parentheses. `+` concatenates when either side is a string.
- Functions (fixed table): `min max round(x, digits?) floor ceil abs sqrt
  pow sum(list, key?) avg(list, key?) count(list) len(x) if(c, a, b)
  contains(listOrString, v) lower upper formatNumber(x, digits?)
  formatCurrency(x, code) formatPercent(x, digits?) formatDate(x, style?)`.
- Bounds: source ≤ 500 characters, nesting ≤ 32, a step budget per
  evaluation, computed names may reference each other without cycles (a cycle
  is a validation error). A number that is not finite renders as `—`.

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
list at `path`, at most 200.

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

A column `format` is `text`, `number`, `currency:EUR`, `percent` or `date`.
Limits: 200 table rows, 500 chart points.

**Input** (`value` is a `@path`)

| Component | Props |
|---|---|
| `TextField` | `label`, `value`, `variant?` (`short`/`long`/`number`), `placeholder?`, `min?`, `max?`, `required?` |
| `Slider` | `label`, `value`, `min`, `max`, `step?`, `format?` |
| `CheckBox` | `label`, `value` |
| `ChoicePicker` | `label?`, `options` *dyn*: `[{ label, value, description? }]`, `value`, `multiple?`, `display?` (`radio`/`chips`/`select`) |
| `DateTimeInput` | `label`, `value`, `enableDate?` (default true), `enableTime?`, `min?`, `max?` |
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

### 2.8 Limits

View JSON ≤ 24 000 characters; ≤ 200 components; nesting ≤ 12; `data`
≤ 16 000 characters serialized; ≤ 20 computed names; per-reply and
per-session caps as in part 1.

## 3. Validation and repair

`lintInlineUiView(body)` (shared, pure) returns part 1's `InlineUiIssue[]`,
so the existing repair round and notices apply unchanged.

- **fatal**: JSON that does not parse (with line and column), no root, an
  unknown component (the message lists the catalog), a missing required prop,
  a prop of the wrong type, an unknown child id, a cycle, an input whose
  `value` is not a `@path`, an expression that does not parse (with the
  expression and position), a bad event name, a URL literal that is not
  `https:`, a limit exceeded.
- **repairable**: an unknown prop (named; it is ignored).

Messages are written for the model: what is wrong, where (component id and
prop), and what is accepted.

## 4. Events: the answer goes back to the agent

A `Button` with an `event` action sends a message in the conversation:

- **Content** — `userMessage` with its `${…}` resolved, or the button's label.
- **`inlineUi.action`** on `chat.send` — `{ blockId, name, componentId,
  context }`, `context` being the event's context with every value resolved
  against the data model at the click.

Server (`resolveInlineUiTurnNotes`): the block must be a view of this
session, the component must exist and carry an event of that name, the
context keys must be the declared ones, the context is JSON of at most 4 000
characters and depth 4. A request that fails any check is refused with a
specific message (fail loud), not silently stripped. Then:

- the model reads one line in the volatile part, after the provenance line:
  `(system note: the user answered interactive answer <uuid> — event "<name>", values: <json>)`;
- the user row stores `metadata.inlineUiAction` (`blockId`, `name`,
  `context`), on the steer path too; the bubble shows "from an interactive
  answer" and the values;
- the block row stores `state = { data, action: { name, componentId, at } }`.
  The web sends `data` (the data model at the click, ≤ 16 000 characters)
  with the action. A reload shows the answer as given, its event buttons
  disabled, with **Change answer** to enable them again.

**What a click may send (S6, T7, T13).** A view's button is drawn by the chat
page, and the bubble shows exactly what was sent. The values are the user's
own input or data the agent wrote itself; they reach the model labelled as
values of an answer, never as instructions. Where the block is `tainted` (the
session had read outside content, private data or a secret when it was
written), the click opens part 1's suggestion strip (full text, **Send** /
**Edit in composer** / **Dismiss**) instead of sending at once. Events are
off while an admin acts as the user. In a room the message is the clicking
member's own, addressed to the agent, as for a suggestion.

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
- **Streaming preview**: the fence body so far is healed (open strings,
  arrays and objects closed) and rendered with inputs disabled when it
  validates; otherwise the "Building “T”…" line alone.
- **Other surfaces**: `inlineUiViewText(view)` writes a view as plain
  markdown (headings, text, `label: value`, tables of at most 20 rows, a
  chart as its table, inputs with their current value, buttons as a list of
  choices). Server-side surfaces that know the session — channel replies,
  `POST /api/chat` without `renders`, the OpenAI-compatible API, room
  notifications — use it in place of part 1's one-line fallback. Clients that
  only hold the marker (the terminal UIs, MCP) keep the line.

## 6. Storage

Migration `0198_inline_ui_views.sql` on `inline_ui_blocks`:

| Column | Type | Notes |
|---|---|---|
| `kind` | text, not null, default `'html'` | `'html'` or `'view'` |
| `view` | jsonb, null | the normalized view (§2.3) |
| `state` | jsonb, null | the last answer (§4) |

For a view: `html`/`css`/`js` are empty, `scripts` false, `tainted`/`risk`
recorded as in part 1. `GET …/inline-ui/:blockId` returns `kind`, `view`,
`state`. `inline-ui__source` returns the view as authorable JSON. The output
guard reads a view's JSON with the reply. Promotion refuses a view (409).

## 7. Offer and prompt

- The offer predicate (D4) is unchanged, with one input more: the setting
  `agent.interactiveAnswers` — `off` (never offered), `auto` (default),
  `prefer` (the section adds one line: use one whenever the answer has
  structure).
- `INLINE_UI_PROMPT` is rewritten: when to use one, in positive terms (the
  user must choose, confirm or give values; several items with several
  attributes; numbers across time or categories; a result that depends on
  inputs; a process); the view format with compact component signatures and
  two short examples; the event round trip; then HTML as the fallback for
  free-form visuals, with only the rules the lint does not already enforce
  in the repair round. Budget: at most 1 000 tokens. It is no longer
  filed under guardrails: label "Interactive answers", category `role`.
- Contradictions removed: `delegation-prompt.md` ("plain text on your LAST
  iteration"; dashboards → `data`), `OUTPUT_FORMATTING_RULES` (fenced blocks
  "ONLY for…").
- No regex-driven per-turn hint: the root reads the message better than a
  keyword table does (see `buildTopicHint`).

## 8. Measuring

- One info log per offered root turn, `Interactive answer offer`:
  `{ offered: true, used: <count>, kinds: [...], refused: <count>, setting }`.
- `eval/inline-ui.yaml` gains unprompted positives (the request does not ask
  for a widget: option choices, comparisons of several items, parameter
  collection, numbers over time) and view-specific negatives. The gate and
  its "not yet run" status are as in part 1 (it needs a live model).

## 9. Not in this change

Native channel widgets (Telegram keyboards, Slack blocks, terminal selects);
views written by child agents; binding a tool result into the data model
without retyping it; saving a view as an artifact; A2UI wire compatibility
(`createSurface`/`updateComponents` messages, catalog negotiation).
