# Direct providers: controls, caching and accounting

Octipus keeps its own tool execution and permissions while calling a model's
API. Provider features depend on the model and endpoint. Supporting the same
completion interface does not imply every provider supports every option.

## Usage and session costs

Successful registered provider calls and LiteLLM wire calls pass through a
shared accounting boundary. Chat, streaming, embeddings, vision and native OCR
record usage where available. Tool-triggered calls inherit user/session/agent
attribution; document processing inherits the document owner. Calls without
attribution are recorded as system work, visible in administrator totals.
CLI invocations also retain available token usage. CLI-reported dollar figures
are not treated as subscription charges; costs use configured rates or remain
unknown. Historical entries are not reconstructed.

Each new ledger entry distinguishes:

- **Reported:** the upstream response supplied a charge, including a legitimate
  zero charge. OpenRouter's `usage.cost` is preserved.
- **Estimated:** provider token counts multiplied by configured model rates.
- **Unknown:** required usage or pricing is missing. Unknown entries contribute
  zero to the legacy numeric sum but have an explicit unknown marker and count;
  that zero is not a claim that the request was free.

The dashboard and the chat session's expandable cost summary separate reported,
estimated and unknown amounts. The shared `/cost` formatter also includes cache
reads/writes and missing-usage counts. The session API is
`GET /api/models/usage/session/:sessionId` and checks session ownership.

Configure input/output rates and cache-read/cache-write rates in USD per million
tokens under **Models → Edit**. Rates are per model, not guessed from its
provider family. Mark genuinely free inference explicitly, including local
models where appropriate. A remotely hosted Ollama endpoint is not assumed free.
Pricing source and the rate snapshot are retained with each estimate. An
ambiguous model ID produces an unknown estimate instead of choosing an alias's
prices arbitrarily. If cache tokens arrive for a model whose row has no
`cacheRead` or `cacheWrite` rate, `CostTracker.logUsageWithCost`
(`src/models/cost-tracker.ts`) logs a WARN once per model and the entry's cost
stays unknown — octipus never invents a cache discount.

Cache savings are an estimate against the same request at uncached input rates,
including configured write costs; they can be negative. Only entries with enough
pricing information contribute. Historical records may contain older estimates.
Token totals include reasoning when the upstream includes it in output counts;
the reasoning breakdown is retained separately and never billed twice.

Every provider boundary reconciles cache counters through one convention
(`foldCacheCounters` in `src/models/providers/usage.ts`): `inputTokens` is the
grand total, and `cacheReadTokens`/`cacheCreationTokens` are subsets of it —
including on the CLI one-shot path (`claude --output-format json`), which
previously dropped Anthropic's `cache_read_input_tokens`/
`cache_creation_input_tokens` fields entirely and under-reported input on a
heavily-cached run. That grand total is what session ledgers and
`sessions.token_count` use. Budget and quota gates instead compare
`billableTokens` (`src/models/billable-tokens.ts`): fresh input plus cache writes plus output. Cache reads are excluded from this
token proxy, but are still charged by the monetary ledger at configured rates.
Cache writes are paid work, including any provider write premium in the cost ledger. See CONFIGURATION.md's Swarm Config section for
where that distinction is enforced.

If a stream ends before final usage arrives, usage may be unavailable. Received
usage is retained when supported response decoding subsequently fails. A ledger
write failure is logged and does not replay a paid request or discard its answer.
This is operational accounting, not an invoice: provider-side retries, delayed
charges, special tiers, media/page fees and calls outside these adapters can
require separate reconciliation. Native OCR currently records the page count
with unknown cost rather than inventing a per-page price.

## Provider controls

The model editor exposes supported controls and validates them before saving:

- Reasoning effort for recognized OpenAI, Gemini, Grok and Claude model families,
  plus recognized OpenAI model IDs through OpenRouter. Other provider-specific
  controls remain available through `metadata.extraBody`; they are not inferred.
- Manual Claude thinking budgets on recognized supporting models; newer Claude
  models use adaptive thinking and effort. The budget must be below the actual
  **default output limit per request**, which is separately editable from the
  model's maximum. Effort and a manual budget cannot both be selected.
- Strict tool mode for compatible schemas. Octipus conservatively leaves schemas
  with optionality or constraints outside the supported intersection unchanged.
  It does not rewrite optional tool arguments into required nullable arguments.
  Local argument validation and permissions still apply.
- Prompt-cache hints and existing Gemini `cachedContents/...` references.
  Selecting “disable Octipus cache hints” does not disable upstream automatic
  caching. Gemini references must already exist and remain valid; Octipus does
  not create, refresh or delete provider cache objects automatically.

Custom endpoints retain their protocol-specific `extraBody` escape hatch; the
editor does not assume that every compatible server implements vendor extras.

## Caching and native protocols

**Anthropic:** native Messages is the default. A request carries at most four
cache breakpoints, Anthropic's limit:

1. the last tool definition (`markToolsCacheBreakpoint`);
2. the end of the **install tier** of the system prompt — security preamble,
   role prompt and delegation text, the same bytes for every user of the
   install (`PromptBuilder.installPrefix()`, sent as its own system message
   flagged `cacheBreak` and its own system content block), so different users'
   and sessions' requests read it from one cache entry (about 5.8k tokens for
   the full root tier, 2.4k for lite). The persona and everything per-user or
   per-session follows it;
3. the end of the static system prompt (user and session tiers: persona,
   workspace, inline-UI rules);
4. the settled conversation history — the last non-system turn before the
   newest one — so an agent loop's accumulated tool results are re-read at
   cache rates instead of full price on iterations 2..N
   (`markHistoryCacheBreakpoint` in
   `src/models/providers/custom/anthropic-compat-provider.ts`).

The newest turn is deliberately left outside every breakpoint. On an attended
turn 1–3 get a one-hour lifetime and the history five minutes (one-hour entries
must precede shorter ones). Tools precede the system prompt in Anthropic's
prefix, so the install block is shared only between requests whose tool arrays
are byte-identical: a per-user MCP server or a different set of sticky lazy
tool groups makes everything after the tools a different prefix. The same split (`src/models/providers/prompt-cache.ts`,
`applyAnthropicCacheControl`) also applies to the OpenAI-compat pass-through —
LiteLLM and OpenRouter — restricted to Anthropic-family models
(`isAnthropicFamily`: a `claude` id or an `anthropic/` path segment); there the
install tier is the first system message and the last leading system message
ends the prefix, so it marks both, plus the history (no tool breakpoint). OpenAI,
Gemini and the other automatic prefix caches need no marker: the install tier is
simply the first system text they receive. Passing
`cachePolicy: 'off'` on a completion call now genuinely disables every
breakpoint on every path, including LiteLLM/OpenRouter, which previously had
no such gate; a caller that leaves `cachePolicy` unset is unaffected. The
static prefix only caches once it clears the model's minimum cacheable size
(`minCacheableChars` in `prompt-cache.ts`): ~1024 tokens (4000 chars) for
Sonnet-4.5-class and unrecognized/aliased models, ~2048 tokens (8192 chars) for
Fable/Mythos 5, Sonnet-4.6 and Haiku-3.x, and ~4096 tokens (16384 chars) for
Opus-4.x and Haiku-4.5 — below the floor Anthropic silently ignores the
breakpoint (`cache_creation_input_tokens` stays 0), so it's a free no-op rather
than a wasted write. Signed thinking and redacted blocks survive tool
round trips, and native JSON Schema responses and strict tools are supported on
recognized models. `ANTHROPIC_NATIVE_MESSAGES=0` restores the compatibility path;
it has no prompt caching or enforced structured output, and those editor controls
are disabled. Manual thinking cannot use required tool choice. Adaptive thinking
supports forced tools except on Fable/Mythos 5.1; the worker respects these limits.

**OpenAI:** cache reads/writes and reasoning counters are preserved. Session
policy supplies a hashed cache-affinity key. Advanced cache settings remain
model-specific `extraBody` options; Octipus does not guess a retention policy.

**Gemini:** the configured output ceiling is respected. Reasoning effort or
Google-specific `extraBody` thinking settings control reasoning, rather than
silently increasing Flash output limits. Tool-call thought signatures are
preserved; foreign-provider raw messages are not replayed as Gemini messages.

**Mistral/Grok:** existing session cache-affinity hints are retained and can be
suppressed. **DeepSeek, Moonshot and z.ai:** compatible cached-token counters are
normalized; provider reasoning context is preserved where implemented.

## Optional organization billing reports

Administrators can call:

`GET /api/models/billing/report?provider=openai&start=2026-09-01&end=2026-09-02`

Use `provider=anthropic` for Claude. Configure `OPENAI_ADMIN_KEY` or
`ANTHROPIC_ADMIN_KEY`, or the matching lowercase system vault entry. Ordinary
inference keys are not silently reused as admin keys. Reports cover at most 31
days, follow pagination and preserve the provider's original amount units
(Anthropic reports decimal cents). They are read-only and never overwrite the
session ledger. Compare matching organization/project/workspace scopes: these
reports can include other applications and provider-specific exclusions.

## TUI handoff

The TUI and gateway transport are being updated independently. This change does
not edit those surfaces. They can consume the shared `UsageStats` fields
`reportedCost`, `estimatedCost`, `unknownCostRequests`, `unknownUsageRequests`,
`cacheReadTokens`, `cacheCreationTokens`, and `estimatedCacheSavings`, and reuse
`src/models/usage-summary.ts`. The model API exposes `metadata.providerSettings`,
`metadata.pricing`, and `defaultMaxTokens`; the shared validation/control helpers
are in `src/shared/provider-settings.ts`.

## Validation and sources

Offline tests cover provider usage normalization, session ledger aggregation,
pricing provenance, missing prices, stream ownership, parsing failures, signed
Claude round trips, model settings and billing pagination. They do not establish
live cache-hit rates, subscription eligibility or invoice parity.

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Claude compatibility limitations](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude thinking modes](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Gemini compatibility controls](https://ai.google.dev/gemini-api/docs/openai)
- [Claude usage and cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)

## Conversation continuity and OpenRouter

Root direct-provider turns retain a native message snapshot: tool calls, tool
results and provider reasoning data survive the creation of a new worker. Each
snapshot records the clear generation, model, checkpoint and acknowledged
transcript cursor. New messages from another execution path are appended. A model
switch retains ordinary tool history and discards incompatible provider-native
reasoning fields. Children do not load or overwrite the root conversation.

Stable instructions precede history. Dates, memory and live guidance are attached
to their user turn and persisted with that turn, rather than rewritten ahead of
all prior messages. This still sends a full request on stateless APIs: provider
prompt caching determines how much is reused and charged at a discount.

Compaction uses current context size, a covered message cursor and a retained
recent suffix. It publishes the checkpoint only after successful complete
summarization and audit persistence. Native recent tool sequences survive;
resumable CLIs rotate to the checkpoint. Local locks serialize root turns and
maintenance within one server process. Horizontal deployments need a distributed
lease before multiple processes can execute the same session concurrently.

### Keeping a long conversation cacheable

Every change to the start of a request — tools, system prompt, an earlier
message, the model — is a cold provider cache for everything after it. What
keeps a long session's prefix stable:

- **Compaction** runs after a turn only once the conversation passes half the
  session model's context window, capped at 64k tokens (below the agent loop's
  own 100k in-turn compaction), or 300 rows (`compactionTriggerTokens` in
  `session-compaction.ts`). It used to run at 8k tokens or 20 rows — on almost
  every turn of a tool-heavy session.
- **The saved conversation** (`nativeConversation`) is capped at 1M characters
  and, past it, trimmed to half at once rather than one turn per turn.
- **Old tool outputs** are truncated in batches: once a large one falls outside
  the newest `toolOutputSoftCap` results, everything older than the newest half
  of the cap is cut, so the history is rewritten every few results instead of
  every one.
- **The root agent's tool groups** are chosen per message but never dropped
  within a conversation (`stickyCoreToolIds`, stored as `context.toolGroups`
  for the clear generation and checkpoint).
- **The root agent's model** follows the routed lane only when it is a step up
  in price while the conversation is warm (`warmConversationOf`,
  `keepWarmModel` in `model-selector.ts`); a cheaper lane would save less than
  re-reading the history costs. `/model` still wins, and so does a rebound
  lane: once the lane that chose the model no longer resolves to it, the next
  turn follows the route.

Claude binds its thinking blocks to the system prompt, tools and messages
before them ("preserved thinking"); replayed after an edit they are rejected
(accounts created on or after 2026-08-31) or dropped. Wherever Octipus edits a
conversation — truncation, compaction, a trimmed snapshot, a changed prompt or
tool set between requests — it removes the signed reasoning from that point on
(`stripSignedReasoning`, `guardSignedReasoning` in `agent-worker.ts`). Under
manual thinking (`budget_tokens`, accepted only by models from before the
check) the agent loop keeps it: those models need the in-flight tool round's
thinking block. A native Claude request that configures thinking explicitly
also gets `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`
(beta `thinking-binding-controls-2026-08-01`); a request that leaves thinking
to the model's default is not given a mode. A reported
`prefix_binding_mismatch` is logged as a warning.

Every Claude request, on every path and for every model, carries no forced tool
choice (`required` becomes `auto`) and no `temperature`/`top_p`/`top_k`
(`claude-request.ts`) — rules each release has tightened, kept by family rather
than by a version list. A non-Claude model behind an Anthropic-compatible
endpoint keeps both.

**Session cache keys.** The affinity key (`cacheAffinityKey`) hashes user,
session and cache scope (`root:<generation>` for the root agent,
`child:<role>` for children, so siblings of a role share their prefix):

| Provider | Sent |
| --- | --- |
| OpenAI | `prompt_cache_key` by default (off with `cachePolicy: 'off'`), naming the prefix family (model, agent kind, tool names) so sessions that share a prefix share a cache, split into stable per-session buckets only above ~15 requests a minute per family; `session` adds `prompt_cache_retention: '24h'` (`prompt_cache_options: { ttl: '12h' }` on GPT-5.6+), dropped (and retried once) for a model that rejects it |
| Grok | `x-grok-conv-id` header |
| Mistral | `prompt_cache_key` |
| OpenRouter | the key as `user`, plus a per-conversation endpoint pin (below) |
| LiteLLM, custom OpenAI-compatible | `prompt_cache_key` only with `cachePolicy: 'session'` (unknown upstream), never for a Claude model |
| Claude on any path | cache breakpoints; `session` makes them one-hour (`ttl: '1h'`, 2x write) |

OpenRouter gets the opaque key as `user`, and Octipus pins each conversation
(per session, user and cache scope) to the endpoint that served its first
request; explicit `provider.order` overrides it and fallback/expiry can still
move a request. Tool and structured-output requests default to
`provider.require_parameters: true`, preserving explicit routing overrides.
Streaming and non-streaming requests use the same parameters. Structured
`reasoning_details` (including signatures/encrypted blocks) are echoed back only
to the originating model; plain reasoning is retained when structured data is
absent. Usage reads the final SSE usage block, including cache writes and
OpenRouter's reported charge; no deprecated `usage.include` request is needed.

Anthropic cache controls mark the stable system prefix and latest eligible input
block. Eligibility is decided by the provider over the full prefix, including
tools. An explicit breakpoint is not a cache hit. Automatic top-level Anthropic
cache control is not forced through OpenRouter because endpoint support differs.
Responses API state, managed Gemini explicit-cache objects, and model-specific
reasoning/context modes remain optional future work, not prerequisites for
correct stateless continuity.

Sources: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Run the deterministic lifecycle benchmark with `npx vitest run src/core/session-turns.test.ts`.
Set `SESSION_BENCHMARK_REPORT` to write its structural metrics. It covers 40 turns,
three compactions, a clear, tool evidence, and synthetic recall. These are not
measured provider cache hits or dollar savings.

For actual OpenRouter cache/cost/latency counters, set `OPENROUTER_API_KEY` and
`OPENROUTER_BENCHMARK_MODEL`, then run `npm run benchmark:sessions:openrouter`.
This opt-in paid benchmark uses only synthetic conversations, alternates streaming
and non-streaming, and defaults to 20 turns (2–50 via `SESSION_BENCHMARK_TURNS`).
It tests the provider wire path; it does not measure live Octipus compaction or CLI
performance. The output defaults to `openrouter-session-benchmark.json`.
