# Voice & Phone Calls

Octipus hears and speaks:

- **Hear** — speech to text: the microphone in the chat, a live conversation,
  voice notes on Telegram / WhatsApp / Slack / Teams, audio files, phone calls.
- **Speak** — text to speech: spoken replies in a conversation, voice-note
  answers, the `speak` tool, phone calls.

Both are done by a **speech engine**: a model, bound to the **Transcription**
lane (hear) or the **Speech** lane (speak) like every other kind of model
work. You choose engines, test them and pick a voice under **Settings →
Voice**; `octi setup` asks the same questions in the terminal.

Nothing bound means speech is **off** (not broken): the microphone is hidden,
a voice note gets one line asking to type, spoken replies stop
([MODULES.md → Capability gates](MODULES.md#capability-gates)).

## One pipeline

Every surface is a transport into the same pipeline. Where a turn ends, what
of a reply is said aloud and how it is cut into sentences are decided on the
server, once.

```text
 microphone ──▶ endpointer ──▶ speech to text ──▶ the turn's text ──▶ 🧠 root agent
 (16 kHz PCM)   who is talking,   the Transcription                    (the same turn as typed
                when they stop    lane's engine                         chat; `spoken` style)
                                                                              │ text, as it is written
 speaker   ◀── PCM, as it is ◀── text to speech ◀── sentence chunker ◀───────┘
               generated          the Speech lane's   + text shaper (no markup,
                                  engine + voice       code, links or sources)
```

| Surface | How audio gets in and out | What it uses of the pipeline |
|---|---|---|
| **Live conversation** (web chat, mobile app in *Octipus server* mode) | `/voice` WebSocket, `mode=conversation`: PCM up, PCM (or WAV clips) down | all of it — see [Live conversation](#live-conversation) |
| **Dictation** (the composer's microphone) | a recording → `POST /api/voice/transcribe` | hear |
| **Mobile app, *This phone* mode** | the phone's own recogniser and voice; only text reaches the server (`chat.send` with `spoken`) | the turn, the spoken style, the sentence chunker (ported) |
| **Voice notes on channels** | the attachment → transcript → the turn; the reply goes back as text **and** audio | hear, shaper, speak |
| **TUI push-to-talk** | records locally → `/api/voice/transcribe`, `/api/voice/speak` | hear, shaper, speak |
| **`transcribe_audio` / `speak` tools** (and the MCP server's) | a workspace file in, an audio file out | hear / shaper + speak |
| **Phone calls** | a carrier's media stream or its speech gathering | see [Phone Calls](#phone-calls) |

## Engines are models

Every place that hears or speaks resolves its engine from the lane
(`src/voice/resolve.ts`):

- **primary, then backup** — a primary that cannot run (not installed, no key,
  the server is down) or fails falls to the backup, logged with the reason;
- **protection levels** — content that must stay local only reaches a local
  engine or a speech server at a private address: a cloud primary is skipped
  for it and a local backup takes it;
- **accounting** — every call is recorded against its row (cost, spend budgets);
- an account that may not use the install's hosted keys gets local engines
  (and private-address speech servers) only.

| Engine | Lane | Row (provider / model id) | Notes |
|--------|------|-----|-------|
| faster-whisper | Transcription | `local-audio` / `faster-whisper:<model>` | On this machine. `<model>` is a size (`small`), a release (`large-v3-turbo`, `distil-large-v3`) or a CTranslate2 repository on Hugging Face. Needs `uv` and ffmpeg. Uses a GPU when it finds one (`metadata.speech.device`). |
| whisper.cpp | Transcription | `local-audio` / `whisper.cpp:base` | On this machine, no Python; built from source on install (git, cmake, a compiler). The row's *Model file* names another ggml model. |
| Voxtral | Transcription | `mistral` / `voxtral-mini-latest` | Cloud; streams live. Mistral key (or the row's own key). |
| OpenAI | Transcription | `openai` / `gpt-4o-transcribe` | Cloud; streams live (`gpt-realtime-whisper`). OpenAI key. |
| Kokoro | Speech | `local-audio` / `kokoro:<voice>` | On this machine, 54 voices in nine languages. Needs `uv`. |
| Piper | Speech | `local-audio` / `piper:<voice>` | On this machine, very small. You install the binary; the row's *Model file* is the `.onnx` voice. |
| Voxtral | Speech | `mistral` / `voxtral-mini-tts-2603` | Cloud. Preset voices or a reference clip. |
| OpenAI | Speech | `openai` / `gpt-4o-mini-tts` | Cloud. Preset voices, a style description, speed; streams. |
| **Your own speech server** | either | a row with an `endpoint` (`custom-openai`) / any model id | Any OpenAI-compatible server — see below. |

**Old engine names still work as requests:** `?engine=` on the `/voice`
socket and `model` on `/api/voice/transcribe` accept a row name or `auto`,
`local`, `whisper`, `whisper-cpp`, `fasterwhisper`, `mistral`/`voxtral-*`,
`openai`/`whisper-1` — they pick the bound row of that engine.

### Local engines

**Settings → Voice → Add an engine → Install** downloads and sets up
faster-whisper, whisper.cpp or Kokoro on the server and follows the job on the
page (`POST /api/voice/engines/install`); `octi setup` does the same in the
terminal. An installed engine takes its lane when the lane is free.

- faster-whisper and Kokoro run in **resident workers**: the model is loaded
  once and shared, and the worker stops after ten idle minutes. A first call
  pays the load; the ones after it do not.
- A GPU: faster-whisper uses one when CTranslate2 finds it, and falls back to
  the CPU — saying so in the server log — when the GPU cannot load the model.
  Set the engine's device to *GPU* (Settings → Voice → the engine → Edit) to
  have the CUDA libraries installed with it and to fail instead of falling back.
- Docker: the image carries ffmpeg and `uv`; models download into the
  `octipus-models` volume. whisper.cpp is not buildable in the image (no
  compiler) — use faster-whisper there.

### Your own speech server

Any model served over the OpenAI audio API — `POST /v1/audio/transcriptions`
and `POST /v1/audio/speech` — is a speech engine: **Settings → Voice → Your
own speech server**, with the server's URL, the model id as the server serves
it, and optionally the name of the secret holding its key
(`POST /api/voice/engines/server`). That covers
[Speaches](https://github.com/speaches-ai/speaches), vLLM and vLLM-Omni,
LocalAI, NVIDIA NeMo-Speech / NIM, and hosted ones such as Groq or DeepInfra.
A server at a private address counts as local: protected content may use it.

`docker compose --profile speech up -d` starts a Speaches server on the GPU
(`http://octipus-speech:8000/v1`) as a ready example.

What differs between models rides on the row (`metadata.speech`, editable
under the engine's *Advanced* settings). A row starts with what is known of
its model id (`src/voice/speech-hints.ts`), so these work by naming them:

| Model | Lane | What the row starts with |
|---|---|---|
| `openai/whisper-large-v3-turbo` (and any Whisper) | Transcription | plain transcription; live audio is transcribed one whole turn at a time |
| `nvidia/nemotron-3.5-asr-streaming-0.6b`, Parakeet, Canary | Transcription | clips uploaded as 16 kHz WAV; live audio over NeMo-Speech's realtime socket |
| `openbmb/VoxCPM2` | Speech | a voice description is passed as VoxCPM's `(…)` text prefix; reference clip for cloning; streams; 48 kHz |
| `BreezeBlue/Breeze-TTS-2` | Speech | speaker tags `S0`–`S9`; `instructions` for voice design; reference clip; streams; 24 kHz |

Settings a row can carry: how a voice description is passed (`instructions`:
`field` / `prefix` / `none`), whether a reference clip is taken (`cloning`),
whether audio streams (`streams`), whether `speed` is taken, `sampleRate`,
extra request fields sent as they are (`extraBody`, e.g. `cfg_value`,
`inference_timesteps`, `seed`), `upload` (`wav` = transcode clips first), and
the server's realtime transcription socket (`realtime`: the OpenAI realtime
protocol as Speaches and NIM speak it, or NeMo-Speech's).

Changing model is changing the row: add the other model, make it primary; the
one it replaces stays as the backup.

> **Checked against:** faster-whisper (tiny and large-v3-turbo) and Kokoro,
> installed through the API and driven end to end; and an OpenAI-compatible
> server holding the real large-v3-turbo weights. The request shapes for
> VoxCPM2 and Breeze-TTS-2 follow vLLM-Omni's speech API documentation and
> the NeMo-Speech realtime socket follows NVIDIA's `docs/api.md`; neither was
> run against the real model here (both need a GPU server).

## Voices

A **voice profile** (Settings → Voice → Voices) is a named way of speaking:

- a voice the engine offers (`af_sarah`, `alloy`, `S3`),
- a description in words — "a calm woman in her forties, slight Scottish
  accent" — for engines that design a voice from text,
- a reference clip with its transcript, for engines that clone.

A described voice is generated anew for every sentence and drifts; *Keep this
exact voice* saves a preview as the profile's reference clip, so an engine
that clones repeats it. The **active** profile (`voice.profile`) is what
replies, voice notes and phone calls are spoken in; `/api/voice/speak`, the
`speak` tool (`voice`, `style`, `speed`) and the MCP `octipus_speak` tool may
name another. A profile made for one engine is handed to that engine only — a
preset id means nothing to another — and the backup speaks in its own default.
Reference clips are files under `~/.octipus/voices` (`OCTIPUS_VOICES_DIR`).

`voice.ttsVoice` (a bare voice id for the primary engine) is still honoured
when no profile is active.

## Live conversation

A hands-free conversation: you talk, Octipus answers aloud while it is still
writing, and talking over it stops it. The web chat's conversation button and
the mobile app's *Octipus server* mode both use it.

The client opens `/voice?mode=conversation&session=<chat session>&token=<ws
ticket>` and is a transport: it streams the microphone as 16 kHz mono PCM —
all the time, with echo cancellation — and plays the audio it is sent. The
server (`src/voice/session.ts`):

1. **Ends the turn** (`src/voice/endpointer.ts`): speech starts after 60 ms of
   sound above the room's own level, and ends after a pause of
   `voice.endpointSilenceMs` (700 ms). A click or a cough is not a turn.
2. **Transcribes it**: a streaming engine hears continuously and its text is
   cut where the turn ended; any other engine transcribes the whole utterance
   once — no fixed windows cutting words in half.
3. Sends `{"type":"utterance","text":…}`; the client sends it as the chat
   message (`chat.send` with `spoken: true`), so the turn is the same one a
   typed message starts — memory, tools, agents, approvals.
4. **Speaks the reply as it is written**: the root agent's text deltas go
   through the sentence chunker; each sentence is synthesised as soon as it is
   complete, the next one while the current one plays. Markup, code, links
   and the sources footer are never read out
   (`src/shared/speech-text.ts`, shared with the web).
5. **Stops when talked over** (`voice.bargeIn`): sustained speech above the
   reply's own echo cancels what is queued and becomes the next turn.

A turn whose reply is read aloud gets one **spoken-reply directive** in its
system prompt (`SPOKEN_REPLY_DIRECTIVE`): answer first, short sentences, no
markup, offer anything long in writing. It applies wherever the reply is
heard — a `chat.send` marked `spoken`, the mobile voice channel, a session in
web voice mode — and the phone prompt is built on the same text.

Measured on a 4-core machine without a GPU (faster-whisper tiny, Kokoro, a
model writing eight words a second): the turn's text 1.1 s after the last
word (0.7 s of it the pause), the first audio 2.6 s after it — before the
model had finished the reply.

### Socket protocol

`mode` omitted is the older dictation protocol (PCM in, a running
`transcript` out), unchanged.

| Client → server | |
|---|---|
| binary frames | 16 kHz mono s16le PCM |
| `{"type":"interrupt"}` | stop speaking |
| `{"type":"expect_reply"}` | speak the next reply although it was typed |
| `{"type":"say","text":…}` | read this aloud |
| `{"type":"playback","state":"ended"}` | everything sent has been played |
| `{"type":"stop"}` | end |

| Server → client | |
|---|---|
| `{"type":"ready","mode":"conversation","engine":…,"live":bool,"speak":bool}` | `speak:false`: no speech engine — replies are shown only |
| `{"type":"speech_start"}`, `{"type":"transcript","text":…,"final":false}` | someone is talking; what they have said so far |
| `{"type":"utterance","text":…}` | the finished turn |
| `{"type":"audio","seq":n,"format":"pcm"\|"wav","sampleRate":hz,"ms":n,"text"?:…}` + one binary frame | reply audio: ~200 ms PCM frames, or (`&audio=wav`) one WAV per sentence |
| `{"type":"speaking","on":bool}`, `{"type":"barge_in"}` | the reply started / ended; drop queued audio now |
| `{"type":"error","message":…}` | |

Query: `speak=0` (listen only), `audio=wav`, `silence=<ms>`, `engine=<row>`.

### The propose-then-confirm gate and the narrator (web)

Unchanged, and on top of the pipeline. With the web's voice mode on
(`voice.set`), a work request is not dispatched at once: Octipus proposes an
approach out loud — or asks one clarifying question — and waits for "yes"
(`src/core/agent/voice-plan-gate.ts`). Long turns are narrated
(`src/voice/narrator.ts`): an agent the root agent starts is announced, and
its finish too, unless the answer is already being spoken. The root agent's
own start is not announced. Interactive planning turns run on the model mapped
to the **`voice` topic**.

## Other surfaces

- **Dictation.** The composer's microphone records and sends the clip to the
  server's engine. Only when the server has none does it fall back to the
  browser's own recognition, and says so (that audio goes to the browser
  vendor).
- **Voice notes on channels.** A voice note is transcribed and answered in
  text and in voice (Telegram and WhatsApp as a voice note, Slack as a file;
  Teams gets text and a link). The spoken part is the reply as it would be
  said, cut at a sentence within 2000 characters.
- **Tools.** `transcribe_audio` (long recordings are cut into parts and
  stitched; `timestamps` returns segments) and `speak` (`voice`, `style`,
  `speed`) are on the general role, gated on the lanes.
- **TUI.** Alt+T / F8: push-to-talk, recorded and played on the terminal's
  machine, heard and spoken by the server's engines.

## API

| Method | Path | |
|--------|------|---|
| GET | `/api/voice/status` | whether hear / speak are available, and why not |
| POST | `/api/voice/transcribe` | `{audio (base64), format?, model?, sessionId?}` → `{text, model, language, duration}` |
| POST | `/api/voice/speak` | `{text, voice?, profile?, instructions?, speed?, format?, raw?, model? (admin), sessionId?}` → the audio; `X-Speech-Model` names the engine. Text is shaped for speech unless `raw`. |
| GET | `/api/voice/voices` | the engine's voices, the profiles, the active one |
| PUT / DELETE | `/api/voice/profiles/:name` | create or replace / remove a voice profile (admin) |
| POST | `/api/voice/profiles/active` | which profile speaks (admin) |
| GET | `/api/voice/engines` | everything the Voice page shows (admin) |
| POST | `/api/voice/engines/install` | download and set up a local engine in the background (admin) |
| POST | `/api/voice/engines/use` | register a built-in engine and bind it (admin) |
| POST | `/api/voice/engines/server` | add a model on your own speech server (admin) |
| PATCH / DELETE | `/api/voice/engines/:name` | an engine's own settings / remove it (admin) |

Binding a lane by hand is still `PUT /api/topics/<transcription\|speech>/binding`;
a model that is not a speech engine of that direction is refused.

## Settings

| Setting | Default | |
|---------|---------|---|
| `voice.language` | `en` | the language spoken (`auto` lets the engine detect it) |
| `voice.profile` | — | the active voice profile; empty = the engine's default voice |
| `voice.endpointSilenceMs` | `700` | live conversation: the pause that ends your turn |
| `voice.bargeIn` | `true` | live conversation: talking over a reply stops it |
| `voice.ttsVoice` | — | older: a bare voice id for the primary engine, used when no profile is active |

`voice.sttProvider`, `voice.fasterWhisperModel`, `voice.whisperModelPath`,
`voice.ttsProvider` and `voice.piperModelPath` are retired (turned into lane
bindings once, on the first boot after that upgrade); `voice.wakeWord` is
removed — nothing on the server listened for one.

## Key files

| Area | File |
|------|------|
| Lane resolution: primary/backup, protection, accounting, voices, PCM streams | `src/voice/resolve.ts` |
| Engines as model rows; your own speech server | `src/voice/speech-rows.ts`, `src/voice/compatible.ts`, `src/voice/speech-hints.ts` |
| Engine adapters (subprocess and socket plumbing) | `src/voice/stt.ts`, `src/voice/tts.ts`, `src/voice/resident-worker.ts`, `*_worker.py` |
| Voice profiles | `src/voice/profiles.ts` |
| The conversation: endpointing, the session, the socket | `src/voice/endpointer.ts`, `src/voice/session.ts`, `src/api/voice-ws.ts` |
| Text shaping, sentence chunking, the spoken-reply directive | `src/shared/speech-text.ts` |
| Installing local engines; the Voice page's data | `src/voice/install-jobs.ts`, `src/voice/provision.ts`, `src/voice/whisper.ts`, `src/voice/overview.ts` |
| Routes | `src/api/routes/voice.ts` |
| Web | `web/components/settings/voice-tab.tsx`, `web/hooks/useVoiceRealtime.ts`, `web/components/chat/prompt-input.tsx` |

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
