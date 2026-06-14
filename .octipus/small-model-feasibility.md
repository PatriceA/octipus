# Running Octipus on one small local model — feasibility & plan

> Design note, 2026-06-13. Scope decision (owner): **pragmatic** — the realistic
> minimum is **1 small chat model + 1 small embedding model**, vision optional.
> This note records the feasibility investigation and the plan; gap #2 (a
> worker-side "lite" path) is started in the same change (see _Status_).

## The scenario

A user wants to self-host Octipus with a single local model (Ollama), no bigger
than ~10B params. The question isn't "does the orchestrator cope" — it already
does — it's whether everything *downstream* of the orchestrator (worker/expert
prompts and the automated background LLM tasks) is too heavy for a 10B model.

## What's already solved: the orchestrator tier system

`src/core/orchestrator/mode-selector.ts` resolves an execution mode from the
default model's parameter count (parsed from the model tag or
`metadata.paramCount`; MoE tags expanded to the aggregate):

| Mode | Param band (default) | Behaviour |
|---|---|---|
| `router` | < 10B | **No orchestrator LLM.** `classifier.ts` (keyword heuristics) → one specialist → relay. `router-turn.ts`. |
| `lite` | 10–24B | Shrunken orchestrator prompt (~560 tok vs ~2 260), single-step delegation, 3 iterations. `prompt.lite.md`. |
| `full` | ≥ 24B | Full swarm: parallel `spawn_child`, pipelines, 25 iterations. |

Thresholds are config (`orchestrator.routerSmallModelMaxParams`,
`liteModelMaxParams`); `mode: 'auto'` re-derives live so swapping the default
model changes the mode with no restart. **For a ≤10B model this auto-selects
router mode**, which is the right shape: the small model only ever runs as a
single role-scoped worker, never holding the swarm-coordination prompt.

This part is well-designed and already targets the user's scenario.

## The real gaps

### Gap 1 — "one model" is a fiction for some topics
A single 10B **chat** model cannot serve every topic. These are different model
classes and must be bound separately (or the feature degrades/disables):

- `embedding` — RAG + long-term memory vector store. Without it, RAG and memory
  recall fail (the `/api/knowledge/readiness` self-check already 503s).
- `vision` / `ocr` — document processing. Needs a vision model (LLaVA/Qwen-VL).

→ **Realistic minimum: 1 chat model + 1 embedding model.** Vision optional.
This is the scope the rest of the plan assumes.

### Gap 2 — workers have no size-aware mode (the orchestrator does)
Router mode picks one specialist, but that specialist still gets the **full**
treatment: full role prompt + full expert scaffold + full tool list. A typical
auto-selected worker assembles to ~2.1–3.3k tokens of system + tools before the
user's request, and hands a 14-tool surface (the `general` role) to a model that
loses track of large tool surfaces. There was no worker equivalent of the
orchestrator's `prompt.lite.md`. **This is the highest-leverage fix** and is
what this change starts on.

### Gap 3 — tool-calling / JSON reliability is the actual bottleneck
Not prompt length — *reliability*. `known-bad-orchestrators.ts` already blocks
the whole qwen3 family because local Ollama builds emit malformed tool-call JSON
(unbalanced braces). Ollama reports `tools: true` but `structuredOutput: false`
(`src/models/capabilities.ts`), so every JSON task relies on free-text parse +
repair, not enforced schemas. A 10B model that can't reliably produce tool JSON
breaks router mode too, because the single worker still calls tools. QA points
users at `glm-4.7-flash` / `qwen2.5:32b` as the local models that actually work.

### Gap 4 — automated background tasks degrade unevenly
Ten LLM tasks run outside chat. Pattern: **classification/judgment survives;
multi-source synthesis with strict output constraints fails.**

| Task | Topic | On a 10B model |
|---|---|---|
| Memory judge (ADD/UPDATE/DELETE/NOOP) — `memory/judge.ts` | `memory_extraction` | ✅ fine |
| Document categorize (10 classes) — `documents/processor.ts` | default | ✅ fine |
| RAG embedding — `rag/embeddings.ts` | `embedding` | ✅ (needs embed model) |
| Document OCR — `documents/processor.ts` | `ocr` | ✅ if vision model present |
| Memory extraction (facts+confidence) — `memory/extractor.ts` | `memory_extraction` | ⚠️ miscalibrated confidence; has non-LLM fallback |
| Doc/email summarize — `documents/processor.ts`, `email/service.ts` | default/`general` | ⚠️ lower polish |
| Context compaction — `session-compaction.ts` | default | ⚠️ degrades on long history; has non-LLM fallback |
| Email draft reply — `email/service.ts` | `general` | ⚠️ weak tone |
| Weekly knowledge review (wikilinks) — `knowledge/weekly-review.ts` | `knowledge_review` | ❌ misses links/connections |
| Deep research synthesis (cite-only-provided-ids) — `research/service.ts` | `research` | ❌ hallucinates citations |

## Feasibility summary (1 small chat model)

- **Good:** casual chat, single-specialist routing (router mode), simple
  coding/edits, classification, short summaries — *if* the model does reliable
  tool JSON (glm-4.7-flash class, not qwen3).
- **Degraded but usable:** memory extraction, compaction, summaries, email drafts.
- **Needs a 2nd model or disabling:** RAG + memory (embedding model), vision/OCR
  (vision model), deep research synthesis, weekly review, and multi-agent
  swarms/pipelines (router mode disables these by design).

## Plan (next steps)

1. **Small-model profile** — a first-class config preset that binds one chat
   model to all chat topics, prompts for an embedding model, and marks
   vision/research/weekly-review as disabled-or-degraded with a clear UI note.
   (Replaces the current 27-manual-binding setup.)
2. **Worker-side lite path** — mirror the orchestrator: trim worker prompts and
   cap the tool surface when the bound model is small. **(started — see Status.)**
3. **Enforce JSON** for the structured automated tasks via Ollama `format: json`
   where supported, instead of free-text parse+repair; give deep-research and
   weekly-review explicit small-model guards (disable / fall back) rather than
   silent low-quality output.
4. **Capability gate at bind time** — run the conformance suite's tool-calling +
   JSON tests when a model is bound and warn loudly if a small local model fails
   (extends the known-bad/known-good list into an active check).
5. **User-facing guide** — "Running Octipus on one local model": the realistic
   minimum, the feasibility matrix, and which features turn off.

## Status — what this change implements (gap #2, increment 1)

A worker-side small-model tier, the mirror of the orchestrator mode selector:

- **`src/core/orchestrator/small-model.ts`** — `isSmallModel(meta, routerMax)`
  (reuses `deriveParamCount`; returns `false` on unknown size so cloud models
  are never silently degraded), `capToolsForSmallModel` / `applyToolCap`.
- **`worker-spawner.ts`** — resolves the worker's topic model up front, derives
  the small tier once, and when small:
  - **caps the tool list** to `orchestrator.smallModelMaxTools` (default 7).
    Role tool lists are priority-ordered, so the cap keeps the core tools and
    drops the long tail (incl. MCP meta-tools / connector handlers).
  - **trims the expert scaffold**: skips the deliverable template and success
    metrics (quality scaffolding weak models follow poorly anyway). Critical
    rules stay — short and behavioral.
  - **skips the verbose MCP meta-tool guidance** (the `mcp_list_tools` →
    `mcp_call_tool` indirection small models can't drive, and whose handlers are
    usually capped away).
- **Config** — `orchestrator.smallModelMaxTools` (schema + defaults +
  settings-registry + env `ORCHESTRATOR_SMALL_MODEL_MAX_TOOLS`).
- **Tests** — `small-model.test.ts` (size banding, MoE, unknown-size guard,
  custom threshold, tool-cap edges).

## Status — gap #2 increment 2: the explicit `/expert` path

`handleExpertMessage` builds the expert prompt itself and passes it to
`spawnWorker` as a `systemPrompt` override, so the auto-path trim didn't reach
it (only the tool cap + MCP-skip, which apply to any worker). Mirrored the trim
so an explicitly invoked `/expert` on a small model gets the same lean prompt:

- tier detected from the expert's `modelPreference` (if set) else the role topic
  model;
- deliverable template + success metrics skipped when small;
- compact Response Guidelines (~180 tok → 3 lines);
- skills injected as the **index summary**, not full bodies (the main win for
  multi-skill experts).

## Status — gap #1 increment 1: a single model now binds all text topics

Worker topics are fail-loud (`getModelForTopic` has no default fallback), but
the first-boot bootstrap bound only `general` — so a one-model install broke the
moment the router routed to any other specialist (`coding`, `research`, …).
Fixed at the source:

- **`src/models/single-model-binding.ts`** — `SINGLE_MODEL_CHAT_TOPICS` (the 16
  role topics + `chat`/`simple`/`local`/`voice` + `memory_extraction`/
  `knowledge_review`/`evaluation`; excludes `embedding`/`ocr`/`vision`) and
  `singleModelTopicBindings()`.
- **`bootstrap-model.ts`** binds the single bootstrap model to all of them.
  `embedding`/`ocr`/`vision` stay unbound on purpose — the user adds those model
  classes separately, and the dependent features fail loud / degrade as designed.
- **Tests** — bindings + a drift guard that cross-checks the role subset against
  the live role registry, so a newly added role can't silently end up unbound.

This is the reusable engine the eventual config-profile UI/API (plan #1) will
call; the binding logic now exists and is tested independent of any UI.

### Deliberately not done yet (follow-ups)
- Smallness (gap #2) is derived from the **topic** model. An expert with an
  explicit big `modelPreference` over a small topic model would still be trimmed
  (rare; system experts ship without `modelPreference`). Revisit if it bites.
- Trimming role base prompts / a `prompt.lite.md` per role: low leverage and
  higher risk (the role body is the actual instructions, ~500–900 tok; the big
  bloat was tools + scaffold + skills, all now handled). De-prioritized.
- The config-profile **surface** (API/UI to re-bind an existing model to the
  single-model set, plus the degraded-feature warnings) — the engine exists; the
  surface + UX is the remaining part of plan #1.
- Plan items #3 (enforce JSON for structured tasks), #4 (capability gate at bind
  time), #5 (user guide) — unstarted.
