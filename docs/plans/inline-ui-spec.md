# Interactive answers (inline UI) — implementation spec

> **Spec, revision 2, 2026-10-14.** Adds small interactive answers — charts,
> calculators, diagrams, comparisons with controls — rendered inside the web
> chat, next to the reply that produced them. The idea and some code come from
> [CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
> (MIT, © Atai Barkai), abbreviated **OIUI**. Its framework (CopilotKit,
> AG-UI, a Python LangGraph agent, the paid "Jev" visualization router) is
> **not** adopted. Four mechanisms are: a sandboxed per-answer frame, a
> validated bridge from the frame back to the chat, a streaming preview, and
> the authoring guidance that makes generated UI usable.
>
> Revision 1 was reviewed against the code by four independent reviewers
> (security; code accuracy; product and model behaviour; tests, operations and
> house rules). They raised 95 findings, 9 of them blockers; every verified
> finding is folded in. Appendix B lists what changed and why. The review also
> turned up pre-existing problems outside this feature; they are listed in
> §13 and are not fixed by this spec.
>
> Every statement about today's code carries a `file:line` reference against
> `main` at d2f9b65.
>
> **User-facing name:** "Interactive answer". **Code name:** `inline-ui`.

## Contents

- §1 What exists today
- §2 Goals and non-goals
- §3 Decisions
- §4 Security invariants and threat model
- §5 P1 — Tool, storage, frame, history, evaluation
- §6 P2 — Suggested follow-ups (prompt bridge)
- §7 P3 — Save as live artifact
- §8 P4 — Streaming preview (conditional)
- §9 Guidance
- §10 Cross-cutting: cost, privacy, accessibility, operations, compatibility, docs
- §11 Test plan
- §12 Delivery: PRs, done criteria
- §13 Pre-existing issues found in review
- §14 Open questions
- Appendix A — What is taken from OIUI
- Appendix B — Revision log

---

## 1. What exists today

### 1.1 Rendering in the chat

| Fact | Evidence |
|---|---|
| Assistant text is markdown via `react-markdown` + `remark-gfm`, no raw HTML | `web/components/ui/markdown-renderer.tsx:68-235` |
| The timeline merges entry kinds `message`, `agent`, `team`, `file_changes` by time; ordering and ids come from a shared module with an exhaustive kind map | `web/components/chat/message-timeline.tsx:827-831,850-931,968-988`; `src/shared/timeline-order.ts:23-35` |
| `MessageTimeline` is also used by rooms | `web/components/rooms/room-view.tsx:481` |
| Tool calls show only in a collapsed per-agent list; result rendering switches on `ToolResultPreview.kind` with no `default` | `message-timeline.tsx:369-447,463-502,504-593` |
| `ToolResultPreview` is a shared union; previews are capped at 2 000 chars; large payloads go "preview + ref, never the whole file through the event bus" | `src/shared/work-stream.ts:44-63,56-59,77` |
| A tool may attach UI-only data under `__workStream`; it is stripped before the model and the persisted row see the result, and survives `executeWithMiddleware` and hooks | `src/shared/work-stream.ts:89-120`, `src/core/tool-executor.ts:1052-1056`, precedent `src/tools/filesystem/index.ts:378` |
| Auto-scroll depends only on message count and tracked-agent count | `message-timeline.tsx:938-942` |
| The web app is dark-only | `web/app/layout.tsx:35` |
| The TUI summarizes result previews and shows nothing for unknown kinds | `src/tui-pi/gateway-adapter.ts:513-545` |

There is no way today to show agent-generated interactive HTML in the chat.
The only interactive HTML surface is a live artifact, which needs a workspace,
an ASK approval (`src/tools/artifacts/index.ts:183-186`), a slug, and opens on
its own page.

### 1.2 Event flow for a turn

| Fact | Evidence |
|---|---|
| Server→client events are a TS union with `unknown` payloads; client→server frames are Zod-validated | `src/core/gateway/protocol.ts:85-199,253,272-404` |
| Text streams as `chat.delta`, root only, when `agent.streaming !== false` and the provider streams | `src/core/agent-worker.ts:2374-2389`, `src/core/gateway/event-bridge.ts:76-90` |
| Providers yield partial tool-call JSON (`toolCallDelta`); `collectStream` assembles it server-side; only text reaches `onDelta`; the final `ToolCall.id` equals the assembly key | `src/models/stream-collect.ts:38-51,74-77` |
| Id-less streams key calls `call_<n>`, so the same key recurs across iterations | `stream-collect.ts:46` |
| The CLI provider does not stream | `src/models/providers/cli-provider.ts:713-714` |
| Tool start reaches clients with `argsSummary ≤ 120`; completion as `tool_call_complete {resultPreview ≤ 200, title, input, result}` | `tool-executor.ts:502-523,140-154,866-878` |
| A denied or blocked call pushes a result with no `tool_call_complete` | `tool-executor.ts:723-745` |
| `permission.request` carries the full arguments | `event-bridge.ts:159` |
| `agent_events` older than one day are deleted at boot | `src/index.ts:176-181` |
| Replay buffer: 200 events per session, 500 sessions, `UNRECORDED_TYPES` excluded | `src/core/gateway/event-bus.ts:25,28,52` |

### 1.3 History: what the model sees on later turns

| Fact | Evidence |
|---|---|
| Personal root sessions save a **native conversation snapshot** — the full message list including tool calls with their arguments and tool results — and replay it on the next turn | write `src/core/agent-worker.ts:797-807`; read `:576-581`; schema comment `src/db/schema/sessions.ts:98` |
| Rooms neither read nor write the snapshot | `agent-worker.ts:576-578` |
| Snapshot cap: 256 000 chars, oldest turns dropped first | `src/core/session-history.ts:177-190` |
| `providerRaw` (signed provider blocks) is dropped on replay when the model changed | `agent-worker.ts:580` |
| When the snapshot is not usable, history is rebuilt from `user`/`assistant` rows; a row's `metadata.promptContext` is prepended for the model only | `src/core/session-history.ts:159-165`, `src/db/schema/messages.ts:41` |
| Tool rows are stored truncated at 50 000 chars or spilled, and do not set `toolName` | `tool-executor.ts:1048-1099`, `src/utils/sanitize.ts:11` |

So render arguments would be re-sent **on every later turn** until the
snapshot cap pushes them out, and three large renders would crowd most of the
real conversation out of the snapshot.

### 1.4 Sending a message from the web

| Fact | Evidence |
|---|---|
| `sendMessage` is a closure in the chat page; it sends `chat.send`, and falls back to `POST /chat` without a `channel` | `web/app/chat/page.tsx:1559-1754,1684` |
| A REST turn without `channel` runs with `RunContext.channel = 'api'` and `attended = false` | `src/api/routes/chat.ts:185`, `src/core/agent/service.ts:276`, `src/security/approval-policy.ts:69-74` |
| Composer draft lives inside `PromptInput` (`useState`), a React 19 function component | `web/components/chat/prompt-input.tsx:38,106`, `web/package.json:32` |
| Sending during a running turn steers it | `src/core/gateway/message-handler.ts:302-313`, `page.tsx:2023-2028` |
| The web never sends `clientVersion` | `protocol.ts:277`, `web/lib/gateway.ts:185` |

### 1.5 Isolation and egress controls already in place

| Fact | Evidence |
|---|---|
| Artifacts render in `<iframe sandbox="allow-scripts">` (opaque origin) | `web/app/artifacts/view/detail-client.tsx:147-151`, `src/api/routes/artifact-pages.ts:184` |
| Artifact embed CSP allows `img-src 'self' data: https:` and `connect-src 'self'` + gateway | `src/core/artifacts/csp.ts:16-35` |
| The SPA server sets no CSP; the API sets a strict CSP and `X-Frame-Options: DENY` except under `/a/`, `/__artifacts__/` | `web/serve.mjs:111-114`, `src/api/server.ts:161-176` |
| Tauri: `"csp": null`; a custom `set_backend_url` command exists | `web/src-tauri/tauri.conf.json:23-25`, `web/src-tauri/src/lib.rs:34-47` |
| Flow guard: session labels `secret`/`private`/`suspicious`; ALLOW→ASK for any egress after `secret`, or write egress after private+suspicious; web fetch is `read` egress | `src/security/flow-guard.ts:101-169,128-129,480-491,524-541` |
| A call whose arguments carry a `{{secret:NAME}}` placeholder is exempt from the flow guard | `tool-executor.ts:710-711`, `flow-guard.ts:494-511` |
| BaseTool replaces `{{secret:NAME}}` in every handler's arguments unless `injectSecrets: false`; a vault entry with empty `allowedTools` serves every tool | `src/tools/base-tool.ts:220-224`, `src/security/vault.ts:663-666` |
| Session cookie is `HttpOnly; SameSite=Strict`; the web also stores a Bearer token in `localStorage` | `src/api/session-cookie.ts:27`, `web/lib/api.ts:146` |
| An admin can act as another user (`principal.actorUserId`) | `src/api/server.ts:295-330` |

### 1.6 Tool plumbing

| Fact | Evidence |
|---|---|
| `AgentContext` has no channel field; `root` marks the root agent; the turn's channel is in `RunContext` and passed into root-runner | `src/core/types.ts:48-118,91-101`, `src/core/run-context.ts:21-45`, `src/core/agent/root-runner.ts:175` |
| Session audience kinds: `personal`, `group`, `space`, `room`, `remote-space` | `src/core/agent/audience.ts:27,67-73` |
| Root tool set: role tools, plan/space/remote filters, small-model cap (`rootIsSmall` at :349), intent shrink, lazy split whose advertised core is `lazyCoreToolIds` | `root-runner.ts:312-342,343-355,387-439,410` |
| `rootAllowedToolIds` only feeds what children may be granted | `root-runner.ts:250-253`, `src/core/swarm/spawner.ts:605,2500-2508` |
| Built-in tools register in `MODULES` (`AGENT.md:207-208` is stale) | `src/tools/discovery.ts:19-50,54-86` |
| Codemode scripts call `ToolHandler`s; flags live on the handler | `src/tools/codemode.ts:84-92`, `src/core/agent-base.ts:73-105` |
| A missing required parameter is rejected before the tool body runs; truncated tool JSON is usually repaired, not dropped | `base-tool.ts:110-117`, `src/models/tool-call-args.ts:24-35` |
| A length-truncated turn is retried only when it has no tool calls | `agent-worker.ts:1626-1645` |
| Root gets no skill discovery; long guidance reaches it through a tool action (precedent `artifacts_toolbox` → `design`) | `root-runner.ts:306-311`, `src/tools/artifacts-toolbox/index.ts:22,180-185` |
| Output cap defaults to 16 384 tokens, thinking included | `agent-worker.ts:2315`, `src/db/schema/models.ts:8`, `src/models/thinking-budget.ts:19-46` |
| Eval integration runs `POST /api/chat` with `channel` defaulting to `api`; `toolsUsed` is always `[]` | `src/eval/runner.ts:75,180-182,239` |
| Web has no unit lane; Playwright stubs the API and gateway; unmatched `/api` calls answer `200 {}`; a console watchdog fails tests on page errors | `vitest.config.ts:48`, `tests/web/fixtures/api-stubs.ts:68-74`, `tests/web/fixtures/auth.ts:76-78,143-153` |
| Migrations are hand-written SQL plus a journal entry; the journal ends at `0137_federation` | `src/db/migrations/meta/_journal.json`, `drizzle.config.ts` |

---

## 2. Goals and non-goals

**Goals**

- G1. In a personal web chat, the root agent can answer with a small
  interactive UI that appears with its reply, works, and survives reload.
- G2. Generated code can do nothing outside its frame except what a user
  action in the parent app allows.
- G3. Server-side refusals reach the model as tool errors so it can fix the
  UI in the same turn; client-side failures are visible in the block and
  reported to the model on the next turn.
- G4. A render costs once, not on every later turn.
- G5. A useful interactive answer can be kept as a live artifact.
- G6. Use is measured before the feature grows (eval gate after P1).

**Non-goals**

- No agent framework, no visualization router model.
- No interactive answers outside personal web chat in this spec: not TUI,
  channels, MCP, voice, rooms, spaces or group threads (§14).
- No data sources, refresh or sharing — that is what live artifacts are for.
- No state that survives re-mounting a frame.
- No network from a frame, no CDN libraries.

---

## 3. Decisions

**D1. One tool group, `inline-ui`, three handlers.**
- `inline-ui__render` — action `render`, ALLOW. Params `{ title, height_hint?, css?, html, js? }`; `html` is checked in the body, not marked `required` in the schema (§5.2 truncation).
- `inline-ui__get` — action `read`, ALLOW, read-only. Returns the source of a block **of the current session only** (no cross-session laundering of flow labels).
- `inline-ui__guide` — action `read`, ALLOW, read-only. Optional recipes (SVG charts, diagrams). Not required before rendering: the essential contract is in the `render` description (§9.1).

All three register with `injectSecrets: false`.

**D2. Source stored in its own table, fetched by reference.**
The tool result carries a `ToolResultPreview` of kind `inline_ui` with the
block id. The browser fetches the source over REST. This keeps the event-bus
rule (§1.1) and makes reload independent of the one-day `agent_events`
retention.

**D3. Timeline entry kind `inline_ui`, anchored to its turn.**
Added to `src/shared/timeline-order.ts` and the web `TimelineEntry`. Sort key:
the server `createdAt` of the block, which lies inside its root agent's run
and therefore before that turn's final reply, for both live and reloaded
entries. The live entry uses the gateway envelope timestamp until the
listing confirms `createdAt`. `MessageTimeline` takes the entries through an
optional prop, so rooms are unaffected.

**D4. Offered only when one predicate holds — and re-checked at execute.**
`inlineUiOffered({ root, audience, renders, small, denied })`:
- the agent is the root (`context.root === true`);
- `sessionAudience(session).kind === 'personal'`;
- the client declared it can render inline UI (D14);
- the model is not small-tier;
- no stored DENY for the `inline-ui` tool exists for the user (the kill switch, §10.4).

`render` evaluates the same predicate and throws `ToolNotExecutedError` when it
fails. Children, rooms, spaces, group threads, remote rooms and old clients
never get the tool, whatever a role row lists. Lite-tier (24B-class) models
are offered the tool; the eval decides whether they keep it (§5.10).

**D5. Added by root-runner, not through a role.**
Interactive answers are a capability of the client, not of a role, and
customized `general` rows never receive new tools or prompt lines
(`src/db/seed-roles.ts:50-75`). root-runner appends the handlers after
`rootIsSmall` is computed (`root-runner.ts:349`) and pushes `'inline-ui'`
into `lazyCoreToolIds` (`:410`). It is **not** added to
`rootAllowedToolIds`, so the root cannot grant it to a child. `'inline-ui'`
joins `PERSONAL_ONLY_TOOL_IDS` (`src/security/space-tools.ts:139`) as defence
in depth.

**D6. One fixed shell document for every frame; generated content is data.**
The parent never concatenates generated text into HTML. It builds a constant
shell — CSP, theme, and one nonced script — and passes `{ css, html, js }` as
a JSON value with `<` written as `<`. The shell:
1. parses `html` into a `<template>` (inert), removes refused elements and
   attributes (§4, S7), then moves the result into `<body>`;
2. sets a `<style>` element's `textContent` to `css`;
3. in scripted mode only, creates a `<script>` with the shell's nonce and
   `textContent = js`, after the body is in place.

This removes every parser-breakout class at once (`</style>` in css,
`</script>` or `<!--` in js, `<plaintext>`/`<textarea>`/`<title>` in html,
meta pragmas). The browser's parser is the sanitizer's parser; no HTML
parser dependency is added. Two modes: **static** (no `js`; no generated code
ever runs) and **scripted**.

**D7. No network from a frame.**
The frame CSP denies every fetch and every remote image, font, stylesheet,
script, frame and worker. OIUI allows four CDNs and `'unsafe-eval'`; that
would let generated code send anything anywhere and pull arbitrary code.
Charts are SVG or canvas written by the model, with recipes in the guide.

**D8. Nothing leaves the parent without a click in the parent.**
- Links: the shell intercepts every link click and asks the parent; the
  parent shows the full URL in a chip with a real link (P1).
- Follow-ups (P2): the frame suggests a message; the parent draws a
  suggestion strip **outside the frame** with the full text and
  `[Send] [Edit in composer] [Dismiss]`. Send is a click in the parent, so it
  is the user's action.

OIUI sends and opens directly. We diverge because generated code is model
output that untrusted content can steer, and a sent message counts as the
user's own words and can steer a running turn (§1.4).

**D9. Flow guard: a scripted render is `read` egress, with no vault exemption.**
Scripted code can still navigate its frame to a URL that carries data (no
CSP directive governs a frame's self-navigation). That is the capability of a
URL fetch, which flow guard classifies as `read` egress
(`flow-guard.ts:128-129`). So:
- a scripted render after a `secret` read is ASK;
- `isVaultAuthenticated` returns false for `toolId === 'inline-ui'`, and
  `render` refuses any `{{secret:` placeholder (fail loud);
- a static render has no egress — the shell removes or intercepts every
  navigation path (S4, S7).

Unlike a server-side fetch, a frame's navigation leaves from the user's
browser: it reveals the user's IP and can reach their LAN with a GET. The
session cookie stays home (`SameSite=Strict`).

**D10. Scripted blocks need a click to run when the risk is higher.**
A scripted block mounts as **click-to-run** (parent-drawn "Run interactive
answer" button; html and css are shown static until then) when any holds:
- the block was loaded from history (a block that freezes the tab would
  otherwise freeze the session on every reload, §4 threat T6);
- the block was rendered in a session labelled `suspicious`, `private` or
  `secret` (stored on the block as `tainted`; phishing and steering, T5);
- the viewer is impersonating another user;
- the previous mount of this block did not report a heartbeat (§5.6).

Otherwise — a live render in a clean personal session — it runs at once.

**D11. Shared, pure helpers in `src/shared/inline-ui/`.**
Shell builder, CSP strings, shell script source, refusal lint, partial-JSON
extractor, bridge message validator, limits and theme tokens. No runtime
imports; browser APIs only through `globalThis` (the web compiles shared
files with `types: ["vite/client"]`, no Node types). Testable by root Vitest;
importable by the web (house rule 7).

**D12. Render arguments become a stub in history after execution.**
After `render` executes, the arguments of that call in the agent's message
list are replaced with `{ "id": "<uuid>", "title": "…", "stored": true }`.
This applies in the turn and therefore in the saved snapshot (§1.3). It gives
G4 and keeps the id where the model will see it on later turns. When the
snapshot is not usable, the final assistant row's `metadata.promptContext`
carries `[Interactive answers shown in this turn: "<title>" id=<uuid>; …]`
(model-only, §1.3). Signed provider blocks: if a provider rejects an edited
tool input next to signed thinking, that message's `providerRaw` is dropped
— a state replay already supports (`agent-worker.ts:580`). P1's done
criteria include a live check against Anthropic and one OpenAI-compatible
provider.

**D13. A tool call, not a fenced block in the reply.**
The alternative — the model writes the UI as a fenced block in its text,
which would stream for free over `chat.delta` — was considered and rejected
for this spec:
- A tool call returns validation errors to the model in the same turn (G3).
  A fenced block can only fail in front of the user.
- Per-call permissions, stored DENY, flow guard and approval apply to tool
  calls, not to text.
- `chat.delta` reaches every client of the session, including the TUI, and
  final text reaches channels; raw markup would need stripping on every path.

It stays an open question (§14-Q1) because it would make streaming work on
providers that deliver tool arguments in one chunk.

**D14. Clients declare what they can render.**
`chat.send` (Zod frame) and REST `POST /chat` gain an optional
`renders: ['inline_ui']`. The web sends it; the REST fallback also sends
`channel: 'webchat'`, which additionally fixes `attended` for fallback turns
(§1.4). The value is copied into `RunContext.renders` and passed to
root-runner. A client that does not declare it — old tabs, TUI, channels,
MCP, eval runs unless they opt in — is never offered the tool. This puts the
difference between clients in the backend contract, as DESIGN.md asks.

**D15. Promotion uses the tool's version writer, moved to core.**
`writeVersion` (`src/tools/artifacts/index.ts:67-112`) moves to
`src/core/artifacts/` in a refactor PR before P3. The new promote endpoint
and the tool both call it. Whether the REST create route should also lift
scripts into a bundle is a separate decision (§13-5).

---

## 4. Security invariants and threat model

### 4.1 Invariants

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Generated code never runs with the app's origin, cookies or storage | `sandbox` without `allow-same-origin` → opaque origin; `srcdoc` |
| S2 | No fetch, and no remote script, style, font, image, media, frame or worker | Frame CSP (§4.2), first element of `<head>` in a constant shell (D6) |
| S3 | No popups, forms, top navigation, modals, downloads, device features | `sandbox="allow-scripts"` and nothing else; `allow` attribute lists every policy-controlled feature with `'none'` (§4.2); shell removes `autofocus` |
| S4 | No navigation in static mode; in scripted mode a navigation stops the frame | Shell strips `meta`/`base`/`form`, rewrites links to bridge messages, `x-dns-prefetch-control: off`; parent unmounts on `pagehide` from the shell, on a second `load`, or on any message after either |
| S5 | The parent acts only on its own frame's messages, of known shape and rate | `event.source === iframe.contentWindow`; per-mount `channel` id (a correlation id, not a secret: frame code can read it); validator in `src/shared/inline-ui/bridge.ts`; limits in S9; a frame sending more than 20 invalid or over-limit messages in a second is unmounted |
| S6 | Nothing is sent or opened without a click in the parent | D8; `prompt` and `link` messages are dropped unless `navigator.userActivation.isActive` in the parent when they arrive; suggestion text has C0/C1 controls, bidi controls (U+202A–202E, U+2066–2069) and zero-width characters (U+200B–200F) removed; the parent never moves focus |
| S7 | Refused markup is reported to the model (lint, not boundary) and removed by the shell (boundary with CSP) | §4.3 |
| S8 | Only the session owner reads a block, through the scoped session repository | `scopedRepos(principal).sessions.findById` then block by `(id, session_id)`; 404 otherwise; `cache-control: no-store` |
| S9 | Sizes and rates are bounded | §4.4 |
| S10 | Flow guard sees a scripted render as egress, with no vault exemption | D9 |
| S11 | Vault secrets never enter a block | `injectSecrets: false`; `{{secret:` refused |
| S12 | The frame cannot impersonate the app | Parent-drawn border and header; footer "Made by the agent · don't enter passwords or keys here"; height ≤ min(2 000 px, 80 vh); a parent-owned spacer between the last block and the composer/permission banner; `input[type=password]` and `autocomplete*=password` refused and stripped |
| S13 | Desktop IPC is unreachable from a frame | P1 done criterion: from a scripted frame, `__TAURI_INTERNALS__`, `window.ipc`, `webkit.messageHandlers.ipc` and `chrome.webview` are absent or rejected on WebKitGTK, WKWebView and WebView2; custom commands restricted to the main window in `capabilities/default.json` |

### 4.2 Frame policy

CSP, both modes (`N` = per-mount random nonce from `crypto.getRandomValues`):

```
default-src 'none'; script-src 'nonce-N'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
manifest-src 'none'; form-action 'none'; base-uri 'none'
```

In static mode the shell runs and generated `js` is never attached. In
scripted mode the shell attaches `js` with the nonce. Inline event-handler
attributes cannot run in either mode (no `'unsafe-inline'`,
no `'unsafe-hashes'`); the guide tells the model to use `addEventListener`.
`javascript:` URLs are blocked for the same reason. There is no
`'unsafe-eval'`.

Head order: CSP · `<meta name="referrer" content="no-referrer">` ·
`<meta http-equiv="x-dns-prefetch-control" content="off">` · charset ·
`color-scheme: dark` · theme `<style>` · shell `<script nonce>`.

`iframe` attributes: `sandbox="allow-scripts"`, `srcdoc`, `title`,
`referrerpolicy="no-referrer"`, `loading="lazy"`,
`allow="accelerometer 'none'; ambient-light-sensor 'none'; attribution-reporting 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; fullscreen 'none'; geolocation 'none'; gyroscope 'none'; hid 'none'; magnetometer 'none'; microphone 'none'; midi 'none'; payment 'none'; picture-in-picture 'none'; publickey-credentials-get 'none'; screen-wake-lock 'none'; serial 'none'; sync-xhr 'none'; usb 'none'; web-share 'none'; xr-spatial-tracking 'none'"`.

A `srcdoc` document takes a snapshot of the parent's policy container when
created. The SPA sets no CSP today (§1.5). A future SPA or desktop CSP without
nonce support in `script-src` would break frames; a test pins this (§11).

### 4.3 Refusals (S7)

The server lint gives the model a specific error. The shell enforces the
same rules on the parsed DOM, so a lint bypass (`\75rl(`, `&#106;avascript:`)
gains nothing: CSP and the shell are the boundary.

| Field | Refused (case-insensitive) | Shell action |
|---|---|---|
| `html` elements | `script`, `meta`, `link`, `base`, `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `form`, `noscript` | removed |
| `html` attributes | `on*`, `ping`, `attributionsrc`, `autofocus`, `formaction`, `action` | removed |
| `html` URLs | `src`/`srcset`/`poster`/`background`/`xlink:href` not `data:`/`blob:`/`#`; `href` not `https:` or `#` | removed (links: intercepted, never navigate) |
| `html` inputs | `type=password`, `autocomplete` containing `password` | element replaced by a notice |
| `css` | `@import`; `url(` / `image-set(` with a value other than `#…` or `data:` | left to CSP (blocked) |
| `js` | syntax errors (checked with esbuild `transform`, already a dependency of `src/core/artifacts/bundler.ts`) | n/a |
| any field | `{{secret:` | n/a |

### 4.4 Limits (S9)

Constants in `src/shared/inline-ui/limits.ts`, not admin config, because the
client enforces them too.

| What | Limit | Reason |
|---|---|---|
| `title` | ≤ 80 chars, single line, no controls | header, provenance |
| `html` / `css` / `js` | ≤ 24 000 / 6 000 / 12 000 chars | — |
| total | ≤ 36 000 chars | ≈ 10 k output tokens; a JSON-encoded `get` stays under the 50 000-char tool-result cap (§1.3) |
| renders per turn | 4 | counted in the table by `(session_id, run_id)` |
| blocks per session | 200 | storage |
| height | 40 px … min(2 000 px, 80 vh) | S12 |
| `height` messages | coalesced to one per animation frame | — |
| `error` messages | 20 per mount | — |
| `prompt` / `link` messages | 1 per 500 ms per frame; text ≤ 4 000 chars | — |
| invalid messages | > 20 per second → unmount | S5 |

### 4.5 Threat model

| # | Threat | Outcome |
|---|---|---|
| T1 | Injected content asks for a UI that sends session data out | No session access (S1); no fetch (S2); self-navigation only in scripted mode, which needs approval after a secret read (D9) and a click-to-run in a tainted session (D10) |
| T2 | Vault secret placed in markup | Refused (S11) |
| T3 | Parser breakout from css/js/html into the shell | Impossible: content is data (D6) |
| T4 | Exfiltration without script (meta refresh, prefetch, CSS) | Shell strips pragmas and links; DNS prefetch off; CSS URLs blocked by CSP |
| T5 | Fake login or fake app UI (phishing) | S12; click-to-run in tainted sessions (D10) |
| T6 | Tab freeze or memory bomb (opaque-origin frames may share the parent's process in Firefox, WebKit and WebView2) | History blocks click-to-run; heartbeat marker (§5.6); unmount on flood |
| T7 | Steering the user's next message | Suggestion strip outside the frame, full text shown, explicit Send (D8, S6) |
| T8 | Cross-session or cross-user read | S8; `get` restricted to the current session (D1) |
| T9 | Admin impersonation runs the target's code | Click-to-run and bridge disabled while impersonating (D10) |
| T10 | Desktop IPC | S13 |
| T11 | Streaming preview leaks before validation and approval | §8: shell-based static preview; forwarded only for offered handlers and only while the session is not `secret` |
| T12 | Promotion opens network access to every viewer | §7: absolute URLs refused, visibility limited, `secret` sessions refused |

---

## 5. P1 — Tool, storage, frame, history, evaluation

### 5.1 Table `inline_ui_blocks`

Schema `src/db/schema/inline-ui-blocks.ts`, exported from
`src/db/schema/index.ts`. Hand-written migration
`src/db/migrations/0138_inline_ui_blocks.sql` plus a journal entry, as `0137`
was. Additive; no down-migration (repository convention).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk default random | |
| `session_id` | uuid not null → `sessions.id` on delete cascade | sessions are hard-deleted (`src/db/repositories/session-repository.ts:319`) |
| `run_id` | text not null | per-turn cap, log correlation |
| `agent_id` | text not null | |
| `tool_call_id` | text not null | |
| `title` | text not null | |
| `height_hint` | integer not null | |
| `css` / `html` / `js` | text not null default `''` | |
| `scripts` | boolean not null | `js.trim() !== ''`, set by the server |
| `tainted` | boolean not null | session label had `suspicious`, `private` or `secret` at render time |
| `created_at` | timestamptz default now | |

Indexes `(session_id, created_at)` and `(session_id, run_id)`. Repository
`src/db/repositories/inline-ui-repository.ts`: `create`,
`countForRun(sessionId, runId)`, `countForSession(sessionId)`,
`getInSession(id, sessionId)`, `listForSession(sessionId)`.

### 5.2 Tool `src/tools/inline-ui/index.ts`

Pattern: `src/tools/visual/index.ts`. Registered in `MODULES`. Manifest
permissions: `render` ALLOW, `read` ALLOW.

| Handler | Options |
|---|---|
| `render` | `{ permissionAction: 'render', injectSecrets: false, excludeFromCodemode: true, streamInput: true }` |
| `get` | `{ permissionAction: 'read', readOnly: true, injectSecrets: false }` |
| `guide` | `{ permissionAction: 'read', readOnly: true, injectSecrets: false }` |

`excludeFromCodemode` and `streamInput` are new optional fields on
`ToolHandler` (`src/core/agent-base.ts:73-105`), copied from options in
`registerTool` (`base-tool.ts:85-101`); `scriptableTools` checks
`h.excludeFromCodemode !== true` (`codemode.ts:84-92`).

**`render` steps**
1. `inlineUiOffered(...)` (D4) or `ToolNotExecutedError`.
2. Lint (§4.3) and limits (§4.4); each failure is a `ToolNotExecutedError`
   naming the rule, the field and the limit.
3. **Truncation.** Missing or empty `html` → "html is missing — the call was
   probably cut off by the output limit; make the UI smaller (target under
   12 KB)". `html` ending inside a tag or `js` failing to parse near its end
   gets the same advice.
4. Per-turn and per-session caps.
5. Insert the row (`tainted` from `getFlowLabel(sessionId)`).
6. Log `info` with `runId`, `blockId`, sizes, mode, and refusal codes on
   failure.
7. Return:

```json
{ "rendered": true, "id": "<uuid>", "title": "…", "mode": "scripted",
  "note": "Shown inline in the user's web chat. Don't repeat it as text; add at most one sentence. To change it later, call inline-ui__get with this id and render a new version.",
  "__workStream": { "inlineUi": { "id": "<uuid>", "title": "…", "heightHint": 320, "scripts": true, "tainted": false } } }
```

**`get`** — `{ id }` → `{ id, title, css, html, js, createdAt }` when the id
belongs to the current session; otherwise `ToolNotExecutedError("not found
in this session")`.

**`guide`** — returns `src/tools/inline-ui/guide.md` (§9.2), imported through
the md loader like `src/tools/artifacts-toolbox/design-guide.md`.

**Description** (≈ 600 tokens, §9.1) carries the whole contract.

### 5.3 Flow guard

`classifyFlow` (`src/security/flow-guard.ts:101-169`): `inline-ui` with action
`render` and non-empty `js` → `{ taints: [], egress: 'read' }`; otherwise
`{ taints: [] }`. `isVaultAuthenticated` (`:494-511`) returns false for
`toolId === 'inline-ui'`. `permission.request` for `render` carries a summary
(`title`, sizes, mode), not the full arguments (`event-bridge.ts:159`).
`docs/FLOW-GUARD.md` updated.

### 5.4 History stub (D12)

In the worker, after the tool results of an iteration are appended: for each
successful `inline-ui__render` call, replace `toolCalls[i].arguments` in that
iteration's assistant message with the stub. At turn end, if any blocks were
rendered, set `metadata.promptContext` on the final assistant row
(`service.ts:1099`) to the summary line. Failed renders keep their arguments,
so the model can correct them in the same turn.

### 5.5 Work-stream plumbing

- `src/shared/work-stream.ts`: `inlineUi?: { id; title; heightHint; scripts; tainted }` on `ToolResultWorkStreamMeta`; union member
  `{ kind: 'inline_ui'; id; title; heightHint; scripts; tainted }` on `ToolResultPreview`.
- `src/core/work-stream/renderers.ts`: a `REGISTRY` entry for
  `inline-ui__render`; title "Showed <title>".
- Web `ToolResultPreviewView` gets the case and a `default: return assertNever(result)`.
- TUI `summarizeResultPreview` gets
  `case 'inline_ui': return \`interactive answer: ${title} (open in the web app)\``.

### 5.6 Web

**`web/components/chat/inline-ui-block.tsx`**
- Parent-drawn chrome (S12): border; header with title (heading), an
  "Interactive answer" label, a "Resets when reloaded" note on scripted
  blocks, and actions (P3 save, "View source" in the read-only code viewer,
  "Restart"); a "Skip interactive answer" link before the frame; the footer
  from S12.
- Frame built by `buildInlineUiShell({ css, html, js, mode, theme })` from
  `src/shared/inline-ui/shell.ts`; theme passed in (dark today), not
  hard-coded.
- Shell runtime (nonced) does: sanitize-and-insert (D6); attach `js` in
  scripted mode; `ResizeObserver` height reports; `window.onerror` and
  `unhandledrejection` → `error`; a heartbeat `ready` after insertion; a
  capture-phase click listener turning `a`/`area` clicks into `link`
  messages; `pagehide` → `stopped`; a "blank" check (no text, SVG or canvas
  after insertion → `error: 'blank'`).
- Bridge messages, P1: `ready`, `height`, `error`, `link`, `stopped`.
  P2 adds `prompt`. One global for generated code: `octi` (frozen);
  P1 exposes `octi.openLink(url)`, P2 adds `octi.prompt(text)`.
- Lifecycle: mount within one viewport of view (IntersectionObserver); at
  most 6 mounted frames (3 below 640 px width); least recently visible
  unmounted to a placeholder with title and "Show".
- Freeze guard (T6): before mounting a scripted frame, write
  `sessionStorage['octi-ui-mounting:<id>']`; clear it on `ready`. A marker
  present at page load means that block's last mount never reported: show
  it as "Stopped — it froze the page" with Run. Storage access wrapped in
  try/catch with a logged warning (fail loud, no swallow).
- Click-to-run per D10.
- States (DESIGN.md): loading source · ready · waiting for click · script
  error (message) · stopped (navigated or flooded) · blank · unavailable (404
  or fetch failed, with Retry) · source deleted (session cleared).
- Links: a `link` message with a parent activation shows a chip under the
  frame with the full URL as `<a target="_blank" rel="noopener noreferrer">`.
  Non-`https:` URLs and URLs with credentials are dropped.

**`web/app/chat/page.tsx`**
- On `tool_call_complete` with `result.kind === 'inline_ui'` from the root
  agent of the open session: add an `inline_ui` entry (envelope timestamp).
- `loadSessionMessages` also calls `GET /sessions/:id/inline-ui`; a 404 from
  an older server means "no blocks" with one `console.warn`; a malformed
  body shows "unavailable".
- Auto-scroll also triggers on new `inline_ui` entries and frame growth, only
  when the user is within 120 px of the bottom.
- `chat.send` and the REST fallback send `renders: ['inline_ui']`; the
  fallback also sends `channel: 'webchat'` (D14).

**Errors reach the model (G3).** Client-side outcomes `error`, `stopped` and
`blank` are kept per block. When the user next sends a message in that
session, the frame `chat.send` carries
`inlineUiReports: [{ id, outcome, message ≤ 200 }]` (Zod-validated, ids must
belong to the session). The server writes them to the user row's
`metadata.promptContext` as
`[Interactive answer "<title>" id=<uuid> reported: <outcome> — <message>]`.

### 5.7 REST

`src/api/routes/inline-ui.ts`:
- `GET /api/inline-ui/:id` → block with source; scoped session check (S8);
  `cache-control: no-store`.
- `GET /api/sessions/:id/inline-ui` (param name `:id`, matching
  `src/api/routes/sessions.ts:40`) → `{ blocks: [{ id, toolCallId, agentId, title, heightHint, scripts, tainted, createdAt }] }`; 404 if not the caller's.
- Isolation test `src/api/routes/inline-ui.isolation.test.ts`: two users, a
  deactivated user, impersonation.

### 5.8 Offering (root-runner)

```ts
// after rootIsSmall (root-runner.ts:349)
if (inlineUiOffered({ root: true, audience, renders: runContext.renders, small: rootIsSmall, denied })) {
  rootTools = [...rootTools, ...inlineUiHandlers()];
  lazyCoreToolIds.push('inline-ui');            // root-runner.ts:410
  // + INLINE_UI_PROMPT_LINE in the turn's volatile prompt part, only when offered
}
```

`inlineUiOffered` lives in `src/core/agent/inline-ui-offer.ts`. The prompt
line goes into the turn's volatile part only when offered; `prompt.md` and
`prompt.lite.md` do not change. A mirror sentence goes into the
`create_live_artifact` description: "for a one-off visual in this chat, use
inline-ui if available".

### 5.9 Evaluation harness (needed by P1: AGENT.md requires routing and tool-selection changes to pass `npm run eval`)

- `tool-executor.ts:1093-1099` sets `toolName` on tool rows (it does not today).
- `POST /api/chat` accepts opt-in `toolsUsed: true` (same pattern as
  `routedRoles`, `src/api/routes/chat.ts:169-176`) and returns the tool names
  of rows created in this turn.
- The integration runner sends `toolsUsed: true`; `uses_tool` and
  `not_uses_tool` are "not evaluable" in unit mode instead of passing or
  failing trivially. Suites that used `not_uses_tool` are re-baselined and
  the change is reported in the PR.
- YAML `context` gains `renders: [inline_ui]`; `inline-ui.yaml` sets it with
  `channel: webchat`.

### 5.10 Evaluation suite and gate

`eval/inline-ui.yaml`, ≥ 30 cases, each run 3× on at least two models (one
local). Mix: clear positives (calculator, converter, diagram of a mechanism,
chart of given numbers, scenario comparison); clear negatives (factual
question, code, short list, single value, plain table); ambiguous cases
(inline vs artifact, "chart my open tasks" with real tool data). Reported as
use rates per class, not pass/fail.

Mechanical quality checks on every rendered block, run in Playwright from
the stored rows: renders without `error`/`blank`; no CSP violations; each
`input[type=number|range]` set to min, max and empty shows no `NaN` or
`Infinity`. Plus human review of 10 blocks per model.

**Gate before P2:** positives ≥ 70% use, negatives ≤ 10% use, mechanical
checks ≥ 80% clean, on the hosted model. Below the gate, P1 stays and the
description and guide are revised; P2–P4 wait. The gate result and the
lite-tier result are recorded in the P1 PR.

---

## 6. P2 — Suggested follow-ups

- Frame: `octi.prompt(text)` → `prompt` message.
- Parent: S5/S6 checks (activation, rate, cleaning); then a suggestion strip
  **below the frame, drawn by the parent**: "Suggested by <title>:" + full
  text + `[Send] [Edit in composer] [Dismiss]`. One strip per block; a new
  suggestion replaces the old one.
  - **Send** calls `sendMessage` with `provenance: { inlineUiId }`. During a
    running turn the button reads "Send as guidance" (it will steer, §1.4).
  - **Edit in composer** calls a new `PromptInput` handle
    `insertDraft(text, source)` (ref + `useImperativeHandle`); it appends on
    a new line, never replaces, and shows a removable "from <title>" chip.
    Focus moves only because the user clicked.
- Provenance (§6): `chat.send` gains `provenance?: { inlineUiId }`. The
  server checks that the id belongs to the session and writes
  `[Sent from interactive answer "<sanitized title>" id=<uuid>]` to the user
  row's `metadata.promptContext`. The visible bubble shows a "from <title>"
  chip, rendered from metadata. The message text is not changed.
- Disabled while impersonating.

---

## 7. P3 — Save as live artifact

Prerequisite PR (refactor, no behaviour change): move `writeVersion` to
`src/core/artifacts/version-writer.ts`; move `SLUG_RE` (duplicated at
`src/api/routes/artifacts.ts:22` and `src/tools/artifacts/index.ts:24`) to
`src/shared/artifacts.ts`; split `ARTIFACT_BASE_CSS`
(`src/core/artifacts/widget-render.ts:189`) into light and dark token
constants in `src/shared/inline-ui/theme.ts`, rebuilt into the same media
query for artifacts.

Feature:
- "Save as artifact" on a block; disabled with a reason when there is no
  workspace or the block is `tainted` with a `secret` session label.
- Dialog: title, slug (`SLUG_RE`), visibility `private` (default) or
  `workspace` only. It says: "a static copy — no data refresh; the
  interactive parts run in the artifact page". If the source uses
  `octi.prompt`/`octi.openLink`, it warns that those buttons will show "not
  available here".
- `POST /api/inline-ui/:id/promote` → scoped session check →
  workspace from `artifactStore(principal)` (`src/api/routes/artifacts.ts:70`) →
  refuse absolute URLs in html/css (the artifact CSP allows `img-src https:`,
  §1.5) and `</script` in js → template `html + "<script>" + octiShim + js + "</script>"`
  → `writeVersion`. `octiShim` defines `octi.prompt`/`octi.openLink` as
  rejected promises with a visible message.
- A user action under the user's own session; it does not go through the
  agent's ASK.

---

## 8. P4 — Streaming preview (conditional)

**Precondition.** Measure per provider whether tool arguments arrive in more
than one chunk (hosted Anthropic, OpenAI, OpenRouter; Ollama; Gemini; the
LiteLLM proxy). Build P4 only if the providers in use by the eval models
stream them. Otherwise P4 is replaced by §14-Q1.

**Server**
- `collectStream` gains `onToolCallDelta(key, name, fragment)` with the
  resolved key (`stream-collect.ts:41-51`).
- The worker forwards fragments only when `name` is in this turn's offered
  root handlers with `streamInput`, and only while the session label has no
  `secret`; coalesced to one emit per 150 ms per call, as
  `thought { type: 'tool_input_delta', toolCallId, name, delta, iteration }`.
- `event-bridge.ts` maps it to gateway event `chat.tool_input_delta` (literal
  `type:` at the publish site for the catalog); `agent-manager.ts:377`
  treats it like `text_delta` (not persisted); `event-bus.ts:25` adds it to
  `UNRECORDED_TYPES`. Federation drops it by default (allowlist,
  `src/core/federation/virtual-connection.ts:69`).

**Client**
- `src/shared/inline-ui/partial-args.ts` extracts `title`, `css`, `html` from
  the accumulated argument text, tolerating any key order and fragments that
  split an escape. `js` is never extracted.
- Preview = the P1 shell in **static mode**, fed by `{channel, css, html}`
  messages at most every 300 ms. The shell sanitizes each update exactly as
  in D6, so the preview is network-free and cannot navigate.
- Previews are keyed `(agentId, iteration, toolCallId)` and destroyed on
  `tool_call_complete` of any status, on that call's `observation`, on the
  agent's terminal status, or after 30 s without deltas. The final block
  always mounts from the stored source; preview content is never promoted.
- Old clients ignore the unknown event (`page.tsx:1039` default branch).

---

## 9. Guidance

### 9.1 `render` description (≈ 600 tokens)

1. When: a control, a calculation, a stepper, or a chart of given or
   retrieved numbers helps more than text. At most one per answer unless
   asked.
2. When not: prose, code, lists, a single value, a table (use markdown),
   anything to keep, share or refresh (use artifacts).
3. Contract: `title`, then `css`, `html`, `js` (best-effort order: styled
   first paint); target under 12 KB; limits; no network, storage, forms,
   remote images or inline `on*` handlers (use `addEventListener` in `js`);
   links are shown to the user as chips.
4. Quality: labels on inputs, keyboard access, `role="status"` for results,
   validate numbers (`valueAsNumber`, `Number.isFinite`, bounds, no division
   by zero, never show NaN), label sample vs user vs retrieved vs calculated
   values, render untrusted strings with `textContent`.
5. Theme tokens `--octi-*`; width 100%, `min-width: 0`, wrap at phone width.
6. `octi.openLink(url)` (and from P2 `octi.prompt(text)`) only from a click
   handler.
7. `inline-ui__guide` has SVG chart and diagram recipes.

### 9.2 `src/tools/inline-ui/guide.md` (≈ 2 000 tokens, v1 in P1)

Adapted from OIUI's `master-playbook`, `advanced-visualization` and
`svg-diagrams` skills (MIT, attribution in the header). It covers:

- an SVG bar and line chart recipe with axes, labels and a text alternative;
- an SVG diagram template (boxes, arrows, `marker`, `viewBox`);
- canvas sizing with `ResizeObserver`;
- reduced motion;
- an accessible stepper and slider pattern;
- numeric validation examples.

The eval compares "guide available" against "description only" (§5.10).

---

## 10. Cross-cutting

### 10.1 Cost

- **Rendering.** A 12 KB UI is about 3.5 k output tokens; 36 KB is about 10 k. Both are counted by the existing budgets (`agent-worker.ts:1117-1124,1380-1387`).
- **Later iterations.** Arguments are re-sent on later iterations of the same turn, at most 4 × 36 KB. On later turns only the stub is re-sent (D12).
- **Guide.** `inline-ui__guide` costs one extra iteration when used.
- **Schema.** Three handlers cost ≈ 900 tokens of schema, on offered turns only. Measured with `src/core/agent/prompt-budget.ts` and reported in the P1 PR.

### 10.2 Privacy and storage

- Blocks are session content. They are deleted with the session (cascade) and by idle-session cleanup.
- They are not indexed, not shared, and not sent to other users.
- Backups need nothing new (`scripts/backup.ts` runs `pg_dump`).
- Growth is bounded at 200 blocks × 36 KB per session.

### 10.3 Accessibility

- Every frame has a `title`, and the header is a heading.
- A skip link sits before each frame.
- Script errors, stops and suggestions are announced with `role="status"`.
- The parent never moves focus without a click.
- Accessible markup is the default in the description, and the eval checks it.

### 10.4 Operations

- **Kill switch.** A stored DENY on tool `inline-ui` for a user or globally makes `inlineUiOffered` false. Nothing is advertised and nothing fails at call time. This uses the existing permission system and adds no flag (house rule 9).
- **Metrics.** Renders and refusals appear in `octipus_tool_executions_total{tool,status}` (`docs/OBSERVABILITY.md:53`).
- **Logs.** Each render writes one info line (§5.2).
- **Client-side outcomes.** These are shown in the block and reported to the model on the next message (§5.6). They are not collected as telemetry.

### 10.5 Compatibility

| Client / server | Behaviour |
|---|---|
| Old web, new server | Doesn't declare `renders` → never offered |
| New web, old server | Listing 404 → no blocks; `renders` and `inlineUiReports` are dropped by the old `ChatSendSchema`, a non-strict `z.object` that strips unknown keys (`src/core/gateway/protocol.ts:292`) |
| TUI | Not offered; shows "open in the web app" for blocks rendered from the web in the same session |
| Channels, MCP, eval | Not offered unless declared |
| Federation peers | No events forwarded |

### 10.6 Docs

- New `docs/INLINE-UI.md`, covering users, contributors and operations, including the kill switch.
- Updates:
  - `docs/FLOW-GUARD.md`
  - `docs/TOOL-ROUTING.md:45`
  - `docs/AGENT-ARCHITECTURE.md:266`
  - `docs/ARTIFACTS.md` (promotion)
  - `docs/OBSERVABILITY.md`
  - `docs/OPENCLAW-COMPARISON.md:110,149`
  - `docs/DEVELOPMENT.md:80-82` and `AGENT.md:207-208` (tools register in `MODULES`)
  - `CHANGELOG.md`
- README "New in" when shipped.

### 10.7 Catalog

New routes, the P4 gateway event and new module edges change
`docs/architecture/generated/CATALOG.md`. Run `npm run catalog` in each PR
that adds them; CI checks it (`.github/workflows/ci.yml:64`).

---

## 11. Test plan

| Area | Test | Lane |
|---|---|---|
| Lint and limits | every refused element, attribute, URL scheme, password input, `{{secret:`; limits at boundary ±1; esbuild syntax check | unit `src/shared/inline-ui/*.test.ts`, `src/tools/inline-ui/*.test.ts` |
| Shell builder | CSP is the first element of head; payload JSON escapes `<`; the shell source is constant (hash pinned) | unit (string) + Playwright (parsed: `document.head.firstElementChild` is the CSP meta, exactly one `meta[http-equiv=Content-Security-Policy]`) |
| Breakout payloads | `</style>` + `<link rel=dns-prefetch>` in css; `</script>`, `<!--<script>` in js; `<plaintext>`, `<textarea>`, `<title>`, unclosed `<!--` in html; meta refresh in html | Playwright: shell intact, no request, heartbeat received |
| Partial JSON | escapes split across fragments, any key order, truncated input, non-string values | unit |
| Bridge validator | wrong version/channel/type, oversize, non-https, credentials, bidi/zero-width stripping | unit |
| Offer predicate | root × audience kind × renders × small × denied | unit |
| Tool | conformance; render stores and returns meta; `get` only in the current session; per-turn and per-session caps; D4 re-check from a child and from codemode; `injectSecrets` off; truncation messages | unit + database |
| History stub | arguments replaced after success, kept after failure; snapshot size bounded after N renders; `promptContext` summary when no snapshot | unit + database |
| Flow guard | scripted after secret → ASK; static → no egress; vault placeholder → refused, no exemption | unit |
| REST | S8 isolation (two users, deactivated, impersonating); `no-store`; listing envelope | database `inline-ui.isolation.test.ts` |
| Web: rendering | from stub `tool_call_complete` + stubbed REST (`stubSessions` gains `**/api/sessions/*/inline-ui → { blocks: [] }`); reload via listing; ordering before the final reply; height clamp; unmount at the frame cap | Playwright `tests/web/inline-ui.spec.ts` |
| Web: S1–S3 | frame cannot read `parent.document`, `localStorage`, `document.cookie`; `fetch`, remote img/font/`@import` blocked (`securitypolicyviolation` reported via `error`); `window.open`, form submit, `top.location`, `alert`, `navigator.clipboard` fail; no `page.on('popup')` | Playwright, with an allow-list of the expected console messages per test (the watchdog records frame errors) |
| Web: S4 | scripted `location=` to a routed `https://exfil.test/**` (fulfilled 200): request seen (proves D9's premise), frame stopped; static link click → chip, no request | Playwright |
| Web: S5/S6 | messages from another frame ignored; flood unmounts; `link`/`prompt` without parent activation dropped | Playwright |
| Web: D10 | history scripted block waits for click; tainted live block waits; freeze marker → "stopped" | Playwright |
| Web: P2 | strip shows full text; Send sends with provenance; Edit appends to existing draft; nothing sent without a click | Playwright |
| SPA CSP pin | the SPA serves no CSP that would break the shell nonce | unit on `web/serve.mjs` headers |
| Desktop | S13 IPC checks | manual on three webviews, recorded in the P1 PR |
| Promotion | bundle created; behaviour works; shim message visible; absolute URL refused; `secret` refused; visibility limited | database + Playwright |
| Preview (P4) | keys, teardown paths, not persisted, not replayed, not forwarded for unoffered names or `secret` sessions, preview cannot load remote img or navigate | unit + Playwright |
| Evals | §5.10 | `npm run eval` |

---

## 12. Delivery

One phase per PR ("one thing per PR"). The refactor before P3 is its own PR.

| PR | Contents | Done when |
|---|---|---|
| P1a | Eval harness (§5.9), `toolName` on tool rows | tests green; existing suites re-baselined and reported |
| P1 | §5 except the harness; guide v1; docs | `typecheck`, `lint`, `test`, `test:web`, `catalog:check`, web `tsc` green; §11 rows for P1 written; eval gate result recorded (§5.10); history-stub live check against Anthropic and one OpenAI-compatible provider; S13 desktop check on three webviews; schema token cost reported |
| P2 | §6 | as above for its rows; eval re-run shows no drop |
| P3-refactor | `writeVersion`, `SLUG_RE`, theme tokens moved; no behaviour change | existing artifact tests green |
| P3 | §7 | as above |
| P4 | §8, only if the precondition holds | provider measurements recorded in the PR |

---

## 13. Pre-existing issues found in review (not fixed by this spec)

1. **Embed pages have no CSP `sandbox` directive** (`src/api/routes/artifact-pages.ts:300-303`). In path-prefix mode (`src/core/artifacts/host.ts:15-19`), opening `/__artifacts__/…/embed` at top level runs the artifact bundle with the app's origin. Proposed fix: add `sandbox allow-scripts` to the embed CSP header.
2. **OAuth popup listener has no origin check** (`web/components/settings/oauth-section.tsx:82`).
3. **Stale developer docs.** `AGENT.md:207-208` and `docs/DEVELOPMENT.md:80-82` say tools are auto-discovered; they are registered in `MODULES`.
4. **`uses_tool` can never pass** (`src/eval/runner.ts:75,239`). Fixed by P1a.
5. **REST artifact create stores inline scripts without bundling them** (`src/api/routes/artifacts.ts:84-92`), so behaviour is silently lost. Deciding to bundle them changes what REST callers can run; it needs its own threat note.
6. **Stale comment about lazy tool discovery.** `src/core/agent/roles/general/config.ts:12-18` says lazy discovery is Ollama-only; it is on for every provider (`src/core/agent/lazy-tools.ts:44-48`).

---

## 14. Open questions

1. **Fenced block instead of a tool call (D13).** This would stream on every provider and avoid escaping HTML inside JSON. It needs server extraction on both the message and snapshot paths, stripping on non-web clients, and flow-label checks at extraction time. Decide after the P4 provider measurement.
2. **Rooms, spaces, group threads.** Other members would run code generated in someone else's turn. Proposal: static only, with no bridge.
3. **Children.** Should a child return data for the root to render, or render itself?
4. **Libraries.** If evals show SVG charts are too costly or too poor, vendor one chart library from the app origin with a path-scoped `script-src`. This is a supply-chain and size decision.
5. **Lite tier.** Keep the tool or drop it, depending on the eval (§5.10).
6. **Light theme.** If the app gains one, the frame takes the theme parameter it already has.

---

## Appendix A — Taken from OIUI

| OIUI | Here | Change |
|---|---|---|
| `generateSandboxedUi`; parameter order `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions` | `title → height_hint → css → html → js`, best-effort | One js field; no placeholder messages |
| `process-partial-html.ts` | Not used | The shell sanitizes parsed DOM instead (D6) |
| Websandbox + Idiomorph | Constant `srcdoc` shell, `innerHTML` swap | No dependency; some flicker accepted in P4 |
| CSP with 4 CDNs and `'unsafe-eval'`; inline handlers allowed | Nonce-only, no network, no eval, no inline handlers | D7, §4.2 |
| `sendPrompt` sends immediately | Parent-drawn suggestion strip | D8 |
| `openLink` opens immediately | Link chip | D8 |
| Jev router | Description + eval gate | Non-goal |
| Skills in the system prompt | Contract in the tool description; recipes behind `guide` | §9 |
| Auto-height via `ResizeObserver` + polling | `ResizeObserver` in the shell, coalesced, clamped | — |

## Appendix B — Revision log

**Revision 2** (from four reviews):

- **Corrected facts**
  - Tool calls do re-enter later turns through the native conversation snapshot (§1.3). This led to the history stub (D12, G4).
  - The REST fallback runs as channel `api`.
  - The group audience exists (D4).
  - `rootAllowedToolIds` only gates children (D5).
  - Citation drift fixed.
- **Security**
  - Vault placeholder substitution and the flow-guard exemption are closed (S11, D9).
  - Parser breakouts are closed by the constant shell (D6).
  - Static mode was not free of egress; the shell now intercepts links and pragmas.
  - The preview leaked before validation; it is now a static shell (§8).
  - Phishing chrome added (S12); freeze and DoS guard added (D10, T6).
  - Bridge changes: activation check and character cleaning (S6).
  - `get` limited to the current session (T8).
  - Cache `no-store`.
  - Promotion limits added (T12).
  - Desktop IPC check added (S13).
  - Explicit `allow` list.
- **Product**
  - Contract moved into the description; `guide` is optional.
  - Suggestion strip instead of composer fill.
  - Provenance moved to metadata instead of the visible text.
  - Size limits reduced to fit the output and tool-result caps.
  - Truncation detection that can actually fire.
  - Turn-anchored placement and auto-scroll.
  - Eval gate after P1; P4 made conditional.
  - Fenced-block alternative recorded (D13, §14-Q1).
  - User-facing name "Interactive answer".
- **Delivery**
  - Capability declaration instead of a channel string (D14).
  - Eval harness moved before P1.
  - Phases made independently shippable; bridge message set defined in P1.
  - Listing envelope and test stubs.
  - Hand-written migration.
  - Handler flags placed on `ToolHandler`.
  - `timeline-order.ts` added.
  - TUI and assertNever cases.
  - Kill switch, logs and done criteria.
  - Pre-existing issues listed (§13).
