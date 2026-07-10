# Full Mistral direct-API integration

> **Status: implemented.** Two API facts differed from the published docs and were
> corrected against the `@mistralai/mistralai` v2.4.1 package source:
> - `POST /v1/audio/transcriptions` is **multipart/form-data**, not `application/json`
>   as the API-reference page states.
> - Realtime STT is a **WebSocket** at `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…`
>   with `Authorization` header auth and a JSON event protocol
>   (`input_audio.append` carrying base64 PCM → `transcription.text.delta` / `transcription.done`),
>   not the SSE variant the `#stream` path implies.
>
> `POST /v1/audio/speech` returning JSON `{ audio_data: <base64> }` (not a raw audio
> body like OpenAI's) was confirmed as written.

## Context

The request assumed Octipus only has the Mistral **CLI** (`vibe`) integrated. That is out of date. PR #118 landed a direct API provider on `main`, and `src/models/providers/mistral-provider.ts` already exists and is registered at all 16 required sites (provider router, discovery, health, conformance, settings-registry, rate-limiter, capabilities, setup, and the six web/ registration points).

So three of the seven requested capabilities are **already shipped and live-verified**:

| Capability | Status |
|---|---|
| Conversation (chat + streaming) | Done — `MistralProvider.complete()` / `.stream()` |
| Function calling | Done — tools passed through; includes the Mistral-specific 9-char tool-id remap (`toMistralToolId`) |
| Embedding | Done — `MistralProvider.embed()`, `mistral-embed` = 1024-dim |

The remaining four are genuine gaps. Each of them lands on an interface that **already exists**, so this is plumbing rather than new architecture:

| Capability | Gap | Existing seam to use |
|---|---|---|
| Vision | `mistral` missing from the vision provider map, so pixtral can't serve the `vision` topic | `providerEndpoints` in `litellm-client.ts` |
| OCR | Mistral has a native `POST /v1/ocr`; Octipus instead rasterizes PDFs with `pdftoppm` and prompts a vision model page-by-page | `ModelProvider` optional-method pattern (`embed?()`), `DocumentProcessor` |
| Speech-to-text | No Voxtral engine | `STTEngine` interface in `src/voice/stt.ts` |
| Text-to-speech | No Voxtral engine, **and no HTTP route for TTS at all** | `TTSEngine` interface in `src/voice/tts.ts` |

Intended outcome: a Mistral model can be bound to every topic Octipus has a lane for (`agents`/`chat`/`voice`, `embedding`, `vision`, `ocr`), and Voxtral can serve as both an STT and a TTS engine, reachable over HTTP.

**Decisions taken (confirmed with user):** native `/v1/ocr` endpoint; TTS engine + a new `/speak` route, preset voices only (no cloning); STT batch **and** true realtime streaming.

**No new npm dependency.** OCR and TTS are single JSON POSTs (`fetch`), realtime STT uses Bun's native `WebSocket`. Adding `@mistralai/mistralai` would duplicate the `openai` client the chat path already uses. If the realtime handshake proves fiddly in Phase 4, the SDK is the escape hatch — but try without it first.

---

## Phase 0 — Shared API-key resolver (prerequisite)

`MistralProvider.getApiKey()` is `private`. The OCR, STT and TTS code all need the same env→vault resolution (`MISTRAL_API_KEY` → vault `mistral_api_key`).

**`src/models/providers/mistral-provider.ts`**
- Extract the body of `getApiKey()` (lines 279–295) into an exported module-level `export async function getMistralApiKey(): Promise<string | null>`.
- Have the private method delegate to it. No behaviour change, no new file.

Everything below imports this. Do not re-implement key lookup anywhere.

---

## Phase 1 — Vision (smallest change; do it first)

`LiteLLMClient.completeVision()` (`src/models/litellm-client.ts:786`) builds correct OpenAI-style `image_url` content parts and routes to a direct provider, but its `providerEndpoints` map has no `mistral` key — so `pe` is undefined and it throws `Unsupported provider for vision: mistral`.

**`src/models/litellm-client.ts`** — add one entry to `providerEndpoints`:

```ts
mistral: { baseURL: 'https://api.mistral.ai/v1', vaultName: 'mistral_api_key', envVar: 'MISTRAL_API_KEY' },
```

That is the entire vision task. `MistralProvider.supportsModel()` already matches the `pixtral-` prefix, and the DB-provider lookup above it already resolves the bound model's provider correctly.

**Caveat to leave alone:** `src/visual/analyzer.ts:111` inlines images as `[Image: data:...base64...]` inside a plain text string rather than calling `completeVision()`. That is a pre-existing bug affecting every provider, not a Mistral one. Out of scope — note it, don't fix it here.

**Also out of scope:** images as first-class content in the ordinary agent turn. `AgentMessage.content` is a `string`; widening it to a parts union would ripple through `complete`/`stream` and every provider. Not required by this request.

---

## Phase 2 — Native OCR

### 2a. Interface

**`src/models/providers/interface.ts`** — add one optional method to `ModelProvider`, directly mirroring the existing `embed?()`:

```ts
/** Native document OCR (optional — only providers with a dedicated OCR endpoint) */
ocr?(document: OcrDocument, model: string): Promise<OcrResult>;
```

Define alongside it:
- `OcrDocument = { kind: 'url'; url: string } | { kind: 'base64'; data: string; mimeType: string }`
- `OcrResult = { pages: Array<{ index: number; markdown: string }>; model: string }`

Keep `OcrResult` minimal. Mistral returns `images`, `dimensions`, `usage_info`, `document_annotation` and optional bboxes; `DocumentProcessor` consumes **only** concatenated markdown today. Do not model fields nobody reads.

### 2b. Implementation

**`src/models/providers/mistral-provider.ts`** — add `async ocr()`.

- `POST https://api.mistral.ai/v1/ocr`, `Authorization: Bearer <getMistralApiKey()>`, JSON body.
- Body: `{ model, document, table_format: 'markdown' }` where `document` is `{ type: 'document_url', document_url: '<url or data URI>' }` for PDFs and `{ type: 'image_url', image_url: '<...>' }` for images. Mistral accepts a `data:` URI in these URL fields — that is how we send local files without needing the Files API.
- Response: `{ pages: [{ index, markdown, ... }], model, usage_info }`. Map to `OcrResult`.
- Wrap failures in `classifyError(error, 'mistral')`, matching `complete()`/`embed()`.
- Set the request timeout to `DEFAULT_TIMEOUT_MS`; a long PDF is one slow call, not thirty fast ones.

Model id: `mistral-ocr-latest`. Already matched by the `mistral-` prefix in `SUPPORTED_PREFIXES`, so it binds to the `ocr` topic with no registry change.

### 2c. Pipeline branch

**`src/core/documents/processor.ts`** — the `'ocr'` case of the strategy switch (~line 167).

Before the existing PDF/image split, resolve the `ocr` topic model (`registry.getModelForTopic('ocr')` — already called at lines 277 and 418), look up its provider via `getProviderRouter()`, and if that provider implements `ocr()`:

- Read the file, base64 it, call `provider.ocr()` with the correct `kind`, and join `pages.map(p => p.markdown)` with `\n\n`.
- **Skip `extractPdfText()`, `pdftoppm` and the per-page vision loop entirely** — Mistral handles multi-page PDFs in one call, and there is no 20-page cap to work around.
- Skip the `stripGroundingTokens` step; that strips DeepSeek-OCR `<|grounding|>` artifacts which Mistral does not emit.

Otherwise fall through to today's code path, unchanged. Every other provider keeps working exactly as it does now.

Two existing behaviours to preserve deliberately:
- `isImageDerived` (line 200) still governs `purpose: 'image_description'` for retention/retrieval. Native OCR of an **image** is text extraction, not description — so it should set `purpose='document'`, same as the OCR-text branch does today. Read lines 196–215 carefully before changing this; getting it wrong silently mislabels KB rows.
- The error message at lines 183–184 tells users to install poppler. Reword to note that a provider with native OCR (Mistral) removes that requirement.

**Bonus, free:** this makes `pdftoppm`/ImageMagick optional for Mistral users, and Mistral's `table_format: 'markdown'` beats what a vision prompt extracts from a table.

---

## Phase 3 — Speech-to-text (batch)

**`src/voice/stt.ts`** — add `export class MistralSTTEngine extends EventEmitter implements STTEngine`.

`transcribe(audio: Buffer | string)`:
- `POST https://api.mistral.ai/v1/audio/transcriptions`. Despite the OpenAI-lookalike path this endpoint takes **`application/json`, not multipart** — confirmed against the API reference. Body: `{ model, file: { content, file_name } | file_url, language, timestamp_granularities: ['segment'], diarize, context_bias }`.
- Response `{ text, model, language, segments, usage }` → map to the existing `TranscriptionResult` (`{ text, segments: [{start, end, text, confidence}], language, duration }`). Mistral's segments carry no per-segment confidence; use `1.0`, exactly as `WhisperEngine` already does (stt.ts:124).
- Model: `voxtral-mini-latest`.

Wire it into `createSTTEngine()` (stt.ts:359): widen the `type` union to include `'mistral'`, add the case. Widen the same union in `SpeechToText.create()` and in `VoiceServiceConfig.stt.type` (`src/voice/index.ts:21`).

**`src/api/routes/voice.ts`** — `/transcribe` already dispatches on a `model` string in the request body. Add a branch before the OpenAI fallback: if the model starts with `voxtral`, use `MistralSTTEngine`. No config change needed for this route.

---

## Phase 4 — Speech-to-text (realtime streaming)

This is the one genuinely fiddly piece; budget accordingly.

Realtime is a **WebSocket** at `wss://api.mistral.ai` (not the SSE variant the `/v1/audio/transcriptions#stream` path suggests). Model `voxtral-mini-transcribe-realtime-2602`. Audio goes up as raw **`pcm_s16le` @ 16 kHz**. Events come back as JSON: `RealtimeTranscriptionSessionCreated`, `TranscriptionStreamTextDelta`, `TranscriptionStreamDone`, `RealtimeTranscriptionError`. `diarize` is **not supported** on realtime — reject it rather than silently dropping it.

Implement `MistralSTTEngine.streamTranscribe(stream: ReadableStream<Uint8Array>)` using Bun's native `WebSocket`:
- Open the socket, wait for `RealtimeTranscriptionSessionCreated`, then pump `stream` chunks in.
- `yield` the text of each `TranscriptionStreamTextDelta`; resolve on `TranscriptionStreamDone`; `throw classifyError(...)` on `RealtimeTranscriptionError`.
- Close the socket in a `finally`, mirroring the temp-file cleanup discipline in the existing engines.

**The trap:** `WhisperEngine.streamTranscribe` writes its chunks to a `.wav` file, so callers may be feeding WAV-framed bytes. Voxtral wants headerless PCM. **Before writing this, verify what `VoiceService.listen()` and the wake-word path actually push into the stream.** If it is WAV, strip the 44-byte RIFF header on the first chunk; if it is not already 16 kHz mono s16le, that is a resample, and a resample is a much bigger job than this phase assumes — surface it rather than hiding it.

Given the only realtime consumer today is telephony, and telephony currently gets its speech text from Twilio/Telnyx rather than from our own STT, **this phase has no live caller yet.** Implement it, but do not let it block Phases 1–3 from shipping. If the resample turns out to be required, split it into its own change.

---

## Phase 5 — Text-to-speech

### 5a. Engine

**`src/voice/tts.ts`** — add `export class MistralTTSEngine extends EventEmitter implements TTSEngine`.

`synthesize(text)`:
- `POST https://api.mistral.ai/v1/audio/speech`, body `{ input: text, model: 'voxtral-mini-tts-2603', voice_id?, response_format: 'mp3' }`.
- Response is JSON `{ audio_data: '<base64>' }` — **not** a raw audio body. `Buffer.from(audio_data, 'base64')` and return it. This differs from OpenAI's `/v1/audio/speech`; do not assume compatibility.
- `getVoices()`: `GET /v1/audio/voices`.
- `streamSynthesize()`: the endpoint supports `stream: true` (`text/event-stream`). Ship the sentence-splitting fallback the other engines use (tts.ts:84–92) first; SSE streaming only pays off for the telephony path, which has no caller yet (same reasoning as Phase 4).

Note the format/latency tradeoff from the docs: `pcm` ≈0.8 s end-to-end, `mp3` ≈3 s. Default to `mp3` for the HTTP route; leave `response_format` on `TTSOptions` so a latency-sensitive caller can pick `pcm`. This is the calibration knob — do not hardcode it away.

Wire into `createTTSEngine()` (tts.ts:344): widen the `type` union to `'piper' | 'edge' | 'coqui' | 'mistral'`, add the case. Same widening in `TextToSpeech.create()` and `VoiceServiceConfig.tts.type` (`src/voice/index.ts:26`).

Voice cloning (`ref_audio`, voices CRUD) is **explicitly out of scope**. Pass `voice_id` through; that's it.

### 5b. Config

`ttsEnabled` is currently derived from `piperModelPath` being set, in **three** places that must stay consistent — `src/config/runtime-loader.ts:79`, `src/config/index.ts:65`, `src/config/legacy-loader.ts:89`. A Mistral TTS user has no Piper model, so `ttsEnabled` would stay `false` and `/api/voice/status` would lie.

- **`src/config/schema.ts`** (`voiceConfigSchema`, ~line 145): add `ttsProvider: z.enum(['piper','edge','coqui','mistral']).default('piper')`.
- Update all three derivation sites to: `ttsEnabled = !!piperModelPath || ttsProvider !== 'piper'`.

Per repo policy the API key stays in the **vault** (`mistral_api_key`), already registered in `settings-registry.ts`. Add **no** new secret to `.env`.

### 5c. Route

**`src/api/routes/voice.ts`** — add `POST /speak`:
- Auth-gated (`if (!user) return { error: 'Not authenticated' }`), matching every other route in the file.
- Body: `{ text: string, voice_id?: string, format?: 'mp3'|'wav'|'pcm'|'flac'|'opus' }`.
- Build the engine from `config.voice.ttsProvider` via `createTTSEngine`, return the audio with the right `Content-Type`.
- Return `503` when `!config.voice.ttsEnabled`.

Validate `text` length at the boundary (this is a metered endpoint billed per 1k characters — an unbounded body is a billing hole, not a style nit). Cap it and reject over the cap.

---

## Files touched

Core:
- `src/models/providers/mistral-provider.ts` — export `getMistralApiKey`, add `ocr()`
- `src/models/providers/interface.ts` — optional `ocr?()` + `OcrDocument`/`OcrResult`
- `src/models/litellm-client.ts` — one `providerEndpoints` entry
- `src/core/documents/processor.ts` — native-OCR branch in the `'ocr'` strategy case
- `src/voice/stt.ts`, `src/voice/tts.ts`, `src/voice/index.ts` — new engines, widened unions
- `src/api/routes/voice.ts` — voxtral branch in `/transcribe`, new `/speak`
- `src/config/schema.ts` + `runtime-loader.ts` + `index.ts` + `legacy-loader.ts` — `ttsProvider`

Cosmetic, optional: `web/components/models/model-card.tsx` `ProviderBadge` color map has no `mistral` entry (falls back to `colors.custom`). `grok` is missing too. One line if you want the badge.

**Not touched, by design:** provider registration (all 16 sites already done), settings-registry, discovery, health, rate-limiter, capabilities, and every web/ registration point.

---

## Verification

Each phase gets one runnable check. No new test framework, no fixtures.

1. **Vision** — bind `pixtral-12b-2409` to the `vision` topic on the Models page, upload a screenshot, confirm `VisualAnalyzer` returns a description instead of `Unsupported provider for vision: mistral`.
2. **OCR** — bind `mistral-ocr-latest` to the `ocr` topic, upload a multi-page PDF **with a table** via `/api/documents`. Assert: the job completes, `documents.ocrText` contains a markdown table, and `pdftoppm` was never spawned (temporarily rename the binary to prove the branch is taken — this is the check that actually fails if the branch is wrong).
3. **STT batch** — `POST /api/voice/transcribe` with `{ audio: <base64 wav>, model: 'voxtral-mini-latest' }`; assert non-empty `text` and populated `segments`.
4. **STT realtime** — a small `assert`-based script that pipes a known WAV through `streamTranscribe()` and asserts the concatenated deltas match the batch transcription of the same file. This is the check that catches the PCM/WAV header trap.
5. **TTS** — `POST /api/voice/speak` with `{ text: 'hello' }`; assert a non-empty audio buffer with a valid MP3 magic prefix (`ID3` or `0xFF 0xFB`). Assert `/api/voice/status` reports `ttsEnabled: true` with `ttsProvider: 'mistral'` and no Piper model configured — that is the config-drift regression.

Existing suites to re-run: `bun test src/models/providers/mistral-provider.test.ts` and `src/voice/stt.test.ts`.

**Known-flaky, ignore:** the full-suite litellm-health failure is the documented `bun mock.module` process-wide leak, not a regression from this work.

Per repo convention, run a Sonnet code review before opening the PR.

---

## Suggested PR split

Phases 1+2 (vision + OCR) and Phases 3+5 (STT batch + TTS) are independent and each ship real user value. Phase 4 (realtime) is the only one with an unresolved unknown (the resample question) and no live caller — keep it out of the first two PRs so it can't hold them up.
