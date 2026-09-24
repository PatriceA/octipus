# Decision models (Jev-like "System One" models) as an optional lane

> **Status (2026-09-23):** see the phase table at the end for what is built.
> Every site runs in shadow mode until someone flips its `*_LIVE` constant.

## Why

TypeSafe released Jev on 2026-09-15 (limited early access). It is the first of
what TypeSafe calls *System One* models: it never generates text. The caller
supplies a `state` and a set of typed questions, and Jev returns calibrated
probabilities over a closed answer space, typically in about 100 ms, for about
$0.042 per million input tokens (output is free).

Octipus spends a lot of LLM calls on exactly this shape of work: triage an
email, classify a document, pick a lane, choose ADD/UPDATE/DELETE/NOOP for a
memory, pick one link candidate. Today each of these call sites builds a
free-text prompt, asks for `json_object` and repairs the JSON by hand. A
decision model would replace that with a typed answer and a real confidence
value. We could then gate automation on the confidence value instead of
trusting whatever the model said.

Jev is the first model of this kind, and it will not be the only one. Local,
open-weight equivalents are likely to follow soon. This plan therefore defines
a **decision-model kind** in Octipus, with Jev as one provider for it. Nothing
in Octipus should depend on Jev specifically.

## Jev facts that shape the design

| Aspect | Value |
|---|---|
| API | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{model, state, questions}` |
| Primitives | `noul` (P(true), 0–1); `choice` (≤255 options, per-option probabilities + `confidence`); `score` (2–10 ordered levels, continuous score + distribution + `confidence`) |
| Limits | ~64k tokens for state + all questions; ~32k tokens for state + the longest single question; text/JSON only (no images) |
| Semantics | Every question is evaluated **independently** against the same state. One answer never feeds into another question. |
| Weak spots | Counting, maths, date parsing and hex comparison are unreliable. Irrelevant state lowers accuracy. |
| Versions | `jev-latest`, `jev-preview`, or a pinned version (`jev-1.13.0`) |
| SDK | `@typesafe-ai/sdk` (Node 20+). A plain `fetch` is enough, so we add no dependency. |
| Deployment | Hosted only, closed weights. No self-host path. |

### Data protection: the actual situation

- **Training:** the privacy policy says TypeSafe *"will not train or fine tune
  any artificial intelligence or machine learning models on … Input"*. The
  worry that inputs are used for training is therefore **not supported by the
  published terms**. We have no way to audit that promise.
- **Retention:** this is the real problem. For non-enterprise customers,
  inputs are kept *"as long as reasonably necessary … or otherwise in support
  of our business or commercial purposes"*. Zero data retention (ZDR) is
  available only on enterprise contracts. Inputs may also be shared with
  service providers.
- **Location and legal basis:** hosted in the US only. The privacy policy has
  no GDPR section. A DPA exists at `typesafe.ai/legal/data-processing`.
- **Alternative route:** Vercel AI Gateway. See the next section.

### Vercel AI Gateway route (ZDR without an enterprise contract)

Vercel AI Gateway is a multi-provider proxy: one API key, billing through
Vercel, routing, fallbacks and observability. It serves Jev as
`typesafe-ai/jev`, and Octipus had no Vercel provider before this. For
evaluation models, the gateway works only through its own endpoints, not its
OpenAI-compatible one:

- `POST https://ai-gateway.vercel.sh/v1/evaluate` is the gateway's own
  evaluation shape. It is identical to TypeSafe's except that `noul` is named
  `boolean` and its answer is `{type:'boolean', probability}`. `usage` uses
  camelCase, and cost is returned in `providerMetadata.gateway.cost`.
- `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` is a TypeSafe
  wire-compatible endpoint. ZDR is **not documented** for this path, so we do
  not use it.
- **ZDR per request:** set
  `providerOptions.gateway.zeroDataRetention: true` in the body. Vercel lists
  TypeSafe as ZDR-compliant and no-training. The contract wording is:
  *"TypeSafe shall not retain prompts … longer than necessary to generate
  Output"*. Vercel itself retains nothing.
  - Cost: no extra charge per request, but it requires a Pro or Enterprise
    plan. Team-wide ZDR costs $0.10 per 1,000 requests.
  - If no ZDR provider is available, the request fails with
    `400 no_providers_available`, so there is no silent downgrade. We also
    send `only: ['typesafe-ai']`.
- **Trade-off:** Vercel becomes a second US processor, in exchange for
  enforceable no-retention. BYOK TypeSafe keys are skipped under ZDR unless
  they are marked as ZDR in the Vercel dashboard.

In Octipus, the route is selected by the model id alone, so no extra
configuration is needed:

| model id | route | vault key | policy |
|---|---|---|---|
| `typesafe-ai/jev` | gateway `/v1/evaluate` | `ai_gateway_api_key` | remote, ZDR enforceable per request |
| `jev-1.13.0`, `jev-latest` | TypeSafe direct `/v1/systemone` | `typesafe_api_key` | remote, input retained, no training |

The privacy gate requests ZDR exactly when a `personal` site runs on the
gateway route. The provider refuses a ZDR request on the direct route
instead of sending it without ZDR.

**Consequence:** until a ZDR contract exists or a local model is available,
personal data (email, documents, memories) must not go to Jev unless the owner
explicitly opts in. The design enforces this in code. It is not left to prompt
wording or to the LLM.

## Design principles

1. **Hard-wired, never chosen by the LLM.** Each call site is fixed code that
   builds `state` and `questions`, calls the decision model, and branches on
   the typed answer. The LLM never sees a "use Jev" tool. This follows the
   pattern TypeSafe itself recommends: *input → deterministic code → decision
   model → typed answer → deterministic code → act / escalate*.
2. **Optional per call site, with the LLM as fallback.** If no decision model
   is bound, or the privacy gate blocks the call, or the call errors, or
   confidence falls below the site's threshold, the call site runs its current
   LLM path unchanged. Octipus without a decision model behaves exactly as it
   does today.
3. **Provider-agnostic.** Octipus defines a decision-model contract. Jev is
   one implementation, a later local model is another, and a constrained LLM
   can act as a third, degraded one.
4. **Bound by topic, never hardcoded** (AGENT.md). The model resolves through
   `getModelForTopic`, and per-model behaviour lives in `ModelMetadata`.
5. **Fail loud.** A blocked or failed decision call leaves a log line that
   says why the call fell back. It never silently degrades.

## Architecture

### 1. Contract (`src/models/decision.ts`, new, one file)

The types are defined in `src/models/decision.ts`. Questions use the wire
naming, `criteria`, for both routes: a `{true,false}` record for `noul`, a
name→description record for `choice`, and an ordered array for `score`. Every
answer carries a `confidence`, which is the provider's own value when it
sends one and otherwise the top probability. The gateway sends none.
`decide(site, state, questions)` returns `DecisionAnswers | null`, where
`null` means the caller falls back to its LLM path.

A `DecisionSite` is `{ id, sensitivity: 'public'|'personal'|'secret',
minConfidence }`. It is a code constant that sits next to each call site, not
user configuration.

`decide()` does all of the following:

- resolves the model through `getModelForTopic('decision')`;
- applies the privacy gate (section 3);
- runs `filterPII` (`src/core/agent/pii-filter.ts:67`) on `state` whenever the
  model is remote and the site sensitivity is `personal`;
- validates the response against the question set: every key is present,
  every `choice` is one of the options, every probability is in [0, 1]. On a
  mismatch it logs loudly and returns `null`;
- logs the site, model, latency and confidence, and whether it fell back.

### 2. Model kind and provider

- `src/models/topics.ts:24`: add `'decision'` to `TopicKind`, plus one
  `decision` topic in `TOPICS`. Follow the `ocr`/`embedding` pattern, which
  also keeps it out of `TEXT_TOPIC_VALUES` and the single-model binding.
- `src/models/providers/interface.ts`: add an optional `decide?()` alongside
  `embed?`/`ocr?`.
- `decide()` calls `getProviderByName(model.provider)` directly and does not go through a `ProviderRouter` dispatch. The name heuristic would route `typesafe-ai/jev` to OpenRouter, because OpenRouter claims every id that contains `/`.
- Providers:
  - **`typesafe-provider.ts`** (built): a plain `fetch` for both routes (see
    the gateway table above), with keys in the **vault**. Errors go through
    `classifyError`, and usage and cost go through `recordProviderUsage`
    (`requestType: 'decision'`). Pin `jev-1.13.0` for reproducibility on the
    direct route.
  - **LLM-backed `decide()`** for any provider that already supports
    `responseFormat: json_schema`, with an `enum` constraint per question. It
    exists for local models and as a reference to measure against. Where the
    provider exposes logprobs, it derives probabilities from them. Otherwise
    `confidence = null`, which every site treats as below threshold. That
    means an LLM stand-in can **never** trigger automation that requires
    confidence.
  - **Future local System-One models:** a provider that implements `decide()`
    is enough. No call site changes.

### 3. Privacy gate (`ModelMetadata.dataPolicy`)

Add this to `ModelMetadata` (`src/db/schema/models.ts:67`), in jsonb, so no
migration is needed:

```ts
dataPolicy?: { hosting: 'local'|'remote'; retention: 'none'|'provider'; trainsOnInput: boolean }
```

The rule inside `decide()`, which is the single place every site routes
through:

| site sensitivity | local | remote + retention `none` (ZDR) | remote + retention `provider` |
|---|---|---|---|
| public | ✔ | ✔ | ✔ |
| personal | ✔ | ✔ (PII-filtered) | only if the owner enables `allowRetainedPersonalData` on the model, then PII-filtered |
| secret | ✔ | ✘ | ✘ |

Three things follow from this:

- If `dataPolicy` is unset on a remote model, treat it as the worst case
  (`retention: 'provider', trainsOnInput: true`).
- The Jev default is `{remote, provider, false}`. A ZDR contract flips it to
  `none`.
- The Models page shows the policy next to the model and a warning when
  `personal` sites run on it.

The gate is generic. Once it exists, it could also apply to ordinary
LLM topics. That is **out of scope here**, but worth noting for later.

## Call sites, ranked by value and risk

Each call site starts in **shadow mode**: the LLM path still decides, the
decision model runs alongside it, and the log records whether the two agree.
A site switches over only after its eval (section Evaluation) is green.

| # | Call site | Today | Decision questions | Sensitivity |
|---|---|---|---|---|
| 1 | **Email triage**, `src/core/email/service.ts:284` `triageInbox` | One `everyday` LLM call, hand-repaired JSON (`triageEntries` :243, `coercePriority` :228) | `choice` category (user's categories + `other`), `score` priority (levels written as concrete situations), `noul` needs_reply, `noul` is_newsletter/automated | personal |
| 2 | **Document categorisation**, `src/core/documents/processor.ts:787` `categorize()` | Free-text label on `getDefaultModel()` (not even a lane) | `choice` doc type (invoice, contract, payslip, letter, …, `other`), `noul` contains_deadline, `noul` needs_action | personal |
| 3 | **Memory judge**, `src/core/memory/judge.ts:106` | ADD/UPDATE/DELETE/NOOP as JSON | `choice` over the 4 verbs; below threshold → current LLM path | personal |
| 4 | **Link resolver**, `src/core/knowledge/link-resolver.ts:229` | LLM picks a candidate and returns JSON | `choice` over the candidates (≤255) + `none` | personal |
| 5 | **Lane routing**, `src/core/agent/lane-intent.ts:77` `selectLane` | Heuristic classifier with a confidence floor at :44 | Only **below** the heuristic floor: `choice` lane (7 canonical lanes). The heuristic stays first because it is free and local. | public/personal (message text) |
| 6 | ~~Router LLM classifier~~ | Deleted: `router.ts classifyWithLLM` had no callers | — | — |
| 7 | **KB relevance filter**, after `hybridSearch` (`src/core/rag/embeddings.ts:733`) | RRF only; no reranker exists | One `noul` "this chunk answers the query" per chunk, all in one request (questions are independent anyway). Drop chunks below a threshold. This adds a real reranking step. | depends on the source; product docs are public |
| 8 | **Answer grounding check** (new) | None | `noul` "the answer's claim X is supported by the retrieved chunks". Deterministic code splits the claims, then fans out. Unsupported → warning in the answer. | personal |
| 9 | **Evidence / QA gates**, `pipeline-manager.ts` evidence and QA verdict | The QA verdict contract uses up the run pool | `noul` "output satisfies requirement R" per requirement, as a cheap first gate. A reasoning-model review happens only when it is uncertain. | secret (code/workspace) → local only |
| 10 | **Browser micro-decisions**, `src/tools/browser*` | The agent's LLM loop decides every step | The LLM keeps planning. Code asks per page: `noul` cookie banner / login wall / captcha / page is the goal page; `choice` which of ≤255 interactive elements (from the snapshot) matches the step. The loop only goes back to the LLM for the plan and when confidence is low. | public, but personal on logged-in pages → decided by URL/session |

The following are deliberately **not** decision-model work: summarisation,
reply drafting, translation, research, and anything that generates text,
counts, does arithmetic or parses dates. A decision model is also not a
replacement for the heuristic classifier where the heuristic is already
certain.

## Evaluation

- One `eval/decision-*.yaml` suite per site, using labelled examples from real
  data (email and documents anonymised with `filterPII`). `npm run eval` is
  required anyway for routing changes (AGENT.md).
- Metrics per site: accuracy against the label, **calibration** (does P≈0.9
  mean ~90% correct?), fallback rate, p50/p95 latency, and cost compared with
  the current LLM path.
- A site switches from shadow to live only if accuracy is at least that of
  the LLM path and calibration is stable across the confidence bands used by
  the threshold.
- Every site logs a `decision shadow` line containing labels, counts or
  probabilities only, never content. `scripts/decision-shadow.ts` reads the
  backend log on stdin, either raw JSON or the pretty format that `octi`
  writes, and reports agreement per site, for example
  `npx tsx scripts/decision-shadow.ts < ~/.octipus/backend.log`. Email triage
  reports priority and category agreement separately, and both paths now
  share one priority rubric, so a disagreement is about the mail rather than
  about two different definitions of "high".
  Logs go to stdout only, so no table is needed until a log pipe proves
  insufficient.

## Phases

| Phase | Content | Done when |
|---|---|---|
| P0 ✔ | `decision.ts` contract + validation + `decide()`, `TopicKind 'decision'`, TypeSafe provider (direct + gateway, keys in vault), `dataPolicy` + gate, UI registration (provider label, secrets, Topics kind), `decision.test.ts` | Unit tests green. **Still open:** a live smoke test against Jev (no key yet), and the LLM-backed `decide()` (deferred until a local site needs it) |
| P1 ✔ (shadow) | Site 1 (`email/service.ts` `TRIAGE_SITE`, one `decide()` per message, score→priority + choice→category) and site 2 (`documents/processor.ts` `DOC_CATEGORY_SITE`). Both log `decision shadow` lines with labels only, never content. `decide()` never throws and caches "unbound" for 30 s | Shadow logs show agreement; then set `TRIAGE_LIVE` / `DOC_CATEGORY_LIVE`. Labelled eval suite still open (no decision-model eval harness yet) |
| P2 ✔ (shadow) | Site 3 memory judge (`JUDGE_SITE`), site 4 link resolver (`RESOLVER_SITE`, labels `1..n`/`none`), site 5 lane routing (`shadowLaneDecision`, fire-and-forget, only below the classifier floor; going live needs async lane selection at both callers). Shared `preferDecision()` helper. Site 6 (`router.ts classifyWithLLM`) was dead code with no callers, and has been deleted | Shadow agreement, then flip `JUDGE_LIVE` / `RESOLVER_LIVE`; lanes only after `npm run eval:routing` |
| P3 ✔ site 7 (shadow), site 8 deferred | Site 7: `search_knowledge` (`src/tools/knowledge/index.ts`, `RELEVANCE_SITE`) asks one `noul` per hit, fire-and-forget, and logs `wouldDrop` counts. Site 8 (grounding check) is **deferred**: agent answers combine many tools, so there is no single "answer from the KB" point to check. It needs its own design, for example a post-answer hook that is given the retrieved passages | Go live on site 7 (await and drop `p < 0.2`) only if the shadow counts show it removes noise, not answers |
| P4 ✔ (shadow) | Site 9: `gateQaVerdict` (`pipeline-manager.ts`, `QA_SITE`, sensitivity **secret**, so it runs on a local model only). It logs agreement with the parsed verdict, plus what it would read when nothing parsed. It must never decide a gate on its own; at most it may recover `parsed === null`. Site 10: browser `open`/`navigate` page-state hints (cookie banner, login wall, captcha; `BROWSER_SITE`). The page is snapshotted synchronously, decided in the background, and the snapshot is skipped when no decision model is bound (`decisionModelBound()`) | Shadow numbers first; site 10 goes live by setting `BROWSER_HINTS_LIVE` (adds `pageState` to the tool result) |
| P5 ✔ | No open-weight System One model exists yet, so any **Ollama chat model** can serve the `decision` topic through a stand-in (`src/models/local-decision.ts`). It makes one call per question, labels options A–Z, predicts one token (`think:false`, `num_predict:1`) and normalizes the option letters' first-token logprobs; it refuses when less than 0.5 of the probability mass lands on an option. Measured on ornith:35b (warm): 3 questions in 3.5 s, with plausible probabilities. It is **uncalibrated** compared with Jev. Ollama counts as local only on a private endpoint (`isPrivateEndpoint`: loopback, RFC 1918, ULA, single-label or `.lan`-style hosts), never on ollama.com or a public IP | When a real local System One model ships, it only needs a `decide()` implementation |

## Open decisions for the owner

1. Request access to Jev early access or an enterprise ZDR contract? Without
   ZDR, personal sites stay gated to shadow/opt-in.
2. Default for `allowRetainedPersonalData`: off (recommended).
3. Is Vercel AI Gateway with `zeroDataRetention` acceptable as an interim
   route? It means a second US processor, but no retention.
4. Should the privacy gate also apply to ordinary LLM topics? Separate plan.

## Sources

- TypeSafe docs: https://docs.typesafe.ai/models
- Privacy policy: https://typesafe.ai/legal/privacy-policy, DPA: https://typesafe.ai/legal/data-processing
- API details and limits: https://flaviocopes.com/jev/
- Primitives and patterns: https://gist.github.com/pjburnhill/adf8d28efcad9df037bfdece178ef965
- LangChain harness: https://www.langchain.com/blog/building-a-harness-with-jev
- Local options: https://www.modemguides.com/blogs/ai-news/jev-typesafe-reality-check-run-locally
