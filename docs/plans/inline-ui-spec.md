# Inline UI — implementation spec

> **Spec, revision 1, 2026-10-14.** Adds small interactive answers — charts,
> calculators, diagrams, comparisons with controls — rendered inside the web
> chat, next to the reply that produced them. The idea and some code come from
> [CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
> (MIT, © Atai Barkai), abbreviated **OIUI** below. Its framework (CopilotKit,
> AG-UI, a Python LangGraph agent, the paid "Jev" visualization router) is
> **not** adopted; four mechanisms are: a sandboxed per-answer frame, a
> streaming preview of half-generated HTML, a validated bridge from the frame
> back to the chat, and the authoring guidance that makes generated UI usable.
>
> Every statement about today's code carries a `file:line` reference against
> `main` at d2f9b65.

## Contents

- §1 What exists today
- §2 Goals and non-goals
- §3 Decisions
- §4 Security invariants
- §5 P1 — Tool, storage, final render
- §6 P2 — Bridge back to the chat
- §7 P3 — Streaming preview
- §8 P4 — Save as live artifact
- §9 P5 — Guidance and evaluation
- §10 Cross-cutting (cost, privacy, accessibility, docs, catalog)
- §11 Test plan
- §12 Open questions
- Appendix A — What is taken from OIUI and how

---

## 1. What exists today

### 1.1 Rendering in the chat

| Fact | Evidence |
|---|---|
| Assistant text is markdown via `react-markdown` + `remark-gfm`, no raw HTML (no rehype) | `web/components/ui/markdown-renderer.tsx:68-235` |
| The timeline merges four entry kinds by time: `message`, `agent`, `team`, `file_changes` | `web/components/chat/message-timeline.tsx:827-831,850-931,968-988` |
| Tool calls show only inside a collapsed per-agent list; result rendering switches on `ToolResultPreview.kind` (`empty,text,exit,list,diff,file,image`), not on tool name | `message-timeline.tsx:369-447,463-502,504-593` |
| `ToolResultPreview` is a shared discriminated union the web already imports | `src/shared/work-stream.ts:44-63` |
| Per-tool server renderers produce those previews | `src/core/work-stream/renderers.ts:260-307` |
| Every preview string is capped at 2 000 chars | `src/shared/work-stream.ts:77` |
| A tool may attach UI-only data under `__workStream`, stripped before the model sees the result; only `diff` is typed today | `src/shared/work-stream.ts:89-120`, `src/core/tool-executor.ts:1052-1056`, precedent `src/tools/filesystem/index.ts:378` |
| The web app is dark-only | `web/app/layout.tsx:35` (`className="dark"`) |

There is **no way today to show agent-generated interactive HTML in the
chat**. The only interactive HTML surface is a live artifact, which needs a
workspace, an ASK approval (`src/tools/artifacts/index.ts:183-186`), a slug, and
opens on its own page.

### 1.2 Event flow for a turn

| Fact | Evidence |
|---|---|
| Server→client events are a TS union; payloads are `unknown`; only client→server frames are Zod-validated | `src/core/gateway/protocol.ts:85-199,253,272-404` |
| Text streams as `chat.delta`, root agent only, when `agent.streaming !== false` and the provider streams | `src/core/agent-worker.ts:2374-2389`, `src/core/gateway/event-bridge.ts:76-90` |
| Every provider yields partial tool-call JSON (`toolCallDelta`), but `collectStream` assembles it server-side and only calls `onDelta` for text | `src/models/stream-collect.ts:38-51,68-73`; providers e.g. `src/models/providers/custom/anthropic-compat-provider.ts:525-548`, `openai-provider.ts:186-201`, `ollama-provider.ts:472-490`, `gemini-provider.ts:254-272` |
| The CLI provider does not stream | `src/models/providers/cli-provider.ts:713-714` |
| Tool start reaches clients as `agent.action {toolCalls:[{argsSummary ≤120 chars…}]}`; completion as `tool_call_complete {resultPreview ≤200, title, input, result}` | `src/core/tool-executor.ts:502-523,140-154,866-878` |
| The full `observation` (raw results) is also bridged and persisted to `agent_events` | `tool-executor.ts:1028`, `event-bridge.ts:117-131`, `src/core/agent-manager.ts:374-404` |
| `agent_events` older than one day are deleted at boot | `src/index.ts:176-181` |
| The gateway replay buffer keeps 200 events per session, 500 sessions, dropping only `voice.speak` | `src/core/gateway/event-bus.ts:25,28,52` |

### 1.3 Persistence and reload

| Fact | Evidence |
|---|---|
| Tool results are stored as `messages` rows with `role:'tool'`, truncated at 50 000 chars or spilled to a file | `tool-executor.ts:1048-1099`, `src/utils/sanitize.ts:11`, `src/core/tool-output-spill.ts:83-95` |
| Tool rows never re-enter a prompt; model history reads only user/assistant | comment `tool-executor.ts:1091`, `src/db/repositories/message-repository.ts` (`findContextMessages`) |
| Web reload loads `roles=user,assistant,system` and rebuilds tool calls from persisted agent events, at most 4 agents per load | `web/app/chat/page.tsx:333-469` |

So a tool result cannot carry a 20 KB UI to the browser through the existing
previews, and a reload after one day could not rebuild it from `agent_events`.

### 1.4 Sending a message from the web

| Fact | Evidence |
|---|---|
| `sendMessage` is a closure in the chat page; it auto-creates a session, sends `chat.send`, falls back to `POST /chat` | `web/app/chat/page.tsx:1559-1754` |
| Composer draft lives inside `PromptInput` (`useState('')`), not reachable from outside | `web/components/chat/prompt-input.tsx:106,115,120` |
| Sending during a running turn steers it (no attachments) instead of starting a new one | `src/core/gateway/message-handler.ts:302-313`, `page.tsx:2023-2028` |

### 1.5 Isolation and egress controls already in place

| Fact | Evidence |
|---|---|
| Artifacts render in `<iframe sandbox="allow-scripts">` (opaque origin) | `web/app/artifacts/view/detail-client.tsx:147-151`, `src/api/routes/artifact-pages.ts:184` |
| Artifact embed CSP: `default-src 'none'; connect-src 'self' …; script-src 'self' …; img-src 'self' data: https:; …; form-action 'none'` | `src/core/artifacts/csp.ts:16-35` |
| Inline scripts in artifacts are lifted into an esbuild bundle; imports are refused | `src/core/artifacts/render.ts:132-179`, `src/core/artifacts/bundler.ts:49-117` |
| The SPA server sets no CSP; the API sets a strict CSP and `X-Frame-Options: DENY` except under `/a/` and `/__artifacts__/` | `web/serve.mjs:105-108`, `src/api/server.ts:161-176` |
| Tauri desktop: `"csp": null` | `web/src-tauri/tauri.conf.json:23-25` |
| No postMessage bridge between any artifact frame and the app | grep: only OAuth popups and an AudioWorklet use it |
| Flow guard labels a session `secret` / `private` / `suspicious` and turns ALLOW into ASK for egress after a secret read, or write egress after private+suspicious | `src/security/flow-guard.ts:101-169,480-491,524-541`, `docs/FLOW-GUARD.md` |
| An unknown tool gets no taint and no egress | `flow-guard.ts:166-167` |
| Tool results are not scanned or fenced as untrusted in general | `src/utils/sanitize.ts:402-427`; fencing only in research/reader/email |

### 1.6 Tool plumbing

| Fact | Evidence |
|---|---|
| `AgentContext` has no channel/client field; the turn's channel is in the ambient `RunContext.channel` | `src/core/types.ts:48-118`, `src/core/run-context.ts:21-45`, set at `src/core/agent/service.ts:275-277` |
| Root tool set: `getToolsForRole(ROOT_ROLE)` then plan-mode, space and remote-room filters, small-model cap, intent shrink, lazy split | `src/core/agent/root-runner.ts:312-439` |
| `seedRoles` does not merge new `toolIds` into a customized role row | `src/db/seed-roles.ts:50-75` |
| Built-in tools register through the `MODULES` list, not a folder scan (`AGENT.md:207-208` is stale) | `src/tools/discovery.ts:10,20-86` |
| Codemode scripts can call any non-final, non-discovery handler | `src/tools/codemode.ts:84-92` |
| The root agent gets no skill discovery; long guidance reaches it via a tool action (precedent: `artifacts_toolbox` → `design`) | `root-runner.ts:306-311`, `src/tools/artifacts-toolbox/index.ts:22,180-185` |
| Output cap per request defaults to 16 384 tokens, thinking budget included | `src/core/agent-worker.ts:2315`, `src/db/schema/models.ts:8`, `src/models/thinking-budget.ts:19-46` |
| `uses_tool` eval assertions cannot pass: `toolsUsed` is always `[]` | `src/eval/runner.ts:75,239` |
| `web/` has no unit tests; Playwright with a stubbed gateway is the web test lane | `vitest.config.ts:48`, `tests/web/fixtures/gateway.ts:11-24` |

---

## 2. Goals and non-goals

**Goals**

- G1. The root agent can answer a web chat turn with a small interactive UI
  that appears in the timeline, works (controls compute real values), and
  survives reload.
- G2. Generated code can do nothing outside its frame except through two
  explicit, user-mediated bridge actions.
- G3. While the UI is being generated, the user sees it build up.
- G4. A useful inline UI can be kept as a live artifact in one click.
- G5. Fail loud: a UI that cannot render says why, in the timeline and to the
  model.

**Non-goals**

- No new agent framework, no AG-UI/CopilotKit, no visualization router model.
  The model decides when a UI helps, guided by the tool description.
- No inline UI outside the web chat (TUI, channels, MCP, voice) in this spec.
- No data sources, refresh or sharing for inline UIs — that is what live
  artifacts are for (§8).
- No persisted state inside a frame. Re-mounting a frame resets it.
- No CDN libraries in P1 (see D7).

---

## 3. Decisions

**D1. One tool group, `inline-ui`, three handlers.**
`inline-ui__render` (action `render`, ALLOW), `inline-ui__get` (action
`read`, ALLOW, read-only), `inline-ui__guide` (action `read`, ALLOW,
read-only). `render` takes `{ title, height_hint?, css?, html, js? }` in that
property order. No `list`: the ids of prior UIs reach the model through the
render result in the same turn and through bridge provenance (§6.3) in later
turns.

*Why `get`:* tool rows never re-enter later prompts (§1.3). Without it, "make
the bars blue" one turn later would force a rewrite from memory.

**D2. The UI's source is stored in its own table and fetched by reference.**
The tool result carries only a reference (`ToolResultPreview` kind
`inline_ui`). The browser fetches the source by id over REST. This follows the
existing rule for large payloads ("stream a preview + a ref, never the whole
file through the event bus", `src/shared/work-stream.ts:56-59`), keeps the
2 000-char cap intact, and makes reload independent of the one-day
`agent_events` retention.

**D3. The timeline gets a fifth entry kind, `inline_ui`,** placed by
`createdAt`, independent of the per-agent tool list. Live: added when a
`tool_call_complete` carries `result.kind === 'inline_ui'`. Reload: from
`GET /api/sessions/:id/inline-ui`. Deduplicated by id.

**D4. Root agent, web chat, personal sessions only, normal and large models.**
The group is offered only when all hold: the turn's `RunContext.channel` is
`webchat`; no space, no room, no remote room; the model is not small-tier.
`execute` re-checks the channel and space conditions and throws
`ToolNotExecutedError` otherwise (codemode and future paths cannot bypass the
offer filter). Rooms and spaces are deferred to §12 because other members'
clients would render code generated in someone else's turn.

**D5. The group is added by `root-runner`, not by the `general` role's
`toolIds`.** It is a capability of the client, not of the role, and
customized `general` rows would never receive it through `seedRoles`
(`src/db/seed-roles.ts:50-75`). It is added after the space/remote filters,
added to `rootAllowedToolIds`, and kept in the core set of the lazy split.

**D6. Two frame modes decided at render time on the client: `static` (no
`js`) and `scripted` (has `js`).** `static` renders with `sandbox=""` — no
script at all. `scripted` renders with `sandbox="allow-scripts"` and the CSP of
§4. The mode is stored with the block (`scripts` column) and shown on the
block's header ("interactive").

**D7. No network from a frame. No CDN libraries in P1.** The frame CSP denies
every fetch, image, font, stylesheet and script source other than inline and
`data:`/`blob:`. OIUI allows four CDNs plus `'unsafe-eval'`; that would let
generated code send anything anywhere and pull arbitrary code. Charts are
SVG/canvas written by the model; the guide gives it a compact SVG chart
recipe. Vendored libraries served from the app's own origin are §12-Q3.

**D8. The bridge never sends a message by itself.** `prompt` puts the text in
the composer, marked with its source; the user presses Send. `openLink` shows
the full URL in a chip with a real link the user clicks. OIUI sends directly;
we diverge because generated code is model output that can be steered by
untrusted content (a fetched page, an email), and a sent message counts as the
user's own words and can steer a running turn (§1.4).

**D9. Flow guard contract: `render` with `js` is `read` egress.**
A scripted frame can still navigate itself to a URL carrying data (no CSP
directive governs frame self-navigation). That is the same capability as a
web fetch, which flow guard already classifies as `read` egress
(`flow-guard.ts:111`). So a scripted render after a `secret` read asks for
approval; a `static` render has no egress. `render` sets no taint.

**D10. Shared, pure helpers live in `src/shared/inline-ui/`.** Document
builder, CSP string, partial-HTML processor, partial-JSON string extractor,
bridge message validator and size limits — no runtime imports, so the web can
import them (house rule 7; `src/shared/types.ts:1-11`) and root Vitest can test
them (web has no unit lane, §1.6).

**D11. Promotion to a live artifact goes through a new endpoint that reuses
the tool's version writer.** `POST /api/artifacts` stores the template without
lifting scripts into a bundle (`src/api/routes/artifacts.ts:84-92`), so a
promoted UI would lose its behaviour. `writeVersion`
(`src/tools/artifacts/index.ts:67-112`) moves to `src/core/artifacts/` and both
the tool and the new endpoint call it. The REST create route also starts
calling it (fixing the same loss for any REST caller).

---

## 4. Security invariants

Each invariant names the mechanism that holds it and the test that proves it
(§11).

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Generated code never runs with the app's origin, cookies or storage | `sandbox` without `allow-same-origin` → opaque origin; `srcdoc` document |
| S2 | Generated code cannot fetch, load remote scripts, styles, fonts or images | Frame CSP (below) as the first element of `<head>`; the generated part goes only into `<body>` and `<style>`/`<script>` we emit after the CSP |
| S3 | Generated code cannot open windows, submit forms, navigate the top window, request permissions | `sandbox` tokens: only `allow-scripts` (scripted) or none (static); no `allow-popups`, `allow-forms`, `allow-top-navigation*`, `allow-modals`, `allow-downloads`; `allow=""` on the iframe (no camera, mic, geolocation, clipboard) |
| S4 | A frame that navigates itself is stopped and reported | Parent counts `load` events; a second load replaces the frame with an error card. The request has already left — hence D9 |
| S5 | The parent acts only on messages from its own frame, of known shape | `event.source === iframe.contentWindow` plus a per-mount random `channel` token injected into the frame; validator in `src/shared/inline-ui/bridge.ts`; unknown types ignored and counted |
| S6 | Nothing is sent or opened without a user action in the parent | D8 |
| S7 | Markup cannot smuggle a policy-changing or network-loading element | Server-side refusal (fail loud, `ToolNotExecutedError`) of `<meta`, `<base`, `<link`, `<iframe`, `<frame`, `<object`, `<embed`, `<portal`, `<script` (scripts belong in `js`), and `javascript:` URLs in `html`; `@import` and `url(` with a non-`data:` scheme in `css` |
| S8 | Only the session owner can read a block's source | `GET /api/inline-ui/:id` and the session listing check `sessions.userId === user.id`; 404 otherwise (no existence oracle) |
| S9 | Sizes are bounded end to end | `html ≤ 60 000`, `css ≤ 20 000`, `js ≤ 40 000`, `title ≤ 120` chars, total ≤ 100 000; ≤ 6 renders per turn; height clamp 40–2 000 px; bridge `prompt.text ≤ 4 000`, ≤ 1 bridge message per 500 ms per frame |
| S10 | Flow guard sees scripted renders as egress | D9, contract in `classifyFlow` |

**Frame CSP (scripted):**

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none';
form-action 'none'; base-uri 'none'
```

**Frame CSP (static):** the same with `script-src 'none'`.

`'unsafe-inline'` is acceptable because inline is the only script there is and
S1–S3 bound what it can reach; there is no `'unsafe-eval'`. A meta CSP in a
`srcdoc` document is enforced; any CSP the parent later sets is inherited and
intersected, never loosened (the SPA sets none today, §1.5).

**Threat walk-through.** A fetched page tells the model to build a UI that
reads the session and posts it out. The UI has no access to the session (S1),
cannot fetch (S2), can navigate itself with data in the URL — if the session
read a secret, the render needed approval first (D9/S10); otherwise the
exposure equals a `websearch__fetch` the same page could have induced, and
the parent stops the frame (S4). It can put text in the composer (S6), which
the user sees before sending, marked with its source.

---

## 5. P1 — Tool, storage, final render

### 5.1 Table `inline_ui_blocks` (migration `0138_inline_ui_blocks.sql`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk default random | |
| `session_id` | uuid not null → `sessions.id` on delete cascade | |
| `user_id` | uuid not null → `users.id` on delete cascade | owner, for S8 |
| `agent_id` | text not null | the root agent of the turn |
| `tool_call_id` | text not null | correlates with `tool_call_complete` |
| `title` | text not null | |
| `height_hint` | integer not null | clamped 40–2 000 |
| `css` / `html` / `js` | text not null default `''` | |
| `scripts` | boolean not null | `js !== ''` |
| `created_at` | timestamptz default now | |

Index `(session_id, created_at)`. Repository
`src/db/repositories/inline-ui-repository.ts` (`create`, `getOwned(id, userId)`,
`listForSession(sessionId, userId)`), plus a `reposFor(context)` entry if the
content repos require it.

`contentStorageOff` sessions (`src/core/agent/audience.ts:15-40`) are excluded
by D4 (they are space/remote sessions), so no in-memory variant is needed.

### 5.2 Tool `src/tools/inline-ui/index.ts`

Pattern: `src/tools/visual/index.ts` (manifest :57-90, `registerTool`
:156-185, singleton :214). Registered in `MODULES` (`src/tools/discovery.ts`).

Manifest permissions: `render` ALLOW, `read` ALLOW. Handlers:

- **`render`** — validates sizes (S9) and markup (S7) in shared code, checks
  D4, counts per-turn renders (keyed by `getRunContext().runId`), stores the
  row, returns:

  ```json
  { "rendered": true, "id": "<uuid>", "title": "…", "mode": "scripted",
    "note": "Shown to the user inline in the web chat. Don't repeat its content as text; one sentence of context is enough. To change it later, call inline-ui__get with this id and render a new version." ,
    "__workStream": { "inlineUi": { "id": "<uuid>", "title": "…", "heightHint": 320, "scripts": true } } }
  ```

  Missing `html` with the other fields present says *"arguments look
  truncated (output token limit?) — make the UI smaller"* rather than the
  generic missing-parameter error, because a cut-off tool call is the likely
  cause (§1.6, 16 384-token default).
- **`get`** — `{ id }` → `{ id, title, css, html, js, createdAt }`, owner-checked.
- **`guide`** — returns `guide.md` (§9.1), imported through the md loader like
  `src/tools/artifacts-toolbox/design-guide.md`.

`excludeFromCodemode: true` (new `ToolExecutionOptions` flag honoured at
`src/tools/codemode.ts:84-92`) on `render`: a script must not loop renders.

Description (≈ 180 tokens) states: when to use (a control, a calculation, a
diagram or chart helps more than text), when not (plain answers, tables that
markdown handles, anything to keep → live artifact), the parameter order and
why (css first renders styled; js runs only after html is complete), the
limits, "no network", "call `inline-ui__guide` before your first render in a
session".

### 5.3 Work-stream plumbing

- `src/shared/work-stream.ts`: add `inlineUi?: { id; title; heightHint;
  scripts }` to `ToolResultWorkStreamMeta`, and the union member
  `{ kind: 'inline_ui'; id: string; title: string; heightHint: number; scripts: boolean }`
  to `ToolResultPreview`.
- `src/core/work-stream/renderers.ts`: a `REGISTRY` entry for
  `inline-ui__render` that reads the meta and emits that preview, title
  "Rendered <title>".
- `stripWorkStreamMeta` already keeps the meta out of the model's copy.

### 5.4 Offering the tool (root-runner)

After the remote-room block (`root-runner.ts:330-343`) and before the
small-model cap (`:347-354`):

```ts
if (inlineUiOffered({ channel: getRunContext()?.channel, space, remoteRoom, small: isSmallModel(...) })) {
  rootTools = [...rootTools, ...inlineUiHandlers()];
  rootAllowedToolIds.add('inline-ui');
}
```

…and add `'inline-ui'` to the core ids passed to the lazy split
(`root-runner.ts:387-439`) when offered. `inlineUiOffered` is a pure function
in `src/core/agent/inline-ui-offer.ts` with unit tests. The REST fallback
`POST /chat` (`src/api/routes/chat.ts:181-188`) must pass the web's channel:
verify what `channel` resolves to for a web REST call and make it `webchat`
when the request comes from the web client (it already stores
`channelType: 'webchat'`, `chat.ts:147`).

The general prompt's tool list (`src/core/agent/roles/general/prompt.md:3-17`)
gets one line: "`inline-ui` — interactive answers in the web chat (offered
only there)". `roles.test.ts:79-99` updated.

### 5.5 REST

In `src/api/routes/inline-ui.ts`, mounted under `/api`:

- `GET /api/inline-ui/:id` → `{ id, sessionId, title, heightHint, scripts, css, html, js, createdAt }`; 404 unless owned; `cache-control: private, max-age=31536000, immutable` (blocks never change).
- `GET /api/sessions/:id/inline-ui` → `[{ id, toolCallId, agentId, title, heightHint, scripts, createdAt }]`, owner-checked, ordered by `created_at`.

### 5.6 Web

New `web/components/chat/inline-ui-block.tsx`:

- Header: title, "interactive" badge when scripted, actions (P4 save, "View
  source" which opens the existing code viewer read-only, "Reload frame").
- Body: the frame, built with `buildInlineUiDocument({ css, html, js, mode,
  channel })` from `src/shared/inline-ui/document.ts`:
  1. `<!doctype html><html data-theme="dark"><head>`
  2. CSP `<meta>` (§4) — first child of head
  3. `<meta name="color-scheme" content="dark">`, charset
  4. base theme CSS: the dark token set of `ARTIFACT_BASE_CSS`
     (`src/core/artifacts/widget-render.ts:186-210`) moved to
     `src/shared/inline-ui/theme.ts` and imported by both (the app is
     dark-only, §1.1; a light OS must not produce a light frame in a dark chat)
  5. `<style>` with the generated css
  6. `</head><body>` generated html `</body>`
  7. scripted only: the bridge runtime (§6) then `<script>` with
     `try { <js> } catch (e) { __octi.error(e) }` and a `window.onerror`
     hook — errors reach the parent and show as a red line under the frame
     (fail loud).
- `iframe` attributes: `sandbox` per D6, `allow=""`, `referrerpolicy="no-referrer"`,
  `loading="lazy"`, `title={title}` (accessible name), `srcdoc`.
- Height: `height_hint` until the frame reports; then the reported height
  (clamped, S9). Static frames cannot report — they use `height_hint` and a
  "expand" toggle.
- Lifecycle: mount when within one viewport of the visible area
  (IntersectionObserver); at most 8 mounted frames per page, least recently
  visible unmounted to a placeholder with the title and a "Show" button. A
  remount restarts the UI (non-goal: persisted frame state).
- States (DESIGN.md "loading, stale, unavailable, interrupted, completed"):
  loading source · rendering · ready · script error (message) · stopped
  (navigated away) · unavailable (404/fetch failed, with Retry).

`message-timeline.tsx`: add the `inline_ui` entry kind (D3);
`web/app/chat/page.tsx`: on `tool_call_complete` with
`result.kind === 'inline_ui'` add the entry; on session load call the listing
endpoint alongside `loadSessionMessages` (`page.tsx:333-357`). The row in the
agent's tool list (`ToolResultPreviewView`, `message-timeline.tsx:369-447`)
renders `inline_ui` as "Rendered <title> ↓" linking to the block.

### 5.7 Flow guard

`classifyFlow` (`src/security/flow-guard.ts:101-169`):
`inline-ui` + action `render` + non-empty `js` → `{ taints: [], egress: 'read' }`;
otherwise `{ taints: [] }`. `docs/FLOW-GUARD.md` table updated.

---

## 6. P2 — Bridge back to the chat

### 6.1 Frame side

A small runtime injected before the generated script defines a frozen
`window.octi`:

```js
octi.prompt(text)    // → Promise<void>; resolves when the parent placed the text
octi.openLink(url)   // → Promise<void>; https only; resolves when the chip is shown
```

Both post `{ v: 1, channel, type, … }` to `parent` with target `'*'` (the
parent's origin is not knowable from an opaque origin, and the payload carries
nothing secret). Replies come back on the same channel token.

### 6.2 Parent side

One `message` listener per mounted block: S5 checks, rate limit (S9), then:

- `prompt` — calls a new imperative handle on `PromptInput`
  (`useImperativeHandle` → `insertDraft(text, source)`), which appends to the
  current draft on a new line (never discards what the user typed), focuses
  the composer and shows a removable chip "from <title>". Send stays a user
  action.
- `openLink` — `https:` only (`URL` parse, reject credentials in the URL);
  shows a chip under the frame with the full URL as a real
  `<a target="_blank" rel="noopener noreferrer">`. Repeats replace the chip.

### 6.3 Provenance

When a draft carrying an inline-UI chip is sent, the message content gets a
final line `(from inline UI "<title>", id <uuid>)`. This tells the model which
UI the user acted on — the only way it learns an id in a later turn (D1) — and
makes the source visible in history. The input guard runs on it like any user
message (`src/core/gateway/message-handler.ts:107`).

---

## 7. P3 — Streaming preview

### 7.1 Server

- `collectStream` (`src/models/stream-collect.ts:41-51`) gets an optional
  `onToolCallDelta(key, name, fragment)` called with the resolved key (the same
  key that becomes the final `ToolCall.id`, `:45-46,68-73`).
- `completeViaTarget` (`agent-worker.ts:2374-2389`) passes it when streaming;
  the worker forwards fragments only for handlers registered with
  `streamInput: true` (new `ToolExecutionOptions` flag; only `render` sets it),
  coalesced to one emit per 150 ms per call, as
  `thought {type:'tool_input_delta', toolCallId, name, delta, iteration}`.
- `event-bridge.ts` maps it to a new gateway event `chat.tool_input_delta`
  (`protocol.ts` union), like `chat.delta` (`:76-90`).
- `agent-manager.ts:374-379` treats it like `text_delta`: forwarded, never
  buffered or persisted. `event-bus.ts:25` excludes it from the replay buffer
  so a long UI cannot evict the 200 events reconnect needs.
- Only the root streams (§1.2), which matches D4. A non-streaming provider or
  the CLI provider simply produces no preview.

### 7.2 Client

- `src/shared/inline-ui/partial-args.ts`: given the accumulated argument text,
  returns `{ title?, css?, cssComplete, html?, htmlComplete }` by scanning for
  top-level string keys and decoding JSON string escapes up to the last
  complete escape. Tolerates any key order; `js` is never extracted for
  preview.
- `src/shared/inline-ui/partial-html.ts`: OIUI's `processPartialHtml`
  (38 lines, MIT, attributed) — strips the trailing incomplete tag, complete
  and incomplete `<style>/<script>/<head>` blocks and a trailing partial entity.
- Preview frame: `sandbox="allow-scripts"`, CSP
  `script-src 'nonce-<random>'` (no `'unsafe-inline'`, so inline handlers in
  the partial html cannot run), containing only our 15-line updater that
  replaces `body.innerHTML` on `{channel, html}` messages from the parent.
  Updates at most every 300 ms. Shown once some html exists; css applied when
  complete (styled first paint, OIUI's ordering).
- When `tool_call_complete` arrives, the preview frame is destroyed and the
  final block (§5.6) mounts from the stored source — the preview is never
  promoted to a live frame, so preview-only content can never run.

---

## 8. P4 — Save as live artifact

- Button "Save as artifact" on a block, disabled with a reason when the user
  has no workspace.
- Dialog: title (prefilled), slug (derived, validated by the existing
  `SLUG_RE`), visibility (default `workspace`).
- `POST /api/inline-ui/:id/promote` → owner check → builds
  `html_template = html + "<script>" + bridgeShim + js + "</script>"`, `css`,
  `type: 'html'` → the shared `writeVersion` (D11), which lifts the script
  into the CSP-pinned bundle. `bridgeShim` defines `octi.prompt` /
  `octi.openLink` as rejected promises with a visible message ("not
  available in a saved artifact"), so a promoted UI fails loud instead of
  throwing on an undefined global.
- Response links to the artifact's app URL. This is a user action under the
  user's own session; it does not go through the agent's ASK.

---

## 9. P5 — Guidance and evaluation

### 9.1 `src/tools/inline-ui/guide.md` (≈ 2 500 tokens)

Adapted from OIUI's `master-playbook`, `advanced-visualization` and
`svg-diagrams` skills (MIT, attribution in the file header), rewritten to this
host:

- When to choose inline UI vs text vs markdown table vs live artifact.
- Parameter order and the streaming consequence; html readable before js runs.
- Host limits: no network, no storage, no forms (use `type="button"`), no
  remote images, `octi.prompt` / `octi.openLink` only on a user click, never on
  load, timers or input changes.
- Theme tokens available (`--octi-*`), responsive layout at phone widths.
- Accessibility: labels, keyboard, visible focus, `role="status"` results,
  reduced motion, text alternatives for SVG/canvas.
- Numeric input validation (`valueAsNumber`, `Number.isFinite`, bounds, no
  division by zero, never show NaN/Infinity).
- Data honesty: label sample vs user vs retrieved vs calculated values; never
  invent live data.
- A compact SVG bar/line chart recipe and an SVG diagram template.
- Untrusted strings go in via `textContent`, never `innerHTML`.

### 9.2 Evaluation

- Fix `toolsUsed` collection in integration mode (`src/eval/runner.ts:239`)
  from the turn's `tool_call_complete` events; unit mode stays `[]` and the
  runner marks `uses_tool` as not evaluable there instead of failing.
- `eval/inline-ui.yaml`: ≥ 12 cases — 6 should use `inline-ui__render`
  (calculator, unit converter with controls, flow diagram, chart of given
  numbers, scenario comparison with sliders, explaining a mechanism with a
  stepper), 6 should not (factual question, code request, short list, a
  plain table, "make me a dashboard I can share" → live artifact, a TUI
  turn).
- A quality rubric in `eval:quality` for rendered UIs: controls wired, no
  console errors, no NaN on edge inputs (checked by loading the stored block
  in Playwright and driving its inputs).

---

## 10. Cross-cutting

**Cost.** A 20 KB UI is roughly 6–8 k output tokens, counted by the existing
budgets (`agent-worker.ts:1117-1124,1380-1387`). The arguments stay in that
turn's history and are re-sent as input on every later iteration of the same
turn; across turns they are not (§1.3). The description and guide steer to
one render per answer, the 6-per-turn cap bounds the worst case. Tool schema
cost: three handlers ≈ 400 tokens, web turns only; measured with
`src/core/agent/prompt-budget.ts` and reported in the PR.

**Privacy.** Blocks are session content, deleted with the session (cascade).
They are not indexed into knowledge, not sent to other users, not shared.

**Accessibility.** The frame has a `title`; the block header is a heading; a
script error and a stop are announced via `role="status"`. The guide makes
accessible markup the default; the evaluation checks it.

**Desktop (Tauri).** `csp: null` (§1.5) does not loosen the frame; the frame's
own meta CSP applies. Verified in the Playwright lane only for the browser; a
manual desktop check is part of P1's done criteria.

**Docs.** New `docs/INLINE-UI.md` (user and contributor view). Updates:
`docs/FLOW-GUARD.md`, `docs/TOOL-ROUTING.md:45`, `docs/AGENT-ARCHITECTURE.md:266`,
`docs/ARTIFACTS.md` (promotion), `docs/OPENCLAW-COMPARISON.md:110,149`,
`docs/DEVELOPMENT.md:80-82` and `AGENT.md:207-208` (tools are registered in
`MODULES`, not auto-discovered), README "New in" when shipped.

**Catalog.** New routes, a new gateway event type and new module edges change
`docs/architecture/generated/CATALOG.md`; `npm run catalog` in each phase that
adds them.

---

## 11. Test plan

| Area | Test | Lane |
|---|---|---|
| Size and markup refusal (S7, S9) | every refused element/scheme; limits at boundary ±1 | unit, `src/shared/inline-ui/*.test.ts` |
| Document builder | CSP meta is first in head; generated html cannot precede it (input containing `</head>`, `<head>`, comments, CDATA); static mode has `script-src 'none'` and no script tags | unit |
| Partial JSON extractor | escapes split across fragments (`\u12`, `\"`), keys in any order, nested quotes, truncated input, non-string values | unit |
| Partial HTML | OIUI's test cases ported | unit |
| Bridge validator | wrong version/channel/type, oversized text, non-https, credentials in URL | unit |
| Offer filter | channel × space × room × remote × small-model matrix | unit |
| Tool | conformance (`src/tools/conformance.test.ts`), render stores and returns meta, `get` owner check, per-turn cap, D4 re-check throws `ToolNotExecutedError`, codemode exclusion | unit + database |
| Flow guard | scripted render after secret read asks; static does not; private+suspicious does not (read egress) | unit |
| REST | owner-only 404s, listing order, cache header | database |
| Streaming | `onToolCallDelta` keys match final ids for id-less providers; only `streamInput` tools forward; not in replay buffer; not persisted | unit |
| Web | block renders from stub `tool_call_complete` + stubbed REST; reload path via listing; script error shown; navigation stop; `fetch` blocked (CSP violation event); popups blocked; foreign-frame postMessage ignored; `prompt` fills composer without sending and appends to existing draft; `openLink` chip; preview never runs `onclick` from partial html; 9th frame unmounts the least visible | Playwright, `tests/web/inline-ui.spec.ts` with `stubGateway` |
| Promotion | promoted artifact has a bundle and working behaviour; shim fails loud | database + Playwright |
| Evals | §9.2 | `npm run eval` |

---

## 12. Open questions

1. **Rooms and spaces.** Showing a member's inline UI to the others means
   running code generated in someone else's turn in your browser. S1–S3 still
   hold; the bridge would put another person's agent's text in your composer.
   Proposal: static-only in shared sessions. Decide before extending D4.
2. **Children.** A child's renders would appear in the root's timeline. Is
   that wanted, or should the child return data and the root render?
3. **Libraries.** If evals show SVG charts are too costly or poor, vendor one
   chart library and serve it from the app origin with a path-scoped
   `script-src` entry. Each library is a supply-chain and size decision.
4. **In-turn token cost.** Replacing the stored arguments with a stub after a
   successful render would stop the re-send cost (§10). Needs a check that
   providers with signed thinking (`providerRaw`, `agent-worker.ts:2346-2354`)
   accept edited tool inputs.
5. **TUI.** Show "interactive UI — open in web" with a deep link?

---

## Appendix A — Taken from OIUI

| OIUI | Here | Change |
|---|---|---|
| `generateSandboxedUi` param order `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions` | `title → height_hint → css → html → js` | one js field; placeholders dropped (the timeline already shows progress) |
| `process-partial-html.ts` | `src/shared/inline-ui/partial-html.ts` | as is, attributed |
| Websandbox (`@jetbrains/websandbox`) + Idiomorph morphing | plain `srcdoc` + 15-line updater | no dependency (`AGENT.md` "Things to avoid"); flicker accepted |
| CSP with 4 CDNs and `'unsafe-eval'` | no network, no eval | D7 |
| `sendPrompt` sends immediately | `octi.prompt` fills the composer | D8 |
| `openLink` opens immediately | chip with a real link | D8 |
| Jev router per turn | model choice guided by description + guide | non-goal |
| Skills (`master-playbook`, `advanced-visualization`, `svg-diagrams`) | `inline-ui__guide` | rewritten for this host |
| Auto-height via `ResizeObserver` + 200 ms polling | same, scripted mode only | clamped |
