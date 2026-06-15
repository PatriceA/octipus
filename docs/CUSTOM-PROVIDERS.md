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
