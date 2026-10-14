# Interactive answers (inline UI) — implementation spec

> **Revision 4, as built, 2026-10-14.** Small interactive answers — charts,
> calculators, diagrams, comparisons with controls — rendered inside the
> agent's reply in the web chat and in rooms. The idea and some code come from
> [CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)
> (MIT, © Atai Barkai), abbreviated **OIUI**. Its framework (CopilotKit,
> AG-UI, a Python LangGraph agent, the paid "Jev" visualization router) is
> **not** adopted. Four mechanisms are: a sandboxed per-answer frame, a
> validated bridge from the frame back to the chat, a streaming preview, and
> the authoring guidance that makes generated UI usable.
>
> **What changed since revision 3.1.** Revision 3.1 specified a tool call
> (`inline-ui__render`) and left a fenced block in the reply as open question
> 1. The implementation uses the fenced block (D13 records why), supports
> rooms and members' space chats (question 2), and records the spike result
> (D9). Every section below describes the code as it is; the revision log
> (Appendix B) lists the differences from revision 3.1.
>
> **Review.** Revisions 1–3.1 were reviewed against the code: four reviewers
> on revision 1 (95 findings, 9 blockers), two on revision 2 (39 findings,
> 3 blockers), one check of revision 3 (1 blocker, 3 majors, 3 minors). The
> pre-existing problems those reviews found (§13) are fixed in the same
> branch, with more found while implementing.
>
> **User-facing name:** "Interactive answer". **Code name:** `inline-ui`.
> User and operator documentation: [`docs/INLINE-UI.md`](../INLINE-UI.md).

## Contents

- §1 What existed before
- §2 Goals and non-goals
- §3 Decisions
- §4 Security invariants and threat model
- §5 P1 — Format, storage, frames, history, evaluation
- §6 P2 — Suggested follow-ups
- §7 P3 — Save as live artifact
- §8 P4 — Streaming preview
- §9 Guidance
- §10 Cross-cutting
- §11 Tests
- §12 Delivery and what is open
- §13 Pre-existing issues found in review and implementation
- §14 Open questions
- Appendix A — What is taken from OIUI
- Appendix B — Revision log

---

## 1. What existed before

The facts this design started from, with `file:line` references against
`main` at d2f9b65, before this work. Several have changed since (the Tauri
manifest, `toolName` on tool rows, the stale docs); §13 lists those fixes.

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

- G1. In the web chat — personal chats, members' chats in a space — and in
  rooms, the root agent can answer with a small interactive UI that appears
  in its reply, works, and survives reload.
- G2. Generated code can do nothing outside its frame except what a click in
  the parent app allows.
- G3. A block that cannot be shown reaches the model in the same turn;
  client-side failures are visible in the block and reach the model on the
  user's next message, as structured outcomes only.
- G4. A block's source costs once, not on every later turn.
- G5. A useful interactive answer can be kept as a live artifact.
- G6. Use is measured (eval suite) before the feature grows.

**Non-goals**

- No agent framework, no visualization router model.
- Not rendered in the TUI, channels, MCP, voice, notifications or group
  threads: they get one plain line (§5.6).
- No data sources, refresh or sharing — live artifacts do that.
- No state that survives re-mounting a frame.
- No network from a frame, no CDN libraries.

---

## 3. Decisions

**D1. A fenced block in the final reply.** The model writes

````text
```octi-ui title="Loan calculator" height=360
<style>…</style>
<div>…</div>
<script>…</script>
```
````

in its final reply. The info string carries `title` (required, ≤ 80
characters, one line, control and bidi characters removed) and `height`
(optional, default 320, clamped). The body is split into CSS (the text of
every top-level `<style>`), markup, and JS (the text of every plain inline
`<script>`; `<script src>` and non-JS types are refused with a repairable
issue). A body containing a line of three backticks is fenced with four. One
read-only tool, `inline-ui__source`, returns an earlier block of the session
(§5.3). Parsing, markers and fallbacks live in `src/shared/inline-ui/fence.ts`.

**D2. Source stored in its own table; a marker stays in the reply.** At the
end of the root agent's run each fence is stored in `inline_ui_blocks` and
replaced by the line `[[octi-ui:<uuid>|<title>]]`. The web fetches the
source by id over REST. The event bus and every copy of the reply carry the
marker, never the source; reload does not depend on `agent_events`
retention.

**D3. Placement is the marker's place in the reply.** The web splits an
assistant message into text and marker segments and renders a block where
its marker is (`AssistantContent`), so a block is always inside its reply,
in order, with no timeline kind and no clock to reconcile. A marker line
inside a code fence is text, not a block.

**D4. Offered when one predicate holds** (`inlineUiOffered`,
`src/core/inline-ui/offer.ts`, unit-tested as a matrix):
- root agent, not small-tier, not a vendor CLI root (its own transcript
  cannot be stubbed, D12), no stored DENY on tool `inline-ui` action
  `render` (the kill switch);
- **room**: always — members read a room in the web app, whoever's turn it
  was; a room bridged to a platform thread gets the fallback line there;
- **personal** and **space** (a member's own chat in a space): when the
  client declared `renders: ['inline_ui']` for the turn (D14);
- **group** threads and **remote-space** sessions: never (the first answers
  on its platform; the second stores nothing outside its own rows).

root-runner computes it after `rootIsSmall` and stores
`context.metadata.inlineUiOffered`. The source tool and the repair round
(D12) check it again; children never see it.

**D5. Added by root-runner, not through a role.** A client capability, not a
role capability. When offered: the prompt section `INLINE_UI_PROMPT` joins
the root prompt's static (cacheable) part, the `inline-ui` handlers join the
root's tools and the lazy core ids; when not offered, `inline-ui` handlers a
customised role row brought in are filtered out. Children never receive it.

**D6. Two nested frames; generated content is data; only the inner frame ever
holds it.** (`src/shared/inline-ui/frames.ts`)

```
chat page ──iframe sandbox=allow-scripts srcdoc=HOST──▶ host frame (our code only)
                                                         CSP: script-src 'nonce-H' 'nonce-C'; frame-src 'none'
                                                         └─iframe sandbox=allow-scripts srcdoc=CONTENT──▶ content frame
                                                              CSP: script-src 'nonce-C'; no network
                                                              runtime (ours) + sanitized html + css [+ js]
```

- The **host document** is a constant plus a JSON payload in which every `<`
  and U+2028/U+2029 are escaped (`jsonForScript`, `src/shared/html.ts`). The
  host never inserts generated markup into its own document. It creates the
  content frame from the content document, observes it (load events, message
  rate), relays validated messages, and is the only frame the chat page
  listens to.
- The **content runtime** runs first under nonce C, caches the DOM methods
  and objects it uses, then: parses the markup with `template.innerHTML`
  (inert), walks it with `querySelectorAll('*')` and applies §4.3
  (`template` itself is refused, so nothing hides in nested template
  content), moves the result into `<body>`, sets a `<style>` element's text
  to the CSS, wires links, height, errors and `octi`, and in scripted mode
  attaches the JS last as a `<script>` with nonce C.
- Parser breakouts cannot occur: no generated text is concatenated into
  markup. The browser's parser is the sanitizer's parser.
- Generated code shares a realm only with the content runtime, never with
  the host: it can forge or suppress content messages, not host signals.
- Two modes: **static** (no JS; no generated code runs) and **scripted**.
- No `allow` attribute: Chromium logs a console error for every `'none'`
  entry on every frame, and the sandbox with an opaque origin already
  withholds every feature whose default allowlist is `self`. Videos get
  `disablepictureinpicture`.

**D7. No network from a frame.** Both CSPs deny every fetch and every remote
image, font, stylesheet, script, frame and worker. Charts are SVG or canvas
written by the model.

**D8. Nothing leaves the chat page without a click in the chat page.**
- Links: no live `href` exists in the content frame (§4.3); activation
  becomes a `link` message; the chat page shows the URL in a chip with a real
  link (`target="_blank" rel="noopener noreferrer"`).
- Follow-ups (§6): the frame suggests a message; the chat page draws a strip
  outside the frame with **Send**, **Edit in composer**, **Dismiss**.

OIUI sends and opens directly. We diverge because generated code is model
output that untrusted content can steer, and a sent message counts as the
user's own words.

**D9. Self-navigation: contained by the host frame on Chromium; click-to-run
elsewhere.** The spike (`tests/web/inline-ui-frames.spec.ts`) shows on
Chromium that the host's `frame-src 'none'` blocks the content frame's own
navigation to an `https:` URL answered with 200 and with 204 — no request
reaches the route — and that the `srcdoc` content frame itself still loads.
The host stops a block when it sees a second content `load`; signals from the
content realm are never relied on. Firefox and WebKit were not available to
the spike, so a scripted block waits for a click on any engine that is not
Chromium (`navigator.userAgentData.brands`; D10). Because a block is text in
a reply, not a tool call, there is no egress classification: the session's
flow label is recorded on the block when it is stored (`tainted`, `risk`)
and drives D10 and §7.

**D10. Click-to-run.** A scripted block mounts with its markup shown and a
chat-page-drawn "Run interactive answer" button, instead of running, when
any holds:
- it was not received live on this page (history);
- the conversation is shared (a room: one member's question shapes what
  everyone runs);
- `tainted` — the session had read outside content, private data or a secret
  when the block was stored; with `risk = high` (a secret, or private data
  together with outside content) the prompt is a red warning;
- the viewer is an admin acting as the user;
- the freeze marker for the block survived (§5.5);
- containment is not verified on this engine (D9).

A static block runs no generated code; it follows the freeze-marker rule.

**D11. Shared, pure helpers in `src/shared/inline-ui/`** — fence parsing,
markers and fallbacks, lint, limits, theme tokens, frame documents and
runtimes, bridge validation — with no runtime imports, so the web and the
server use the same code. The esbuild syntax check is server-only
(`src/core/inline-ui/extract.ts`).

**D12. Sources leave history at the end of the turn; one repair round.**
- **Repair.** When the final reply has a block that cannot be shown as
  written (fatal: cut off, empty, too large, a script that does not parse)
  or would lose parts (repairable: inline handlers, remote resources, forms,
  `<script src>`…), the worker appends the draft and a message saying what
  is wrong and asks once more, in the same turn (G3).
- **Extraction.** When the root agent finishes, before the snapshot, the
  message row or any event keeps a copy, `storeInlineUiBlocks` stores each
  acceptable fence and puts a marker in its place; a block that still cannot
  be shown becomes a visible notice (`> ⚠ Interactive answer “T” could not be
  shown: …`). It is idempotent; the service runs it again on whatever reaches
  it (a CLI root, a plan path).
- **Snapshot.** The final assistant message in the native snapshot holds the
  markers; fences in earlier iterations (text beside a tool call, a repaired
  draft) are replaced by their one-line form; and the `providerRaw` of every
  changed message is dropped, because Anthropic and Gemini replay it.
- Later turns see `[[octi-ui:<id>|<title>]]`; `inline-ui__source` fetches
  the source when the model wants to change a block.

**D13. A fenced block, not a tool call.** Revision 3.1 chose a tool call and
kept the fenced block as an open question. Implementing it showed the
block is the better fit:
- it streams on every provider over `chat.delta`, so the preview (§8) needs
  no tool-argument streaming, which most providers deliver in one chunk;
- HTML is not escaped inside JSON, and a cut-off block is detected by its
  missing closing fence;
- G3 holds through the repair round (D12) instead of a tool error;
- the flow label is recorded at extraction, and the kill switch works at the
  offer (D4) — the two things per-call permissions gave the tool call;
- the cost — every surface that is not the web must not show raw markup — is
  met by one fallback function applied at each of them (§5.6) and by
  extraction before anything keeps the reply.

**D14. Clients declare what they can render.** `chat.send` takes optional
`renders: ['inline_ui']` (Zod); `handleMessage` takes a trailing
`inlineUi?: { renders, notes, provenanceId }` and puts it into `RunContext`
(`renders`, `inlineUiNotes`, `inlineUiProvenance`). The web declares it over
the gateway. The REST fallback does not: it runs when the tab cannot hear the
gateway, so the block would not appear live — and since it sends no channel
it is unattended (§13-7). `POST /api/chat` accepts `renders` for the eval
runner and keeps markers in its response only then. Rooms need no
declaration (D4).

**D15. Promotion uses the artifact version writer and a closed network
policy.** `writeVersion` lives in `src/core/artifacts/version-writer.ts`
and is used by the tool, the REST routes and promotion. Promoted artifacts
have `network = 'none'`: the embed CSP gets `connect-src 'none'` and
`img-src data: blob:`, and the page carries no SDK, gateway or token (§7).

---

## 4. Security invariants and threat model

### 4.1 Invariants

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Generated code never runs with the app's origin, cookies or storage | Both frames `sandbox="allow-scripts"` without `allow-same-origin`, `srcdoc` |
| S2 | No fetch; no remote script, style, font, image, media, frame or worker | §4.2 CSPs, first element of each `<head>`, in constant documents (D6) |
| S3 | No popups, forms, top or sibling navigation, modals, downloads | Sandbox flags (only `allow-scripts`); opaque origin withholds `self`-default features (D6); runtime strips `autofocus` |
| S4 | Content cannot navigate (Chromium); elsewhere scripts wait for a click | No live `href` (§4.3); host `frame-src 'none'`; host stops on a second content load; D9, D10 |
| S5 | The chat page acts only on host-frame messages of known shape and rate | `event.source` check; per-mount channel (readable by generated code — not a secret); `parseInlineUiHostMessage`; §4.4 rates; > 20 invalid messages per second unmount |
| S6 | Nothing is sent or opened without a click in the chat page | D8. Strip and chip buttons ignore input for 800 ms after they appear; frame height locked while a strip is open; suggestion text cleaned of C0/C1, bidi and zero-width characters (`cleanSuggestedText`) |
| S7 | Refused markup is reported to the model (lint, repair round) and removed by the runtime | §4.3 |
| S8 | Only those who may read the conversation read a block | `inlineUiReader`: the scoped session read of the chat routes (`contentRepos`), or `roomAccess`; a remote room through the federation op `room.inline_ui` (`roomAccess` and the room's space); block id must belong to that session; 404 otherwise; `cache-control: no-store` |
| S9 | Sizes and rates are bounded | §4.4 |
| S10 | What the session had read is visible where it matters | `tainted` / `risk` recorded at extraction from `getFlowLabel`; D10; promotion refused for `tainted` (§7) |
| S11 | Vault secrets never enter a block | Placeholders are not resolved in replies; `inline-ui__source` has `injectSecrets: false` |
| S12 | A frame cannot impersonate the app | Chat-page-drawn border, header and footer ("Made by the agent · don't enter passwords or keys here"); height ≤ min(2 000 px, 80 vh); password and file inputs replaced; `text-security` removed |
| S13 | Desktop IPC is unreachable from either frame | App commands declared in an `AppManifest` and granted to the main window only; Tauri refuses app commands to remote origins; the frames are opaque-origin `srcdoc` documents without the invoke key; the webview has no store permission (§13-8) |
| S14 | Focus cannot be stolen while the user types | The chat page watches focus moving into a frame: a theft is a page keystroke within the last second, or no user activation (Tab exempt); focus returns to where it was and the block stops |

### 4.2 Frame policies

Host frame CSP (`H`, `C` = per-mount nonces from `crypto.getRandomValues`):

```
default-src 'none'; script-src 'nonce-H' 'nonce-C'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';
frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none';
form-action 'none'; base-uri 'none'
```

Content frame CSP:

```
default-src 'none'; script-src 'nonce-C'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';
frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none';
form-action 'none'; base-uri 'none'
```

A `srcdoc` document copies its creator's policy container, so the content
frame enforces the host CSP as well as its own; the host allows exactly what
the content needs (a unit test checks the subset). `frame-src 'none'` still
lets the host create its `srcdoc` child (spike). Inline handlers and
`javascript:` URLs cannot run (no `'unsafe-inline'` for scripts, no
`'unsafe-hashes'`); no `'unsafe-eval'`.

Head order in both: CSP · `referrer no-referrer` · `x-dns-prefetch-control
off` · charset · base CSS · runtime `<script nonce>`. Both iframes:
`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, `title`.

### 4.3 Refusals (S7)

The server lint (`lintInlineUi`) tells the model; the content runtime enforces
the same rules on the parsed DOM, so a lint bypass gains nothing. The refused
elements and dropped attributes are one list each
(`INLINE_UI_REFUSED_ELEMENTS`, `INLINE_UI_DROPPED_ATTRIBUTES`), read by the
runtime and by the server sanitizer for saved copies (§7).

| Field | Refused | Runtime action |
|---|---|---|
| elements | `script`, `meta`, `link`, `base`, `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `form`, `noscript`, `template`, `slot`, SVG `set`; `animate*` of `href`/`xlink:href`/`src` | removed with content |
| attributes | `on*`, `ping`, `attributionsrc`, `autofocus`, `formaction`, `action`, `shadowrootmode`, `shadowroot`, `srcdoc`, `srcset`, `imagesrcset`, `name` on `img` | removed |
| links | `href` on `a`/`area` | `https:` → `data-octi-href`, `#…` → `data-octi-anchor`, with `role="link"` and `tabindex="0"`; anything else removed. Activation (click, middle click, Enter, Space) → `link` message or scroll; drag prevented |
| other URLs | SVG `href`/`xlink:href` other than `#…`; any SVG `a` href; `src`/`poster`/`background`/`data`/`lowsrc` not `data:`/`blob:` | removed |
| inputs | `type=password`, `type=file`, `autocomplete` containing `password` | replaced by a notice |
| CSS | `@import`, remote `url(`/`image-set(` (lint; CSP blocks); `text-security` | `text-security` declarations removed |
| render cost | more than 200 `<use>`, more than 20 `<filter>` | removed beyond the cap |
| JS | syntax errors (esbuild `transform`, server) | n/a — fatal, repair round |

### 4.4 Limits (S9)

Constants in `src/shared/inline-ui/limits.ts`; the browser enforces them too.

| What | Limit |
|---|---|
| title | ≤ 80 chars, one line |
| markup / CSS / JS | ≤ 24 000 / 6 000 / 12 000 chars; total ≤ 36 000 |
| blocks | 4 per reply, 200 per session |
| height | 40 px … min(2 000 px, 80 % of the viewport) |
| `error` messages | 20 per mount |
| `prompt` / `link` | 1 per 500 ms per frame; prompt text ≤ 1 000 chars |
| invalid messages | > 20 per second → unmount |
| reports per message | ≤ 20 |
| live frames | 6 (3 below 640 px) |
| strip/chip input delay | 800 ms |

### 4.5 Threat model

| # | Threat | Outcome |
|---|---|---|
| T1 | Injected content asks for a UI that sends session data out | No session access (S1); no fetch (S2); navigation blocked (Chromium) or click-to-run (elsewhere); click-to-run when tainted (D10) |
| T2 | Vault secret in markup | Not resolvable in a reply (S11) |
| T3 | Parser breakout | Impossible: content is data (D6) |
| T4 | Exfiltration without script (meta refresh, prefetch, CSS, SMIL href) | Refused elements, no live hrefs, SMIL href refused, CSP blocks CSS URLs, DNS prefetch off |
| T5 | Fake login or fake app UI | S12; click-to-run when tainted |
| T6 | Tab hang or memory bomb | History blocks wait for a click; render-cost caps; freeze marker; flood unmount; live-frame cap |
| T7 | Steering the user's next message | Strip outside the frame, full text, explicit Send, input delay, height lock (S6) |
| T8 | Cross-session or cross-user read | S8; `inline-ui__source` limited to the agent's session |
| T9 | Admin impersonation runs the target's code | Click-to-run; suggestions and saving disabled |
| T10 | Desktop IPC | S13 |
| T11 | Preview leaks before validation | The preview is static (no JS), sanitized by the same runtime, and built from text the user is already shown streaming |
| T12 | Promotion opens network access to viewers | `network = 'none'`; tainted blocks refused; private or workspace only (§7) |
| T13 | Generated text reaches the model as the user's words | Client reports are enums, an error class and a line number; ids, never titles, in model-facing notes |
| T14 | Focus theft | S14 |
| T15 | A room member's question shapes code everyone runs | Shared conversations wait for a click (D10); suggestions post as the clicking member's own addressed message |

---

## 5. P1 — Format, storage, frames, history, evaluation

### 5.0 Spike

`tests/web/inline-ui-frames.spec.ts` builds the real host document in a blank
page and records every request to a `.test` host. Results on Chromium: the
runtime runs under the inherited host CSP and `data:` images load; a
scripted content frame's `location =` to a routed URL answered 200 or 204
sends no request; the host reports `stopped` with reason `navigation`; the
content cannot forge host signals; floods unmount; the refused-markup and
clobbering cases leave the runtime intact. Firefox and WebKit could not be
run in the build environment; D9 applies click-to-run to them.

### 5.1 Table `inline_ui_blocks`

Schema `src/db/schema/inline-ui-blocks.ts`; migration
`src/db/migrations/0139_inline_ui_blocks.sql` plus its journal entry.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `session_id` | uuid → `sessions.id` on delete cascade | |
| `run_id` | text | the turn (`runId`), for logs |
| `agent_id` | text | |
| `requester_id` | uuid → `users.id` on delete set null | who asked (room requester or chat owner) |
| `title` | text | |
| `height_hint` | integer default 320 | |
| `css` / `html` / `js` | text | |
| `scripts` | boolean | JS present |
| `tainted` | boolean | flow label had any flag |
| `risk` | text `normal` / `high` | `secret`, or `private` with `suspicious` |
| `issues` | jsonb | repairable issue codes that the runtime will remove |
| `created_at` | timestamptz | |

Repository `src/db/repositories/inline-ui-repository.ts`: `create`,
`countForSession`, `getInSession`, `getManyInSession`, `listForSession`.

### 5.2 Extraction (`src/core/inline-ui/extract.ts`)

`storeInlineUiBlocks(text, { sessionId, agentId, requesterId,
contentStorageOff })`: for each fence — lint and syntax check, per-reply and
per-session caps, `contentStorageOff` (a remote-space session) refuses —
store and replace with a marker, or replace with a notice. Logs
`Interactive answer stored` (info: block id, mode, sizes, `tainted`, `risk`,
issues) or `Interactive answer refused` (warn: codes), with the turn's
`runId`. `stubInlineUiFences` replaces fences with the fallback line for
history copies. `inlineUiRepairMessage` builds the repair request (D12).

The worker's other text passes see only prose: text tool-call recovery and
the toolshim run on `withoutInlineUiFences`, and the loop and thinking
strippers run through `transformOutsideInlineUiFences`, so markup that
repeats by nature (table rows) is not mangled.

### 5.3 Tool `src/tools/inline-ui/index.ts`

`inline-ui__source` — action `read`, read-only, `injectSecrets: false`;
registered in `MODULES`. Requires `context.root` and
`metadata.inlineUiOffered`; `{ id }` → `{ id, title, height, body }` where
`body` is the block rebuilt as `<style>`, markup, `<script>`, if the block
belongs to the agent's session, else "No interactive answer … in this
conversation". Manifest permissions `render` ALLOW (the kill switch is a
stored DENY on it) and `read` ALLOW.

### 5.4 Offering and the prompt (root-runner)

`resolveInlineUiOffer` reads the session audience, the CLI-provider check, a
stored-DENY check on `inline-ui`/`render`, and `getRunContext().renders`,
after `rootIsSmall`. When offered: `INLINE_UI_PROMPT` (≈ 550 tokens: when
and when not, the format, limits, no network, links and `octi`, quality,
theme tokens, markers and `inline-ui__source`) joins the static prompt
parts; `inline-ui` joins the lazy core ids; `inlineUiNotes` (D14, §5.5) join
the volatile part.

### 5.5 Web (`web/components/chat/inline-ui/`)

- `context.tsx` — the page that shows a conversation (chat, room) provides a
  host: how to fetch a block, whether the conversation is shared, which
  blocks arrived live, impersonation, and the actions (report, send/edit a
  suggestion, save as artifact). Fetches are cached per conversation; a
  failed fetch is not cached (Retry).
- `content.tsx` — `AssistantContent` splits a reply into markdown and blocks
  (markers inside code fences stay text); `StreamingContent` and
  `InlineUiPreview` (§8).
- `frame.tsx` — the host frame, built once per mount; listens to that frame
  only; floods unmount.
- `block.tsx` — chrome (border, header with title, "Interactive answer",
  "resets when reloaded", View source, Restart, Save as artifact; skip link;
  footer), click-to-run (D10), the live-frame cap, the freeze marker
  (`localStorage['octi-ui-mounted:<id>']`, set before mount, cleared on
  clean unmount and `pagehide`), the focus guard (S14), errors, removed
  parts, blank, link chip, suggestion strip, height lock, source view.
- States: loading · ready · waiting for a click (with the reason) · script
  error (class and line) · stopped (navigation, flood, focus) · froze ·
  blank · not available (404, Retry).
- The chat page marks blocks of replies received while open as live, keeps
  client reports per session and sends them with the next `chat.send`
  (REST fallback: kept for the next gateway send), declares `renders`, and
  provides `saveAsArtifact`. Rooms (`room-view.tsx`) provide a shared host;
  remote rooms fetch through the remote-spaces route.

**Client outcomes reach the model (G3, T13).** `chat.send` carries
`inlineUi.reports: [{ id, outcome, errorClass?, line? }]` (enums and
integers, ≤ 20). `resolveInlineUiTurnNotes` keeps reports for blocks of the
session and turns each into one line,
`(system note: interactive answer <uuid> reported script-error TypeError line 12)`,
in the root prompt's volatile part — which the worker stores on the user row,
so it reaches the model in both history paths. Reports for other sessions'
blocks are dropped with a warning.

### 5.6 Other surfaces

`inlineUiFallbackText` (markers and any stray fence → "▸ Interactive answer
“T” — open this conversation in the Octipus web app to use it.") is applied
by: channel replies (`summarizeForChannel`), monitor delivery, the group
bridge relay, hook `notifyOwner`, room notifications, `POST /api/chat`
without `renders`, the OpenAI-compatible API, and the TUI (final and
streaming text). Voice (server and web) uses `inlineUiSpeechText`, which
drops blocks entirely. MCP clients reach replies through `/api/chat` and get
the line.

### 5.7 REST and federation

- `GET /api/sessions/:id/inline-ui/:blockId` → the block with `shared`
  (`src/api/routes/inline-ui.ts`); S8; `no-store`.
- `POST /api/sessions/:id/inline-ui/:blockId/promote` (§7).
- Federation host op `room.inline_ui` (`roomAccess`, the room in the named
  space) and `GET /api/remote-spaces/:id/rooms/:roomId/inline-ui/:blockId`.

### 5.8 Evaluation harness

- Tool rows record `toolName`; `POST /api/chat` with `toolsUsed: true`
  returns the tool names of the turn (`toolNamesSince`).
- `uses_tool` / `not_uses_tool` cannot be judged in unit mode and fail with
  the reason (they used to pass on an empty list).
- YAML `context.renders` is passed to `/api/chat`; a test that declares it is
  refused in unit mode (`rendersObservabilityBlocker`), where the root
  prompt is never built.
- The YAML loader now applies double-quote escapes (§13).

### 5.9 Evaluation suite

`eval/inline-ui.yaml`: 15 positives (calculators, converters, charts of
given numbers, mechanism and algorithm step-throughs, comparisons with
controls), 10 negatives (facts, code, lists, single values, plain tables,
prose), one case without `renders` (never offered), 5 ambiguous cases
(reported, not gated). Positives must show a marker with no refusal and no
raw fence; negatives must show neither.

**Gate:** positives ≥ 70 % use, negatives ≤ 10 % use, each case 3× on at
least two models (one local). Not yet run (§12).

---

## 6. P2 — Suggested follow-ups

- Frame: `octi.prompt(text)` → `prompt` (≤ 1 000 chars, cleaned).
- Chat page: a strip below the frame at a fixed place, the frame's height
  locked while it is open: the full text, **Send** ("Send as guidance" while
  a turn runs — it steers), **Edit in composer**, **Dismiss**; buttons inert
  for 800 ms after appearing. One strip per block.
  - **Send** sends the text as the user's message with
    `inlineUi.provenance: { inlineUiId }`; in a room it posts the member's
    own message addressed to the agent.
  - **Edit in composer** calls `PromptInput`'s `insertDraft(text, source)`;
    it appends to the draft and shows a removable "from interactive answer
    “T”" chip; the provenance travels with the send.
- Provenance: checked against the session; the model-facing line is
  `(system note: the user sent this from interactive answer <uuid>)`; the
  user row stores `metadata.inlineUiProvenance`, on the steer path too
  (`trySteerRunningRootAgent`); the bubble shows "from an interactive
  answer".
- Disabled while impersonating.

---

## 7. P3 — Save as live artifact

Prerequisites (done): the embed CSP header carries `sandbox allow-scripts`
(§13-1); `writeVersion` in core (D15); `ARTIFACT_SLUG_RE` and
`slugFromTitle` in `src/shared/artifacts.ts`; `ARTIFACT_BASE_CSS` built from
the shared theme tokens (byte-identical); artifact `network` column
(`'default' | 'none'`, migration `0140_artifact_network.sql`) and
`buildEmbedCsp({ network })`.

**Web.** "Save as artifact" in the block header; disabled with the reason
for a `tainted` block or while impersonating; the chat page only (not
rooms). The dialog: title, slug (suggested from the title, validated),
visibility `private` (default) or `workspace`; it says "a static copy — no
data refresh, and it reaches no network", and when the script uses `octi`
(`usesOctiBridge`) that those buttons will say "not available here". On
success: a link to the artifact and any build warning.

**Server** — `POST /api/sessions/:id/inline-ui/:blockId/promote`:
1. authenticated; refused while impersonating (403);
2. the caller's own chat: `contentRepos(principal).sessions.findById` and
   `session.userId === principal.userId` (an admin who may read the chat
   cannot save from it; rooms are not chats) → else 404;
3. the block in that session → else 404; `tainted` → 409;
4. title 1–200 chars, slug `ARTIFACT_SLUG_RE`, visibility private or
   workspace, a workspace → else 400;
5. `promotedPage(block)` (`src/core/inline-ui/promote.ts`):
   - the markup through `sanitizeInlineUiMarkup` — `htmlparser2`, the §4.3
     rules from the shared lists, plus refusal of the elements browsers parse
     as raw text (`xmp`, `plaintext`, `noembed`, `noframes`); `<style>`
     elements moved into the CSS (closing the SVG/MathML `<style>`
     re-parsing tricks); comments dropped; written by a canonical serializer
     (text and attributes escaped, `{` as `&#123;` so the template renderer
     never sees a placeholder);
   - CSS: the frame's element CSS, the markup's styles, the block's CSS, with
     every `<` escaped;
   - script: `PROMOTED_OCTI_SHIM` then the block's JS (when it has JS or
     links) — the shim keeps `octi`'s shape, shows a visible notice and
     rejects; link chips show their address, anchors scroll;
6. the artifact (`type: html`, `network: 'none'`, metadata `savedFrom`) in
   the request's workspace store (a space needs `write`), and its version
   through `writeVersion` with the script on the bundler path (no string
   concatenation of `<script>`); a taken slug → 409.

A user action under the user's own session; no agent ASK.

**Residual.** The artifact pages that frame an embed set no `frame-src`, so a
saved copy's script can still navigate its own frame to another site (the
D9 containment is the chat's host frame, which a saved copy does not have).
What it could carry is only the page's own content: the copy has no session,
data source, token or network, and answers made after reading outside
content are refused.

---

## 8. P4 — Streaming preview

Built on the text stream (D13), not on tool arguments. While a reply streams
(`chat.delta`), `StreamingContent` finds an open `octi-ui` fence, shows the
prose around it, and renders `InlineUiPreview`: the frames in static mode
(`preview: true` — no JS ever), first with the content so far, then
`update { html, css }` messages at most every 300 ms. The host accepts
`update` only from its parent with the mount's channel and passes it to the
content runtime, which sanitizes exactly as for a stored block. The preview
is labelled "Building “T”…"; the final reply mounts from the stored source.

---

## 9. Guidance

The contract lives in `INLINE_UI_PROMPT` (§5.4), in the root prompt's
cacheable part on offered turns: when and when not; the format with title
and height; limits and "aim for under 12 KB"; no network, storage, forms,
iframes, password or file inputs, or inline handlers (`addEventListener`,
`<button type="button">`); links and `octi.prompt` / `octi.openLink` only
from click handlers; quality (labels, keyboard access, `role="status"`,
numeric validation, no NaN, label sample/user/retrieved/calculated values,
`textContent` for untrusted text); dark theme tokens and phone width; one
sentence of context; markers and `inline-ui__source`. OIUI's recipe
playbooks (SVG charts, diagrams) are not included yet (§14-8).

---

## 10. Cross-cutting

### 10.1 Cost

- Prompt section ≈ 550 tokens on offered turns, in the cached prefix.
- A block costs its output tokens once (12 KB ≈ 3.5 k tokens); later turns
  carry only the marker line. A repair round costs one more completion.
- `inline-ui__source` costs one extra iteration when used.

### 10.2 Privacy and storage

Session content: deleted with the session (cascade); not indexed. A block
in a room is readable by the room's members, as its messages are. Bounded at
200 × 36 KB per session.

### 10.3 Accessibility

Frame `title`; heading in the header; skip link; script errors, stops and
suggestions announced with `role="status"`; focus moves only on a click, or
back to where it was (S14); accessible markup is the default in the prompt.

### 10.4 Operations

- **Kill switch:** a stored DENY on tool `inline-ui` action `render`, per
  user or global, makes the offer false.
- **Logs:** §5.2, and "Interactive answer needs repair — asking the model
  once".
- **Client outcomes:** shown in the block and sent with the next message;
  not collected as telemetry.

### 10.5 Compatibility

| Case | Behaviour |
|---|---|
| Old web, new server | Does not declare `renders` → not offered in chats; a room reply's markers show as plain lines |
| New web, old server | `renders` and `inlineUi` stripped by the non-strict schema; nothing offered |
| REST fallback | Not offered (D14) |
| TUI, channels, MCP, voice, OpenAI-compatible API | Fallback line (§5.6) |
| CLI-provider root | Not offered (D4) |
| Federation | Remote rooms fetch blocks through `room.inline_ui` |

---

## 11. Tests

| Area | Tests | Lane |
|---|---|---|
| Fences, markers, fallbacks, lint, limits, document builders, CSP subset, bridge validation | `src/shared/inline-ui/inline-ui.test.ts` | unit |
| Offer matrix | `src/core/inline-ui/offer.test.ts` | unit |
| Extraction, caps, notices, flow label, idempotence, access (owner, admin, member, stranger, room, wrong session), `no-store`, turn notes, source tool, promotion (bundle after shim, closed CSP, tainted, visibility, ownership, slug) | `src/api/routes/inline-ui.isolation.test.ts` | database |
| Repair round (draft kept, once only, not offered / child) | `src/core/agent-worker.inline-ui.test.ts` | unit |
| Server sanitizer (refusals from the shared lists, raw-text elements, SVG/MathML `<style>`, links, escaping, cost caps), promoted page | `src/core/inline-ui/promote.test.ts` | unit |
| Frames in a browser: spike, inheritance, navigation (200/204), forged signals, floods, breakouts, clobbering, links, caps | `tests/web/inline-ui-frames.spec.ts` | Playwright (Chromium) |
| Chat: history waits, live runs, suggestion strip with provenance, reports, link chip, streaming preview, not available, focus guard, save dialog, tainted save disabled | `tests/web/inline-ui.spec.ts` | Playwright |
| Saved copy: script after the shim, opaque origin when opened directly, notices, no request | `tests/web/inline-ui-saved.spec.ts` | Playwright |
| Rooms: every member sees a block, scripts wait, a suggestion posts addressed | `tests/web/rooms.spec.ts` | Playwright |
| Eval harness: unobserved tool use, renders blocker, loader escapes, suite loads | `src/eval/*.test.ts` | unit |
| Embed sandbox header, closed CSP; REST versions keep bundles; 409 slug | `src/core/artifacts/csp.test.ts`, `src/api/routes/artifact-versions.isolation.test.ts` | unit, database |
| OAuth callback pages | `src/api/popup-callback.isolation.test.ts` | database |

---

## 12. Delivery and what is open

Shipped on one branch, in four commits: the server, the web, the
pre-existing fixes (§13), and P3 with the docs and this revision.

Open:
1. **Eval gate** (§5.9) with live models — needs provider access.
2. **Firefox and WebKit** navigation containment (D9). Until verified,
   scripted blocks wait for a click there.
3. **Desktop webviews** (WebKitGTK, WKWebView, WebView2): run the frames and
   check that `set_backend_url` is refused from a content frame (S13). The
   build script and capability file were verified to generate and validate.
4. **Recipes** for charts and diagrams (§9) if the eval shows weak visuals.

---

## 13. Pre-existing issues found in review and implementation

All fixed on this branch.

1. **Embed CSP had no `sandbox` directive** — an embed opened directly in
   path-prefix mode ran with the app's origin. The header now carries
   `sandbox allow-scripts` (`embedCspHeader`).
2. **OAuth popup listener had no origin check** — it now accepts only its
   own popup at the app's origin.
3. **Stale docs** — tools, channels and MCP groups are registered in lists
   (`AGENT.md`, `docs/DEVELOPMENT.md`).
4. **`uses_tool` could never pass** — §5.8.
5. **REST artifact writes lost behaviour** — create, edit and restore use the
   version writer: scripts are bundled, CSS-only edits keep the bundle,
   restores copy it, viewers are notified. Threat note in
   `version-writer.ts`: REST callers can run nothing the agent tool does not
   already run for them, and only inside the sandboxed embed.
6. **Stale comment** — lazy discovery is not Ollama-only.
7. **REST fallback turns are unattended** — documented in the chat page and
   `docs/API.md`.
8. **Tauri app commands were not governed by capabilities** — `AppManifest`
   with both commands, granted to the main window; the unused `store:default`
   permission (which let page script write the backend URL past
   `set_backend_url`'s checks) removed.

Found while implementing:

9. **OAuth callback pages reflected script.** The connector callback put
   `?error=` into an inline script with `JSON.stringify` under
   `'unsafe-inline'`; the provider callback likewise. The global CSP
   replaced the page's policy — which also blocked the pages' own scripts,
   so popups never reported back. One builder now: script-safe JSON, escaped
   markup, a nonce policy the global headers keep (`src/api/popup-callback.ts`).
10. **A taken artifact slug answered 500** (REST) or a raw SQL error (tool):
    Drizzle wraps the driver error, so the constraint is on `cause`
    (`src/db/unique-violation.ts`).
11. **Eval YAML double-quoted strings were not unescaped**, so a suite's
    regex `"\\*\\*[1-9]"` matched any digit.
12. **Phantom dependencies** — `htmlparser2`, `domhandler`, `domutils` were
    imported but installed only through `botbuilder`.
13. **`docs/ARTIFACTS.md` described bundles as a future endpoint** with
    hash pinning; rewritten. The biome schema version now matches the
    pinned CLI.

---

## 14. Open questions

1. ~~Fenced block instead of a tool call~~ — chosen (D13).
2. ~~Rooms, spaces, group threads~~ — rooms and members' space chats are
   supported, rooms with click-to-run; group threads get the fallback line.
3. **Children.** Return data for the root to render, or render themselves?
   Today only the root writes blocks; a child's fence that reaches the reply
   is extracted like the root's.
4. **Libraries.** Vendor one chart library from the app origin with a
   path-scoped `script-src`, if evals show SVG charts are too costly or poor.
5. **Lite tier.** Offered (only small-tier is excluded); keep or drop per the
   eval.
6. **Light theme.** The frames take a theme parameter; the app is dark-only.
   Saved copies follow the viewer's `prefers-color-scheme`.
7. **Other engines** — §12-2.
8. **Recipes** — §12-4.

---

## Appendix A — Taken from OIUI

| OIUI | Here | Change |
|---|---|---|
| `generateSandboxedUi` tool, args `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions` | an `octi-ui` fence in the reply: `title`, `height`, `<style>`, markup, `<script>` | text, not a tool call (D13); one script |
| `process-partial-html.ts` | not used | the runtime sanitizes parsed DOM (D6); the preview streams from text (§8) |
| Websandbox + Idiomorph, one frame | two constant frames, `innerHTML` swap | no dependency; trusted host outside generated code's realm |
| CSP with 4 CDNs and `'unsafe-eval'`, inline handlers | nonce-only, no network, no eval, no inline handlers | D7, §4.2 |
| `sendPrompt` sends immediately | chat-page suggestion strip | D8 |
| `openLink` opens immediately | link chip | D8 |
| Jev router | prompt section + eval suite | non-goal |
| Skills in the system prompt | the contract in a prompt section on offered turns | §9 |
| `ResizeObserver` + polling | `ResizeObserver`, coalesced, clamped | — |

---

## Appendix B — Revision log

**Revision 4** (as built):
- **Format (D1, D13).** A fenced `octi-ui` block in the final reply instead of the `inline-ui__render` tool call; stored at the end of the run and replaced by a marker line (D2); placement is the marker's place in the reply (D3), so no timeline kind and no envelope clock.
- **Audiences (D4).** Rooms always (scripts wait for a click), members' space chats with `renders`; group threads and remote-space sessions never.
- **G3 (D12).** One repair round in the turn replaces tool errors; extraction runs before any copy of the reply is kept; earlier-iteration fences are stubbed and `providerRaw` dropped.
- **Spike (D9).** Chromium: host `frame-src 'none'` blocks the content frame's navigation (200 and 204) and still allows the `srcdoc` child. Firefox and WebKit not run: click-to-run there. No write-egress classification: the flow label is recorded on the block (`tainted`, `risk`).
- **Frames (D6).** No `allow` attribute (console noise; the opaque origin already withholds `self`-default features); `querySelectorAll` walk with `template` refused.
- **Tools.** Only `inline-ui__source`; the contract is a prompt section, not a tool description; `inline-ui__guide` dropped (recipes open, §14-8).
- **Preview (§8).** From the streamed text, not tool arguments; no new gateway event.
- **Focus guard (S14).** A theft is a page keystroke within one second or no user activation; Tab exempt (pointer events inside a frame never reach the page).
- **Promotion (§7).** Server sanitizer on `htmlparser2` sharing the runtime's lists, canonical serializer, `octi` shim in the bundle, `network = 'none'` embed without SDK or token.
- **Eval harness.** `renders` blocker in unit mode; loader escapes; `eval/inline-ui.yaml`.
- **§13.** All eight pre-existing issues fixed; five more found and fixed.

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
