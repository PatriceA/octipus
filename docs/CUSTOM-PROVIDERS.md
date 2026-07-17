# Custom Providers

Octipus supports two custom-provider flavors for connecting to LLM endpoints
that aren't backed by a first-party provider class. Pick the one that matches
the upstream wire format:

| Flavor | `provider` column value | Wire format | Use for |
|---|---|---|---|
| **Custom OpenAI-compatible** | `custom-openai` | OpenAI `/v1/chat/completions` | vLLM, Together, Groq, Fireworks, DeepInfra, internal OpenAI-shaped proxies |
| **Custom Gemini-compatible** | `custom-gemini` | Native Google Gemini (`candidates[].content.parts[]`) | Vertex AI, Google AI Studio (native), Gemini-fronting proxies |
| **Custom Anthropic-compatible** | `custom-anthropic` | Native Anthropic Messages (`POST /v1/messages`, `content[]` blocks) | Self-hosted / proxied Anthropic-shaped endpoints, Bedrock-style Messages gateways |

Both are stateless — configuration lives entirely on the `model_config` row
and is loaded per call. Add as many models against the same upstream as needed;
each row points at its own endpoint and key.

> **Reaching Google Vertex AI?** For service-account auth (no static keys),
> prefer the **first-class `vertex` provider** below over the `custom-gemini`
> route. Use `custom-gemini` only for an API-key or proxied Gemini endpoint.

## First-class Vertex AI provider

`provider = 'vertex'` is a built-in provider (not a custom flavor) that talks to
Vertex's OpenAI-compatible endpoint and authenticates with a **short-lived
OAuth2 access token minted from a service account** — **no static API key**.

- **Credentials.** Store the service-account JSON in the vault as
  `system` / `vertex_service_account`, or set `VERTEX_SERVICE_ACCOUNT_JSON`.
  The token is minted via the RS256 JWT-bearer grant (`node:crypto`, no
  `google-auth-library` dependency), cached, and refreshed ~60 s before expiry;
  concurrent refreshes coalesce into one mint. Only the derived bearer token
  ever reaches the model client.
- **Project / region.** `VERTEX_PROJECT` (or `GOOGLE_CLOUD_PROJECT`, or the
  SA's `project_id`) and `VERTEX_LOCATION` (default `us-central1`).
- **Model selection.** A model is routed here by a `vertex/` (or `vertex_ai/`)
  prefix — e.g. `vertex/gemini-2.0-flash`, which is sent to Vertex as
  `google/gemini-2.0-flash`. `checkHealth()` mints a token to verify the
  credential path without a model call.

## Configuration

A custom-provider model row uses the existing `model_config` columns plus a
`metadata.customProvider` block:

```ts
{
  name: 'tpg-flash',                         // user-facing name (unique)
  modelId: 'gemini-3-flash-preview',         // model id sent upstream
  provider: 'custom-gemini',                 // routes to the custom provider
  endpoint: 'https://api.example.com',       // base URL (no trailing slash)
  apiKeyRef: 'tpg_api_key',                  // vault entry name (or 'env:VAR_NAME')
  metadata: {
    customProvider: {
      auth: { type: 'bearer' },              // 'bearer' | 'header' | 'query'
      requestEnvelope: 'gemini-blocks-config',
      // pathOverride: '/generate',          // optional, defaults per envelope
      // extraHeaders: { 'X-Org': 'foo' },   // optional
    },
  },
}
```

### Auth schemes

| `auth.type` | Required fields | Wire effect |
|---|---|---|
| `bearer` | — | `Authorization: Bearer <key>` |
| `header` | `headerName` (e.g. `x-api-key`) | `<headerName>: <key>` |
| `query` | `paramName` (e.g. `key`) | `?<paramName>=<key>` |

### API key resolution

`apiKeyRef` is resolved in this order:

1. `env:VAR_NAME` prefix → reads `process.env.VAR_NAME` directly
2. Vault lookup by name (`getVault().getByName('system', apiKeyRef)`)
3. Fallback env var: `CUSTOM_OPENAI_API_KEY` or `CUSTOM_GEMINI_API_KEY`

Use `env:` for local development, vault for shared/production.

## Request envelopes (Gemini-compat only)

The `requestEnvelope` field controls how the request body is shaped:

### `standard` (default)

Native Google Gemini wire format. Path defaults to:

- `POST {endpoint}/v1beta/models/{modelId}:generateContent`
- `POST {endpoint}/v1beta/models/{modelId}:streamGenerateContent` (streaming)

Body:

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "generationConfig": { "temperature": 0.7, "maxOutputTokens": 4096 },
  "tools": [{ "functionDeclarations": [...] }]
}
```

Use for: real Google Gemini API, Vertex AI generative endpoints.

### `gemini-blocks-config`

Bespoke envelope used by some Gemini-fronting proxies. Single path
(default `/generate`), with Anthropic-style content blocks and a camelCase
`config:{}` wrapper.

Body:

```json
{
  "mode": "text",
  "model": "gemini-3-flash-preview",
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "..." }] }],
  "stream": false,
  "config": {
    "temperature": 0.7,
    "maxTokens": 4096,
    "response_schema": { "type": "OBJECT", "properties": { ... } },
    "tools": [{ "name": "...", "description": "...", "parameters": { ... } }]
  }
}
```

Response shape is identical to `standard` (native Gemini `candidates[]`).

## Streaming

- **OpenAI-compat**: SSE via the OpenAI SDK. Standard `delta.content` /
  `delta.tool_calls` deltas.
- **Gemini-compat**: SSE with `data: {gemini-chunk}\n\n` events. Each event
  contains the full chunk shape; we yield text deltas and tool-call deltas
  as they arrive.

## Tool calling

Both flavors support function/tool calling via the standard Octipus tool
schema (OpenAI-style). The Gemini-compat provider translates schemas
on the way out (`functionDeclarations`) and parses `functionCall` parts
on the way in.

## What's NOT supported (yet)

- Image / multi-modal input — text only for now
- Embeddings — no custom flavor implements `embed()`
- Batch / parallel mode (proxy-specific feature)

## Adding a new envelope

If you need a third request shape, add a new branch to
`src/models/providers/custom/gemini-envelope.ts` and extend the
`requestEnvelope` enum in `src/db/schema/models.ts`. Each new envelope
should ship with unit tests in `gemini-envelope.test.ts`.

## Local-runtime presets (one-click self-hosted models)

Local OpenAI-compatible model servers (LM Studio, llama.cpp, vLLM, SGLang, TGI,
Ollama's `/v1`) all speak the same wire format as the `custom-openai` provider,
so they need no new provider class — only their boilerplate (endpoint, path,
auth). `src/models/providers/presets.ts` supplies that, plus model
autodiscovery.

### API

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/models/presets` | any user | List the known local-runtime presets. |
| POST | `/api/models/discover` | admin | `{ endpoint, apiKey? }` → `{ models: string[], healthy: boolean }` — lists the endpoint's `/models` and probes health. |

### Flow (setup wizard / models UI)

1. `GET /api/models/presets` → user picks a runtime (e.g. **LM Studio →
   `http://localhost:1234/v1`**).
2. `POST /api/models/discover` with the (default or edited) endpoint →
   autodiscovered model ids + a health flag.
3. For a chosen model, `buildModelConfigFromPreset(preset, modelId, endpoint)`
   produces the `custom-openai` `model_config` fields, then register it via the
   existing `POST /api/models`.

Presets included: `lmstudio`, `llamacpp`, `vllm`, `sglang`, `tgi`,
`ollama-openai`. Discovery/health degrade gracefully (return `[]` / `false`)
when the endpoint is unreachable, so the UI can fall back to manual entry.
