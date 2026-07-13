# Voice, end-to-end

> **Status: plan.** Audit of the whole voice surface + a phased plan to make voice a
> first-class input/output across WebUI, channels, and TUI. Build order and engine
> posture confirmed with user: **WebUI live voice first; local-first engines.**

## The core insight

Every conversation turn — text chat, `/plan`, telephony — already converges on
**`OrchestratorService.handleMessage()`** (`src/core/orchestrator/service.ts:82`),
which classifies the turn and *either answers directly or spawns background agents*.

So the requested behaviour — "talk to octipus, agents spin up in the background from
the conversation" — **is not a voice feature.** It already exists for text. Voice is an
**audio↔text adapter wrapped around the existing turn**:

```
mic → STT (have it) → the normal chat turn (have it) → assistant text → TTS (have it) → speaker
```

The only new code per surface is the **loop/transport** around that line. Spawn-vs-answer
routing, memory, and swarm come free.

---

## Current state (audit)

| Surface | STT | TTS | Reaches agents | Verdict |
|---|---|---|---|---|
| WebUI chat | record → `/voice/transcribe` → **text into input box**, manual send | **none** | via manual send | Half-wired; never speaks back; no live loop |
| Channels (Telegram/WA/Slack/Teams) | audio metadata captured, **bytes never fetched**, dead-ends before orchestrator | none | **no** | Broken: misleading "processing…" then silence |
| Telephony (Twilio/Telnyx/Plivo) | **carrier** (`<Gather>`) | **carrier** (`<Say>`) | fast-path direct LLM (bypasses orchestrator) | Live, text-only exchange |
| TUI (`tui-pi`) | none | none | — | No voice |

**Engines (`src/voice/`):**
- Local STT — `WhisperEngine` (whisper.cpp binary + `ggml-base.bin` **committed** to
  `models/whisper/`; genuinely local; wired into `/transcribe` as the default). ✅ real.
- Local TTS — `PiperEngine` / `CoquiTTSEngine` (need host binaries **not committed**).
- Remote — Mistral Voxtral STT+TTS, OpenAI `whisper-1` STT (inline in the route, no TTS).

**Built but orphaned (never instantiated in prod):** `VoiceService` (a *complete* local
mic→STT→LLM→TTS→speaker loop w/ wake-word, `arecord`-only), all wake-word engines,
`SpeechToText`/`TextToSpeech`, `createSTTEngine`, `FasterWhisperEngine`, realtime
`streamTranscribe` (the #190 work), telephony media-stream (`<Connect><Stream>`).

**On "Ollama voice":** dead end. Ollama has no audio endpoint, so it would mean bolting a
separate local model anyway — net-new for no gain over whisper.cpp + piper. **Local =
whisper.cpp (STT, committed) + piper (TTS). Already present, just unwired. No new dep.**

---

## Architecture decision: turn-based first, realtime as an upgrade

- **A — Turn-based** (utterance → response → utterance, ~2–4 s/turn). Reuses
  `/transcribe`, the normal chat turn, `/speak` **as-is**. Zero new infra. Delivers the
  whole experience incl. background agents.
- **B — Realtime** (duplex WS, barge-in, streaming STT+TTS). The #190 `streamTranscribe`
  engine is exactly this upgrade; it stays on the shelf until A proves the UX.

**Ship A everywhere; keep B (Phase 4) as the latency/barge-in upgrade.**

### The one real tension with "local-first"

whisper.cpp (STT) is committed and works with no setup. **Piper (local TTS) is not
committed** — it needs a host binary + `.onnx` voice, and `/speak` returns `503` if
`ttsEnabled` is false. So local-first STT is free; local-first TTS is conditional.

**Decision to make (flagged, not assumed):** for local TTS either (a) commit a piper
binary + one voice under `models/` the way whisper is committed, or (b) default TTS to
Mistral/OpenAI with piper as opt-in, or (c) ship voice-in first and gate voice-out on
`ttsEnabled`, documenting piper setup. Recommend **(a)** to keep the "local-first"
promise honest; **(c)** if committing a binary is unwanted. STT is unaffected either way.

---

## Phase 1 — WebUI live voice *(build first)*

**Goal:** a conversational mode in the browser chat. Talk; octipus streams a reply and
speaks it back; agents spawn in the background exactly as in text chat.

**Reuse seams (all exist):**
- STT: `POST /api/voice/transcribe` — defaults to `'local'` (whisper.cpp) when no `model`
  is sent, which is already what `prompt-input.tsx` does. Local-first for free.
- Turn: `sendMessage(transcript)` in `web/app/chat/page.tsx:1320` — the *same* function
  the text composer calls. A voice turn calls it directly instead of stuffing the input box.
- TTS: `POST /api/voice/speak` (gated on `ttsEnabled`).

**New code (the loop only):**
1. **`useVoiceConversation` hook** (new, `web/hooks/`) — a state machine
   `idle → listening → transcribing → thinking → speaking → listening`. Owns the mic
   stream, segmentation, and playback queue.
2. **Utterance segmentation** — reuse the existing `AudioContext` analyser already in
   `web/components/chat/audio-waveform.tsx` for a simple RMS silence-detector (speak →
   ~800 ms silence → cut). Push-to-talk (hold-to-talk) as the fallback / v1 if auto-VAD
   feels twitchy. *ponytail: no VAD library — the analyser is already mounted.*
3. **TTS playback** (currently absent entirely) — on assistant-turn completion, `POST
   /speak`, decode, autoplay via one `<audio>` sink. v1 speaks the whole reply; a
   per-sentence queue (lower latency) is a later refinement.
4. **Live-mode toggle** in `prompt-input.tsx` (`:518-566`, alongside the existing mic
   button) — enters/exits the loop, shows state (listening / thinking / speaking).

**Deliberately deferred:** barge-in (interrupt playback by speaking) → Phase 4; streaming
STT → Phase 4. v1 is strictly half-duplex.

**Files:** `web/hooks/useVoiceConversation.ts` (new), `web/components/chat/prompt-input.tsx`,
small helper in `web/app/chat/page.tsx` to expose turn-complete for the TTS trigger.
No backend change if TTS decision is (a) or (b); decision (c) needs nothing new either.

**Verify:** enter voice mode, say "spawn a research task on X"; assert (1) a user turn with
the transcript appears, (2) the normal spawn-vs-answer path runs (agents start for a
work-shaped ask), (3) the reply is spoken. Confirm STT used whisper.cpp (no API key set).

---

## Phase 2 — Channels voice-in *(smallest; fixes a live bug)*

Inbound audio dead-ends at `src/channels/index.ts:603` (+ `attachment-handler.ts`
`PROCESSABLE_MIMES` rejects `audio/*`, and the "no-caption → skip orchestrator" branch
swallows it). Fix in one place, all channels benefit (Telegram/WA/Slack/Teams build audio
attachments identically):

- In `attachment-handler.ts`, accept `audio/*`; **download the bytes** (Telegram only
  fetches metadata today).
- Transcribe via the existing STT engine (whisper.cpp local default → no API cost).
- Inject the transcript as `messageContent` at `src/channels/index.ts:603` (mirrors the
  existing vision-analysis prepend at `:625-631`) and **bypass the no-caption skip** for
  audio so `orchestrator.handleMessage(...)` (`:655`) actually runs.
- Optional voice-out: Telegram already has `sendAudio` (`telegram/index.ts:302`); feed it
  `/speak` output if `ttsEnabled`.

**Verify:** send a Telegram voice note; assert transcript → orchestrator turn → reply
(instead of the current misleading "processing…" then silence).

---

## Phase 3 — TUI live voice

Revive the orphaned `VoiceService` loop (`src/voice/index.ts` — it already does
listen→transcribe→getResponse→speak→playAudio), but **repoint `getResponse` from its
direct-LLM call to the gateway `sendChat` seam** (`src/tui-pi/gateway-adapter.ts:126`,
reached from `app.ts:303`) so it reuses the same pipeline as typed TUI input. Push-to-talk
key at the `addInputListener` block (`app.ts:99`). Local engines by default.

*Caveat:* `VoiceService.listen()` hard-depends on `arecord`/`aplay` (Linux/ALSA) — no
cross-platform capture. Fine for Linux; note it, don't paper over it.

**Verify:** in the TUI, hold-to-talk a request; assert it enters the same
`handleMessage` flow as typed text and the reply is spoken.

---

## Phase 4 — Realtime upgrade *(optional, only if Phase 1 UX justifies it)*

> Detailed plan added 2026-07-12 after a full audit of the realtime seams. Split into
> four independently-shippable sub-PRs; ship the verifiable ones first.

### The core gap
Everything realtime hinges on one missing primitive: a **continuous 48 kHz → 16 kHz mono
s16le resampler**. Today resampling is batch-only — browser `OfflineAudioContext` on a whole
recorded blob (`web/hooks/useVoiceConversation.ts:311` `encodeWav16kMono`) and server ffmpeg
on a file (`src/voice/stt.ts:62` `toWhisperWav`). The streaming STT engines
(`stt.ts:106,226,527`) assume the caller already delivers conformant 16 kHz PCM;
`stripWavHeader` (`stt.ts:447`) is a *guard*, not a converter. Fix the resampler and the rest
is wiring.

### 4a — Realtime foundation *(pure functions; fully testable here)*
Shared primitives both web-realtime and telephony need, as tested library code — no endpoints:
- `resamplePcm16(input, inRate, outRate)` + a **stateful streaming** variant (carries the
  fractional sample position across frames).
- **μ-law codec** `muLawDecode/Encode` (8 kHz PCM16 ↔ G.711) — telephony needs it; harmless for web.
- A **frame accumulator** adapting pushed PCM16 frames into the `ReadableStream<Uint8Array>`
  that `streamTranscribe` consumes, with a byte-threshold flush.
- **Files:** new `src/voice/audio-codec.ts` + `audio-codec.test.ts`. 100% unit-testable
  (sine round-trips, rate ratios). **This is the safe first PR.**

### 4b — Web duplex WS + live capture *(logic testable; e2e needs a browser mic + Mistral key)*
- **Server:** new `app.ws('/voice', …)` in `src/api/voice-ws.ts` — NOT the JSON `/gateway`
  (it decodes all binary to string, `gateway-ws.ts:50`). Reuse the `getSessionManager().validate`
  URL-token handshake like `/ws` (`websocket.ts:41`). Bridge inbound binary frames → 4a
  accumulator → the streaming STT engine. **Main path = whisper.cpp sliding-window `--stream`**
  (reuse the committed binary; ~0.5–2 s latency, local, all surfaces). `MistralSTTEngine.streamTranscribe`
  (`stt.ts:527`) stays as the cloud upgrade. Note: the current whisper path at `stt.ts:232` re-runs
  3 s batches — replace it with the binary's real streaming mode, don't build on the batch re-run.
  Emit partial transcripts back.
- **Browser:** an **AudioWorklet** off the existing `getUserMedia` stream
  (`useVoiceConversation.ts:250`) emitting 16 kHz mono s16le frames (reuse the Float32→PCM16
  logic from `pcmToWav` `:335`), replacing the per-utterance `MediaRecorder` + `encodeWav16kMono`
  batch path in live mode.
- **Default to local whisper.cpp streaming; Mistral is the opt-in cloud upgrade** (gated on key
  for best-accuracy/multilingual). Local streaming is the main path, not a degraded fallback.

### 4c — Streaming reply + barge-in *(the UX payoff)*
- **Barge-in:** run the RMS VAD *during* `speaking` (today gated to `listening`,
  `useVoiceConversation.ts:233`); on detected speech, stop the `<audio>` sink (`:106`) and
  reopen STT. Large perceived win, mostly verifiable now (state-machine logic).
- **Streaming TTS:** wire `MistralTTSEngine`'s documented `stream:true` SSE gap (`tts.ts:394`)
  so the reply speaks as it synthesizes.
- **Streaming assistant text (deep):** replies aren't token-streamed to clients — the gateway
  union is closed (`protocol.ts:40`) and emits the whole reply once (`message-handler.ts:240`).
  Add a `chat.response.delta` event + surface orchestrator token deltas. Biggest blast radius;
  do it last, behind a flag.

### 4d — Telephony media-stream *(DEFERRED — untestable without a live carrier)*
New WSS `/voice/media/:provider` speaking Twilio's `start/media/stop` protocol, μ-law 8 kHz
(reuses the 4a codec), wiring the currently-dead `streamUrl` branch (`twilio.ts:114`, its only
`<Connect><Stream>`) off the `voice.publicUrl` setting (`voice.ts:74`). **Cannot be verified
without a live Twilio number + a public `wss://`** — codec/parser units are testable, the
handshake is not. Its own PR when a real carrier line is available; independent of the
web-realtime work (shares only the STT/TTS engines, not the WS handlers).

### Recommended sequencing
**4a → (4c barge-in) → 4b → 4c streaming → 4d.** Ship 4a (tested foundation) and the barge-in
slice first — both complete and verifiable now. 4b / 4c-streaming / 4d each need external
resources (Mistral key, browser mic, Twilio) to verify end-to-end, so flag them and land as
their capabilities become testable.

### Open decisions
1. **Local-first vs cloud realtime** — **decided: local-first, one engine.** Streaming STT is
   *not* Mistral-only — that framing was wrong. whisper.cpp already ships a **sliding-window
   streaming mode** (`--stream`, ~0.5–2 s latency); the "3 s batch re-run" at `stt.ts:232` is a
   *usage choice*, not an engine limit. **Main path: wire whisper.cpp's streaming mode**, reusing
   the binary already committed to `models/whisper/` — no new dep, works CPU/Metal/cross-platform,
   and it's the *same* engine the server-side TUI/channels paths use (one engine, not a per-surface
   zoo). Mistral streaming stays as the **cloud upgrade** for best-accuracy/multilingual, gated on key.
2. **Streaming assistant deltas** (4c) touch the orchestrator/gateway core — worth it, or is
   "speak the whole reply, but interruptible" (barge-in without token-streaming) enough?

### Future upgrade — Moonshine in the browser *(not now)*
A 2026 model class (**Moonshine v2**, MIT for English) is *built* for streaming — sub-second, low
token-revision — and has an official **in-browser** path (`onnx-community/moonshine-*-ONNX` via
Transformers.js, WebGPU-accelerated + WASM fallback). For WebUI live voice this would run STT
**100% in the browser** — no `/transcribe` round-trip, no server load, no API key. Tempting, but
**deferred on purpose:** the server-side TUI + channels paths need whisper regardless, so adopting
Moonshine *just* for the browser means maintaining two STT engines. Stick to one (whisper streaming)
until the browser-local UX win justifies the second engine. Caveat when revisited: Moonshine is
English-first (8 langs), so whisper/Voxtral stay the multilingual fallback — the real axis is
language + hardware, not local-vs-cloud. **Engine choice ladder:** whisper.cpp streaming (main,
multilingual, all surfaces) → Mistral (cloud, best accuracy) → Moonshine Web (future, English,
browser-local).

---

## Cleanup (fold into whichever phase touches the file)

- Dead exports: `FasterWhisperEngine`, `SpeechToText`/`TextToSpeech`, `createSTTEngine`
  (no prod caller) — wire or delete, don't leave dangling.
- Stale comment `src/tools/voice/index.ts:4` ("Leverages the existing VoiceService…") —
  the file never touches `VoiceService`.
- `web/components/chat/chat-input.tsx` — unused legacy input with its own mic handler.
```
