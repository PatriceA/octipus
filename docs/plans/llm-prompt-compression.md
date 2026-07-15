# LLM Prompt Compression & Token Efficiency — Plan

## Context

Analysis of Octipus's LLM communication (July 2026) found that prompts are
verbose human prose, rebuilt and re-billed from scratch on every turn, and
that inter-agent handoffs repeatedly round-trip through free text:

- **System prompts are layered English prose**, concatenated per spawn
  (`src/core/orchestrator/worker-spawner.ts:480-710`):
  `SECURITY_PREAMBLE` (~320 tok) + `OUTPUT_FORMATTING_RULES` (~120 tok) +
  persona (~800 tok default) + role prompt (~380–2,080 tok) + skill
  fragments (potentially tens of KB) + date + git status + profile +
  memory block. A full-mode orchestrator turn re-sends ~5–8K mostly-static
  tokens every turn.
- **Prompt caching is absent everywhere.** No `cache_control` blocks are
  ever emitted (`src/models/providers/anthropic-provider.ts:56-61`
  documents why the OpenAI-compat path can't). The `cacheReadTokens` /
  `cacheCreationTokens` fields providers *do* return are populated on
  `CompletionResult.usage` and consumed by nothing — not
  `src/models/cost-tracker.ts`, not `src/core/telemetry.ts`.
- **Token counting is `chars/4`** (`src/utils/context-compaction.ts:34`).
  All budgets (32K window, 100K budget, compaction thresholds) enforce
  against an estimate that is 20–50% off for code/JSON.
- **Structure is thrown away at every agent boundary.** `spawn_child` is a
  typed tool call, then `composeChildMessage`
  (`src/core/swarm/spawner.ts:1301-1397`) flattens it into a prose brief
  with ~1.5 KB of static delegation-policy boilerplate per depth-1 child.
  The declared `expectedOutput.schema` is advisory prose, never enforced.
  Child results return as `<ChildResult>` envelopes of free prose the
  parent LLM re-interprets (`src/core/swarm/swarm-tool.ts:472-490`);
  the deterministic `SwarmReceipt` is not in the string the parent sees.
  Pipeline handoffs regex-scrape stage prose
  (`src/core/orchestrator/handoff.ts:119-159`); the QA retry loop parses
  verdicts through a 3-tier JSON→regex→prose fallback
  (`src/core/orchestrator/pipeline-manager.ts:933-1029`).
- **Injected context is count-limited, not token-limited.** 20 memory rows
  per turn regardless of size; skill fragments inlined verbatim;
  summarizer input silently truncated at 8,000 chars.

The principle for the whole plan: **keep structure on the wire as
schema-enforced JSON, cache the static prose, and measure with real
numbers.** No invented token vocabularies — models are trained on natural
language and JSON, not on novel symbolic notations, and API providers do
not let us extend tokenizers. "Macro-tokens" are realized here as prompt
caching (a cached prefix is a reference that costs ~10–25% of input price)
and reference-by-ID (advertise, don't inline — the lazy tool-advertisement
mode in `src/core/agent-base.ts` already does this for tool schemas).

## Goals

1. Cut per-turn input cost of the static prompt prefix by ≥70% on
   cache-capable providers.
2. Cut inter-agent exchange size ~3–5× by replacing prose envelopes with
   schema-enforced JSON, removing three regex-parse failure modes.
3. Make every saving measurable: cached-token accounting in cost tracking
   and Prometheus before any compression ships.
4. No quality or safety regression: every prompt change gates on
   `bun run eval` + the red-team suite (CI-blocking, per DESIGN.md).

## Non-goals

- Inventing a compressed symbolic protocol (ART-style bracket notation,
  custom macro-tokens). Not implementable against API tokenizers; hurts
  the "Observability over cleverness" design principle.
- Learned prompt compression (LLMLingua et al.). Revisit only after
  caching + structural fixes land; smaller marginal win, big dependency.
- Emitting raw probability floats as certainty markers. LLM self-reported
  probabilities are poorly calibrated; use enumerated confidence
  (`high|medium|low`) in enforced JSON instead.

---

## ⚠️ SECURITY — read before touching any prompt

This section is load-bearing. Every phase below is subordinate to it.

1. **`SECURITY_PREAMBLE` is sacred.** DESIGN.md ("Security preamble is
   load-bearing") forbids editing it without an issue and an argument. It
   is **excluded from all compression work**. It stays the *first* block
   of every system prompt — which is also exactly what prefix caching
   wants. Do not reorder it, do not terse-rewrite it, do not dedupe it
   away except via the existing `stripSecurityPreamble()` path
   (`src/core/orchestrator/roles.ts:101`).
2. **Compression must never weaken injection resistance.** The red-team
   eval suite (prompt injection, role confusion, tool misuse, data
   leakage, off-topic drift) runs on every phase and blocks merge.
   A terse role prompt that scores equal on quality but worse on red-team
   does not ship.
3. **Structured handoffs REDUCE injection surface — that is a security
   win, state it and test it.** Today a child agent's free prose (which
   may embed attacker text from web content or tool output) is
   re-interpreted by the parent LLM, and pipeline regexes scrape prose
   that can be steered. Typed JSON envelopes with schema validation
   narrow what a compromised child can say to the parent to known fields.
   Add red-team cases: injected instructions inside `ChildResult.output`,
   inside QA `issues[]`, and inside handoff `decisions[]` must not steer
   the consumer.
4. **Prompt caching must not cache user-scoped data into shared prefixes.**
   Cache breakpoints go **only** after static, role-scoped content
   (preamble + formatting rules + persona + role prompt + skills). All
   user/session-scoped material (profile facts, memory block, git status,
   date) moves *after* the last breakpoint. Provider caches are
   API-key-scoped and exact-prefix-matched, so cross-user leakage via the
   provider is not expected — but keeping user data out of cached blocks
   is defense in depth and keeps the cache useful across users.
5. **Never cache secrets.** Vault values must not appear in prompts at
   all (existing rule); caching makes any violation worse by persisting
   it provider-side for the TTL. Add a pre-flight assert in the cache
   marker path that the cached block contains no `vault:`-resolved
   strings.
6. **Session-scoped alias/dictionary tables (if ever added) are
   session-private.** A symbol table mapping IDs to file paths/entities
   must live in session state, never in shared caches, or it becomes an
   information-disclosure channel.
7. **Fail loud applies.** If schema-enforced output fails validation, the
   worker sees the error and retries or surfaces it — no silent fallback
   to prose parsing (that would quietly reopen the injection surface the
   schema closed).

---

## Provider caching matrix

Ground truth: **all direct providers currently speak OpenAI-compat via the
OpenAI SDK** — including Anthropic (`https://api.anthropic.com/v1/`,
`anthropic-provider.ts:14`) and Gemini
(`…/v1beta/openai/`, `gemini-provider.ts:17`). That choice blocks the two
explicit-caching APIs (Anthropic `cache_control`, Gemini `cachedContents`)
but is irrelevant to the automatic-caching providers, which only need a
**stable prompt prefix**.

| Provider | Mechanism | Discount (verify at impl time) | What Octipus must do |
|---|---|---|---|
| **Anthropic** | Explicit `cache_control: {type:"ephemeral"}` breakpoints; native `/v1/messages` only; 5 min TTL (write 1.25×) or 1 h (write 2×); min cacheable block ~1024–2048 tok | reads ~10% of input price | Route through native path — the custom `anthropic-compat-provider.ts:130-151` already builds native bodies and already *reads* `cache_read_input_tokens`; add breakpoints there, or migrate the main provider off OpenAI-compat |
| **OpenAI** | Automatic prefix caching, prompts ≥1024 tok; optional `prompt_cache_key` for cache-routing affinity | ~50–90% depending on model | Nothing to send. Stable prefix ordering (Phase 2a) + read `prompt_tokens_details.cached_tokens` (litellm-client already does at `:465`; direct provider must too) |
| **Gemini** | Implicit caching, automatic on 2.5+ models; explicit `cachedContents` API (native only, storage fee + TTL) | implicit ~75–90% on cached tokens | Stable prefix; confirm whether the OpenAI-compat layer reports/discounts implicit cache hits (open question — test and record; if not, consider native `generateContent` path later) |
| **DeepSeek** | Automatic context caching (disk), always on | cache hits ~90% cheaper | Stable prefix; parse DeepSeek-specific `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` usage fields in `deepseek-provider.ts` |
| **xAI Grok** | Automatic prompt caching; ~5 min window; `x-grok-conv-id` header recommended to maximize hit rate | ~75–90% depending on model | Stable prefix; set `x-grok-conv-id` per session in `grok-provider.ts`; read cached-token usage |
| **Mistral** | Explicit opt-in: set `prompt_cache_key` on chat-completions requests sharing a prefix; caches in 64-token blocks (<64-token prompts never hit); key raises hit likelihood but doesn't guarantee it | cached tokens ~10% of input price (90% off) | Send `prompt_cache_key` (stable per session, e.g. sessionId hash — no secrets in the key) in `mistral-provider.ts`; stable prefix; read `prompt_tokens_details.cached_tokens` |
| **Ollama (local)** | KV-cache prefix reuse for the loaded model (`keep_alive`); no billing — latency win | prompt-eval skip | Stable prefix ordering makes repeated prefixes near-free to re-process locally |
| **OpenRouter** | Pass-through: forwards Anthropic `cache_control` content blocks; automatic for OpenAI/DeepSeek-style upstreams; reports cache discount in usage/generation metadata | per upstream | Emit `cache_control` blocks for Anthropic-family models; read cached-token usage in `openrouter-provider.ts:75` |
| **LiteLLM (proxy path)** | Pass-through of `cache_control` to Anthropic; already surfaces `cached_tokens` (`litellm-client.ts:463-476`) | per upstream | Emit `cache_control` in message content when the bound model is Anthropic-family |
| **CLI providers** (Claude Code, Gemini CLI, Codex) | The CLI harness does its own prompt caching internally | n/a | Nothing |
| **Voyage** | Embeddings — n/a | — | — |

Two consequences:

- **Phase 2a (stable prefix ordering) benefits *every* provider at once**
  — OpenAI, DeepSeek, Grok, Gemini get their discounts with zero request
  changes, and Ollama gets latency. It ships first.
- **Only Anthropic needs request-shape work** (breakpoints + native
  path). Mistral and Grok need one-line request additions
  (`prompt_cache_key` / `x-grok-conv-id`), and
  DeepSeek/Grok/Mistral/OpenRouter need small usage-parsing additions.

---

## Phase 1 — Measure first (no prompt changes)

*Everything later must be provable. Est. small.*

1. **Wire cached-token accounting end to end.**
   - `logUsageWithCost` (`src/models/cost-tracker.ts`) takes
     `cachedInputTokens` (+ `cacheCreationTokens`) and prices them at the
     provider's cached rate (new columns on `costLog`; migration).
   - `recordLlmRequest` (`src/core/telemetry.ts:168`) gains a
     `direction="prompt_cached"` series on `octipus_llm_tokens_total`.
   - Pass-through from every provider's usage parsing: OpenAI-compat
     `prompt_tokens_details.cached_tokens`, DeepSeek
     `prompt_cache_hit_tokens`, Anthropic-native
     `cache_read_input_tokens` / `cache_creation_input_tokens`.
2. **Real tokenizer for budgets.** Replace `estimateTokens = chars/4`
   with a real tokenizer (e.g. `js-tiktoken` `o200k_base` as the default
   estimator; providers' true counts still come from `usage`). Keep the
   `chars/4` path as fallback for exotic models. All compaction
   thresholds re-validated after the swap.
3. **Baseline dashboard.** Record one week of per-topic
   prompt/completion/cached token counts so Phases 2–5 have a before/after.

**Acceptance:** cost logs show cached vs uncached input priced
differently; Prometheus exposes the cached series; token estimates within
~5% of provider-reported usage on a sample.

## Phase 2 — Prompt caching

### 2a. Stable prefix ordering (all providers)

Reorder system-prompt assembly (`worker-spawner.ts`,
`orchestrator-runner.ts`, `swarm/spawner.ts`) into a strict
**static → semi-static → volatile** layout:

```
[STATIC, cacheable]    SECURITY_PREAMBLE + OUTPUT_FORMATTING_RULES
                       + persona block + role prompt + skill fragments
[SEMI-STATIC]          expert index, repo-suite map, AGENTS.md guide
[VOLATILE, never cached]  date/time, git status, profile facts,
                       related profiles, memory block, prior swarm
                       actions, session summary
```

The killer today is `CURRENT DATE & TIME` and memory injected mid-prefix —
they bust every automatic cache. Volatile content moves to the end of the
system prompt (or the first user message). Tool definitions must also be
ordered deterministically (sorted by id) since they participate in the
prefix for most providers.

**Security note:** rule 4 above — the static block is role-scoped only.

### 2b. Anthropic explicit breakpoints

- Extend `CompletionRequest` with optional `cacheBreakpoints` (indices
  into system-content blocks), emitted as `cache_control` by providers
  that support it, ignored elsewhere.
- Implement in `custom/anthropic-compat-provider.ts` (already native
  body + already reads cache usage fields), then decide whether the main
  `anthropic-provider.ts` migrates to the native path or delegates.
  Max 4 breakpoints: end of static block is the required one; end of
  semi-static is optional. Default TTL 5 min (matches turn cadence);
  make TTL config-driven.
- Emit the same blocks through the LiteLLM path and OpenRouter for
  Anthropic-family models.

### 2c. Provider-specific follow-ups

- Grok: send `x-grok-conv-id: <sessionId hash>` per request.
- Mistral: send `prompt_cache_key: <sessionId hash>` per request (no
  secrets/PII in the key); parse `prompt_tokens_details.cached_tokens`.
- DeepSeek: parse hit/miss usage fields.
- Gemini: measure whether OpenAI-compat surfaces implicit-cache discounts;
  document the finding in this file; only then evaluate a native path.

**Acceptance:** on a 20-turn session against Anthropic + one automatic
provider, ≥60% of input tokens report as cached from turn 2 onward;
cost dashboard shows the discount; evals green.

## Phase 3 — Structured handoffs (stop prose→regex→prose)

1. **Enforce `expectedOutput.schema`.** When a `spawn_child` call declares
   a schema, set it as provider structured output (`responseFormat`) on
   the child's final turn instead of advisory prose. Plumbing exists in
   all providers (22 files already wire `responseFormat`).
2. **Typed `ChildResult` envelope.** Serialize status, token counts, and
   the deterministic `SwarmReceipt` (real tool-execution counters,
   `src/core/swarm/receipt.ts`) into the JSON the parent LLM reads —
   the parent audits against ground truth instead of the child's
   self-narration. Keep `output` as the schema-validated payload.
3. **QA verdict schema.** Replace the 3-tier prose parse with enforced
   `{"passed": bool, "confidence": "high"|"medium"|"low", "issues": [...]}`.
   Update the built-in QA stage template accordingly. Delete
   `parseProseVerdict` once eval passes. (Certainty markers, done right:
   enumerated, not floats.)
4. **Pipeline handoff schema.** Stages emit
   `{decisions, openQuestions, artifacts, nextStageInstructions}` as
   structured output; `createHandoffContext` consumes it directly and
   the regex extractors become a fallback for legacy/free-prose stages
   only — with a loud log when the fallback fires (Fail loud).

**Security acceptance (rule 3):** new red-team cases proving injected
text inside child output / QA issues / handoff fields does not steer the
consumer. **Functional acceptance:** pipeline retry loop triggers off
schema fields on 100% of QA stages in eval; parent-visible receipt
matches recorded tool counters.

## Phase 4 — Deduplicate and terse-ify (eval-gated)

1. **Move the ~1.5 KB delegation-policy boilerplate** out of every
   depth-1 child brief (`spawner.ts:1353-1388`) into the role prompt
   layer (static → cached). The brief keeps only per-task fields.
2. **Send briefs as compact labeled fields**, not expanded prose
   sections — task / constraints / forbidden / expected shape. Terser
   *and* less ambiguous.
3. **Generalize the lite-prompt pattern.** `prompt.lite.md` proves 485
   tokens can do the job of 2,080. Rewrite each role prompt as a dense
   rule-table variant; A/B against `bun run eval` + red-team per role;
   ship whichever scores equal-or-better. Expected 40–60% reduction on
   role prompts. **`SECURITY_PREAMBLE` is exempt (rule 1).**
4. **Reference-by-ID for skills.** Advertise skill names + 200-char
   descriptions; agent pulls full body via a `load_skill` tool on demand
   (same pattern as lazy tool advertisement / `mcp_list_tools`).

**Acceptance:** per-spawn brief overhead down ≥1.5 KB; role-prompt token
count halved with eval + red-team parity; skill bodies no longer inlined
by default.

## Phase 5 — Token-budgeted context injection

1. Memory block: budget in tokens (real tokenizer from Phase 1), rank by
   value-per-token, not a flat 20-row limit.
2. Skill fragments / expert index / repo map: per-section token budgets
   with deterministic truncation order.
3. Summarizer input: replace the silent 8,000-char slice
   (`utils/context-compaction.ts:326`) with chunked map-reduce
   summarization so long histories keep fidelity.

**Acceptance:** no per-turn context section can exceed its token budget;
compaction quality evals hold.

---

## Rollout & sequencing

Phases are independent enough to ship separately; the order above is the
dependency order (measurement → caching → structure → dedup → budgets).
Each phase: feature-flagged where behavior-visible, eval + red-team
gated, before/after token numbers recorded against the Phase 1 baseline
and appended to this document.

## Risks

- **Anthropic native-path migration** touches the failover/error-
  classification chain (`classifyError`); keep the OpenAI-compat path as
  fallback until parity is proven.
- **Cache-TTL cost inversion:** Anthropic writes cost 1.25–2×; sessions
  with a single turn *lose* money on breakpoints. Gate breakpoints on
  session type (orchestrator/worker roles, not one-shot background
  calls like the memory judge).
- **Terse prompts on small local models:** the lite variant exists
  precisely because small models need *different*, not just shorter,
  prompts. Terse variants are per-role-per-tier, chosen by the existing
  small-model detection.
- **Schema enforcement on weak providers:** some models ignore
  `json_object`. Fail loud (rule 7) and let the swarm's typed error
  path (`ChildResult.status`) carry the failure instead of silently
  degrading to prose.

## Pricing/behavior references (verify at implementation time)

- Anthropic prompt caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- Gemini context/implicit caching: https://ai.google.dev/gemini-api/docs/caching
- xAI prompt caching: https://docs.x.ai/developers/advanced-api-usage/prompt-caching
- DeepSeek context caching: https://api-docs.deepseek.com/guides/kv_cache
- Mistral prompt caching: https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
- OpenRouter prompt caching: https://openrouter.ai/docs/features/prompt-caching

---

## Implementation status (2026-07-15)

All five phases shipped to `main`, one PR + adversarial code-review each.
Remaining work is tracked in a follow-up plan:
**`docs/plans/llm-prompt-compression-followups.md`**.

| Phase | PR | Shipped | Deferred (→ follow-up plan) |
|---|---|---|---|
| **1 — Measure** | #219 | `cost_log` cache columns (migration 0078) + provider-aware cached pricing; `octipus_llm_cached_tokens_total`; `extractCachedTokens` across OpenAI-compat providers; real o200k tokenizer for `estimateTokens` | — |
| **2 — Caching** | #220, #224 | 2a stable prefix ordering (worker-spawner + orchestrator-runner); 2c Grok `x-grok-conv-id` + Mistral `prompt_cache_key`; **2b** `cache_control` on the Anthropic **native** path (`buildCachedSystem`, #224) | 2b: LiteLLM/OpenRouter Anthropic-family pass-through; native migration of the main OpenAI-compat `anthropic-provider` |
| **3 — Structured handoffs** | #221 | Receipt in `<ChildResult>` envelope; `parseStructuredHandoff` (```handoff fence, per-field fallback); QA `confidence` enum | `responseFormat` enforcement on the child's final turn; delete `parseProseVerdict` once QA emits enforced JSON |
| **4 — Dedup** | #222 | `buildDelegationGuidance` hoisted ~1.5 KB out of every brief into the cacheable system prompt (compact salience reminder kept) | Dense per-role prompt rewrites (`prompt.lite`-style, A/B per role). **Skill reference-by-ID was already implemented** (`list_skills`/`get_skill`) |
| **5 — Token budgets** | #223, #225 | Standalone `token-count.ts`; token-budgeted memory (value-per-token, logs drops); map-reduce summarizer (gated, `allSettled`); **per-section** bound on the AGENTS.md guide (`truncateToTokens`, #225) | Per-section budgets for the expert index + repo map |

**Deferred items are deferred for a reason**, not forgotten: each is either
eval-gated (needs the CI-blocking `bun run eval` + red-team suite, which can't
run locally without model credentials) or a cross-cutting change the plan's
§Risks flagged. They are specified in the follow-up plan.

Each phase's review caught real defects fixed before merge — notably the
cache-token convention split (Anthropic `input_tokens` excludes cached, OpenAI
includes), the `??`-doesn't-catch-empty-string handoff fallback, and an
average-ratio truncation that could exceed the very budget it enforced.
