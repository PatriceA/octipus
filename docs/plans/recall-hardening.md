# Recall hardening

Status: implemented (stages 1 to 3, 2026-11-22); written as a plan before
implementation. [CONTEXT-HOOKS.md](../CONTEXT-HOOKS.md) describes what was built.
Feature: context hooks, the `recall` module ([CONTEXT-HOOKS.md](../CONTEXT-HOOKS.md)).

## Goal

Recall exists so an agent has the user's knowledge in front of it without
having to decide to search. A review found the mechanism sound but the
feature weaker than its numbers suggest. This plan closes the gaps: every
agent start is covered, retrieval finds what a person would expect it to find,
a conversation does not pay for the same passage every turn, and the numbers
say whether what was injected was used.

## Findings this plan answers

| # | Finding | Where |
|---|---|---|
| F1 | Swarm children (`spawn_child`, the root's main delegation path) start without hooks. So do plan execution, side questions, and two direct spawns. | `src/core/swarm/spawner.ts`, `src/core/agent/service.ts` (plan path), `src/core/gateway/message-handler.ts`, `src/hooks/actions.ts`, `src/api/routes/agents.ts` |
| F2 | The keyword half of hybrid search needs every word of the message in one chunk (`plainto_tsquery`), so it never fires on a sentence. Recall is vector-only in practice and weakest on names, numbers and codes. | `src/core/rag/embeddings.ts` |
| F3 | A short message that does match by keyword bypasses the similarity bar entirely. | same |
| F4 | One fixed `minSimilarity` (0.45) for every embedding model; tuning is manual. | `src/core/context-hooks/kinds.ts` |
| F5 | The query is the raw current message: a follow-up ("and for enterprise?") is searched without its subject; a long paste is cut to its first 2000 characters. | same |
| F6 | The same passage is re-sent and stored on every turn: the cross-turn dedupe is verbatim per block, and the recall block carries a per-query score and numbering. | `kinds.ts`, `src/core/agent/repeated-context.ts` |
| F7 | Recall raises the session's protection level and counts accesses before the shared budget is applied and after a timeout: side effects for passages never shown. | `kinds.ts`, `run.ts` |
| F8 | Defaults do not fit each other: four 700-character passages exceed the 700-token budget; the eval counts a passage the hook would drop. Excerpts are the first characters of a chunk, not the matching part. | `kinds.ts`, `stats.ts` |
| F9 | Measurement is shallow: "cited" is a title substring; context notes sit in its denominator; nothing says whether a passage was used. | `run.ts`, `stats.ts` |
| F10 | The general role prompt says a recall block "was already searched" even when recall found nothing or did not run. | `src/core/agent/roles/general/prompt*.md` |
| F11 | Docs say recall falls back to keywords without an embedding model; the code skips it. Tests only exercise the keyword fallback, never the vector path. A context note's slug is typed by hand. | docs, tests, `web/app/recall/page.tsx` |

## Design

### 1. Coverage: one entry point, checked by a test

- A single helper in `src/core/context-hooks/` (working name
  `contextForAgentStart`) takes the agent context, the event and the brief,
  applies the audience rule (`shared` or `contentStorageOff`: nothing), and
  returns the blocks and the turn handle. Every call site is one call; the
  audience rule lives in one place instead of being repeated per caller.
- Call sites added:
  - swarm children (`worker_start`, the child's brief). A fork child inherits
    its parent's conversation, which already carries the parent's blocks:
    it gets none of its own.
  - plan execution (`turn_start`, the plan brief).
  - the side question (`turn_start`, the question).
  - the two direct spawns (`hooks/actions.ts`, `api/routes/agents.ts`), when
    they run a user's task for that user.
- Deliberately not covered, and listed as such in the docs: the voice planning
  reply (latency; the confirmed turn that follows is covered) and retry
  respawns (they reuse the prompt already assembled, block included).
- A test enumerates every `agentManager.spawn(` and `directResponse(` call in
  `src/` and fails when one is neither hooked nor on an explicit exemption
  list with a reason. A new start path cannot be added silently.

### 2. Retrieval

**Keyword leg (F2, F3).** `hybridSearch` gains a keyword mode. The default
stays "all terms" so `search_knowledge` is unchanged. Recall uses "any term":
candidates are chunks sharing at least one lexeme with the query, ranked by
`ts_rank_cd`. Matching any term is not evidence of relevance, so the old
"keyword match bypasses the bar" rule goes. A passage qualifies when:

1. its cosine similarity reaches `minSimilarity`; or
2. it covers the message lexically: at least `keywordCoverage` (default 0.6)
   of the message's distinctive lexemes, and at least two of them, with a
   cosine floor of `0.6 × minSimilarity` when an embedding exists; or
3. it contains an identifier from the message: a lexeme with a digit, four
   characters or longer (an invoice number, a version, an error code).

"Distinctive" is four characters or more, or containing a digit: a
language-independent stand-in for stopword removal, since `content_tsv` uses
the English configuration and a Dutch or German message keeps its stopwords.
Coverage and the identifier rule are pure functions with their own tests.
A per-language text-search configuration is out of scope (it needs a
migration and a reindex); the limit is documented.

When the embedding call fails, recall runs keyword-only under rules 2 and 3
(no cosine floor) and records the reason, so the stats show the degraded mode
instead of hiding it.

**Relative cut (F4, precision).** Hits more than `maxGap` (default 0.15)
below the best qualifying hit are dropped. It only ever removes.

**Threshold calibration (F4).** The default stays 0.45: changing it without
measurements against real embedding models would trade one guess for another.
Instead the manual tuning loop is automated and miscalibration is made
visible:

- the eval gains a sweep: the same cases at a range of thresholds, with the
  value that best balances "found" against "abstained" recommended and
  applicable in one click;
- the stats flag a hook that injects on nearly every searched turn, or almost
  never, over a meaningful sample, and point at the sweep.

**Query (F5).** A pure `buildRecallQuery`:

- a short message (few content words) is searched together with the previous
  typed user message of the session, so a follow-up keeps its subject. No
  model call: recall must not add a model round trip to every turn;
- a long message keeps its head and its tail rather than its first 2000
  characters: the question usually follows the paste;
- workers keep task plus input, with the same trimming.

**Excerpt and budget (F8).** The excerpt is the window of the chunk with the
most query terms, not its first characters. The default recall budget rises
so the default four passages fit; the eval and the hook share one selection
and rendering function, so the eval reports exactly what would be injected.

### 3. No repeated passages (F6)

Each passage becomes its own repeatable block with stable bytes: title,
section and age, no score and no position. The existing cross-turn omission
then works per passage: a passage still in view from an earlier turn is left
out, a new one is sent. When every passage of a turn is already in view the
wrapper is left out too (no empty shell); the existing "still above" line
covers it. Restoring after an in-turn compaction keeps working per passage.

### 4. Side effects only for what is shown (F7)

A hook result may carry a commit step. Recall's commit raises the session's
protection level and counts the accesses. `runContextHooks` runs it only for
blocks that passed the deadline and the shared budget, and waits for it: the
level must be raised before the agent starts. A block dropped for budget, or
a hook that timed out, leaves no trace beyond its run record.

### 5. What the agent is told (F10)

The role prompt says what the presence and the absence of the block mean:
present, it was searched for this message and more can be found with the
tools; absent, nothing close was found or recall did not run, and anything
about the user is still to be searched. No per-turn tokens are added.
This is a prompt change: the repo's rule asks for the relevant eval, which
needs a live model. Where none is available the PR says so.

### 6. Measurement that means something (F9)

- `used_items` (new nullable column on `context_turns`): passages whose
  distinctive content (numbers, longer words not in the query) appears in the
  answer. The excerpts live only in the in-memory turn handle; the row still
  stores no message and no passage text.
- "cited" matches titles on word boundaries, and its denominator is turns
  with recall passages only (context notes are not something to name).
- The stats and the page show used beside named, the degraded and omitted
  reasons, and the calibration warning.

### 7. Docs, UI, tests (F11)

- Docs corrected and extended (`CONTEXT-HOOKS.md`, `CHANGELOG.md`, generated
  catalog if a route or edge changes).
- Recall page: a note picker for a context note, the sweep, the new numbers.
  Exercised in a browser (`tests/web/recall.spec.ts`).
- Tests get a deterministic embedding stand-in so the vector path, the
  qualification rules, the budget, the deadline and the cross-turn omission
  are all exercised without a model.

## Out of scope

- A per-language text-search configuration for `content_tsv`.
- A model-written query rewrite, or a model-judged relevance score.
- Long-term memory for swarm children (they get none today; a separate
  change).
- Changing `search_knowledge`'s behaviour.

## Stages

Sequential, one working tree, each stage committed with its tests green.

1. **Retrieval core**: sections 2, 3, 4. `src/core/context-hooks/kinds.ts`,
   `run.ts`, `src/core/rag/embeddings.ts`, `src/core/agent/repeated-context.ts`.
2. **Coverage and prompt**: sections 1, 5, and the previous-message input of
   the query builder. Swarm spawner, service, message handler, direct spawns,
   role prompts.
3. **Measurement, UI, docs**: sections 6, 7.
4. **Review**: independent reviewers on the full diff; findings fixed, each
   bug with a test that fails without the fix (house rule 11).
5. **PR**, CI watched until green.

## Done when

- `npm run typecheck && npm run lint && npm test && npm run catalog:check`
  pass, and the Recall page works in a browser.
- The spawn-site test covers every agent start.
- A follow-up question, an identifier lookup and a paraphrased question each
  recall the right passage in tests; a second turn does not repeat a passage
  still in view; a block dropped for budget raises no protection level.

## What changed during review

Two review passes found gaps in what was built; the design above is kept as
it was written. Where the code now differs from it:

- **Coverage.** `POST /api/agents/:id/message` (a new task for a live agent)
  is hooked for the agent's owner, and the spawn-site test also scans
  `.run(` on an agent taken from the manager. Direct spawns and the side
  question choose their model after the hooks.
- **Retrieval.** Identifiers are only real references (three digits or more,
  or the shapes listed in CONTEXT-HOOKS.md; not `OCT-42`). A short follow-up
  is searched alone first and the previous message only fills free slots.
  The keyword leg ORs at most 16 lexemes, digits first then the longest, and
  runs under a statement timeout on Postgres (PGlite ignores it). Purposes,
  product docs and three chunks per source are filtered in SQL.
- **Excerpt and budget.** Chunkers split long paragraphs, so a new chunk is
  at most 1000 characters; `excerptChars` defaults to 1000 (a chunk shown
  whole keeps its bytes whatever the question) and recall's `tokenBudget` to
  1200. In-view omission compares whole blocks, not substrings.
- **Deadlines.** One start deadline: hooks by 4000 ms, commits by 4500 ms;
  a failed commit gives its tokens back. Access is counted when a worker or
  swarm child actually starts. The embedding request itself is still not
  cancelled.
- **Measurement.** "Used" reads numbers by value in both conventions,
  ignores list numbers, round percentages and quarter-hour times,
  NFC-normalises, keeps combining marks in words, has a Korean word rule,
  and reads at most 20,000 characters of an answer. "Named" does not count
  a title made of the query's words. Named and used count only turns that
  ended with an answer.
- **Calibration.** Each recall run records its bar (`minSimilarity`, and
  whether a found passage cleared it on similarity); only such runs at the
  hook's current value are samples, "almost never" needs knowledge-base rows
  to search, and the message for a custom hook says to set its own value.
- **Recall page.** `purposes` and `includeProductDocs` are checkboxes;
  `worker_start` is labelled as every agent started on a task.
