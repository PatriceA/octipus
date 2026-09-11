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
prices arbitrarily.

Cache savings are an estimate against the same request at uncached input rates,
including configured write costs; they can be negative. Only entries with enough
pricing information contribute. Historical records may contain older estimates.
Token totals include reasoning when the upstream includes it in output counts;
the reasoning breakdown is retained separately and never billed twice.

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

**Anthropic:** native Messages is the default. Stable system-prompt prefixes use
an explicit cache breakpoint. Signed thinking and redacted blocks survive tool
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
