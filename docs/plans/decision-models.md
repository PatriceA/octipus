# Decision models (Jev-like "System One" models) as an optional lane

> **Status (2026-09-23):** see the phase table at the end for what is built.
> On 2026-10-21 the owner requested full live decisions. All eight implemented sites now use live paths in source; the running process needs the rebuilt backend to activate them.

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
| 11 | **Stage skill selection** (`skills.select`), `src/skills/required-skills.ts`, used by `worker-spawner.ts` when a pipeline step sets `autoSkills` | Skills appear only as an index; agents seldom call `get_skill` | One `noul` "the task needs skill X" per discovered candidate (≤ 8). A skill is loaded in full only when `p` ≥ 0.8 and confidence ≥ 0.8. | secret (task carries code) → local only |

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

## Local Clef-flash integration

### Local Clef-flash spike (2026-10-21)

The proposed chat-logprobs integration is blocked by a model/API mismatch.
Do not bind Clef-flash through the generic letter prompt without revising the
plan: the published model uses a joint schema head, not generated answer
letters. Native integration was explicitly reserved for a follow-up in the
execution plan.

- Candidate: `-hf ggml-org/Clef-Flash-GGUF:Q8_0`, file
  `Clef-Flash-Q8_0.gguf`, 9.66 GB, Apache-2.0. The repository identifies
  Cloudflare/clef-flash as its source and the ggml-org conversion pipeline.
  This establishes provenance, not independently measured conversion fidelity.
  [Conversion card](https://huggingface.co/ggml-org/Clef-Flash-GGUF),
  [artifact](https://huggingface.co/ggml-org/Clef-Flash-GGUF/blob/main/Clef-Flash-Q8_0.gguf).
- Cloudflare publishes a native `state` + `questions` contract with `noul`,
  `choice`, and `score`. A dedicated head scores options in a forward pass;
  first-token logprobs and thinking-off switches do not implement that head.
  [Model card](https://huggingface.co/Cloudflare/clef-flash).
- llama.cpp supports this architecture through `/v1/systemone`; support
  landed in PR #29831 (merged 2026-10-03). Its implementation pools question
  and option token spans. A faithful conversion needs this support, not just
  Qwen3.5 backbone support.
  [Implementation](https://github.com/ggml-org/llama.cpp/pull/29831).
- The native request is `{ model, state, questions }`; retain the existing
  question types. llama.cpp notes that Clef processes questions jointly, so
  independent-question semantics need an explicit decision in the follow-up
  (one request per question preserves isolation).
  [Server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api).
- Workstation probes: `GET http://192.168.1.156:8080/health` returned HTTP
  200 with `{"status":"ok"}`; unauthenticated `GET /v1/models` returned HTTP
  401 with `Invalid API Key`. No authenticated inference was performed.

### Approved native integration (2026-10-21)

The owner confirmed Clef is loaded and approved replacing the chat-logprobs
plan with a native local `/v1/systemone` integration. No server/model swap is
needed in this repository. No Cloudflare Workers AI, LiteLLM route, or hosted
decision fallback is introduced. TypeSafe stays available but will be unbound.

1. Authenticate using the system vault entry `LLAMA_API_KEY`; discover the
   actual model id from `/v1/models` and server limits from `/props`. Verify
   both context and microbatch limits: Clef's full prompt must fit the server's
   microbatch. Do not assume the previous 16384-token context is usable.
2. Capture native responses for synthetic `noul`, `choice`, and `score`
   questions, then run ten labelled examples. `questions` is an object keyed
   by id, every question has `instructions`, and choices use a `criteria`
   mapping of option ids to descriptions. Record real responses as fixtures;
   synthetic unit fixtures are not evidence of server compatibility.
3. Add `systemOneDecide` and opt in per custom-openai model row with
   `metadata.decisionProtocol: 'systemone'`. Send one request per question,
   sequentially, preserving question independence. Normalize scalar or typed
   `noul` into `{type, p, confidence}` and preserve the server's native
   confidence for `choice` and `score`. Reject malformed probabilities,
   missing answers, HTTP errors, redirects, and timeouts. No letter prompt,
   logprobs, generation parameters, or thinking switches are involved.
4. Pass `modelConfigName` from the decision router so duplicate upstream model
   ids cannot select another row's endpoint/key. Resolve auth through the
   existing custom-provider configuration. Require a private endpoint and an
   explicit `{hosting:'local', retention:'none', trainsOnInput:false}` policy.
   Do not broaden automatic privacy classification for LAN proxies.
5. Register the discovered model at `http://192.168.1.156:8080/v1`, using bearer
   auth and the system vault reference. Set tools/vision/streaming off, zero
   token prices, and the verified usable context. Bind only `decision`, remove
   any previous primary/backup decision bindings, and leave TypeSafe installed.
6. Run the adapter/provider/router tests, typecheck, lint, catalog check, eval,
   and the repository suite. Build the runtime and run a bound `decide()` smoke
   check with `confident:true`. All sites remain in shadow mode. Live activation
   is a later per-site owner decision after sufficient labelled evaluation.

### Execution status (2026-10-21)

Implemented the native adapter, explicit row opt-in, exact bound-row lookup,
strict response validation, and persistent shadow-log reporting. The key
provided by the owner was in their personal vault; a system-scoped copy now
serves the intended install-wide binding. No credential values are recorded.

Live server: `ggml-org/Clef-Flash-GGUF:Q8_0`, build `b11749-1d88cb05f`,
reported context 16384. A real multi-question response and ten independent
synthetic examples are saved in `src/models/fixtures/clef-systemone.json` and
`src/models/fixtures/clef-baseline.json`. All ten expected labels matched,
including both score examples (rounded expected level). This is a transport
smoke baseline, not a representative accuracy or calibration evaluation.
The first baseline call took 1408 ms; the remaining nine took 188–247 ms.
The observed noul wire response is `{type:'noul', noul:<number>}`; the adapter
also accepts a scalar probability. Choice and score preserve native confidence.

The initial longer request failed at the server's 512-token physical batch
limit. After the owner's homelab update, the same 2545-token request succeeded
in 3831 ms with P(true)=0.98416. An oversized 16945-token probe was rejected
and reported the new physical batch size as 16384, matching the server context.

Prepared an install-wide model row named `Clef Flash (local llama.cpp)` with
context 16384, no tools/vision/streaming, zero prices, native SystemOne opt-in,
the explicit local policy, and `LLAMA_API_KEY`. It has **no topic bindings**.
A live call through `CustomOpenAICompatProvider.decide()` using that row and
its vault reference returned P(true)=confidence=0.980975. The registry now
invalidates primary and backup decision-topic cache entries on model updates.

**Activation deferred:** the owner explicitly prohibited restarting Octipus
because sessions are running. No restart or process interruption was performed.
The running backend still has its previous code; Jev remains the active
`decision` binding. The compiled build is ready on disk. After the owner allows
activation: load that build, set Clef as the sole primary for `decision`, remove
Jev's decision binding (keep its provider/model available), and perform the
bound `decide()` smoke check. Every site must remain in shadow mode. Record the
switch timestamp to separate old Jev and new Clef agreement windows.

Typecheck, lint, build, and focused tests pass. Routing eval reports 6/12
passing: the six role-routing assertions cannot observe specialist spawning
in unit mode and request an integration backend. The broad eval was stopped
when it selected the install's Claude CLI for generated-answer cases; it was
not a local Clef evaluation. The full repository suite passed: 713 test files,
8606 tests; 17 files / 214 tests skipped (519 seconds). The later recorded-wire
fixture and cache-invalidation updates also passed their focused tests.
Typecheck, lint and build were rerun successfully after the final code change.
Catalog check and `git diff --check` pass. Work is on
`feat/local-clef-decision`; changes are not committed.

Review follow-up: single-option choices are now resolved deterministically
without a server request, so an email category list containing only `other`
does not prevent priority inference. Native choices must agree with the
maximum probability, and scores with the probability-weighted level (0.001
rounding tolerance); native confidence is preserved. The 30 focused
adapter/provider/router tests, typecheck, lint, and build pass after these
fixes. The full-suite counts above precede this follow-up. Bindings and the
running backend remain unchanged.

### Activation verified — 2026-10-21

After the owner restarted Octipus and selected Clef in Topics, the binding was
verified at 14:17 UTC: Clef is the sole `decision` primary, with no backup;
Jev remains available but unbound. A synthetic `clef.rollout-smoke` call through
`decide()` passed the secret-data privacy gate and the 0.9 confidence threshold:
P(true)=0.975835, `confident: true`, decision latency 1545 ms. The result is in
`~/.octipus/decision-shadow.jsonl`. All production call sites remain in shadow
mode. This verification timestamp is a conservative start for the Clef window;
the earlier activation-deferred notes above describe the pre-restart state.

### Full live rollout requested — 2026-10-21

The owner explicitly requested shadow mode off for every site. Email triage,
memory judging, document categorization, link resolution and browser page hints
now use their live branches. Uncertain lane routing awaits the decision and
shares that one result between the root worker and model selector. Knowledge
search drops passages only below P(relevant)=0.2; unavailable decisions preserve
all results. Pipeline QA uses a confident negative decision to reject a
contradictory passing report; it cannot promote failed or missing verdicts or
bypass the existing audit evidence requirements. Every site retains its prior
unavailable/low-confidence fallback and privacy gates. Confidence and latency
records continue; shadow comparisons are no longer generated at these sites.

These source changes require loading the new backend build. No restart was
performed because the owner's instruction to preserve running sessions remains
in effect.

Validation for the live rollout: 719 test files / 8637 tests passed (17 files /
214 tests skipped); typecheck, lint, catalog check and backend build passed.
Focused tests also verify sharing the root lane decision without a second
inference. Synthetic live Clef checks selected research, removed an unrelated
knowledge hit, and rejected a contradictory QA pass. Routing eval remains at
6/12: the same six pre-existing unit-mode specialist-observation failures.

### Existing Jev shadow baseline

Snapshot of `~/.octipus/decision-shadow.jsonl` on 2026-10-21, covering
2026-10-05 through 2026-10-21 before this rollout: 178 validated decision
records and 106 shadow records. Every decision record identifies Jev via
Vercel AI Gateway. No historical inputs are present for replay.

| Site | Confident / validated | Agreement | Latency p50 / p95 |
|---|---:|---:|---:|
| Email triage | 7/12 (58.3%) | 7/7; category and priority each 7/7 | 329 / 509 ms |
| Knowledge relevance | 31/31 (100%) | No truth comparison; would drop 29/129 hits | 817 / 1158 ms |
| Memory judge | 1/2 (50%) | 0/1 | 338 / 483 ms |
| Lane routing | 73/133 (54.9%) | 28/73 (38.4%), against the heuristic | 425 / 990 ms |

These are useful operating baselines, not labelled accuracy or calibration.
Confidence coverage excludes failed requests and privacy blocks; agreement is
conditional on a confident answer. Email and memory samples are too small for
live activation, and routing agreement is low. Historical shadow rows lack
model identity, so comparisons across a model switch must use separate time
windows; decision summaries can be grouped by their recorded model names.

`scripts/decision-shadow.ts` now accepts the persistent JSONL as well as raw
and pretty backend logs, reports confidence coverage and p50/p95 by model/site,
and keeps the agreement denominator visible:

```sh
node --import tsx scripts/decision-shadow.ts < ~/.octipus/decision-shadow.jsonl
```


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

### Email calibration capture (2026-10-21)

Live email triage now appends `kind: "email-evaluation"` records to
`~/.octipus/decision-shadow.jsonl`. Each run has a UUID and each per-mail record
has the mailbox message ID. `decision` events contain validated Clef answers
before the confidence gate: priority label/score/confidence, category
label/confidence, model identity, latency and acceptance at the current 0.80
threshold. Unavailable decisions are explicit nulls.

The existing everyday LLM classifies every email for comparison, including
emails accepted by Clef. `comparison` events record its model and labels,
per-question agreement and the source selected for the live result. Confident
Clef answers still win. Missing reference answers are null; reference failures
are recorded and do not discard already captured decisions. A reference-only
failure does not invalidate a batch fully answered by Clef. Run events record
counts and timing. Join events by `(runId, messageId)`, not file order.

This capture intentionally adds reference inference for confident emails. It
records no sender, subject, snippet, body, rubric descriptions or generated
reasons. Agreement with the LLM is a comparison, not human-labelled accuracy.
The existing summary script ignores these new events; detailed threshold
analysis uses the paired events and their separate confidence values.

The `action-required-v2` priority rubric distinguishes required action from mere
relevance: low means no action/reply required; normal means action/reply can
wait; high means action today or a concrete risk from delay. Automated urgent
actions take precedence over the routine-notification rule, and work context or
promotional wording alone does not establish urgency. Clef and the reference
LLM receive the same instructions and levels. Capture events include
`priorityRubric: "action-required-v2"` to separate this experiment from earlier
runs. The score representation and 0.80 threshold remain unchanged.
