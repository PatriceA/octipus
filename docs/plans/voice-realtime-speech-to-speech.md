# Voice — full OpenAI realtime (speech-to-speech) as a parallel mode

> **Status: plan / exploration.** A *new, parallel* voice mode using OpenAI's
> `gpt-realtime` speech-to-speech model — NOT a change to the existing
> STT→orchestrator→TTS pipeline. Both modes coexist; the user picks one.
> Source of truth for the shipped voice surface stays `docs/VOICE.md`.

## The core idea: two brains, clear division of labour

Today (all three lines in `docs/VOICE.md`) the shape is:

```
mic → STT → text → octipus orchestrator (agents, tools, memory) → text → TTS → speaker
```

octipus is the brain; OpenAI/Voxtral are just ears and mouth.

Full realtime inverts the front end:

```
mic ─┐                          ┌─ speaker
     ├─ gpt-realtime (hears, converses, speaks — native barge-in, ~300ms) ─┤
     └─ function calls ──────────────────────────────────┐
                                                          ▼
                                        octipus (agents · memory · tasks · tools · channels)
```

**gpt-realtime becomes the conversational front end** — natural, interruptible,
emotional, low-latency voice — and **octipus becomes its tool backend + context
provider**. The realtime model handles turn-taking, chit-chat, and quick
reasoning itself; for anything that needs *data or action* it calls an octipus
tool. This is the only way to use full realtime without throwing away octipus's
orchestrator, memory, agents, and connectors.

This is a *parallel* mode because the audio never enters our STT/TTS/orchestrator
turn loop — it's a separate socket and a separate lifecycle. Nothing in the
current pipeline changes.

## What gpt-realtime gives us (GA capabilities)

From OpenAI's realtime guide (verified 2026-07):

- **Function calling.** Tools are declared in `session.update`. The model emits
  `response.function_call_arguments.delta`; we run the tool and return output via
  `conversation.item.create` (function_call_output) then `response.create`.
- **Context / instructions.** System prompt via `session.instructions`; prior
  turns seeded with `conversation.item.create`; **mid-session text injection**
  (e.g. "your research agent just finished, here's the result") via a text
  `conversation.item.create` + `response.create`.
- **Text alongside audio.** `response.output_audio_transcript.delta` streams the
  spoken text — so we still get transcripts for logging, memory capture, and the
  on-screen caption.
- **Barge-in.** Native. Server VAD detects the user talking over the model;
  `response.cancel` stops output. No custom RMS barge-in (unlike our realtime hook).
- **Transports.** **WebRTC** for browsers (direct peer audio, lowest latency);
  **WebSocket** for server-to-server / media pipelines.
- **Ephemeral tokens.** `POST /v1/realtime/client_secrets` mints a short-lived
  session token so the browser connects **directly** to OpenAI without exposing
  our `OPENAI_API_KEY`. The session config (instructions, tools, VAD) is baked in
  at mint time.

## Architecture options

### Option A — Browser ↔ OpenAI direct (WebRTC + ephemeral token). Recommended.

1. octipus mints an ephemeral session server-side (`POST /v1/realtime/client_secrets`)
   with the persona instructions, the octipus tool schemas, and seed context
   baked in. Uses `getOpenAIApiKey()` (`src/models/providers/openai-provider.ts`).
2. Browser opens a **WebRTC** connection straight to OpenAI with that token —
   mic + speaker + native barge-in, minimal latency.
3. **Tool calls** arrive in the browser over the realtime data channel. The
   browser forwards each to a new authenticated octipus endpoint
   (`POST /voice/realtime/tool` or a WS), octipus executes it against the real
   orchestrator/memory/etc., and the browser submits the result back to OpenAI.
4. **Live updates** from long-running octipus work (an agent finishing) are
   pushed to the browser over the existing `/ws` channel and injected into the
   realtime session as a text item.

Pros: lowest audio latency, OpenAI handles all audio plumbing. Cons: tool calls
round-trip through the client; the client mediates the octipus↔OpenAI bridge.

### Option B — Server-proxied (octipus holds a WS to OpenAI).

octipus backend keeps the OpenAI realtime **WebSocket**, bridges PCM to/from the
browser (mirroring `src/api/voice-media-ws.ts` telephony bridge), intercepts tool
calls in-process, and injects context server-side.

Pros: octipus is in the loop for every event — cleanest tool execution, easiest
live-context injection, no OpenAI internals in the client. Cons: audio relayed
through our server (extra hop, more backend load), we re-implement the audio
bridge.

### Recommendation

**Start with Option A.** Ephemeral-token WebRTC is the OpenAI-blessed browser
path and keeps the voice latency that makes realtime worth it; the tool round-trip
through the client is a thin, well-defined bridge. Fall back to Option B only if
tool mediation or context freshness proves too awkward client-side, or for the
telephony variant (a call has no browser — server-proxied is the only option
there, and `voice-media-ws.ts` already does 8↔16 kHz bridging we'd adapt).

Mirror the existing mount + auth: WS routes are mounted in `src/api/websocket.ts`
(alongside `setupVoiceWebSocket` and `setupVoiceMediaWebSocket`); `/voice`
(`src/api/voice-ws.ts`, `setupVoiceWebSocket(app)`) authenticates via a `?token=`
query param → `getSessionManager().validate(token)` → `close(4001)` on failure.
Add `setupVoiceRealtimeWebSocket(app)` as a drop-in copy for the token-mint +
live-update channel.

**Only genuinely net-new server piece: ephemeral-token minting.** There is no
`client_secret`/ephemeral helper today — add one that POSTs to OpenAI's realtime
sessions endpoint using `getOpenAIApiKey()` (`src/models/providers/openai-provider.ts`)
and returns the short-lived token (plus the baked session config) to the
authenticated client. The orchestrator brain path is
`getOrchestratorService().handleMessage(sessionId, userId, message, channel?,
expertId?, attachedFiles?, forcedOutputMode?) → { response, agentId?,
classification, … }`, with progress streamed out-of-band via `onEvent`.

## What context we can inject into a session

octipus already assembles all of this for the text pipeline; we reuse the same
sources to seed the realtime session (at mint time) and refresh mid-session:

`src/core/orchestrator/direct-response.ts` (~L47–139) already assembles all four
context blocks for the text pipeline — it's the exact recipe to reuse:

| Context | Source (octipus) | How it's given |
|---|---|---|
| Persona / system prompt | `resolvePersonaForUser(userId)` → `.promptBlock` (`src/core/personas/resolver.ts`; presets `personas/*.yaml` via `loader.ts`/`registry.ts`) | `session.instructions` |
| User profile facts | `new ProfileRepository().findUserProfile(userId).facts` (`src/db/repositories/profile-repository.ts`) | folded into instructions |
| Relevant memories | `retrieveForContext({userId,sessionId,topic,limit})` + `renderMemoriesBlock()` (`src/core/memory/retrieval.ts`, ~250-token budget) | instructions or a `recall_memory` tool |
| Recent messages | `MessageRepository.findRecentBySession(sessionId, n, …)` (`src/db/repositories/message-repository.ts`) | seed `conversation.item.create` |
| Open tasks / active agents | `octipus_list_tasks`; `AgentManager.list()` (`src/core/agent-manager.ts`) | seed items |
| Time / locale / channel status | server time, `octipus_gateway_status` | instructions |
| Tool catalogue | the `mcp-server/` registry (§ below) | `session.tools` |

The instruction prompt must be **tool-first**: "You are octipus's voice. For
anything requiring current data, memory, tasks, or actions, CALL A TOOL — do not
answer from your own knowledge. Acknowledge long tasks immediately and let the
result come back to you." This keeps the realtime model's own knowledge from
overriding octipus's ground truth.

## The tool bridge (the heart of it)

**The `mcp-server/` package is a ready-made realtime `tools` array + executor.**
It's a standalone in-repo MCP package: `mcp-server/src/server.ts` `createServer()`
registers **86 tools** across 26 modules (`mcp-server/src/tools/*.ts`), each
`server.tool(name, description, zodSchema, handler)` where the handler delegates
to `OctiClient` (`mcp-server/src/client.ts`) — a thin HTTP client over the octipus
REST backend. So each tool already carries `{name, description, Zod schema,
HTTP-backed handler}`:

- Translate the Zod input schemas → OpenAI JSON Schema for `session.tools`.
- Reuse `OctiClient` verbatim as the tool-call executor (auth via
  `mcp-server/src/auth.ts`).

(The *internal* layer — `src/tools/registry.ts`, `toolId__operation` names — is
what in-process agents use; not shaped for direct realtime exposure. Use the
`mcp-server` package.)

Two tiers:

1. **Fast tools** (`octipus_search`/`list_memories`, `get_profile`, `create_task`,
   `capture_note`, `list_tasks`) — return in <1s, the model speaks the result
   inline.
2. **Slow / background tools** (`octipus_spawn_agent`, `octipus_start_research`,
   or delegate to the full brain via `OrchestratorService.handleMessage`) —
   return immediately with "started, id=…", the model says "on it, I'll tell you
   when it's done", and the real result arrives later as an injected text item.
   The stream comes from `getOrchestratorService().onEvent(handler)` →
   `OrchestratorEvent {type: chat_response|status_update|worker_spawned|
   worker_completed|approval_required|pipeline_event}`; a `worker_completed`
   event → inject-as-conversation-item into the realtime session. Same
   propose-then-confirm / narrator spirit as `voice-plan-gate.ts` + `narrator.ts`
   (and `setVoiceMode(sessionId, true)` already exists on the orchestrator).

Curate the exposed set — don't dump all 86 tools into every session (token cost +
model confusion). Start with a voice-relevant subset and grow it.

## What this unlocks (possibilities)

- **Natural voice concierge over octipus** — barge-in, emotional prosody,
  sub-second turns, far better than STT→TTS.
- **Voice-driven delegation** — "kick off deep research on X" → background agent →
  spoken summary when done, all hands-free.
- **Ambient capture** — "remember that I…", "add a task to…", "what did we decide
  about Y?" answered from octipus memory by voice.
- **Connector reach** — "what's on my calendar", "summarize my unread email",
  "find the doc about Z" via the Gmail/Calendar/Drive MCP tools.
- **Two-way narration** — the model narrates agent lifecycle as work progresses.
- **Telephony upgrade path** — the same realtime brain over a phone call
  (server-proxied, via the media bridge).

## Risks & constraints

- **Cost.** Realtime speech-to-speech is token-priced and steep:
  gpt-realtime-2.1 ≈ **$64/M tokens**, mini ≈ **$20/M** (vs $0.017/min STT +
  cheap TTS today). A voice mode toggle + usage awareness matters. Consider
  `gpt-realtime-2.1-mini` as the default.
- **Two brains can conflict.** Strict tool-first instructions + a curated tool
  set; decide what the realtime model may answer itself vs must delegate.
- **Tool latency.** Agent spawns are slow; the async/ack pattern above is
  mandatory or the conversation stalls.
- **Memory / audit writeback.** Voice turns must still land in octipus memory and
  the audit log — capture `output_audio_transcript` + tool calls server-side.
- **Security.** Ephemeral tokens are short-lived and scoped; the tool endpoint is
  authenticated with the existing session token; never expose the raw API key or
  unscoped tools to the client.
- **Persona drift.** The realtime voice/persona must match octipus's — bake the
  persona into instructions, don't rely on the model's default.

## Phased build

- **Phase 0 — Spike.** Server route to mint an ephemeral session
  (`/voice/realtime/session`) with static instructions + 2–3 fast tools (recall
  memory, create task). Browser WebRTC connect, talk, confirm a tool call round-
  trips through octipus. Proves the bridge. No pipeline changes.
- **Phase 1 — Context + persona.** Fold persona (`personas/octipus.yaml`),
  profile, and a memory summary into the minted instructions. Add the on-screen
  transcript from `output_audio_transcript.delta`.
- **Phase 2 — Tool catalogue.** Map a curated `octipus_*` subset to realtime
  tools from the MCP registry; server-side tool executor with auth + audit.
- **Phase 3 — Background delegation.** `spawn_agent` / `start_research` /
  orchestrator delegate as ack-now-inject-later; wire agent-finished events
  (`/ws`) → injected realtime text item. Reuse narrator concepts.
- **Phase 4 — Mode UX.** A voice-mode switch in the client (realtime vs the
  current STT/TTS lines), cost/latency indicator, and a `voice.realtimeEnabled`
  setting. Default model `gpt-realtime-2.1-mini`.
- **Phase 5 — Telephony (optional).** Server-proxied realtime over the media
  bridge for phone calls.

## Open decisions (for the user)

1. **Transport:** Option A (WebRTC direct, recommended) or B (server-proxied)?
2. **Default model:** `gpt-realtime-2.1-mini` (cheaper) or full `gpt-realtime-2.1`?
3. **Autonomy:** may the realtime model answer general questions itself, or must
   everything non-trivial go through an octipus tool?
4. **Tool scope:** which `octipus_*` tools are safe/useful to expose by voice
   (esp. anything that sends messages, spends money, or acts on connectors)?
