# Voice & Phone Calls

Octipus includes voice capabilities at two levels:

1. **Local Voice I/O** — speech-to-text, text-to-speech, and wake word detection for hands-free local interaction
2. **Phone Calls** — make and receive actual phone calls via Twilio, Telnyx, or Plivo with interactive voice conversations

## Voice Data Flows — the three lines

Three input pipelines, one brain, one mouth. They differ only in how audio gets
*in* and back *out*; all transcribe at **16 kHz mono** (whisper's only input) and
all speak back through the configured TTS engine (Voxtral by default; also OpenAI
or local Piper). Detail for each stage is in the sections below.

**Line 1 — Recorded input web** (`useVoiceConversation.ts`): record an utterance, POST it, get one reply.

```text
🎤 mic ──▶ MediaRecorder (webm/ogg)          AnalyserNode RMS VAD; stops after SILENCE_MS (2 s)
   │
   ▼  Web Audio decode + OfflineAudioContext  →  encodeWav16kMono
 WAV 16 kHz mono ──base64──▶ POST /api/voice/transcribe
   │
   ▼  whisper.cpp (ggml-small.bin)             transcribeAudioBuffer → else Voxtral / OpenAI; stripNonSpeech
 transcript ──▶ sendMessage() ──▶ 🧠 ROOT AGENT ──▶ chat.response (event over /gateway)
                                                          │
   ┌──────────────────────────────────────────────────────┘
   ▼  /api/voice/speak (whole reply) → stripForSpeech
 Mistral TTS → mp3 ──▶ 🔊 <audio>
```

**Line 2 — Realtime streaming web** (`useVoiceRealtime.ts`): duplex socket, streaming transcript, barge-in.

```text
🎤 mic (echoCancellation)                      AudioContext @16 kHz → AudioWorklet (Float32→Int16)
   │
   ▼  binary PCM frames (16 kHz s16, while "listening")
 /voice  WebSocket  (engine = the Transcription lane's model; ?engine= picks one)
   ├─ whisper : WhisperEngine.streamTranscribe → 2 s sliding window   (voice-ws.ts)
   ├─ mistral : MistralSTTEngine → wss Mistral realtime
   └─ openai  : OpenAIRealtimeSTTEngine → wss OpenAI realtime
   │
   ▼  {type:transcript} frames (running text) → client VAD dispatches delta on silence
 sendMessage() ──▶ 🧠 ROOT AGENT + voice-plan-gate ──▶ chat.response (event over /gateway)
   │                        ╲___ narrator: voice.speak lifecycle events over /gateway,
   │                             to the tab that sent voice.set {on:true} only
   ▼  per-sentence /api/voice/speak → Mistral TTS ──▶ 🔊
        ◀── barge-in: sustained over-talk (RMS) stops playback, reopens mic (pre-roll flush)
```

**Line 3 — Telephony / phone** (`voice-media-ws.ts` + `media-bridge.ts`): 8 kHz μ-law over a carrier, both ways.

```text
📞 caller ──▶ carrier ──▶ TwiML <Connect><Stream> ──▶ /voice/media/:provider
   │  8 kHz μ-law base64 media frames
   ▼  twilioMediaToPcm16k:  muLawDecode → 8 kHz PCM → resamplePcm16(8k→16k)   [StreamingResampler]
 16 kHz PCM ──▶ per-utterance WhisperEngine.streamTranscribe ──▶ transcript
   │
   ▼  generatePhoneReply  (voice-topic model, short prompt — NOT the full root agent)
 reply ── Mistral TTS → mp3 → ffmpeg → 16 kHz PCM
   │
   ▼  pcm16kToTwilioMedia:  resamplePcm16(16k→8k) → muLawEncode → base64
 8 kHz μ-law ──▶ carrier ──▶ 🔊 caller            paced real-time; RMS barge-in
```

**Where they converge**

```text
 Lines 1 & 2 ─▶ AgentService.handleMessage (full pipeline + voice-plan-gate)
 Line 3      ─▶ generatePhoneReply (direct-LLM fast path)
                        │
        planning turns (web) + phone reply run on the  ► voice-topic model ◄  (Gemini Flash Lite)
        heavy post-handoff work → normal routing
                        │
        Mouth: configured TTS (Voxtral en_paul_neutral by default).  STT floor: 16 kHz mono; telephony bridges 8↔16 kHz.
```

## Engines are models

Speech to text and text to speech run on the models bound to the
**Transcription** and **Speech** lanes (Topics page), like every other kind of
model work. Every place that hears or speaks — channel voice notes, the web
microphone, `/api/voice/transcribe`, `/api/voice/speak`, voice replies, phone
calls, the TUI (through the API) and the audio tools — resolves its engine
there (`src/voice/resolve.ts`):

- **primary, then backup** — a primary that cannot run (not installed, no key)
  or fails falls to the backup, logged with the reason;
- **protection levels** — content that must stay local only reaches a local
  engine: a cloud primary is skipped for it and a local backup takes it;
- **accounting** — every call is recorded against its row (cost, spend budgets);
- an account that may not use the install's hosted keys gets local engines only.

Nothing bound means speech is **off** (not broken): the microphone is hidden,
a voice note gets one line asking to type, spoken replies stop
([MODULES.md → Capability gates](MODULES.md#capability-gates)).

| Engine | Lane | Row (provider / model id) | Notes |
|--------|------|-----|-------|
| whisper.cpp | Transcription | `local-audio` / `whisper.cpp:base` | Offline, no key. Model file: the row's *Model file*, else the installed `ggml-base.bin` (`octi setup`). Streaming windows ≥ 2 s. |
| faster-whisper | Transcription | `local-audio` / `faster-whisper:<size>` | Offline, CTranslate2, ~4x faster than whisper.cpp; `small`/`medium` run in realtime on fast hardware. Needs `uv`. |
| Voxtral | Transcription | `mistral` / `voxtral-mini-latest` | Realtime streaming via the row's `metadata.speech.streamingModel`. Mistral key (or the row's own key). |
| OpenAI | Transcription | `openai` / `gpt-4o-transcribe` | Realtime streaming via `gpt-realtime-whisper`. OpenAI key. |
| Kokoro | Speech | `local-audio` / `kokoro:<voice>` | Offline, leading open local TTS. Needs `uv` + model files (`octi setup`). WAV. |
| Piper | Speech | `local-audio` / `piper:<voice>` | Offline, lightweight. The row's *Model file* is the `.onnx` voice. WAV. |
| Voxtral | Speech | `mistral` / `voxtral-mini-tts-2603` | Mistral key. mp3/wav/opus/flac/pcm. |
| OpenAI | Speech | `openai` / `gpt-4o-mini-tts` | OpenAI key. mp3/wav/opus/flac/pcm. |

**Choosing one:** Topics page → Transcription / Speech → *Use:* (creates the
row and binds it primary; the one it replaces becomes the backup), or bind any
row like on any lane. `octi setup` does the same. `POST /api/voice/engines/use`
`{ direction: 'stt'|'tts', engine, size?, makePrimary? }` is the API.

**Old engine names still work as requests:** `?engine=` on the `/voice`
socket and `model` on `/api/voice/transcribe` accept a row name or `auto`,
`local`, `whisper`, `whisper-cpp`, `fasterwhisper`, `mistral`/`voxtral-*`,
`openai`/`whisper-1` — they pick the bound row of that engine. A row named
directly must be an install speech engine of that direction.

**Settings that remain:** `voice.language`, `voice.ttsVoice` (the voice for
replies and calls, given to the primary Speech engine; a backup speaks in its
own default; empty = the engine's default), `voice.wakeWord` and the
telephony keys. `voice.sttProvider`, `voice.fasterWhisperModel`,
`voice.whisperModelPath`, `voice.ttsProvider` and `voice.piperModelPath` are
**retired**: on the first boot after the upgrade they were turned into lane
bindings once (explicit choices kept; `auto` became whisper.cpp first, as
faster-whisper was only ever chosen by name; the default `mistral` speech
was kept only when it had a key, else a local voice that runs; an engine of
the other kind that can run became the backup; a model path carried over
only when it was not the default and is on disk), and a lane someone bound
is never touched.

### Wake Word Detection

| Engine | Type | Notes |
|--------|------|-------|
| **Sherpa-ONNX** | Local | ONNX keyword spotting |
| **Picovoice** | Cloud | High accuracy, requires API key |
| **VAD** | Local | Voice Activity Detection fallback |

---

## Realtime Web Voice Conversation

The web chat (`/chat`) has a live, hands-free voice mode: you speak, Octipus
transcribes, runs the **same root agent pipeline as typed chat**, and speaks
the reply back — with barge-in and per-sentence streaming TTS. Two mic modes
share one owner (only one active at a time):

- **Recorded input** (`web/components/chat/prompt-input.tsx`): record an utterance →
  `POST /api/voice/transcribe` → send as a chat turn → speak the reply.
- **Realtime / streaming** (`web/hooks/useVoiceRealtime.ts`, Phase 4b): holds a
  duplex WebSocket to `/voice` open, streams 16 kHz mono PCM off an AudioWorklet,
  and receives a running transcript back. Client-side VAD segments utterances;
  barge-in interrupts the spoken reply when you talk over it (Phase 4c).

### The speak-to-the-root agent loop

A spoken turn runs the *same* path as text — classification, memory, agent
spawning — so nothing downstream is voice-specific. What differs is a
**voice-only conversation layer** inside the root agent:

**Propose-then-confirm gate** (`src/core/agent/voice-plan-gate.ts`, wired
in `src/core/agent/service.ts` `handleMessageInner`). With the mic on, a
work request is **not dispatched immediately**. Octipus proposes an approach out
loud — or asks one short clarifying question when the request is vague — and
waits for your go:

- work **or ambiguous** turn → **propose** (on the fast voice model)
- "yes / go / do it" → **execute** the stored plan via the normal work path
- "no / cancel / stop" → drop the plan, keep chatting
- anything else → **refine**: fold the new guidance in and re-propose

Pending-plan state is per-session and in-memory. Affirmation vs. cancellation is
decided by wording, because the classifier tags both "yes" and "no" as
`approval`. The gate is **read-only over the root agent** — it can't spawn
anything itself, so there's no runaway; the only thing that starts work is your
spoken confirmation. Typed chat is unaffected (gated on a per-session voice
flag set by the mic toggle with the gateway's `voice.set` message; the flag is
cleared when that tab's connection closes).

**Backend narrator** (`src/voice/narrator.ts`, wired in
`src/core/gateway/event-bridge.ts`). Long agent turns are narrated as they
happen instead of read back stale: root agent lifecycle events
(`worker_spawned`, `worker_completed`) become `voice.speak` gateway events
("On it — I've started the researcher…") sent only to the connection that put
that session into voice mode. The actual reply is spoken from the
`chat.response` event, **fresh per turn** — so voice is decoupled from turn
timing and attempts to discard stale speech events.

**Fast voice model.** Interactive planning turns run on whatever model is mapped
to the **`voice` topic** (e.g. a flash-tier model) so they stay snappy; the heavy
work after handoff uses normal routing. Map it on the Models/Topics page, or
`registry.updateModel(name, { topicRoles: { voice: 'primary' } })`.

### STT engine for the realtime loop

The engine is the model bound to the Transcription lane (see *Engines are
models*). The `/voice` WebSocket accepts `?engine=` to pick one of the bound
engines. Cloud engines stream natively (low latency); whisper.cpp streams
2 s windows (1 s windows return empty on the base model).

### Tuning knobs (web)

- **`SILENCE_MS`** in both voice hooks — trailing silence that ends an utterance.
  Raise if a thinking pause splits your sentence into two turns; lower if replies
  feel laggy. (Currently 2000 ms.)
- **Barge-in RMS / duration** thresholds in `useVoiceRealtime.ts` — the mic still
  hears residual TTS (browser AEC cancels most, not all), so these keep the
  assistant's own voice from self-interrupting.

### Key files

| Area | File |
|------|------|
| Realtime STT WebSocket (`/voice`) | `src/api/voice-ws.ts` |
| Backend narrator + `speak` frames | `src/voice/narrator.ts`, `src/api/websocket.ts` |
| Propose-then-confirm gate | `src/core/agent/voice-plan-gate.ts`, `src/core/agent/service.ts` |
| Telephony media stream (`/voice/media/:provider`) | `src/api/voice-media-ws.ts` |
| Web hooks | `web/hooks/useVoiceRealtime.ts`, `web/components/chat/prompt-input.tsx` |
| Audio codec (μ-law / resample) | `src/voice/audio-codec.ts` |

> **Known gap:** streaming TTS synthesizes and plays one sentence at a time, so
> there's an audible pause between sentences (the next sentence's synth
> round-trip). Prefetching the next clip while the current one plays would close
> it.

---

## Phone Calls

Make and receive actual phone calls through telephony providers. Octipus uses the existing STT/TTS pipeline for audio processing and routes conversations through the configured `voice` model topic for fast, direct LLM responses.

### Supported Providers

| Provider | Protocol | Credentials Needed |
|----------|----------|-------------------|
| **Twilio** | Programmable Voice + Media Streams | `twilio_account_sid`, `twilio_auth_token` |
| **Telnyx** | Call Control v2 | `telnyx_api_key`, `telnyx_connection_id` |
| **Plivo** | Voice API + XML | `plivo_auth_id`, `plivo_auth_token` |

### Setup (3 steps)

#### 1. Store provider credentials in the vault

Go to **Settings > Vault** in the web UI, or use the API.

> **Token:** these calls use a real API credential — create a Personal Access
> Token under **Settings → API Tokens** (or use a login JWT) and export it as
> `OCTIPUS_API_TOKEN`. (`MASTER_KEY` is the vault *encryption* key, not an API
> credential — it will 401.) The token must belong to an **admin** user to
> write system-scoped secrets.

> **Store at system scope:** telephony reads credentials from the **system**
> scope first, then falls back to the admin user. Pass `"systemLevel": true`
> so the credential lands at system scope (admin token required).

```bash
# Twilio example
curl -X POST http://localhost:3005/api/vault \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "twilio_account_sid", "value": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "systemLevel": true}'

curl -X POST http://localhost:3005/api/vault \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "twilio_auth_token", "value": "your_auth_token", "systemLevel": true}'
```

The phone number is **auto-detected** from your Twilio account — no need to configure it separately.

#### 2. Set the provider and webhook URL

```bash
# Enable Twilio
curl -X PUT http://localhost:3005/api/settings/voice.telephonyProvider \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "twilio"}'

# Set your public webhook URL (ngrok, Cloudflare Tunnel, etc.)
curl -X PUT http://localhost:3005/api/settings/voice.publicUrl \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "https://abc123.ngrok.io"}'
```

#### 3. Assign a model to the "voice" topic

In the **Models** page, assign a fast model to the `voice` topic. Local models (Ollama) give the lowest latency since there's no network round-trip.

That's it. The direct call path uses the configured voice prompt and the model
bound to the `voice` topic.

### Twilio Setup Guide (Detailed)

Step-by-step instructions for getting Twilio working from scratch.

#### Create a Twilio Account

1. Sign up at [twilio.com](https://www.twilio.com/)
2. Verify your email and phone number
3. Navigate to **Twilio Console > Account > API keys & tokens**

#### Gather Your Credentials

| Credential | Format | Where to Find |
|------------|--------|---------------|
| **Account SID** | Starts with `AC` + 32 hex chars (34 total) | Console dashboard, top of page |
| **Auth Token** | 32 hex characters | Console > Account > API keys & tokens |
| **Phone Number** | Auto-detected from account | No manual config needed |

#### Get a Phone Number

If your account has no phone numbers, buy one in **Twilio Console > Phone Numbers > Manage > Buy a number**. Octipus auto-detects available numbers from your account, so no manual phone number configuration is required.

#### Configure the Webhook URL

Your Octipus instance must be reachable from the public internet so Twilio can deliver call events. Use ngrok, Cloudflare Tunnel, or any reverse proxy to expose your local instance.

1. In Twilio Console, go to **Phone Numbers > Manage > Active Numbers**
2. Click your number
3. Under **Voice & Fax > A Call Comes In**, set the webhook to:
   ```
   https://your-public-url/api/voice/webhook/twilio
   ```
4. Set the HTTP method to **POST**

#### Language Configuration

Set the voice language in octipus settings (default: `en-US`):

```bash
curl -X PUT http://localhost:3005/api/settings/voice.language \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "en-US"}'
```

#### Troubleshooting Twilio Connections

| Symptom | Cause | Fix |
|---------|-------|-----|
| **HTTP 401** | Auth Token doesn't match Account SID | Regenerate the Auth Token in Twilio Console and update the vault |
| **HTTP 403** | Account suspended, stale Auth Token cached in vault, or sub-account vs main account mismatch | Verify account status; re-store credentials; ensure SID and token are from the same account |
| **HTTP 404** | Invalid Account SID (wrong format or doesn't exist) | Confirm SID starts with `AC` and is 34 characters total |
| **Phone number not detected** | Account has no numbers provisioned | Buy a number in Twilio Console |
| **Webhook timeout** | Twilio can't reach your public URL | Check ngrok/tunnel is running, firewall allows inbound HTTPS |
| **Signature verification failed** | Public URL mismatch or clock skew | Ensure `voice.publicUrl` matches the URL configured in Twilio exactly |

### How Calls Work

**Outbound calls** are initiated by agents via the `voice_call` tool:

```
Agent: "Call +1234567890 and tell them the deployment is complete"
→ Tool: initiate_call(to: "+1234567890", message: "...", mode: "notify")
→ Twilio dials the number
→ Person answers → TTS speaks the message → Hangup
```

**Conversation mode** enables interactive voice exchange:

```
Agent: "Call the client and discuss the project timeline"
→ Tool: initiate_call(to: "+1234567890", message: "Hello, I'm calling about...", mode: "conversation")
→ Twilio dials → Person answers → TTS speaks greeting
→ Person speaks → Provider STT transcribes → Direct LLM response → TTS speaks back
→ Repeat until hangup
```

**The conversation loop uses a shorter path** — it bypasses the root agent entirely:

```
Caller speaks → Provider STT (~1s) → Direct LLM call (~1-3s) → Provider TTS (~0.5s)
Total: ~2-5 seconds per turn
```

No classification, no worker spawning, no tool execution. The model assigned to
the `voice` topic is called directly with the phone conversation prompt.

### Call Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **notify** | Speak a message and hang up | Alerts, reminders, status updates |
| **conversation** | Interactive voice exchange | Discussions, Q&A, support calls |

### Tool Actions

| Action | Description |
|--------|-------------|
| `initiate_call` | Start a call (requires permission approval) |
| `continue_call` | Send next message in active conversation |
| `end_call` | Hang up |
| `get_status` | Check call state |
| `list_calls` | List active calls |

### Inbound Calls

Disabled by default. Enable with:

```bash
# Allow calls from specific numbers
curl -X PUT http://localhost:3005/api/settings/voice.inboundPolicy \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -d '{"value": "allowlist"}'

curl -X PUT http://localhost:3005/api/settings/voice.inboundAllowFrom \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -d '{"value": ["+1234567890", "+0987654321"]}'
```

Configure your provider's phone number to point webhooks at:
```
https://your-public-url/api/voice/webhook/twilio
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio (local or cloud STT) |
| POST | `/api/voice/speak` | Synthesize text to speech (TTS) and return audio |
| GET | `/api/voice/status` | Voice subsystem status and availability |
| POST | `/api/voice/install` | Download and install Whisper model |
| POST | `/api/voice/webhook/:provider` | Telephony webhook (call events) |
| POST | `/api/voice/webhook/:provider/status` | Telephony status callback |
| GET | `/api/voice/calls` | List active phone calls |
| GET | `/api/voice/telephony/health` | Provider connection health |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `voice.ttsVoice` | — | Voice for spoken replies and calls; empty = the bound engine's default |
| `voice.telephonyProvider` | `disabled` | Provider: twilio, telnyx, plivo |
| `voice.publicUrl` | — | Webhook URL (ngrok etc.) |
| `voice.inboundPolicy` | `disabled` | Inbound: disabled, allowlist, open |
| `voice.inboundAllowFrom` | — | Allowed inbound numbers (E.164) |

### Vault Keys

| Key | Provider | Required |
|-----|----------|----------|
| `twilio_account_sid` | Twilio | Yes |
| `twilio_auth_token` | Twilio | Yes |
| `twilio_phone_number` | Twilio | No (auto-detected) |
| `telnyx_api_key` | Telnyx | Yes |
| `telnyx_connection_id` | Telnyx | Yes |
| `telnyx_public_key` | Telnyx | No (webhook verification) |
| `plivo_auth_id` | Plivo | Yes |
| `plivo_auth_token` | Plivo | Yes |

### Security

- **Webhook signature verification** for all providers (Twilio HMAC-SHA1, Telnyx Ed25519, Plivo HMAC-SHA256)
- **Permission gating** — `initiate_call` requires user approval (ASK level)
- **Inbound filtering** — allowlist-based caller ID filtering
- **Call session tracking** — all calls tracked with status, duration, metadata

---

## Lessons from Twilio Connection Fixes

These improvements were made after debugging real Twilio integration issues and apply to the overall telephony subsystem:

- **Credential format validation before API calls** — Account SID is checked for `AC` prefix and 34-character length, Auth Token for 32-character length. Invalid formats are rejected early with a clear error message instead of sending a doomed API request.
- **Auto-detection of phone number** — Octipus queries the Twilio account's `IncomingPhoneNumbers` resource and picks the first available number. No manual phone number configuration is needed.
- **Detailed error messages per HTTP status code** — Each status (401, 403, 404, etc.) maps to a specific human-readable explanation and suggested fix, rather than a generic "connection failed" message.
- **Webhook signature verification** — Inbound webhooks are verified with each provider's native signing scheme and timing-safe checks where applicable: Twilio uses HMAC-SHA1 over the full webhook URL plus sorted POST parameters, Plivo uses its HMAC scheme, and Telnyx uses Ed25519 signatures. Treat `voice.publicUrl` and provider credentials as security-sensitive.
- **XML escaping for TwiML** — All dynamic text inserted into TwiML responses is XML-escaped to prevent injection. Characters `&`, `<`, `>`, `"`, and `'` are replaced with their XML entities.
- **Gather speech with fallback re-prompt** — If the caller doesn't speak during a `<Gather>` window, Octipus re-prompts instead of hanging up. This uses the `action` attribute to loop back to a re-prompt endpoint.
- **Enhanced speech gathering** — The `<Gather>` element uses `enhanced="true"` for higher-accuracy speech recognition when available on the Twilio account.

---

## Provider Comparison and Portability

The patterns established with Twilio apply to other providers, but each has protocol-level differences.

### Telnyx Differences

| Aspect | Twilio | Telnyx |
|--------|--------|--------|
| **Authentication** | Basic auth (SID + Token) | Bearer token |
| **Call API** | TwiML (XML) | Call Control v2 (JSON) |
| **Say/Speak** | `<Say>` TwiML verb | `speak` command in JSON |
| **Webhook verification** | HMAC-SHA1 | Ed25519 signature |
| **Unique requirement** | — | Connection ID required |
| **Health check** | Queries `/Accounts/{sid}` | Queries `/phone_numbers` endpoint |

### Plivo Differences

| Aspect | Twilio | Plivo |
|--------|--------|-------|
| **Authentication** | Basic auth (Account SID + Auth Token) | Basic auth (Auth ID + Auth Token) |
| **Call API** | TwiML (XML) | XML with different element names |
| **Gather speech** | `<Gather>` | `<GetInput>` |
| **Say** | `<Say>` | `<Speak>` (same) |
| **End call** | POST with `Status=completed` | DELETE request |
| **Webhook verification** | HMAC-SHA1 | HMAC-SHA256 with nonce |
| **Health check** | Queries `/Accounts/{sid}` | Queries `/Account/{authId}/` |

### Common Patterns (All Providers)

These patterns should be applied regardless of which provider is used:

- **Store credentials in the vault** — never in environment variables or config files. The vault encrypts at rest and controls access.
- **Credential format validation before API calls** — catch typos and wrong credentials early with format checks (prefix, length, character set).
- **Detailed error messages per HTTP status** — map each provider's error codes to actionable messages.
- **Auto-detect phone number where possible** — query the provider's number listing API instead of requiring manual configuration.
- **Webhook signature verification** — always verify inbound webhooks using the provider's signing method and timing-safe comparison.
- **XML/response escaping** — escape all dynamic content in TwiML or XML responses to prevent injection.
- **Gather speech with fallback** — always re-prompt on silence instead of dropping the call.
