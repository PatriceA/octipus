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
      // pathOverride: '/generate',          // optional, replaces the default path
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

## Request format (Gemini-compat only)

The **custom-gemini** provider always sends requests in native Google Gemini wire format:

- **Path** (defaults to): `POST {endpoint}/v1beta/models/{modelId}:generateContent` (or `:streamGenerateContent` for streaming)
- **Override**: Use `metadata.customProvider.pathOverride` to point at a different endpoint path if needed

**Request body** follows Google Gemini's native structure:

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "generationConfig": { "temperature": 0.7, "maxOutputTokens": 4096 },
  "tools": [{ "functionDeclarations": [...] }]
}
```

Use for: real Google Gemini API, Vertex AI generative endpoints, or Gemini-API-compatible proxies that expect this exact wire format.

For proxies with non-standard request/response shapes, use `custom-openai` with a compatible endpoint instead.

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

- Image input on the Gemini-compatible flavor (text only). The OpenAI- and Anthropic-compatible flavors send images ([MEDIA.md](MEDIA.md)) when the model is marked **Reads images**.
- Embeddings — no custom flavor implements `embed()`
- Batch / parallel mode (proxy-specific feature)

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

### Local for protection levels

A custom endpoint counts as remote until the model is marked **Runs on this
machine / network** (model editor; `metadata.dataPolicy = { hosting: 'local',
retention: 'none', trainsOnInput: false }`). Then conversations at protection
levels 3–4 may use it ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md)). It can
be set only for an endpoint at localhost, a private address or a
`.local`/`.lan` host. Tick it only when the server runs the model itself, not
when it is a proxy or gateway to a cloud service.

## Running your own models with llama.cpp

Any GGUF model that [llama.cpp](https://github.com/ggml-org/llama.cpp) runs
can be a normal Octipus model: chat, tool calls and, with a vision model,
images. `llama-server` speaks the OpenAI wire format, so it is added as a
**Custom (OpenAI-compatible)** model. With **Runs on this machine / network**
ticked it counts as local, so conversations at protection levels 3–4 may use
it.

### 1. Install llama.cpp

Any of:

- a release build for your platform from the
  [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases);
- a package manager, for example `brew install llama.cpp` on macOS;
- the container image `ghcr.io/ggml-org/llama.cpp:server`.

You need the `llama-server` binary.

### 2. Start a model

```bash
llama-server -hf ggml-org/gemma-3-4b-it-GGUF \
  --jinja -c 16384 --host 127.0.0.1 --port 8080
```

- `-hf <repo>` downloads the GGUF from Hugging Face on first start. Use
  `-m /path/to/model.gguf` for a file you already have.
- `--jinja` uses the model's own chat template. **It is required for tool
  calls**: without it, agents cannot use tools.
- `-c` sets the context size. Enter the same number as the model's
  **Context window** in Octipus.
- For images, the model needs its projector. `-hf` fetches it for repositories
  that ship one; otherwise pass `--mmproj /path/to/mmproj.gguf`.
- Octipus in Docker, or on another machine: listen on the network
  (`--host 0.0.0.0`) and set a key with `--api-key <key>`.

Check it answers: `curl http://localhost:8080/v1/models`.

### 3. Add it in Octipus

Models page → **Add model** → **Manual / Direct**:

| Field | Value |
|-------|-------|
| Provider | **Custom (OpenAI-compatible)** |
| Endpoint URL | `http://localhost:8080/v1`. From Docker: `http://host.docker.internal:8080/v1`. Another machine: its LAN address, e.g. `http://192.168.1.20:8080/v1`. |
| Model ID | Press **Fetch models** and pick it, or type the name `/v1/models` lists. |
| API Key Reference | Leave blank without `--api-key`. With one, save the key under Settings → Secrets and enter that name here (or `env:VAR_NAME`). |
| Context window | The `-c` you started it with. |
| Tools | On (needs `--jinja`). |
| Reads images | On only for a vision model started with its projector. |
| **Runs on this machine / network** | On, so protection levels 3–4 may use it. Offered only for a localhost, private-address or `.local`/`.lan`/`.internal` endpoint. |

Press **Test**, then **Add**.

### 4. Use it

Bind it on the **Topics** page like any other model: as the primary or backup
of a lane (Everyday, Build, Research, …), or for every text lane with **Assign
all**. A local model is also what a conversation at protection level 3–4 falls
back to when its bound model is remote.

### Several models

One `llama-server` serves one model. For more, start one server per model,
each on its own port (`--port 8081`, `8082`, …), and add each as its own
Octipus model. Or put a model switcher such as
[llama-swap](https://github.com/mostlygeek/llama-swap) in front: one endpoint,
which starts the model a request names.

### What it does not cover

- **Search and memory (embeddings).** The custom provider does not embed. Use
  the optional local embedding engine Octipus installs itself
  ([RAG.md → Local embeddings](RAG.md#local-embeddings)), or Ollama.
- **Starting and stopping the server.** You run `llama-server` yourself, for
  example as a system service. Octipus only manages the embedding engine.

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agents never call tools, or tool calls come back as plain text | Start `llama-server` with `--jinja`. |
| "context length exceeded" or cut-off answers | Raise `-c`, and the model's **Context window** with it. |
| Refused in a conversation at protection level 3–4 | Tick **Runs on this machine / network** on the model. |
| Unreachable from Octipus in Docker | Use `host.docker.internal` (or the host's LAN address) and `--host 0.0.0.0`. |
| HTTP 401 | The server has `--api-key`: put the same key in the model's API Key Reference. |
