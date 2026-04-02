# Voice & Phone Calls

The Assistant includes voice capabilities at two levels:

1. **Local Voice I/O** — speech-to-text, text-to-speech, and wake word detection for hands-free local interaction
2. **Phone Calls** — make and receive actual phone calls via Twilio, Telnyx, or Plivo with interactive voice conversations

## Local Voice

### Speech-to-Text (STT)

| Engine | Type | Notes |
|--------|------|-------|
| **Whisper.cpp** | Local | C++ Whisper — fast, private, offline |
| **Faster-Whisper** | Local | Python + CTranslate2 — optimized |
| **OpenAI Whisper** | Cloud | Fallback when local unavailable |

**API:** `POST /api/voice/transcribe` — send base64 audio, receive text.

**Config:**
```
voice.whisperModelPath = /path/to/ggml-base.bin
voice.language = en
```

### Text-to-Speech (TTS)

| Engine | Type | Notes |
|--------|------|-------|
| **Piper** | Local | Neural TTS — fast, high quality, offline |
| **Edge TTS** | Cloud | Microsoft Edge — 200+ voices |
| **Coqui** | Local | Neural TTS — multi-language |

### Wake Word Detection

| Engine | Type | Notes |
|--------|------|-------|
| **Sherpa-ONNX** | Local | ONNX keyword spotting |
| **Picovoice** | Cloud | High accuracy, requires API key |
| **VAD** | Local | Voice Activity Detection fallback |

---

## Phone Calls

Make and receive actual phone calls through telephony providers. The assistant uses the existing STT/TTS pipeline for audio processing and routes conversations through an expert for fast, direct LLM responses.

### Supported Providers

| Provider | Protocol | Credentials Needed |
|----------|----------|-------------------|
| **Twilio** | Programmable Voice + Media Streams | `twilio_account_sid`, `twilio_auth_token` |
| **Telnyx** | Call Control v2 | `telnyx_api_key`, `telnyx_connection_id` |
| **Plivo** | Voice API + XML | `plivo_auth_id`, `plivo_auth_token` |

### Setup (3 steps)

#### 1. Store provider credentials in the vault

Go to **Settings > Vault** in the web UI, or use the API:

```bash
# Twilio example
curl -X POST http://localhost:3005/api/vault \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "twilio_account_sid", "value": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'

curl -X POST http://localhost:3005/api/vault \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "twilio_auth_token", "value": "your_auth_token"}'
```

The phone number is **auto-detected** from your Twilio account — no need to configure it separately.

#### 2. Set the provider and webhook URL

```bash
# Enable Twilio
curl -X PUT http://localhost:3005/api/settings/voice.telephonyProvider \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "twilio"}'

# Set your public webhook URL (ngrok, Cloudflare Tunnel, etc.)
curl -X PUT http://localhost:3005/api/settings/voice.publicUrl \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "https://abc123.ngrok.io"}'
```

#### 3. Assign a model to the "voice" topic

In the **Models** page, assign a fast model to the `voice` topic. Local models (Ollama) give the lowest latency since there's no network round-trip.

That's it. The expert prompt is automatically loaded from the Communicator expert.

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
  -H "Authorization: Bearer $MASTER_KEY" \
  -d '{"value": "allowlist"}'

curl -X PUT http://localhost:3005/api/settings/voice.inboundAllowFrom \
  -H "Authorization: Bearer $MASTER_KEY" \
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
