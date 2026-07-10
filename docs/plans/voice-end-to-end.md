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

Wire the #190 `streamTranscribe` + a duplex WS for barge-in and lowest latency, and the
dead telephony media-stream (`streamUrl` / `<Connect><Stream>`, no WS handler today).
This is where the resample question (16 kHz mono s16le) actually has to be answered.

---

## Cleanup (fold into whichever phase touches the file)

- Dead exports: `FasterWhisperEngine`, `SpeechToText`/`TextToSpeech`, `createSTTEngine`
  (no prod caller) — wire or delete, don't leave dangling.
- Stale comment `src/tools/voice/index.ts:4` ("Leverages the existing VoiceService…") —
  the file never touches `VoiceService`.
- `web/components/chat/chat-input.tsx` — unused legacy input with its own mic handler.
```
