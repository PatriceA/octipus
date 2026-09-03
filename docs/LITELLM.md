# LiteLLM Proxy

Octipus can route every model call through a [LiteLLM](https://docs.litellm.ai/)
proxy instead of (or alongside) talking to providers directly. One proxy URL +
one key gives Octipus access to whatever models the proxy exposes — OpenAI,
Anthropic, Bedrock, Vertex, local Ollama, etc. — under a single OpenAI-shaped
wire format.

> **TL;DR for the "unreachable 401" error:** your proxy enforces a master key
> and Octipus has none set (at **system** scope). Set the **LiteLLM Master Key**
> card on the **Secrets** page — see [Authentication](#authentication).
>
> ⚠️ Do **not** add `litellm_api_key` through the generic "Add Secret" vault
> table — that stores it at *user* scope, where the backend never reads it
> (it resolves the key with `getSystemSecret`). The dedicated card stores it
> system-wide and hot-reloads it.

---

## How Octipus talks to LiteLLM

Two settings drive everything:

| Setting key | Vault / env | Secret? | Purpose |
|---|---|---|---|
| `litellm.proxyUrl` | env `LITELLM_URL` | no | Base URL of the proxy, e.g. `http://localhost:4000` |
| `litellm.apiKey` | vault `litellm_api_key`, env `LITELLM_API_KEY` | **yes** | Bearer key sent to the proxy |

> **`LITELLM_URL` is the canonical env var** — it's the one the settings
> registry reads and migrates into the DB on first boot. `LITELLM_PROXY_URL`
> is **legacy-only**: it's honored solely by the legacy bootstrap loader
> (`src/config/legacy-loader.ts`) as a fallback and does **not** migrate into
> the DB. Prefer `LITELLM_URL` (or just set the URL in the UI).

At call time Octipus resolves the key as:

```
config.litellm.apiKey  ||  process.env.LITELLM_MASTER_KEY
```

(`src/services/provider-service.ts:26`). If **neither**
is set, Octipus sends the request with **no `Authorization` header**. A proxy
started with a `master_key` / `LITELLM_MASTER_KEY` will reject that with
**HTTP 401** — which surfaces in the UI as *"unreachable 401"* / *"LiteLLM
returned 401"*. An open proxy (no master key) works with the key unset.

The chat client (`LiteLLMClient`) falls back to the placeholder `sk-litellm`
when no key is configured, so an **open** proxy chats fine even if the
*Add Model* test path complains — but a **secured** proxy needs the real key
in both paths. Set it once and both work.

---

## Authentication

The LiteLLM key is a **system-wide secret** — it's the operator's shared proxy
key, read once into the runtime config by a single `LiteLLMClient` that serves
every user. There is no per-user LiteLLM key path, so it **must** be stored at
**system scope**. Four ways to set it, pick one:

### 0. Secrets page (recommended, no restart)

**Secrets → LiteLLM Proxy → LiteLLM Master Key**, paste the key, **Save**. This
card writes through the settings endpoint, so the value lands system-scoped and
hot-reloads immediately (`resetLiteLLMClient`). Set the proxy **URL** separately
under **Settings → Configuration → LiteLLM**.

> The status dot turns green once the system-scoped secret exists. If you
> previously added `litellm_api_key` via the generic vault table, delete that
> user-scoped row — it does nothing and is misleading.

### 1. Setup wizard (recommended for first run)

```bash
npm run setup
```

Choose **LiteLLM proxy** when prompted. The wizard asks for the proxy URL
(default `http://localhost:4000`) and an optional API key. Both are persisted —
the URL to `litellm.proxyUrl`, the key to the vault as `litellm_api_key`.

Non-interactive:

```bash
OCTIPUS_SETUP_PROVIDER=litellm \
OCTIPUS_SETUP_BASE_URL=http://localhost:4000 \
OCTIPUS_SETUP_API_KEY=sk-your-master-key \
npm run setup -- --non-interactive
```

### 2. Settings API (running instance)

The key is `isSecret`, so the settings handler routes it to the vault
automatically (`src/api/routes/settings.ts`). Admin token required:

```bash
# Set the proxy URL
curl -X PUT http://localhost:3005/api/settings/litellm.proxyUrl \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":"http://localhost:4000"}'

# Set the master key (stored in vault as litellm_api_key)
curl -X PUT http://localhost:3005/api/settings/litellm.apiKey \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":"sk-your-master-key"}'
```

Changes hot-reload — no restart.

### 3. Environment (bootstrap only)

```bash
LITELLM_URL=http://localhost:4000
LITELLM_MASTER_KEY=sk-your-master-key   # or LITELLM_API_KEY
```

Per repo policy, prefer the vault over `.env` for the key — the DB is the source
of truth. Env is fine for local dev / CI bootstrap.

---

## Adding a model

Once the proxy URL + key are set:

1. **Settings → Models → Add Model** (or `POST /api/models`).
2. Set **Provider** to the upstream the proxy maps the model to (e.g. `openai`),
   **Model ID** to the LiteLLM model name (the `model_name` from the proxy's
   config, e.g. `gpt-4o-mini`).
3. The *Test* button calls `POST /api/models/test`, which sends a one-token
   chat completion through the proxy with your Bearer key.

To browse what the proxy actually exposes:

```bash
curl http://localhost:3005/api/models/providers/litellm/models \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN"
```

This proxies `/model/info` on LiteLLM and returns `{ id, provider, litellmModel }`
per model.

---

## Running a LiteLLM proxy

Minimal `litellm-config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

general_settings:
  master_key: sk-your-master-key   # this is what Octipus must send
```

```bash
docker run -p 4000:4000 \
  -e OPENAI_API_KEY=sk-... \
  -v $(pwd)/litellm-config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml
```

Health check: `curl http://localhost:4000/health/liveliness`.
List models: `curl -H "Authorization: Bearer sk-your-master-key" http://localhost:4000/v1/models`.

Octipus's own `docker-compose.yml` still wires the app's `LITELLM_PROXY_URL`
and a `MASTER_KEY`; point them at your proxy. Note `LITELLM_PROXY_URL` is the
legacy var (read only by the bootstrap loader, doesn't migrate into the DB) —
for a fresh setup prefer `LITELLM_URL`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **"unreachable 401" / "LiteLLM returned 401"** when adding/testing a model | Proxy enforces a master key; Octipus sent none or a wrong one | Set `litellm.apiKey` (see [Authentication](#authentication)); confirm it matches the proxy's `master_key` |
| **"Cannot reach LiteLLM proxy at …"** | Wrong URL, proxy down, network | `curl <proxyUrl>/health/liveliness`; fix `litellm.proxyUrl` |
| **"LiteLLM unreachable (404)"** on model list | Proxy too old / `/model/info` disabled | Upgrade the proxy image |
| Model lists but chat fails | Model ID mismatch with proxy `model_name` | Use the exact `model_name` from the proxy config |

### Seeing the actual error in the log

As of this change, all LiteLLM failures in the model routes are logged via
`coreLogger.error` (`src/api/routes/models.ts`) — previously a 401 was returned
to the UI only and never written to the API log, so it was invisible in
`octi logs`. Now look for:

```
LiteLLM model test rejected   { status: 401, litellmBase, modelId, provider, errData }
Cannot reach LiteLLM proxy    { err, litellmBase, modelId, provider }
LiteLLM model list rejected   { status, litellmBase }
```

`octi doctor` also runs a LiteLLM reachability check.

---

## Related

- [Configuration](./CONFIGURATION.md) — env vars, ports, services
- [Custom Providers](./CUSTOM-PROVIDERS.md) — direct OpenAI/Gemini-compatible endpoints (bypass LiteLLM)
- [Troubleshooting](./TROUBLESHOOTING.md) — general issues, `octi doctor`
