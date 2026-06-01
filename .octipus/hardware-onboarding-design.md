# Hardware-Aware Local-Model Onboarding (`hwfit`)

> Design note, 2026-06-01. Feature #3 from `end-user-enrichment-plan.md`.
> Adapts Odysseus's "Cookbook" / `hwfit`: scan the host's hardware, recommend
> models that actually fit, and offer click-to-install-and-serve. This is the
> single biggest **adoption** unlock for the local-first audience — it removes
> the question that stalls first-run: *"which model can I run, and how do I
> serve it?"* Octipus today assumes a provider is already wired.

Owner decides sequencing; this is independent of the chat/work-stream work and
can proceed in parallel.

---

## Goal & non-goals

**Goal:** from a clean install, a user with (say) a 12 GB GPU can click once and
end up with a working, topic-bound local model — no manual model-name lookup, no
VRAM math, no `ollama pull` guesswork.

**Non-goals (this wave):** building our own inference server, multi-GPU
sharding/placement, fine-tuning, downloading raw GGUF and serving via
llama.cpp/vLLM ourselves. We orchestrate **Ollama** (already a first-class
provider) for the install/serve step. GGUF/vLLM/llama.cpp serving is a possible
later extension, explicitly deferred.

---

## What we already have (extend, don't reinvent)

- **`src/setup/probes.ts`** — discriminated-result probes (never throw) shared
  by the setup wizard + doctor; already has `probeOllama()`. The HW probe
  belongs here, same contract.
- **`src/capabilities/service.ts`** — the exact pattern to mirror: a
  `probe → persist → install` service with typed `InstallResult`, lazy-loaded
  installers, consumed by both the CLI and the orchestrator. `hwfit` is the same
  shape for "models" instead of "capabilities".
- **`OllamaProvider`** — talks to `/api/tags` (list installed) and `/api/chat`;
  the natural home for a `pull(model)` call (`POST /api/pull`, streamed
  progress).
- **`ModelRegistry.registerModel(...)` + topic-role bindings**
  (`topicRoles->>topic = 'primary'`) — recommendations resolve to **topic
  bindings**, not hardcoded model strings (honors DESIGN.md rule #2).
- **`octi setup`** wizard already has steps 6–8 (provider → default model →
  capabilities) and a non-interactive `OCTIPUS_SETUP_*` mode — the recommend
  flow slots in as an alternative to "manually pick a provider".
- **`web/app/models/page.tsx`** — where a "Recommended for your hardware" panel
  lives.

So the new work is: (1) a hardware probe, (2) a fit-scoring service over a model
catalog, (3) an Ollama `pull` + register-and-bind action, (4) two surfaces (CLI
step + web panel). Most plumbing exists.

---

## 1. Hardware probe — `src/setup/probes.ts: probeHardware()`

Returns a discriminated result (never throws), degrading gracefully when tools
are absent:

```
HardwareProfile {
  gpus: { vendor: 'nvidia'|'amd'|'apple'|'unknown', name: string, vramMB: number }[]
  totalVramMB: number          // sum of usable GPU VRAM (0 if none → CPU-only)
  ramMB: number
  cpu: { cores: number; arch: string }
  platform: 'linux'|'darwin'|'win32'
  source: ('nvidia-smi'|'sysfs'|'os'|'apple-metal')[]   // provenance for trust
}
```

Detection, best-effort per platform:
- **NVIDIA**: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`
  (via `commandExists` first). Most common case.
- **Apple Silicon**: unified memory — derive a usable budget from total RAM
  (Metal can use a large fraction); `sysctl`/`os.totalmem()`.
- **AMD/ROCm**: `rocm-smi` if present; else mark `unknown`.
- **CPU-only / no GPU**: `totalVramMB = 0` → recommend small CPU-friendly models
  (≤ ~4 GB quantized) and say so honestly.
- **RAM/CPU**: `os.totalmem()` / `os.cpus()`.

No new heavy deps — shell out to tools that exist, parse, fall back. Cap probe
time (timeouts like the other probes). Provenance (`source`) is recorded so the
UI can say "detected via nvidia-smi" vs "estimated from RAM".

---

## 2. Fit scoring — `src/capabilities/hwfit/` (mirrors capabilities service)

A pure, testable scorer over a **curated model catalog**:

```
ModelCatalogEntry {
  id: string                 // ollama name, e.g. 'llama3.2:3b-instruct-q4_K_M'
  family: string             // 'llama3.2'
  params: number             // 3e9
  quant: 'q4_K_M'|'q8_0'|'fp16'|…
  approxVramMB: number       // sizing for THIS quant
  topics: string[]           // 'chat'|'code'|'vision'|'embeddings' → our topics
  contextWindow: number
  notes?: string
}

ScoredModel {
  entry: ModelCatalogEntry
  fits: boolean              // approxVramMB <= budget (with headroom)
  fitMargin: number          // how comfortably (for ranking)
  recommended: boolean       // best-in-class for a topic that fits
}
```

Scoring rules (pure functions → easy unit tests, and the T2 conformance style):
- **VRAM budget** = `totalVramMB * 0.85` (headroom for KV-cache/context); on
  Apple unified memory use a RAM-derived budget; CPU-only uses a RAM budget with
  a hard small-model cap.
- A model **fits** if `approxVramMB <= budget`. Rank fitting models by capability
  within budget; mark one `recommended` per topic (chat/code/vision/embeddings).
- Quant-aware: prefer the largest quant of a family that still fits (quality),
  not the smallest.
- Always return *something* runnable (the smallest viable model) even on weak
  hardware, with an honest note.

**Catalog source:** ship a curated, versioned JSON catalog in-repo (a few dozen
well-known Ollama models with measured VRAM/quant/topic tags) — deterministic,
testable, offline. A later iteration can refresh it from the Ollama library API,
but the static catalog is the dependable v1 (and keeps recommendations
reviewable, not surprising). Catalog entries map `topics` onto our existing
topic-binding vocabulary so a pick is immediately bindable.

---

## 3. Install + serve + bind — the click-to-run action

`POST /api/models/recommend` → returns `{ hardware, scored[] }` (read-only).
`POST /api/models/install` `{ id, bindTopics: string[] }`:
1. `OllamaProvider.pull(id)` → `POST {ollamaUrl}/api/pull` (stream progress to
   the client via the gateway event bus — reuse the work-stream transport from
   feature #1, so the download shows a live progress bar instead of a hang).
2. On success, `ModelRegistry.registerModel(...)` for the pulled model.
3. Bind it to the requested topics (`topicRoles[topic] = 'primary'`) — or, if
   it's the first model, set it as the default. Resolves via topic, never a
   literal (rule #2).
4. Fail loud on pull/registration errors (DESIGN.md rule #1) — surface the
   Ollama error, don't silently no-op.

Admin-gated (it installs software + binds routing) via the existing permission/
admin checks on model routes.

---

## 4. Surfaces

**CLI — inside `octi setup` (step 6 alternative) + standalone `octi models recommend`:**
- During setup, if Ollama is reachable (`probeOllama`) and no provider is
  configured yet, offer: *"Scan hardware and recommend a local model?"* → show
  the top fit per topic → one keypress to pull + bind. This turns the hardest
  setup step into a guided one.
- Standalone `octi models recommend [--install <id>]` for later use.
- Non-interactive: `OCTIPUS_SETUP_RECOMMEND=1` picks the top recommended chat
  model automatically (good for Docker/CI first-boot).

**Web — `web/app/models/page.tsx` "Recommended for your hardware" panel:**
- Shows the detected `HardwareProfile` (with provenance) + a ranked list with
  "fits / doesn't fit" and VRAM bars, grouped by topic.
- Per row: "Install & use for {topic}" → streams pull progress (work-stream
  transport) → row flips to "Installed · bound to {topic}".

---

## Security / trust notes
- The probe shells out to read-only commands (`nvidia-smi`, `sysctl`); no writes,
  contained, timeout-bounded. Goes through the same probe discipline as the rest
  of `src/setup/probes.ts`.
- `install` runs `ollama pull` — admin-only, and Ollama itself is the trust
  boundary for what it downloads. We pull only catalog `id`s we ship (no
  arbitrary user-supplied model strings to the pull endpoint in v1 → no
  injection surface); a later "advanced: pull any model" mode would validate the
  name shape.
- No secrets involved (local Ollama needs none), so this is lower-risk than the
  provider/vault flows.

## Testing
- **Scorer**: pure unit tests — feed synthetic `HardwareProfile`s (24 GB / 12 GB
  / 8 GB / Apple unified / CPU-only) and assert the fit/recommend output and that
  every profile yields at least one runnable model. Deterministic; no hardware
  needed.
- **Probe**: parser unit tests against captured `nvidia-smi`/`sysctl` sample
  output; the live detection path is best-effort and exercised manually.
- **Catalog**: a conformance test (T2-style) — every entry has a valid quant,
  `approxVramMB > 0`, and `topics` that map to known topic-binding names.

## Sequencing (within this feature)
1. `probeHardware()` + parser tests.
2. Curated catalog JSON + scorer + scorer/catalog tests (no UI yet —
   `octi models recommend` prints a table).
3. `OllamaProvider.pull()` + `POST /api/models/{recommend,install}` + topic bind.
4. Web "Recommended" panel + setup-wizard integration + streamed progress
   (depends on feature #1's work-stream transport for the progress bar; can ship
   with a simple poll first if #1 isn't ready).

Each step its own PR; typecheck/lint/eval green per the audit workflow.

## Explicitly out of scope (this wave)
Non-Ollama serving (raw GGUF/llama.cpp/vLLM), multi-GPU placement, fine-tuning,
auto-refreshing the catalog from a remote API, arbitrary user model pulls.
