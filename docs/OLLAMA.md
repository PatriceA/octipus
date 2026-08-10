# Running Octipus on Ollama

Octipus treats [Ollama](https://ollama.com) as a first-class local provider:
self-hosted, no API key, runs on your own CPU/GPU. This doc covers what Octipus
expects from an Ollama model — **size, tool support, context length** — and the
local-only optimizations (lazy tool discovery, iGPU) that make a swarm usable on
consumer hardware.

> Related: [Small / Local Models](./SMALL-MODELS.md) (single-model setup and
> what degrades) and [Custom Providers](./CUSTOM-PROVIDERS.md) (OpenAI-compatible
> endpoints). This doc is the Ollama-specific companion to both.

---

## TL;DR

| Question | Answer |
| --- | --- |
| Minimum viable model for the **full swarm** (tools + multi-step) | ~**7–8B**, 4-bit, `supportsTools: true` (e.g. `qwen3:8b`) |
| "Small model" threshold (triggers prompt/tool trimming) | **< 10B params** (`orchestrator.routerSmallModelMaxParams`) |
| Tool calling | Native Ollama tool format; **thinking must stay ON** for agent workers |
| Context Octipus packs before compaction | `agent.contextWindowSize`, default **32000** tokens |
| Context Ollama actually allocates | `num_ctx` / `OLLAMA_CONTEXT_LENGTH` — **set this yourself** (default 4096!) |
| iGPU (AMD 890M etc.) | `OLLAMA_IGPU_ENABLE=1` or it silently drops to CPU |

---

## Adding Ollama models

Add models in the **Models** page (or seed via API) with `provider: 'ollama'`.
Octipus talks to Ollama's native `/api/chat` endpoint (not the `/v1` shim — the
native format gives reliable tool calls and JSON mode). Default endpoint is
`http://localhost:11434`; override per-model via the `endpoint` field or globally
with `OLLAMA_URL`.

Pull the weights first (`ollama pull qwen3:8b`), or use the hardware-aware
onboarding (`octi capabilities` / hwfit), which reads your VRAM and recommends
pullable tags from a curated catalog (`src/capabilities/hwfit/catalog.json`).

---

## Model size — and the small-model threshold

Octipus routes by **parameter count**, derived from `metadata.paramCount` or
parsed from the model tag (`qwen3:8b` → 8B; `qwen3:30b-a3b` MoE → counted by
total). See `deriveParamCount` (`src/core/orchestrator/mode-selector.ts`).

A model under **`routerSmallModelMaxParams` (default 10B)** is treated as
**small** and gets:

- **Prompt trimming** — the expert scaffold, deliverable templates, and success
  metrics are dropped (a weak model can't drive a multi-section prompt).
- **Tool cap** — the surface is capped to `smallModelMaxTools` (default **7**)
  tool *groups*, priority-ordered, so core tools survive and the long tail is
  dropped wholesale.
- **No lazy tool discovery** — small models chain multi-step discovery poorly,
  so they keep the capped full-schema path (see below).

Rough capability tiers (4-bit quant, consumer GPU):

| Size | Use | Notes |
| --- | --- | --- |
| ≤ 1.7B | toy / classification only | Won't reliably drive tools or multi-step tasks |
| 4B | casual chat, light single-tool | Small-tier: trimmed prompt + capped tools |
| **7–8B** | **practical floor for the swarm** | Reliable tool calls; good default for ~8GB GPUs |
| 14–32B | higher-fidelity research/coding | Needs 12–24GB VRAM (or MoE like `qwen3:30b-a3b`) |

> House rule #2: never hardcode a model. Bind topics to models and let
> `ModelRegistry` resolve. Size-based behavior above is automatic.

## Quantization

Catalog tags default to **`q4_K_M`** (4-bit) — the sweet spot for quality vs
VRAM. Going below q4 (q3/q2) degrades tool-call reliability noticeably; prefer a
smaller model at q4 over a larger model at q2. The `vramHintMB` in the catalog is
an offline fallback estimate only — real weight size is fetched live from the
Ollama registry manifest at recommend-time.

---

## Tool use

Ollama models tool-call via Ollama's **native tool format** (Octipus maps the
OpenAI-style tool schema in `ollama-provider.ts`). Two things to know:

1. **`supportsTools` gates everything.** Ollama models default to
   `supportsTools: true`; set it to `false` for a model that can't tool-call and
   it will be given no tools at all (and never routed for tool work). Not every
   small Ollama model tool-calls well — verify before relying on it.
2. **Thinking stays ON for agent workers.** Empirically, Ollama models with
   `think:false` emit malformed tool-call JSON that Ollama's Go-side parser
   rejects (`"Value looks like object, but can't find closing '}'"`). Octipus
   therefore **strips a `think:false` from `extraBody`** for tool-calling workers
   (`agent-worker.ts`). The reasoning tokens are stripped before delivery, so
   users never see them — the only effect is reliable tool calls. Casual chat
   (no tools) keeps the model's configured `think` setting.

### Lazy tool discovery (Ollama-only optimization)

Every advertised tool's full JSON schema is sent on **every** request. For a
research worker that was ~12k tokens of schemas against a ~2.4k system prompt —
and on a local iGPU that prefill re-runs every request (no cross-request
server-side prompt caching), which took minutes and timed out the client.

**Lazy tool discovery** advertises only a
small **core** set with full schema, plus two meta-tools — `list_tools` (names +
one-line descriptions, no params) and `describe_tool` (full schema for one tool).
The long tail stays registered and callable by name; the model fetches a schema
on demand (one extra round-trip on first use).

It is gated deliberately to **`provider === 'ollama'` + non-small +
`supportsTools` + a role that opts in** via `coreToolIds`:

- **Remote providers** (OpenAI, Anthropic, DeepSeek, …) prefix-cache the tool
  block cheaply and tool-call more reliably → stay on full schema.
- **Small models** → keep the capped full-schema path (they discover poorly).
- A role with **no `coreToolIds`** → byte-for-byte unchanged behavior.

A role opts in by setting `coreToolIds ⊆ toolIds` in its config. Example
(`roles/research/config.ts`): `coreToolIds: ['websearch', 'knowledge']` — the
hot path stays core; filesystem/profiles/artifacts/task_state become long tail;
`mcp` stays core automatically (it's its own discovery surface).

---

## Context length — two different knobs

This trips people up because there are **two** context settings:

1. **`agent.contextWindowSize`** (Octipus, default **32000**). How much
   conversation history Octipus packs before it compacts/summarizes. Octipus
   side only.
2. **`num_ctx` / `OLLAMA_CONTEXT_LENGTH`** (Ollama). How large a KV context
   Ollama actually allocates for the model. **Ollama's default is only 4096
   tokens** — far smaller than Octipus's 32000. Octipus does not force `num_ctx`
   per request, so if you leave Ollama at its default, long prompts (system
   prompt + tools + history) get **silently truncated** and tool calls degrade.

**Set Ollama's context yourself** to match your work and VRAM:

```bash
# Global, applies to all models (Ollama ≥ 0.6):
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

or bake it into a Modelfile (`PARAMETER num_ctx 32768`). Minimum guidance:

| Workload | Recommended `num_ctx` |
| --- | --- |
| Casual chat, no tools | 8k |
| Tool-using worker (full schema) | **16k+** — the tool block alone can be several k |
| Tool-using worker (lazy discovery) | 8–16k (smaller payload) |
| Research / long synthesis | 32k+ |

Bigger context costs VRAM (the KV cache grows with `num_ctx`), so size it to the
job. Catalog models advertise large native windows (Qwen3 ~40960, Gemma3 32768),
but you still have to *allocate* it via `num_ctx`.

---

## GPU / iGPU notes

- **AMD integrated GPUs (e.g. Radeon 890M).** Ollama 0.30.x drops the 890M iGPU
  by default and silently falls back to CPU → slow prefill and timeouts. Fix with
  `OLLAMA_IGPU_ENABLE=1` (and keep any `HSA_OVERRIDE_GFX_VERSION` gfx override you
  already had). In Docker Compose, env changes need `up -d` to recreate the
  container — a plain `restart` won't pick them up.
- **VRAM spill.** Models larger than VRAM spill to system RAM and run much
  slower. Use the hwfit recommender to pick a tag that fits, or an MoE
  (`qwen3:30b-a3b`: 30B total, ~3B active) for capability-per-VRAM.

---

## Recommended models (from the curated catalog)

Current-gen, pullable, tool-capable defaults (`q4_K_M`):

| Tag | Params | ~VRAM | Good for |
| --- | --- | --- | --- |
| `qwen3:8b-q4_K_M` | 8B | ~5.2GB | **Default** all-round; ~8GB GPUs |
| `qwen3:4b-q4_K_M` | 4B | ~2.9GB | Small chat/reasoning (small-tier) |
| `qwen3:14b-q4_K_M` | 14B | ~9.3GB | Higher-fidelity general/reasoning |
| `qwen3:30b-a3b-q4_K_M` | 30B MoE (~3B active) | ~18.5GB | Capable yet fast |
| `qwen3-coder` / `qwen2.5-coder` | — | — | Coding role |
| `qwen3-embedding` | — | — | Embeddings (RAG) |

See `src/capabilities/hwfit/catalog.json` for the full list and the live-sizing
behavior.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Requests time out on first tool turn | iGPU dropped to CPU, or `num_ctx` too small for the tool block | `OLLAMA_IGPU_ENABLE=1`; raise `OLLAMA_CONTEXT_LENGTH` |
| Malformed tool-call JSON / parser errors | `think:false` on a tool-calling model | Octipus strips it for workers; check the model's `extraBody` if you see it in chat |
| Model never gets tools | `supportsTools: false`, or routed as small + capped out | Check the model's `supportsTools` flag and size tier |
| Prompt seems truncated | Ollama at default 4096 `num_ctx` | Set `OLLAMA_CONTEXT_LENGTH` |
| Tool payload huge / slow prefill on local | Full-schema advertisement | Opt the role into lazy discovery (`coreToolIds`) |
