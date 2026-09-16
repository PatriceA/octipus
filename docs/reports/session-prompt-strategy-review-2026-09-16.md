> This is the initial review of the branch before the follow-up changes. See the [implementation and validation report](session-prompt-strategy-implementation-2026-09-16.md) for the current state.

**Review: `session-prompt-strategy`, commit `262a02f3`, compared with `main` — 2026-09-16**

The branch makes a substantial improvement, but it is not yet a reliable or maximally efficient session implementation. Claude/Codex can reuse vendor sessions, but the implementation equates an Octipus session with a vendor conversation too broadly. Compaction and history loading do not yet share a coherent boundary. Several improvements are undermined by correctness bugs.

This was a code and focused-test review, not a paid live-provider benchmark. No application implementation was changed. Reviewed the branch diff and adjacent root/worker orchestration, message persistence, CLI launch/parsing/bridge, direct-provider serialization, caching/accounting, compaction, and MCP discovery paths. Existing behavior that predates the branch is identified where relevant.

**Validation**

- 11 focused test files passed: 187 tests covering CLI resume, storage, compaction launch, root resume prompting, adapters, parsers, cache markers, usage, billable tokens, MCP isolation, and clear command.
- Three additional temporary reproductions passed assertions of the defective behavior, using the existing fake-CLI fixture and actual worker/argument-building path: pre-clear text appears in a cold prompt; a specialist child resumes the root vendor ID; intervening Octipus messages are absent from the resumed prompt. The temporary file was removed after review.
- These tests mock the vendor binary. They establish Octipus behavior, not provider cache-hit rates or live vendor compaction semantics.

**How turns currently work**

| Path | Next Octipus user turn | State retained | Main limitation |
| --- | --- | --- | --- |
| Claude Code agent | New process resumes saved ID; latest user text/run context and volatile instructions sent | Vendor conversation, including its tool work | Shared root/child slot, missing synchronization cursor, stale static instructions |
| Codex CLI agent | New process resumes saved thread | Vendor conversation | Full Octipus system prompt appended again; MCP namespace changes every launch |
| Antigravity/Vibe agents | New invocation with flattened history | Octipus history only | No vendor reuse; cold history has boundary/size problems |
| Direct API agent | New worker constructs another request with history | Octipus text history; current-turn tool/reasoning state in memory | Transcript reconstruction and volatile system content undermine cross-turn caching |
| One-shot CLI provider | Independent text completion | Explicitly supplied prompt | Appropriate for stateless utility calls, not a persistent agent session |

Your definition is correct: question → answer is one user turn, and another question → answer is a new turn in the same session. A user turn can additionally contain many model/tool iterations. Reusing the worker object is unnecessary. What must survive is a correct conversation checkpoint, a record of what each provider has seen, and stable prompt material.

**Findings, ordered by priority**

1. **P1 — Root and specialist CLI agents share the same vendor conversation slot. Introduced by session reuse.**

   `cli-session-store.ts:31` reads `context.cliSessions[adapterKey]`; `cli-agent-worker.ts:746` enables reuse without checking root/child identity. Swarm children explicitly receive the root session ID at `swarm/spawner.ts:1252`; pipeline workers likewise share the session at `agent/worker-spawner.ts:1128`. Matching model/permissions/cwd therefore makes a child resume the root's conversation. Parallel children can contend for the same session, and differing fingerprints overwrite one another's slots. Claude can also retain the first agent's system prompt. The sequential root→coding-child case was reproduced.

   Fix: initially restrict persistent reuse to root agents. Later introduce explicit conversation owners for independently resumable children. Key by session generation, logical agent conversation, provider identity, and launch configuration; serialize access to each vendor conversation.

2. **P1 — `/clear` still replays cleared content on the next cold run. Existing history bug left exposed by the branch's clear fix.**

   `/clear` stores `clearedAt` and removes CLI IDs, but does not delete messages. `cli-agent-worker.ts:307` loads `findBySession(sessionId)` without a clear boundary. The native loader at `agent-worker.ts:525` has the same problem. The root's recent-history block is filtered correctly, but its worker then reloads older content independently. Reproduced with a pre-clear sentinel present in the resulting CLI stdin.

   Fix: one shared history reader that enforces session generation/clear boundaries on every path, including cold retry and summarization. Timestamp checks on saved CLI IDs alone cannot implement clear semantics.

3. **P1 — Resume silently misses turns handled outside that vendor conversation. Introduced by delta-only resume.**

   `cli-agent-worker.ts:619` sends only the latest user message and run context. Stored records contain ID, fingerprint, and last-used time, but no last-acknowledged message ID. Example: Claude handles A, a direct response/Codex handles correction B, then Claude handles C. Claude resumes its A conversation and never receives B. Returning to an adapter leaves its saved slot eligible. Reproduced by placing an intervening correction in the Octipus history.

   Fix: persist an acknowledged transcript cursor per vendor conversation. Send all unseen relevant events in order. When faithful reconciliation is impossible, rotate from a validated checkpoint. Include interrupted turns, steering, and Octipus postprocessing of vendor answers in the reconciliation design.

4. **P1 — First automatic compaction can fail to persist its summary, then rotate Codex anyway. Summary defect predates the branch; destructive rotation dependency is new.**

   `agent/session-compaction.ts:201` searches for content starting with `Summary`. The actual summarizer returns `[Context Summary - ...]` at `utils/context-compaction.ts:460`. On the initial non-iterative pass, `summaryText` is undefined (`:553`), so the fallback misses and no compaction entry is inserted. The vendor-compaction loop still runs at `session-compaction.ts:249`, dropping Codex's ID. Rotation also proceeds after a caught summary-insert failure or a compactor result that removed nothing.

   Fix: always return a structured summary and exact coverage boundary. Commit it successfully before rotating a vendor session. A no-op compaction must not rotate. Test the entire summarize→persist→rotate→next-prompt chain.

5. **P1 — Compaction does not establish a bounded, current replay window. Existing design problem made more consequential by rotation.**

   Session compaction fetches the first 200 user/assistant messages (`session-compaction.ts:151`). Cold workers fetch the first 100 rows (`message-repository.ts:14`), not the latest unsummarized tail. Summaries do not carry a consumed message cursor into these loaders. Thus summarized text can be replayed again, later messages can disappear behind the limit, and Codex rotation does not reliably seed “summary + recent tail.” The root adds another last-ten-message rendering as well.

   The automatic triggers are lifetime message/spend counters. Once the message threshold is reached, effective passes remain eligible on subsequent turns; counters and summarized boundaries do not advance together. This can repeatedly summarize the same prefix and repeatedly rotate Codex. Native within-turn compaction additionally uses cumulative tokens at `agent-worker.ts:1082`, which is not current context occupancy. Manual compaction returns early below ten messages, even for a very large short transcript.

   Fix: use a durable checkpoint with `summarizedThroughMessageId` and retained tail; calculate actual rendered context including tools and output reserve. Trigger on occupancy or growth since the checkpoint, with hysteresis. Preserve tool pairs and refer to durable artifacts for omitted evidence.

   Also, summary readers in `root-runner.ts:170` and `direct-response.ts:106` skip summary lookup whenever `clearedAt` exists. That suppresses legitimate summaries created after a clear as well as old ones. Select summaries by generation/coverage instead of permanently disabling them for a cleared session.

6. **P1 — The new “billable tokens” calculation treats cache creation as free. Introduced in this branch.**

   `models/billable-tokens.ts:13` subtracts both reads and writes from input. A 100,000-token cache write plus 1,000 output tokens contributes only 1,000 to worker/swarm/daily limits. Cache creation is paid input, frequently more expensive than uncached input; reads also cost money. The separate dollar estimator correctly includes cache rates (`models/pricing.ts`), so displayed cost and admission/budget gates now use materially different definitions.

   Claude documents 5-minute writes at 1.25× base input and 1-hour writes at 2×. These tokens must not vanish from a spend proxy. [Claude caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

   Fix: retain separate context occupancy, cumulative processed tokens, fresh input, cache reads, cache writes, output, and estimated monetary cost. At minimum count writes as input; preferably enforce explicit cost budgets using model-specific rates. Subscription quota consumption is a separate metric, not necessarily equal to API price.

7. **P1 — Vendor compaction bypasses the normal launch isolation and accounting. New path.**

   `cli-session-compact.ts:50` calls bare `execCli('claude', ['-p', '--resume', id, prompt], {cwd})`. It does not pass strict MCP configuration, the run-scoped bridge, provider-specific environment, explicit model/permissions, or a usage recorder. `execCli` defaults to the full server environment (`cli-provider.ts:838`). This is especially problematic for GLM/Kimi sessions stored under the Claude adapter: their normal launch injects a different endpoint/model/auth environment, while compaction does not.

   It also runs from fire-and-forget session compaction (`agent/service.ts:596`) without a per-conversation lock. A subsequent turn can race a Claude compaction or a Codex drop. Global CLI concurrency limits do not provide conversation exclusion.

   Fix: run maintenance through the same provider-aware, isolated executor, with usage recording and a conversation lease. Compare-and-swap the expected generation/ID before committing rotation. Verify actual compact completion rather than treating process exit alone as proof. Live `/compact` semantics were not validated in this review.

8. **P2 — Codex resume still accumulates the whole Octipus system prompt and changes tool identity each invocation.**

   `cli-adapters.ts:779` prepends `systemPrompt` on cold and resumed runs alike. It becomes another user-input block in the saved thread, adding repeated role/delegation/workspace instructions each turn. At `:761`, the MCP server name includes fresh random bytes. Consequently the tool namespace changes, reducing exact-prefix stability and leaving old tool references in history.

   Fix: separate a stable instruction snapshot from append-only per-turn updates. Use a stable collision-safe MCP namespace per logical vendor conversation, with fresh credentials outside model-visible text. Keep host isolation intact. Measure the resulting vendor request cache counters rather than assuming resume guarantees a cache hit.

9. **P2 — Direct-provider caching helps within a tool loop more than across user turns.**

   Static/volatile splitting and history breakpoints are useful. But Anthropic lifts all system content ahead of messages; the root system contains a fresh timestamp and rolling history every user turn (`root-runner.ts:133`, `:206`, `:227`). A history breakpoint cannot reuse a prefix whose earlier system text changed. OpenAI-shaped requests also rebuild history and append the newly assembled system message after loaded history (`agent-manager.ts:264`); this is not a stable append-only request transcript. Later in-loop compaction can reorder/rewrite it again.

   Root history is duplicated between actual messages and system prose. Native history reload drops tool-call/result messages and provider-native blocks, so next-turn state loses evidence and native reasoning continuity even though those are preserved within the current worker.

   Fix: stable tools/instructions first, a canonical structured transcript next, and new time/memory/attachment context as an appended turn event. Preserve native state when compatible, with an explicit conversion/checkpoint policy for provider changes. Do not merely add more cache markers to a changing prefix.

10. **P2 — CLI agents bypass Octipus's lazy tool advertisement; MCP discovery can still dump every schema.**

    Native workers filter schemas using `toolAdvertisement` (`agent-worker.ts:1852`). CLI bridge setup instead exposes every registered handler (`cli-agent-worker.ts:387`), and the bridge lists them all (`cli-tool-bridge.ts:34`). Upstream CLI lazy loading may help, but Octipus does not enforce its advertised core-only policy there.

    External MCP discovery is “lazy” only until its first call: `mcp/bridge.ts:659` offers an optional server filter, then returns all matching descriptions and complete schemas. No query/top-k/schema-only-on-demand interface is provided there. The semantic search in `tools/tool-search.ts` is a separate discovery path.

    Fix: separate tool authorization, registration, and advertisement; retain permission checks for all executable tools. Expose compact searchable summaries, then exact schema lookup and bounded calls. Keep discovery available under the advertised set. Preserve stable tool ordering.

11. **P2 — Claude's static snapshot has no version invalidation.**

    The fingerprint includes only configured model, permission mode, plan mode, and cwd (`cli-session-store.ts:19`). On resume Claude only receives the section after the volatile marker (`cli-adapters.ts:557`). Yet the “static” section contains live expert indexes, workspace listings/repository maps, and project guidance (`root-runner.ts:521` onward). Changes there are dropped on resume. Adapter identity also conflates normal Claude, GLM, and Kimi; effective environment model/endpoint overrides are absent from the fingerprint.

    Fix: include resolved provider/account/endpoint/model identity and a stable-instruction version. Append appropriate state changes explicitly; rotate when an instruction change cannot be applied safely. Do not hash rotating bridge credentials or the clock into the stable version.

12. **P2 — Recovery fixes the current turn but deliberately disables reuse for its replacement session.**

    A missing-session retry sets `forceCold`; `cli-agent-worker.ts:746` consequently disables all reuse participation. Claude does not mint/store a replacement managed ID, and Codex becomes ephemeral. The following user turn therefore pays another cold launch. Additionally, the root already suppressed its summary before the missing-session error; the worker backfills rows but does not rebuild the omitted summary.

    Fix: distinguish “must start a new persistent vendor conversation” from “must be stateless.” Rebuild the full checkpoint-based cold context and persist the replacement session. Keep the one-retry bound.

**Further efficiency and capability gaps**

- The direct budget preflight (`agent-worker.ts:1124`) adds a full request estimate to cache-discounted spend. This remains a conservative cold-miss reservation, so a cached request can still be rejected. Choose and document that policy; do not promise that cached context cannot trip budgets. A monetary reservation reconciled with actual usage would be clearer.
- Anthropic history caching targets the penultimate turn. This is useful, but leaves the newest tool-result payload uncached until a later request. Benchmark caching the last eligible input block/automatic caching with a stable prefix; cache lookup can reuse an earlier written breakpoint. Current comments suggesting any new breakpoint prevents reuse are misleading. Keep model/gateway compatibility explicit.
- Cache eligibility is estimated from system characters alone. Provider minimums apply to the relevant full prefix, including tools. Large tool schemas can make a short system prefix eligible even when the heuristic rejects its breakpoint. Avoid fragile model-name regexes as a capability database.
- OpenAI uses Chat Completions in this implementation. There is no managed Responses conversation/response-ID lifecycle or native compaction path. Gemini primarily uses OpenAI compatibility, with no managed explicit-cache object lifecycle. `extraBody` permits some manual parameters but is not a session manager. These are opportunities, not proof that stateless requests are intrinsically wrong.
- MCP connections support persistence, reconnection, circuit breaking and paginated listing: useful foundations. Resources/prompts are fetched and have bridge methods, but the agent-facing lazy handlers expose only tool listing/calling. Resource templates and list-change refresh handlers are not implemented in the inspected bridge. Tool annotations/output schemas are not carried through its tool-definition abstraction. Raw structured results can pass through, but there is no typed end-to-end optimization contract for them.
- MCP does not itself provide model conversation memory or prompt caching. Resource retrieval can reduce repeated large tool output, but only if Octipus exposes it and selects bounded relevant data. Protocol resources are application-managed. [MCP resource specification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources).
- Large tool outputs already spill to artifacts, but previews retain approximately the old 50,000-character allowance. Consider task-specific previews and retrieval handles. Do not cache arbitrary tool results globally: permissions, mutation, freshness and invalidation matter.
- The semantic tool embedding cache is keyed by text alone (`tools/tool-search.ts:73`), not embedding model/version. A model change can reuse incompatible vectors; key by embedding space as well.
- Atomic JSON context patches are an improvement, but ID writes still lack a generation/lease check. `lastUsedAt` is save time, not proof that a run began after a clear. Other whole-context writers remain, including `agent-manager.ts:277`.

**What is already good**

The branch correctly distinguishes caller-minted Claude IDs from captured Codex IDs, removes ephemeral mode from normal persistent Codex launches, bounds stale-session fallback, accounts for cache counters more consistently, and keeps context totals separate from the new budget proxy. MCP scoping, narrow bridge credentials, exact tool membership checks, tool-pair repair, artifact spilling, and native lazy discovery are sound foundations. Recreating a process per user turn is a valid implementation choice.

**Recommended target design and order**

First repair ownership and history boundaries: root-only reuse as an immediate containment, a session generation, acknowledged per-provider message cursors, and one checkpoint-aware history reader. Then make compaction transactional with successful checkpoint persistence preceding rotation, using a per-conversation lease. Fix paid-cache accounting before evaluating savings.

Next establish immutable instruction/tool prefixes and append-only turn context; retain structured tool history or compact it into retrievable artifacts. Bring the CLI advertisement path into parity and make MCP discovery bounded. Finally add provider-native state/cache features behind an explicit capability layer, with stateless replay as the tested fallback.

Persistent state should include logical conversation owner, session generation, resolved provider identity, vendor ID, instruction/tool version, acknowledged message ID, checkpoint coverage, and active lease. A wall-clock last-used timestamp is insufficient.

OpenAI documents full-prefix matching and the importance of stable tools/instructions and appended history; native conversation state does not replace correct cache layout. [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state). Gemini documents implicit caching and stable common prefixes; its explicit and stateful options vary by API. [Gemini caching](https://ai.google.dev/gemini-api/docs/caching).

Measure 20–50-turn sessions with tool use, provider switching, clear, restart, failures, long pauses and compaction. Track actual read/write/fresh/output tokens and cost, prompt/tool-schema size, first-token latency, resume/rotation reasons, summary coverage, and recall/task success. Compare against the base branch. Acceptance requires no cleared-content replay, no lost intervening turns, no shared root/child vendor sessions, and verified lower total cost at comparable task quality. Neither a small stdin delta nor passing mocked tests alone establishes that.
