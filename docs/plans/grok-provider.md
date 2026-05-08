# Plan — Add Grok (xAI) as a Provider

Status: **drafted, not started**. Resume after reboot.

Prereq context: this plan was drafted right after finishing the CLI-subagent
plan (per-CLI model override + auto-curated live discovery, replacing the
hardcoded `KNOWN_PROVIDER_MODELS` catalog). The discovery layer at
`src/models/providers/discovery/` is the template Grok plugs into.

**State of related work as of plan write:** Phases 1-5 of the CLI-subagent
plan are implemented but **uncommitted**. Decide whether to commit those
first (recommended) or stack the Grok work on top.

---

## Phase 0 — Discovery findings (cite, don't re-research)

**Vendor facts** (https://docs.x.ai):

- Base URL: `https://api.x.ai/v1` — OpenAI-compatible, drop-in `OpenAI` SDK with custom `baseURL`. https://docs.x.ai/docs/overview
- List endpoint: `GET /v1/models`, `Authorization: Bearer $XAI_API_KEY`, OpenAI-style `{ object: "list", data: [...] }`. https://docs.x.ai/docs/api-reference
- Env var: `XAI_API_KEY`. Console: https://console.x.ai
- Models confirmed in vendor docs: `grok-4` (256K ctx, flagship), `grok-4-1-fast-reasoning` / `grok-4-fast-reasoning` / `grok-4-fast-non-reasoning` (2M ctx), `grok-4.20`. Knowledge cutoff Nov 2024. https://docs.x.ai/developers/models
- Tools: OpenAI-compatible schema. **Quirk** — tool calls not streamed token-by-token. https://docs.x.ai/docs/guides/function-calling
- Streaming: SSE, OpenAI-compatible. **Quirk** — bump client timeout to ~3600s for reasoning models. https://docs.x.ai/docs/guides/streaming-response
- Vision: OpenAI-style `content` + `image_url`, JPG/PNG only, 20 MiB max. https://docs.x.ai/docs/guides/image-understanding
- Rate limits: spend-based tier system, 429 on breach. https://docs.x.ai/developers/rate-limits
- Pricing page: https://docs.x.ai/developers/models

**Existing infra to mirror:**

- Provider class template: `src/models/providers/openai-provider.ts` (full file, especially `:200-260` for vault wiring)
- Provider registry: `src/models/providers/index.ts:68-102` (priority chain), `:35-44` (rate-limit keys)
- Discovery client template: `src/models/providers/discovery/openai.ts`
- Discovery dispatcher: `src/models/providers/discovery/index.ts` — env/vault key map at `envMap`/`vaultKeyMap`, registration in `CLIENTS`
- Add-model UI: `web/components/models/add-model-modal.tsx`

**Anti-patterns:**

- No paraphrasing pricing into source — link the docs URL only.
- No hardcoded Grok IDs in a shortlist file — discovery is live (mirrors the openai/anthropic/gemini path).
- Don't fork OpenAI completion logic — Grok is OpenAI-compatible. Only deviate where vendor docs cite a real difference.
- Bump request timeout for reasoning streaming per vendor; don't disable streaming entirely.

---

## Phase 1 — Backend provider

1. **New file** `src/models/providers/grok-provider.ts` — clone `openai-provider.ts`. Change:
   - Class `GrokProvider`, `name = 'grok'`
   - `baseURL: 'https://api.x.ai/v1'`
   - `getApiKey()` → `process.env.XAI_API_KEY`; vault key `xai_api_key`
   - `supportsModel(name)` → matches `grok-*` and `xai/*`
   - For streaming reasoning models: lift request timeout to 3600000 ms (cite https://docs.x.ai/docs/guides/streaming-response in a comment)
   - `listModels()` → `GET /v1/models` (mirror openai-provider's impl)
2. **Register** in `src/models/providers/index.ts`:
   - Import + instantiate `new GrokProvider()`
   - Priority chain insert: CLI → Ollama → OpenAI → Anthropic → Gemini → **Grok** → DeepSeek → OpenRouter → LiteLLM
   - Rate-limit key map: `'grok'`
3. **Vault key seed** — add `xai_api_key` to `scripts/setup.ts` if it pre-seeds known keys.

**Verify:** `bunx tsc --noEmit` exit 0; router resolves `provider: 'grok'` to `GrokProvider`.

---

## Phase 2 — Live discovery client

1. **New file** `src/models/providers/discovery/grok.ts` — clone `discovery/openai.ts`:
   - `provider = 'grok'`
   - `base = creds.endpoint || 'https://api.x.ai/v1'`
   - Reuse `applyTierInference` from `curation.ts`
2. **Register** in `src/models/providers/discovery/index.ts`:
   - `CLIENTS.grok = new GrokDiscovery()`
   - `envMap.grok = 'XAI_API_KEY'`
   - `vaultKeyMap.grok = 'xai_api_key'`
3. **Verify tier inference** for Grok IDs in `discovery/curation.test.ts`:
   - `inferTier('grok-4') === 'flagship'` — extend `flagship` regex if needed
   - `inferTier('grok-4-fast-non-reasoning') === 'cheap'` — add `non-reasoning` if needed
   - `inferTier('grok-4-fast-reasoning') === 'reasoning'` — should match existing `reason` heuristic
   - If any miss, **extend `inferTier` in curation.ts** rather than adding a Grok-specific branch.

**Verify:** new tests pass; no-static-shortlist guard still green; manual probe with `XAI_API_KEY` returns curated shortlist with `source: 'live'`.

---

## Phase 3 — Web UI

1. `web/components/models/add-model-modal.tsx` — add Grok to the provider list:
   ```ts
   { id: 'grok', label: 'Grok (xAI)', vaultKey: 'xai_api_key', docsUrl: 'https://docs.x.ai/developers/models' }
   ```
   Discovery dropdown is provider-agnostic, no further wiring needed.
2. `web/app/secrets/page.tsx` (or wherever `openai_api_key` is pre-suggested) — add `xai_api_key` with link to https://console.x.ai

**Verify:** Models → Add Model shows Grok; with key configured, dropdown populates.

---

## Phase 4 — Docs

1. `docs/features/models.mdx` (website):
   - Cloud Providers table: add Grok row
   - Live model discovery table: add Grok with file path `src/models/providers/discovery/grok.ts`
2. `docs/features/orchestrator.mdx`, `docs/development/architecture.mdx`: insert Grok into the provider chain.
3. Optional one-paragraph "Grok quirks" callout in `models.mdx`:
   - 256K → 2M context (model-dependent)
   - Reasoning streaming: bump client timeout
   - Vision: 20 MiB JPG/PNG max
   - Rate limits: tier-based, permanent

All claims need a vendor URL footnote. No paraphrasing pricing.

**Verify:** website `bun run build` exit 0.

---

## Phase 5 — Verification

1. Backend + web typecheck exit 0
2. All existing tests still pass (21 from prior plan + Grok tier-inference additions)
3. End-to-end with real `XAI_API_KEY`:
   - `curl /api/models/providers/grok/available` → live curated list
   - Register `provider: 'grok'`, `modelId: 'grok-4-fast-non-reasoning'`, send chat, get response
   - Stream test, confirm reasoning-model timeout bump
4. No-static-shortlist guard green
5. Doc link liveness job (weekly) extended to cover Grok URLs

---

## Order

- Phase 1 ‖ Phase 2 (parallel — both clone existing files)
- Phase 3 after Phase 2
- Phase 4 after Phase 1
- Phase 5 last

Estimate: ~30-45 min focused work.
