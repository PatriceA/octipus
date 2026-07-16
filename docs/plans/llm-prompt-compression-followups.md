# LLM Prompt Compression — Follow-ups Plan

## Context

The five phases of `docs/plans/llm-prompt-compression.md` shipped (PRs
#219–#225). This plan tracks the items deliberately deferred from those
phases. Each was deferred for one of two concrete reasons:

1. **Eval-gated.** The item changes model-visible prompts or output contracts,
   so per DESIGN.md it must gate on the CI-blocking `bun run eval` + red-team
   suite. That suite needs live model credentials and does not run locally, so
   these items cannot be validated in a normal dev loop — they belong in a
   branch where CI runs the eval.
2. **Cross-cutting / flagged risk.** The item touches the failover /
   error-classification chain or requires threading state end-to-end, which the
   parent plan's §Risks called out as needing its own scoped change.

The same discipline as the parent plan applies: **SECURITY_PREAMBLE stays
first and untouched; user/session data stays out of cached prefixes; fail
loud; every prompt/contract change gates on eval + red-team.**

## Non-goals

- Re-litigating anything already shipped. This plan is only the remainder.
- Inventing new compression mechanisms (covered/rejected in the parent plan's
  Non-goals — no symbolic protocols, no learned compression yet).

---

## Item A — Anthropic `cache_control` beyond the native path

**Shipped:** `cache_control` breakpoints on the custom-anthropic **native**
provider (`buildCachedSystem`, PR #224) — splits the system prompt at the
deterministic date marker and caches the static prefix.

**Remaining:**

### A1. LiteLLM + OpenRouter pass-through for Anthropic-family models
- LiteLLM and OpenRouter forward Anthropic `cache_control` content blocks to
  Anthropic upstreams. Emit the same static/volatile split as
  `buildCachedSystem`, but in the OpenAI-style **message content-block** shape
  those paths use (not the native `system` array).
- Reuse the volatile-marker split; only the serialization differs. Gate on
  "bound model is Anthropic-family".
- **Acceptance:** on an Anthropic-family model routed via LiteLLM/OpenRouter, a
  20-turn session reports ≥60% cached input tokens from turn 2 (Phase 1
  cost/telemetry already measure this).

### A2. Native migration of the main `anthropic-provider`
- The main `anthropic-provider` (`anthropic-provider.ts`) speaks OpenAI-compat
  via the `openai` SDK to `api.anthropic.com/v1/chat/completions`, which
  **strips `cache_control`** (confirmed by the in-file comment at
  `anthropic-provider.ts:56-61`) — so it can never cache without moving to the
  native `/v1/messages` path.
- **Don't build a fresh native path.** The native `/v1/messages` transport
  already exists as `CustomAnthropicCompatProvider` (`custom-anthropic`,
  `custom/anthropic-compat-provider.ts`), and it already calls
  `buildCachedSystem`. A2 is: route Anthropic-family models through that
  existing provider (or fold its `/v1/messages` + `buildCachedSystem` path into
  `anthropic-provider`), not write native Anthropic wire code from scratch.
- **Risk (parent plan §Risks):** both providers already wrap errors with
  `classifyError` (`anthropic-provider.ts` lines 72/116/150/248;
  `custom-anthropic` lines 62/67/102) but tag a different provider name, so
  failover behavior can diverge. Keep the OpenAI-compat path as a fallback until
  parity is proven; gate the native path behind a model/config flag; A/B the
  error-classification behavior before flipping the default.
- **Acceptance:** failover parity (same `ClassifiedError` outcomes on injected
  429/500/timeout) + the same cache-hit acceptance as A1.

---

## Item B — Enforced structured output on agent boundaries

**Shipped:** structured *consumption* on two distinct boundaries — the swarm
`<ChildResult>` envelope + deterministic `SwarmReceipt`
(`collect-tool.ts`/`receipt.ts`), the pipeline handoff parser
`parseStructuredHandoff` with per-field regex fallback (`handoff.ts`), and the
QA 3-tier verdict parser (`parseQAResult` → inline → `parseProseVerdict`) with
the `confidence` enum — all with loud fallbacks (PR #221). Note these are
separate boundaries: `parseStructuredHandoff` runs on the *pipeline* stage
handoff, not on `<ChildResult>` receipt.

**Remaining (eval-gated — this is the *enforcement* half):**

### B1. Enforce `expectedOutput.schema` as provider `responseFormat`
- **Prerequisite — the `responseFormat` surface has no schema slot yet.**
  `CompletionOptions.responseFormat` is `{ type: 'text' | 'json_object' }`
  (`litellm-client.ts:25`); there is no `json_schema` path. Either (a) extend
  that type to carry a `json_schema` and map it per provider, or (b) scope B1 to
  `json_object` + in-app validation of `expectedOutput.schema` after the fact.
  Pick (b) unless eval shows provider-side `json_schema` measurably beats
  post-hoc validation — it's the smaller change and avoids per-provider schema
  mapping. `expectedOutput.schema` is currently plumbed into the brief
  (`spawner.ts:187`) but **only `shape`/`maxTokens` reach the child prompt**
  (`spawner.ts:1378-1382`) — `schema` is stored-but-unused today.
- Apply on the child's **final** turn — not every turn (`json_object` on a
  tool-calling turn breaks the tool call).
- **Threading required:** `brief.expectedOutput.schema` → child agent context →
  `agent-worker` completion opts, applied only when the worker is emitting its
  final answer (detect via the `final` tool via `hasFinalToolCall` /
  no-more-tools state — both already exist in `agent-worker`/`tool-executor`).
- **Weak-model caveat (parent §Risks):** some models ignore `json_object`.
  Fail loud — let the typed `ChildResult.status` carry the failure; never
  silently degrade to prose.
- **Acceptance:** schema-validated child outputs on capable providers with
  eval + red-team parity; injected text inside a schema-validated payload does
  not steer the parent (red-team case).

### B2. Retire the prose QA parser once templates emit JSON
- Update the built-in QA / Code-Review stage templates to emit enforced
  `{"passed":bool,"confidence":"high|medium|low","issues":[...]}`.
- Only **after** eval shows the JSON path fires on 100% of QA stages, delete
  `parseProseVerdict` (the 3rd-tier prose fallback). Until then it stays as the
  loud fallback added in Phase 3.
- **Acceptance:** QA retry loop triggers off schema fields on 100% of eval QA
  stages; deleting `parseProseVerdict` leaves eval green.

### B3. Pipeline handoff emit side
- Phase 3 shipped the *consumer* (`parseStructuredHandoff`, prefers a
  ```handoff block). Teach the built-in pipeline stage templates to **emit**
  that block so the structured path actually fires; the regex extractor stays
  as the loud fallback for free-prose stages.
- **Acceptance:** structured handoff consumed (not regex-scraped) on 100% of
  eval pipeline stages.

---

## Item C — Dense per-role prompt rewrites (P4 item 3)

Only `orchestrator` has a `prompt.lite.md` today (485 tokens vs the 2,080-token
`prompt.md`); every other role ships a single `prompt.md` and workers *trim it
inline* by section (`worker-spawner.ts`, gated on `isSmall`) rather than
selecting a separate tier file. Give each role a dense rule-table variant so the
small-model path selects a purpose-built prompt instead of a trimmed one.

- **Per-role, per-tier, eval-gated.** For each role: author a dense variant,
  A/B against `bun run eval` + red-team, ship only the variant that scores
  **equal-or-better** on both quality and red-team. A terse prompt that ties on
  quality but regresses on red-team does not ship.
- `SECURITY_PREAMBLE` is exempt (rule 1) — never terse-rewritten.
- Small models need *different*, not just shorter, prompts — the tier detection
  already exists (`mode-selector.ts` `resolveOrchestratorMode`, `small-model.ts`
  `isSmallModel`, both off `deriveParamCount`); this item adds the per-role
  prompt files it selects, which don't exist yet outside `orchestrator`.
- **Acceptance:** role-prompt token count materially down (target 40–60%) with
  eval + red-team parity, per role.
- **Why not done inline:** requires the eval harness to compare variants; a
  wrong terse rewrite silently degrades every spawn of that role.

---

## Item D — Remaining per-section token budgets (P5 item 2)

`truncateToTokens` shipped and bounds the AGENTS.md guide (PR #225). Apply the
same helper to the other large injected sections:

- **Expert index** (`buildExpertIndexBlock`) and **repo suite/map**
  (`orchestrator-runner`): give each a per-section token budget with
  deterministic truncation order (highest-value entries first), so a large
  workspace can't let one section dominate.
- These are already count-bounded (top-40 repos, etc.), so this is lower risk
  than the AGENTS.md case — mechanical, not eval-gated. Bundle whenever
  convenient.
- **Acceptance:** no per-turn context section exceeds its token budget; a
  40-repo workspace's suite block stays within budget with the highest-value
  repos retained.

---

## Sequencing

Independent; rough value/effort order:

1. **D** — mechanical, safe, not eval-gated. Quick win.
2. **A1** — localized, measurable, reuses the shipped split.
3. **B3 → B1 → B2** — the eval-gated structured-output chain; do emit sides
   first (B3, B1 templates) so the enforcement (B2 deletion) can be proven safe.
4. **C** — largest eval surface; one role at a time.
5. **A2** — highest risk (failover chain); gate behind a flag, prove parity.

Every item that changes a prompt or an output contract records before/after
token numbers against the Phase 1 baseline and appends them here.

---

## Status — all items implemented (one PR + code review each)

| Item | PR | Notes |
|------|----|-------|
| **D** — per-section token budgets | #227 | `truncateLinesToTokens` bounds the expert index + repo suite (whole-line, keeps ≥1). Not eval-gated. |
| **A1** — cache_control pass-through | #228 | Shared `prompt-cache.ts` (`splitVolatileSystem`, `isAnthropicFamily`, `applyAnthropicCacheControl`); wired into LiteLLM + OpenRouter. |
| **B3** — pipeline handoff emit | #229 | `HANDOFF_EMIT_INSTRUCTION` injected at runtime for non-final stages; block stripped from persisted output. |
| **B1** — schema enforcement | #230 | `deriveSchemaScorer` → shape gate (valid-JSON object + `required` keys) at the scorer gate; shape=json only; fence-tolerant. |
| **B2** — QA JSON verdict | #231 | `QA_VERDICT_JSON_INSTRUCTION` for `qa_validation` stages (incl. retries); `parseQAResult` scans all fences. `parseProseVerdict` kept. |
| **C** — dense per-role prompts | #232 | `prompt.lite.md` for all 16 roles; selected on the small-model path keyed off finalModel. |
| **A2** — native /v1/messages | #233 | Opt-in (`ANTHROPIC_NATIVE_MESSAGES=1`), default off; reuses the compat native transport; `classifyError(…, 'anthropic')`. |

## Remaining (yours — needs eval / live models / funding)

**Register + fund (nothing exercises A1/A2 live yet):**
- **A1:** register an Anthropic-family model on the `litellm` or `openrouter` provider (e.g. `anthropic/claude-sonnet-4-6`). Acceptance: ≥60% cached input tokens from turn 2.
- **A2:** set `ANTHROPIC_NATIVE_MESSAGES=1` **and** register a model on the `anthropic` provider (none today; needs `ANTHROPIC_API_KEY`/vault). A/B failover parity (injected 429/500/timeout → same `ClassifiedError`) + cache hits before flipping the default.

**Run `bun run eval` + red-team (CI-gated prompt/contract changes):**
- **B1, B2, B3:** confirm no quality/red-team regression. After eval shows B2's JSON path fires on 100% of QA stages, delete `parseProseVerdict`.
- **C — per role:** A/B each of the 16 dense variants; ship only equal-or-better ones. Provisional until then (blast radius = small models only).

**Deferred (documented in code):**
- B1 deep/nested schema validation (currently shallow).
- A2 `responseFormat` on native (Anthropic native has no JSON mode).
- Provider-side `json_schema` responseFormat surface (only if provider-enforced schema is wanted over B1's in-app validation).
