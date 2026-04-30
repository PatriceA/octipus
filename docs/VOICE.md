# Voice & Phone Calls

Octipus includes voice capabilities at two levels:

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

Make and receive actual phone calls through telephony providers. Octipus uses the existing STT/TTS pipeline for audio processing and routes conversations through an expert for fast, direct LLM responses.

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
  -H "Authorization: Bearer $MASTER_KEY" \
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
