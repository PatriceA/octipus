# Session prompt strategy implementation — 2026-09-16

Branch: `session-prompt-strategy`. Changes are local and uncommitted.

The six requested workstreams are implemented. Session continuity and failure
boundaries are substantially stronger. This does not establish maximum possible
provider efficiency or production cost savings. Live provider benchmarking and
several provider-native features remain unvalidated or unimplemented.

## Changes

| Workstream | Result |
| --- | --- |
| Ownership and synchronization | Only roots reuse the root vendor conversation. Children have separate namespaces/state. Acknowledged cursors deliver intervening messages after provider switches. Root execution, casual replies and maintenance share a process-local session lock. |
| History, clear and compaction | One canonical reader uses clear generations and exact timestamp/ID checkpoints, without oldest-100/200 truncation. Unique clear IDs and generation-stamped writes reject old results, including same-millisecond races. Compaction uses current context, requires complete summary coverage, and publishes only after audit persistence. CLI rotation follows publication. Recent native tool sequences survive. |
| Paid cache accounting | Budget proxy includes fresh input, paid cache writes and output. Reads remain excluded from this token proxy; the cost ledger still prices them. OpenRouter reported charges and read/write breakdowns are retained. |
| Stable prefixes and native history | Stable instructions precede history. Live date/memory/guidance is appended to its turn and persisted. Native tool calls/results and compatible reasoning data survive worker replacement. Incompatible signed state is stripped on model changes. Codex resumes send live guidance without re-injecting stable instructions. Fingerprints cover provider configuration, stable instructions and tool schemas. |
| CLI/MCP discovery | CLI lazy advertisement exposes core schemas plus a guarded discovered-tool dispatcher. MCP listing is searchable and paginated, with schemas fetched only for exact tools. Resource/prompt/template discovery is available, and catalog notifications refresh metadata. |
| Measurement | A deterministic 40-turn lifecycle benchmark and an opt-in live OpenRouter wire benchmark are provided. Correctness tests cover tool evidence, provider switching, clear, summary/audit failure, ineffective compaction, checkpoint chaining and stale CLI recovery. |

## OpenRouter-specific assessment

The previous integration left useful documented functionality unused. It now:

- Supplies an opaque `session_id` scoped to the user/session/conversation generation.
  OpenRouter uses this for sticky routing. Explicit provider ordering can override
  affinity, and fallback or expiry can still cause cache misses.
- Defaults tool and structured-output requests to `provider.require_parameters: true`.
  Explicit routing policy still takes precedence.
- Shares request construction between streaming and non-streaming, including
  response format, stop sequences, sampling and configured `extraBody` options.
- Preserves structured reasoning/signatures and encrypted data through tool loops
  and compatible later turns. Plain reasoning is retained when structured data is absent.
- Reads final streaming usage, including cache reads, cache writes and reported
  cost, without deprecated usage-request switches. Stream error events fail the call.
- Honors per-model credentials and current application attribution headers.

Anthropic cache controls target the stable system and latest eligible input.
The provider decides minimum eligibility over the full prefix, including tools.
Top-level automatic Anthropic caching is deliberately not forced across all
OpenRouter endpoints: documented endpoint support differs. Routing stickiness
and cache hints improve conditions for reuse; neither proves a cache hit.

Official references checked:
[Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

## Evidence

- 557 unique focused tests passed across 58 files; 1 opt-in test skipped.
  Counts combine the broad run and subsequent focused reruns, with latest results
  replacing earlier results. This is not the complete repository suite.
- TypeScript typecheck, production build, lint on changed production files and
  `git diff --check` passed.
- The embedded database test exercises real SQL, 250 messages, timestamp ties,
  checkpoint suffix coverage, clear compare-and-set and guarded inserts.
- Windows shell transport fixtures pass with Git's `usr/bin` and `bin` on PATH.
- Structural benchmark: 40 turns, three checkpoints, one clear, synthetic tool
  evidence and recall checks. 71,715 estimated serialized input tokens;
  61,859 belonged to unchanged request prefixes
  (86.26%). This uses the repository's BPE estimator
  on serialized request blocks, not the upstream model's exact token accounting.
- No paid live-provider requests were executed. The shell and local `.env` did
  not contain an OpenRouter key. Provider cost, live cache-hit ratio, first-token
  latency, long-pause cache expiry and live CLI compatibility were not measured.

Artifacts: [structural benchmark](session-turn-benchmark-2026-09-16.json),
[validation summary](session-prompt-strategy-validation-2026-09-16.json).

Run the live synthetic OpenRouter wire benchmark with `OPENROUTER_API_KEY` and
`OPENROUTER_BENCHMARK_MODEL` set, then `npm run benchmark:sessions:openrouter`.
It defaults to 20 paid turns, alternates streaming/non-streaming, and records
usage, cost, total latency and simple recall. It does not simulate the complete
Octipus tool loop or compaction. The lifecycle test covers those locally with
synthetic inference. Neither is a controlled live comparison against `main`.

## Remaining limits and next priorities

1. Prove cost and quality with live, controlled 20–50-turn comparisons against the
   base branch, including cold/warm caches, provider changes, failures, real tools,
   long pauses and summary quality. The 86% structural figure is not an 86% bill reduction.
2. Use a distributed conversation lease before allowing multiple server processes
   to execute the same session. Current locks are in-process. Generation checks
   protect clears across processes, but do not serialize two ordinary root runs.
3. Add OpenAI Responses state/native compaction and managed Gemini explicit-cache
   lifecycle behind provider capabilities if measurements justify them. Correct
   stateless replay remains necessary. Server-side IDs alone do not make prior
   context free. Existing native CLI automatic compaction is still vendor-owned.
4. Move from a token proxy to monetary reservation/reconciliation if predictable
   spend caps are required. Current request preflight conservatively reserves a
   cold miss and can reject a large, usually cached request.
5. Broaden live reasoning compatibility coverage and expose model-specific
   reasoning/context controls using discovered capabilities. `extraBody` already
   passes explicit settings; automatically enabling every option would be unsafe
   for compatibility and can increase cost.

No SQL migration is required: new state and metadata live in existing JSONB
columns. Old CLI records without a generation deliberately start cold once.
Legacy summaries without coverage cursors are not treated as authoritative
checkpoints; the retained transcript is the fallback. Audit rows are written
before active-checkpoint publication; a concurrent clear can leave an unused
audit row, which readers never treat as the current checkpoint.
