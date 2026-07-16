# Voice & Phone Calls

Octipus includes voice capabilities at two levels:

1. **Local Voice I/O** — speech-to-text, text-to-speech, and wake word detection for hands-free local interaction
2. **Phone Calls** — make and receive actual phone calls via Twilio, Telnyx, or Plivo with interactive voice conversations

## Voice Data Flows — the three lines

Three input pipelines, one brain, one mouth. They differ only in how audio gets
*in* and back *out*; all transcribe at **16 kHz mono** (whisper's only input) and
all speak back through the configured TTS engine (Voxtral by default; also OpenAI
or local Piper). Detail for each stage is in the sections below.

**Line 1 — Turn-based web** (`useVoiceConversation.ts`): record an utterance, POST it, get one reply.

```text
🎤 mic ──▶ MediaRecorder (webm/ogg)          AnalyserNode RMS VAD; stops after SILENCE_MS (2 s)
   │
   ▼  Web Audio decode + OfflineAudioContext  →  encodeWav16kMono
 WAV 16 kHz mono ──base64──▶ POST /api/voice/transcribe
   │
   ▼  whisper.cpp (ggml-small.bin)             transcribeAudioBuffer → else Voxtral / OpenAI; stripNonSpeech
 transcript ──▶ sendMessage() ──▶ 🧠 ORCHESTRATOR ──▶ chat_response
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
 /voice  WebSocket  (engine from voice.sttProvider; ?engine= overrides)
   ├─ whisper : WhisperEngine.streamTranscribe → 2 s sliding window   (voice-ws.ts)
   ├─ mistral : MistralSTTEngine → wss Mistral realtime
   └─ openai  : OpenAIRealtimeSTTEngine → wss OpenAI realtime
   │
   ▼  {type:transcript} frames (running text) → client VAD dispatches delta on silence
 sendMessage() ──▶ 🧠 ORCHESTRATOR + voice-plan-gate ──▶ chat_response
   │                        ╲___ narrator: {type:speak} lifecycle frames over /ws
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
   ▼  generatePhoneReply  (voice-topic model, short prompt — NOT the full orchestrator)
 reply ── Mistral TTS → mp3 → ffmpeg → 16 kHz PCM
   │
   ▼  pcm16kToTwilioMedia:  resamplePcm16(16k→8k) → muLawEncode → base64
 8 kHz μ-law ──▶ carrier ──▶ 🔊 caller            paced real-time; RMS barge-in
```

**Where they converge**

```text
 Lines 1 & 2 ─▶ orchestrator.handleMessage (full pipeline + voice-plan-gate)
 Line 3      ─▶ generatePhoneReply (direct-LLM fast path)
                        │
        planning turns (web) + phone reply run on the  ► voice-topic model ◄  (Gemini Flash Lite)
        heavy post-handoff work → normal routing
                        │
        Mouth: configured TTS (Voxtral en_paul_neutral by default).  STT floor: 16 kHz mono; telephony bridges 8↔16 kHz.
```

## Local Voice

### Speech-to-Text (STT)

Pick the engine in **Settings → Voice → "Which engine transcribes your speech"**
(`voice.sttProvider`).

| `voice.sttProvider` | Type | Notes |
|--------|------|-------|
| **auto** (default) | — | Best available: a configured cloud realtime engine, else local Whisper |
| **whisper** | Local | whisper.cpp — offline, no key, free. Needs the model installed (`octi setup`); higher latency |
| **mistral** (Voxtral) | Cloud | `voxtral-mini` realtime streaming. Needs a Mistral API key |
| **openai** | Cloud | `gpt-4o-transcribe` realtime streaming. Needs an OpenAI API key |

**API:** `POST /api/voice/transcribe` — send base64 audio, receive text.

**Config:**
```
voice.whisperModelPath = /path/to/ggml-base.bin
voice.language = en
```

### Text-to-Speech (TTS)

Pick the engine in **Settings → Voice → "Which engine speaks replies aloud"**
(`voice.ttsProvider`).

| `voice.ttsProvider` | Type | Notes |
|--------|------|-------|
| **mistral** (Voxtral, default) | Cloud | `voxtral-mini-tts`. Needs a Mistral API key |
| **openai** | Cloud | `gpt-4o-mini-tts`. Needs an OpenAI API key |
| **piper** | Local | Neural TTS — offline, no key. Needs the Piper binary + a `.onnx` voice |

### Wake Word Detection

| Engine | Type | Notes |
|--------|------|-------|
| **Sherpa-ONNX** | Local | ONNX keyword spotting |
| **Picovoice** | Cloud | High accuracy, requires API key |
| **VAD** | Local | Voice Activity Detection fallback |

---

## Realtime Web Voice Conversation

The web chat (`/chat`) has a live, hands-free voice mode: you speak, Octipus
transcribes, runs the **same orchestrator pipeline as typed chat**, and speaks
the reply back — with barge-in and per-sentence streaming TTS. Two mic modes
share one owner (only one active at a time):

- **Turn-based** (`web/hooks/useVoiceConversation.ts`): record an utterance →
  `POST /api/voice/transcribe` → send as a chat turn → speak the reply.
- **Realtime / streaming** (`web/hooks/useVoiceRealtime.ts`, Phase 4b): holds a
  duplex WebSocket to `/voice` open, streams 16 kHz mono PCM off an AudioWorklet,
  and receives a running transcript back. Client-side VAD segments utterances;
  barge-in interrupts the spoken reply when you talk over it (Phase 4c).

### The speak-to-the-orchestrator loop

A spoken turn runs the *same* path as text — classification, memory, agent
spawning — so nothing downstream is voice-specific. What differs is a
**voice-only conversation layer** inside the orchestrator:

**Propose-then-confirm gate** (`src/core/orchestrator/voice-plan-gate.ts`, wired
in `src/core/orchestrator/service.ts` `handleMessageInner`). With the mic on, a
work request is **not dispatched immediately**. Octipus proposes an approach out
loud — or asks one short clarifying question when the request is vague — and
waits for your go:

- work **or ambiguous** turn → **propose** (on the fast voice model)
- "yes / go / do it" → **execute** the stored plan via the normal work path
- "no / cancel / stop" → drop the plan, keep chatting
- anything else → **refine**: fold the new guidance in and re-propose

Pending-plan state is per-session and in-memory. Affirmation vs. cancellation is
decided by wording, because the classifier tags both "yes" and "no" as
`approval`. The gate is **read-only over the orchestrator** — it can't spawn
anything itself, so there's no runaway; the only thing that starts work is your
spoken confirmation. Typed chat is unaffected (gated on a per-session voice
flag set by the mic toggle over `/ws`).

**Backend narrator** (`src/voice/narrator.ts`, wired in `src/api/websocket.ts`).
Long agent turns are narrated as they happen instead of read back stale:
orchestrator lifecycle events (`worker_spawned`, `worker_completed`) become
`{type:"speak"}` frames over the persistent `/ws` socket ("On it — I've started
the researcher…"), scoped to the voice-mode session. The actual reply is spoken
from the `chat_response` message, **fresh per turn** — so voice is decoupled from
turn timing and never repeats a stale answer.

**Fast voice model.** Interactive planning turns run on whatever model is mapped
to the **`voice` topic** (e.g. a flash-tier model) so they stay snappy; the heavy
work after handoff uses normal routing. Map it on the Models/Topics page, or
`registry.updateModel(name, { topicRoles: { voice: 'primary' } })`.

### STT engine for the realtime loop

The engine is chosen by the `voice.sttProvider` setting (Settings → Voice). The
`/voice` WebSocket also accepts an explicit `?engine=` override (used for
testing); when omitted it follows the setting:

- **auto** (default) — cloud realtime if a key is set (Voxtral, then OpenAI),
  else local whisper.
- **whisper** — local whisper.cpp streaming; no key, offline. Prefer
  `ggml-small.bin` (`voice.whisperModelPath`) over `base` for accuracy. Streaming
  windows must be ≥ 2 s (1 s windows return empty on the base model).
- **mistral** — Mistral Voxtral realtime streaming STT (cloud, needs the Mistral
  key); more accurate than local small.
- **openai** — OpenAI `gpt-4o-transcribe` realtime streaming (cloud, needs the
  OpenAI key).

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
| Propose-then-confirm gate | `src/core/orchestrator/voice-plan-gate.ts`, `src/core/orchestrator/service.ts` |
| Telephony media stream (`/voice/media/:provider`) | `src/api/voice-media-ws.ts` |
| Web hooks | `web/hooks/useVoiceRealtime.ts`, `web/hooks/useVoiceConversation.ts` |
| Audio codec (μ-law / resample) | `src/voice/audio-codec.ts` |

> **Known gap:** streaming TTS synthesizes and plays one sentence at a time, so
> there's an audible pause between sentences (the next sentence's synth
> round-trip). Prefetching the next clip while the current one plays would close
> it.

---

## Phone Calls

Make and receive actual phone calls through telephony providers. Octipus uses the existing STT/TTS pipeline for audio processing and routes conversations through an expert for fast, direct LLM responses.

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

That's it. The expert prompt is automatically loaded from the Communicator expert.

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

**The conversation loop is fast** — it bypasses the orchestrator entirely:

```
Caller speaks → Provider STT (~1s) → Direct LLM call (~1-3s) → Provider TTS (~0.5s)
Total: ~2-5 seconds per turn
```

No classification, no worker spawning, no tool execution. The model assigned to the `voice` topic is called directly with the Communicator expert's system prompt.

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
| POST | `/api/voice/transcribe` | Transcribe audio (local STT) |
| GET | `/api/voice/status` | Voice subsystem status |
| POST | `/api/voice/webhook/:provider` | Telephony webhook (call events) |
| GET | `/api/voice/calls` | List active calls |
| GET | `/api/voice/telephony/health` | Provider connection health |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `voice.sttProvider` | `auto` | STT engine: auto, whisper, mistral, openai |
| `voice.ttsProvider` | `mistral` | TTS engine: mistral (Voxtral), openai, piper |
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
- **Webhook signature verification** — Inbound webhooks are verified using HMAC-SHA1 with timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks. The signature is computed over the full webhook URL plus sorted POST parameters.
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
