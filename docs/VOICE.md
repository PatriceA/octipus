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
- A GPU: faster-whisper uses one when CTranslate2 finds it. On *Automatic* the
  CUDA libraries (cuBLAS, cuDNN) are installed with it when the host has an
  NVIDIA driver (a CPU-only host never downloads them), and the worker decodes
  a second of silence on the GPU before it is used: when the GPU cannot load
  or run the model, it falls back to the CPU and says so in the server log,
  which also names the device the model ended on. Set the engine's device to
  *GPU* (Settings → Voice → the engine → Edit) to fail instead of falling back.
- A worker that answers one request with an error keeps running with its
  model loaded; one that exits or stops answering is replaced on the next
  request (also one that died while idle). Shutting the server down stops them.
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
under the engine's *Advanced* settings). What is known of its model id
(`src/voice/speech-hints.ts`) applies without being stored, so these work by
naming them:

| Model | Lane | What the row starts with |
|---|---|---|
| `openai/whisper-large-v3-turbo` (and any Whisper) | Transcription | plain transcription; live audio is transcribed one whole turn at a time |
| `nvidia/nemotron-3.5-asr-streaming-0.6b`, Parakeet, Canary | Transcription | clips uploaded as 16 kHz WAV; live audio over NeMo-Speech's realtime socket |
| `openbmb/VoxCPM2` | Speech | a voice description is passed as VoxCPM's `(…)` text prefix; reference clip for cloning; streams; 48 kHz |
| `BreezeBlue/Breeze-TTS-2` | Speech | speaker tags `S0`–`S9` (`S0` unless a voice is chosen); `instructions` for voice design; reference clip; streams; 24 kHz |

Settings a row can carry: how a voice description is passed (`instructions`:
`field` / `prefix` / `none`), whether a reference clip is taken (`cloning`),
whether audio streams (`streams`), whether `speed` is taken, `sampleRate`,
extra request fields sent as they are (`extraBody`, e.g. `cfg_value`,
`inference_timesteps`, `seed`), `upload` (`wav` = transcode clips first), and
the server's realtime transcription socket (`realtime`: the OpenAI realtime
protocol as Speaches and NIM speak it, NeMo-Speech's, or `off` — no live
socket even for a model known to have one; each turn is then transcribed
whole). A NeMo socket is told to end an utterance (`endpointing_ms`) 200 ms
before the conversation's own end-of-turn pause (`voice.endpointSilenceMs`),
500 ms at most, so its transcript arrives before the turn ends; a caller of
`resolveSttEngine` may pass its own `endpointSilenceMs`.

A row stores only the settings chosen for it: the Voice page sends what was
changed, `null` clears a setting (the model's default applies again), and
`realtime` is merged into the stored one, so turning the socket off keeps its
URL and rate. Changing the model id of a row starts again from what the new
model is known for; the old model's defaults do not follow it (VoxCPM2's 48 kHz
would play Breeze's 24 kHz audio at double speed), choices made for the row do.

Where the endpoint is decides whether the row is local: at a private address
it is, and moved to a public host it no longer is. A local row's realtime
socket (`realtime.url`) must be at a private address too — a public one is
refused, since live audio of protected conversations would go there.

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
Reference clips are files under `~/.octipus/voices` (`OCTIPUS_VOICES_DIR`),
stored as mono 16-bit WAV at 24 kHz and cut to 20 seconds: a browser records
WebM or Ogg, which servers that read clips with soundfile or librosa
(vLLM-Omni, VoxCPM2, Breeze) cannot open. The conversion needs ffmpeg; without
it a WAV upload is still taken and anything else is refused. *Remove clip* on
the profile (or `clip: null`) removes it. A clip file that has gone missing is
logged once and the profile speaks without it.

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
   reply's own echo cancels what is queued and becomes the next turn. Speech
   that starts while a reply is still being synthesised (not yet heard) drops
   it the same way, and a reply never starts while the person is talking.

**Which replies are read.** `spoken` is part of the message (`chat.send`
`spoken`, REST `/api/chat` `spoken`, the `mobile-voice` channel): the turn
that answers it marks its streamed text (`chat.delta` `spoken`) and its
result (`chat.response` `response.spoken`), both with the root agent's id.
The conversation speaks those turns and follows one at a time by that id, so
replies never mix:

- Two utterances in a row: each reply is heard once, in order.
- Talking over a reply silences the rest of the model call that was writing
  it. If what was said is steered into the running turn, the turn's next
  model call — the one that heard it — is spoken; if it was queued as its own
  turn, that turn's reply is.
- A failed or stopped turn (`chat.error`) ends there.
- A typed message is answered in writing and not read aloud, also in web
  voice mode, unless the client sent `expect_reply` first. A background reply
  (a reminder, a finished task) is not read either.
- A sentence the speech engine fails on ends that reply's speech (one error,
  not one per sentence).

Interim transcripts (`transcript`) come from a streaming engine, or from a
batch engine on this machine, which looks at the turn so far every 1.5 s; a
hosted batch engine is asked only once, when the turn ends, so it is never
billed for the same audio twice. A streaming engine that only reports a
finished segment (NeMo's realtime server) gets up to 1.5 s after the pause to
report it.

The chat's protection level decides which engines may hear and speak it. A
conversation can be opened on a chat that does not exist yet (the first
utterance creates it); from the moment it exists its level counts, and a
hosted streaming engine the level no longer allows is closed at the end of
the turn — later turns go through the lane, which picks a local engine or
refuses.

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
| `{"type":"expect_reply"}` | speak the next turn's reply although it was typed (a "read that again") |
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

Query: `speak=0` (listen only), `audio=wav`, `silence=<ms>` (300–3000),
`partials=0` (no interim transcripts), and, for an admin only, `engine=<row>`
(the speech-to-text engine) and `tts=<row>` (the text-to-speech engine);
anyone else gets the lanes' bindings.

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
| POST | `/api/voice/transcribe` | `{audio (base64), format?, model? (admin; `auto`/`local` for anyone), sessionId?}` → `{text, model, language, duration}` |
| POST | `/api/voice/speak` | `{text, voice?, profile?, instructions?, speed?, format?, raw?, model? (admin), sessionId?}` → the audio; `X-Speech-Model` names the engine. Text is shaped for speech unless `raw`; PCM comes as `audio/L16;rate=<hz>;channels=1`. |
| GET | `/api/voice/voices` | the engine's voices, the profiles, the active one (a member sees each profile's name, note, voice and whether it has a clip) |
| PUT / DELETE | `/api/voice/profiles/:name` | create or replace / remove a voice profile (admin) |
| POST | `/api/voice/profiles/active` | which profile speaks (admin) |
| GET | `/api/voice/engines` | everything the Voice page shows (admin) |
| POST | `/api/voice/engines/install` | download and set up a local engine in the background (admin); one job per engine and model |
| POST | `/api/voice/engines/use` | register a built-in engine and bind it (admin) |
| POST | `/api/voice/engines/server` | add a model on your own speech server (admin) |
| PATCH / DELETE | `/api/voice/engines/:name` | an engine's own settings / remove it (admin) |

Binding a lane by hand is still `PUT /api/topics/<transcription\|speech>/binding`;
a model that is not a speech engine of that direction is refused.

## Settings

| Setting | Default | |
|---------|---------|---|
| `voice.language` | `en` | the language spoken (`auto` lets the engine detect it). A locale (`en-US`, `de_DE`) works too: engines are sent its two-letter code, a phone carrier the locale |
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
| Engines as model rows; your own speech server; the language engines are sent | `src/voice/speech-rows.ts`, `src/voice/compatible.ts`, `src/voice/speech-hints.ts`, `src/voice/speech-language.ts` |
| Engine adapters (subprocess and socket plumbing) | `src/voice/stt.ts`, `src/voice/tts.ts`, `src/voice/resident-worker.ts`, `*_worker.py` |
| Voice profiles | `src/voice/profiles.ts` |
| The conversation: endpointing, the session, the socket | `src/voice/endpointer.ts`, `src/voice/session.ts`, `src/api/voice-ws.ts` |
| Text shaping, sentence chunking, the spoken-reply directive | `src/shared/speech-text.ts` |
| Installing local engines; the Voice page's data | `src/voice/install-jobs.ts`, `src/voice/provision.ts`, `src/voice/whisper.ts`, `src/voice/overview.ts` |
| Routes | `src/api/routes/voice.ts` |
| Web | `web/components/settings/voice-tab.tsx`, `web/hooks/useVoiceRealtime.ts`, `web/components/chat/prompt-input.tsx` |

---

## Phone Calls

Make and receive phone calls through Twilio, Telnyx or Plivo. A call is a
conversation with the model mapped to the **`voice` topic**, called directly
(no root agent, no tools) with the phone prompt, and spoken in the install's
Speech engine and active voice profile when one is available. Only calls from
your own, verified number can reach the full assistant — see
[The full assistant on your own number](#the-full-assistant-on-your-own-number).

Two ways a call runs:

- **Live media stream** (any of the three carriers, `voice.streaming` on,
  `voice.publicUrl` reachable over wss): the carrier streams the call's audio
  both ways and Octipus runs the same pipeline as the web conversation
  (`src/voice/telephony/media-call.ts`): its endpointer ends the caller's turn,
  the Transcription lane hears it, the reply is spoken sentence by sentence
  while the model writes it (μ-law, 20 ms frames, paced in real time), and
  talking over a reply stops it. The carriers differ only in how the stream
  is started and in their frame format (`src/voice/telephony/media-wire.ts`):
  Twilio `<Connect><Stream>`; Telnyx `streaming_start` with bidirectional RTP
  in PCMU (after the greeting has been spoken); Plivo `<Stream
  bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">`.
  The socket (`/voice/media/:provider`) is opened with a single-use token the
  webhook minted for that call, and the stream must be for that call.
- **Turn by turn** (every provider; the default): the carrier gathers the
  caller's speech and sends it as text; the reply is played from the install's
  Speech engine (`<Play>` of a short-lived clip under
  `/api/voice/webhook/audio/:id`) when one is bound and `voice.publicUrl` is
  set, else read by the carrier's own voice in `voice.language`.

Both use one reply implementation (`src/voice/telephony/reply.ts`). The prompt
is the call's own (`make_call`'s `instructions`), else `voice.expertPrompt`,
else a phone prompt built on the spoken-reply directive. The model ends a call
with `[END_CALL]` after a farewell. Calls in progress and those ended in the
last hour are listed at `GET /api/voice/calls`.

### Supported Providers

| Provider | Protocol | Credentials Needed |
|----------|----------|-------------------|
| **Twilio** | Programmable Voice + Media Streams | `twilio_account_sid`, `twilio_auth_token` |
| **Telnyx** | Call Control v2 + media streaming (bidirectional RTP) | `telnyx_api_key`, `telnyx_connection_id`, `telnyx_public_key` |
| **Plivo** | Voice API + XML + audio streaming | `plivo_auth_id`, `plivo_auth_token` |

All three carry live audio (`voice.streaming`) and report a STIR/SHAKEN
caller-ID verification, so the full assistant works on each — for calls on
US and Canadian networks, where STIR/SHAKEN applies.

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

On the **Topics** page, assign a fast model to the `voice` topic. Local models (Ollama) give the lowest latency since there's no network round-trip.

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

The call's language is `voice.language` (default: `en`). A two-letter code is
enough: the carrier gets the matching locale (`en` → `en-US`). Set a locale
only to choose a regional voice and recogniser (`en-GB`, `pt-BR`); the speech
engines are sent its two-letter code either way:

```bash
curl -X PUT http://localhost:3005/api/settings/voice.language \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "de"}'
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

**Outbound calls** are made by an agent with the `make_call` tool (it needs
your approval, and is on the communication role):

| Argument | |
|---|---|
| `to` | the number to call (E.164) |
| `message` | what is said when the call is answered |
| `mode` | `notify` — say the message and hang up; `conversation` — then talk |
| `instructions` | conversation: who the assistant is on this call and what the call is for (replaces the phone prompt for this call) |

The tool waits for the call to end and reports whether it was answered and
what was said; `end_call` hangs up a call in progress.

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

### The full assistant on your own number

By default every caller — including you — talks to the restricted phone
assistant: the `voice` topic's model, no tools. Anyone can dial a number, and
a caller ID is easy to fake, so that is the safe default.

`voice.callAssistant` (Settings → Voice → Calls, "Your full assistant on the
phone") lists numbers whose calls reach a user's **full assistant**: the root
agent with its tools, on a new chat of that user made for the call (channel
`phone`), answering in spoken style. Each entry names the number and the user
it belongs to; an admin sets it, since only an admin can vouch for whose phone
a number is:

```bash
curl -X PUT http://localhost:3005/api/settings/voice.callAssistant \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -d '{"value": [{"number": "+14155551234", "user": "alice"}]}'
```

A listed number is not enough. The call gets the full assistant only when, in
addition, the carrier reports the caller ID as **verified with full STIR/SHAKEN
attestation (A)**:

| Carrier | Webhook field | Counts as verified |
|---|---|---|
| Twilio | `StirVerstat` | `TN-Validation-Passed-A` |
| Telnyx | `shaken_stir_attestation`, `shaken_stir_validated` (on `call.initiated`) | `A` and `true` |
| Plivo | `StirVerification` | `Verified` (Plivo: "equivalent to attestation level A") |

Anything less — attestation B or C, a failed check, a call from a network
STIR/SHAKEN does not cover (outside the US and Canada, most VoIP and SIP
calls) — and the caller gets the restricted assistant, even from a listed
number; the log says why. Attestation A means the originating carrier vouches
that its customer may use the number, which makes spoofing it far harder but
not impossible (a compromised carrier, a SIM swap): list only numbers you
control, and keep tool permissions that matter on ASK.

It also needs:

- **Live audio** (`voice.streaming`): a turn with tools can take longer than a
  carrier waits for a webhook's reply, so the turn-by-turn path always uses the
  restricted assistant.
- **An inbound policy that lets the number in** (`voice.inboundPolicy` open, or
  the number in `voice.inboundAllowFrom`).

Calls the assistant places (`make_call`) never get it, whoever answers.

On the call, each thing you say is sent to the root agent as a spoken turn and
its reply is read as it is written; you can talk over it. A tool that needs
your permission, or an approval the agent asks for, cannot be shown on a
phone, so it is asked aloud ("I need your permission to use … Say yes to allow
it, or no."): only a plain yes (yes, okay, go ahead, ja) allows it; anything
else refuses it, and whatever you said beyond a plain no is then your next
request. A question still open when you hang up is refused. The request also
shows in the web and mobile apps as usual, and answering it there works too.
If you talk over a reply, the turn still finishes; its answer is in the chat.

Code: `src/voice/telephony/assistant.ts` (who gets it, the conversation with
the root agent), the gate in `call-flow.ts`, the wiring in
`src/api/voice-media-ws.ts`.

### API Endpoints

Speech routes are listed under [API](#api) above. Telephony:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/voice/webhook/:provider` | Call events from the carrier (signature-checked) |
| POST | `/api/voice/webhook/:provider/status` | Status callbacks |
| GET | `/api/voice/webhook/audio/:id` | A reply clip the carrier plays (unauthenticated, random id, expires within minutes) |
| GET | `/api/voice/calls` | Calls in progress and ended in the last hour (admin) |
| GET | `/api/voice/telephony/health` | Provider connection health (admin) |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `voice.telephonyProvider` | `disabled` | twilio, telnyx, plivo |
| `voice.phoneNumber` | — | caller id for outbound calls |
| `voice.publicUrl` | — | your public base URL (ngrok, Cloudflare Tunnel, …) |
| `voice.streaming` | `false` | answer incoming calls as a live media stream (Twilio, Telnyx, Plivo) |
| `voice.expertPrompt` | — | how Octipus behaves on calls |
| `voice.inboundPolicy` | `disabled` | disabled, allowlist, open |
| `voice.inboundAllowFrom` | — | allowed inbound numbers (E.164) |
| `voice.callAssistant` | — | `[{number, user}]`: numbers whose verified calls reach that user's full assistant |

Calls are spoken in the active voice profile (`voice.profile`, see [Voices](#voices)).

### Vault Keys

| Key | Provider | Required |
|-----|----------|----------|
| `twilio_account_sid` | Twilio | Yes |
| `twilio_auth_token` | Twilio | Yes |
| `twilio_phone_number` | Twilio | No (auto-detected) |
| `telnyx_api_key` | Telnyx | Yes |
| `telnyx_connection_id` | Telnyx | Yes |
| `telnyx_public_key` | Telnyx | Yes — every webhook is refused without it |
| `plivo_auth_id` | Plivo | Yes |
| `plivo_auth_token` | Plivo | Yes |

### Security

- **Webhook signature verification** for all providers, over the exact bytes received: Twilio HMAC-SHA1 (URL + sorted parameters), Telnyx Ed25519 (timestamp + body, ±300 s), Plivo V3 HMAC-SHA256 (URL + sorted POST parameters + nonce; each nonce accepted once within 30 minutes). Plivo's V2 signature is refused: it covers only the URL and nonce, so it would verify any body.
- **Media socket** — a single-use token, minted by the webhook for one call and valid for two minutes, in the stream URL; the stream must be for that call
- **Permission gating** — `initiate_call` requires user approval (ASK level)
- **Inbound filtering** — allowlist-based caller ID filtering (caller ID can be spoofed: it only decides who may talk to the restricted assistant)
- **Full assistant** — only for a listed number with a carrier-verified caller ID (STIR/SHAKEN A); see above
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
| **Media stream** | `<Connect><Stream>` | `streaming_start` (RTP, PCMU, no reconnect); `media` / `clear` / `mark` |
| **Health check** | Queries `/Accounts/{sid}` | Queries `/phone_numbers` endpoint |

### Plivo Differences

| Aspect | Twilio | Plivo |
|--------|--------|-------|
| **Authentication** | Basic auth (Account SID + Auth Token) | Basic auth (Auth ID + Auth Token) |
| **Call API** | TwiML (XML) | XML with different element names |
| **Gather speech** | `<Gather>` | `<GetInput>` |
| **Say** | `<Say>` | `<Speak>` (same) |
| **End call** | POST with `Status=completed` | DELETE request |
| **Webhook verification** | HMAC-SHA1 | V3: HMAC-SHA256 over URL, parameters and nonce |
| **Media stream** | `<Connect><Stream>` | `<Stream bidirectional keepCallAlive>`; `playAudio` / `clearAudio` / `checkpoint` |
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
