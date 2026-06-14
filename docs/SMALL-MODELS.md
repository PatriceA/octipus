# Running Octipus on one small local model

Octipus is built to run fully self-hosted on local models (Ollama). This guide
covers the realistic setup for a small machine — a single chat model around or
below ~10B parameters — what works, what degrades, and how to configure it.

> Design background and the per-feature feasibility analysis live in
> [`.octipus/small-model-feasibility.md`](../.octipus/small-model-feasibility.md).

## The realistic minimum: 1 chat model + 1 embedding model

"One model" can't literally be one model. Embedding and vision are different
model *classes* — a chat model cannot produce embeddings or read images. So the
practical minimum is:

| Role | Model class | Example (Ollama) | Required? |
|---|---|---|---|
| All text work (chat, routing, specialists, memory) | chat / instruct | `qwen2.5:7b`, `glm-4.x-flash`, `llama3.1:8b` | **Yes** |
| RAG + long-term memory | embedding | `nomic-embed-text` | Strongly recommended |
| Documents / images (OCR, vision) | vision | `llava`, a `-vl` model | Optional |

Without an embedding model, RAG and long-term memory recall degrade (the
knowledge-base readiness check returns 503). Without a vision model, document
OCR / image features are unavailable. These are *intended* fail-loud boundaries,
not bugs.

## Pick a model that can actually call tools

The real bottleneck on small models is **not** prompt length — it's reliable
tool-call JSON. A model that can't emit valid tool calls will fail at agent work
even though everything else is configured correctly.

- Known-good local tool-callers: `qwen2.5:32b`, `glm-4.x-flash`, and other
  proven instruct models.
- Known-bad: the **qwen3** family via Ollama emits malformed tool-call JSON and
  is blocked from orchestration automatically.
- Verify any model before relying on it:
  `POST /api/models/:name/check-capabilities` runs a tool-calling + JSON
  conformance probe and returns a `capable` / `incapable` verdict.

## Configuration

### 1. Bootstrap with a single model

Set the `BOOTSTRAP_*` env vars and Octipus seeds one model on first boot, bound
to **all text topics** (not just `general`) so routing to any specialist works:

```bash
BOOTSTRAP_PROVIDER=ollama
BOOTSTRAP_MODEL=qwen2.5:7b
BOOTSTRAP_BASE_URL=http://localhost:11434
```

### 2. Or adopt the single-model setup on an existing install

In the **Models** page, use the **"Use for all topics"** action on a model (the
layers icon), or call the API directly:

```bash
curl -X POST http://localhost:3005/api/models/<name>/use-for-all-topics
```

This binds the model to every text topic and makes it the default. The response
lists `embedding` / `ocr` / `vision` as still unbound — add those separately.

### 3. Add an embedding model

Register a second model (e.g. `nomic-embed-text`) and bind it to the
`embedding` topic via the Models page.

### Relevant settings

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| `orchestrator.mode` | `ORCHESTRATOR_MODE` | `auto` | `auto` derives the mode from model size; pin to `router` to force the small-model path. |
| `orchestrator.routerSmallModelMaxParams` | `ORCHESTRATOR_ROUTER_MAX_PARAMS` | `10e9` | Below this the orchestrator runs in **router** mode (no orchestrator LLM) and workers run in the **small tier**. |
| `orchestrator.smallModelMaxTools` | `ORCHESTRATOR_SMALL_MODEL_MAX_TOOLS` | `7` | Max tools handed to a small-tier worker — fewer tools, more reliable tool calls. |

## How Octipus adapts to a small model

**Orchestrator** — chosen automatically from the default model's size:

- `router` (< 10B): no orchestrator LLM. A keyword classifier routes each
  message to one specialist, which does the work; the result is relayed. No
  parallel swarms, pipelines, or multi-step planning.
- `lite` (10–24B): a shrunken single-step orchestrator.
- `full` (≥ 24B): the complete swarm orchestrator.

**Workers** — when the bound model is small-tier, each worker automatically:

- caps its tool list to `smallModelMaxTools`,
- drops the heavy expert scaffold (deliverable template, success metrics) and
  uses compact response guidelines,
- injects the skill *index* instead of full skill bodies,
- skips the MCP meta-tool guidance.

**Automated tasks** request JSON mode (Ollama native `format: json`) so
extraction/judgment/research return parseable output instead of prose.

## What works vs. what degrades

| Capability | On one small chat model |
|---|---|
| Casual chat, single-specialist routing | ✅ Works |
| Simple coding / edits, classification, short summaries | ✅ Works (with a reliable tool-caller) |
| Memory extraction, context compaction, email/doc summaries, email drafts | ⚠️ Usable, lower quality |
| RAG + long-term memory | Needs an embedding model |
| Document OCR / vision | Needs a vision model |
| Deep research synthesis, weekly knowledge review | ❌ Unreliable on small models |
| Parallel swarms / pipelines | ❌ Disabled in router mode by design |

## Troubleshooting

- **"No model bound to topic X"** — a worker topic is unbound. Use *Use for all
  topics*, or bind the topic in the Models page.
- **Agent fails with malformed tool-call JSON** — the model is a weak
  tool-caller. Run `check-capabilities` and switch to a known-good model.
- **RAG / memory returns nothing** — bind an `embedding` model.
- **Mode isn't what you expect** — `orchestrator.mode` is `auto`; check the
  default model's size, or pin the mode explicitly.
