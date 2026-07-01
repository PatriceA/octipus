# Hybrid Skill Discovery — Implementation Plan

**Goal:** Replace static `buildTopicPromptFragment(topic)` injection with dynamic per-message discovery combining (1) keyword/regex triggers, (2) embedding similarity, (3) always-inject flag for tiny skills.

**Why:** Current behavior dumps every skill assigned to the role's topic into every spawn's systemPrompt. Doesn't scale past ~10 skills; injects irrelevant content; wastes tokens.

**Non-goals:** Changing the external (filesystem) skill loader, replacing the topic-assignment table, mid-conversation skill loading via tools.

---

## Cross-Phase Principles (apply to every phase)

- **Loud failure**: errors from embedding lookups, DB queries, or trigger compilation must log at `error` level via `coreLogger`. No silent `try/catch` swallowing. Pattern reference: `src/core/orchestrator/worker-spawner.ts:271-278` (existing topic-injection error handler — promoted to error after a prior incident).
- **Graceful degradation, not silent**: if no embedding model is configured, skip the vector path, log `warn` once per process, and continue with triggers + always_inject + topic fallback. Discovery never throws — worker spawn must always succeed.
- **Embedding staleness**: every skill row gets a `description_hash` column (sha256 of `name + description`). The discovery path compares hash; if mismatched (or `description_embedding IS NULL`), the skill is *included* via topic fallback and a re-embedding job is enqueued. Stale rows never silently drift.
- **Bun:test** for all unit tests. Mock conventions per `src/core/swarm/spawner.test.ts:1-12`.
- **Drizzle journal entry required** for every migration (per `feedback_drizzle_journal.md`).

---

## Phase 1 — Schema Migration

**What to implement** — add four columns to `skills` table:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `triggers` | `jsonb` (string[]) | `[]` | Keyword/regex strings, case-insensitive substring match |
| `description_embedding` | `vector(768)` | `NULL` | Backfilled by Phase 2 |
| `description_hash` | `text` | `NULL` | sha256(name + description), used for staleness detection |
| `always_inject` | `boolean` | `false` | Bypass discovery — skill always present for its topic |

**Documentation references — copy from these:**

- Schema column patterns: `src/db/schema/skills.ts:1-28` (jsonb default `[]`, boolean default false patterns already present).
- Vector custom type: `src/db/schema/embeddings.ts:8-19` — copy the `customType` block, change `vector(768)` if needed (keep 768 to match existing embedding model dimension).
- Migration SQL pattern: `src/db/migrations/0042_org_scoped_models_skills.sql:17-26` (ALTER TABLE … ADD COLUMN IF NOT EXISTS + CREATE INDEX).
- HNSW index with PGlite-safe exception handler: `src/db/migrations/0005_rag_setup.sql:17-23` — copy verbatim, replace table/column.

**Steps:**
1. Edit `src/db/schema/skills.ts`: add the four columns. Re-export the `vector` custom type from `embeddings.ts` rather than duplicating it.
2. Run `npm run db:generate` to produce `src/db/migrations/0044_skills_discovery.sql`.
3. Hand-edit the generated SQL: add HNSW index `skills_description_embedding_idx` wrapped in the `DO $$ … EXCEPTION` block from migration 0005. Add `CREATE INDEX skills_always_inject_idx ON skills (always_inject) WHERE always_inject = true;` (partial index — small, hot).
4. Add journal entry to `src/db/migrations/meta/_journal.json`: `idx: 44, version: "7", when: <next ts>, tag: "0044_skills_discovery", breakpoints: true`.
5. Run `npm run db:migrate` against dev DB.

**Verification checklist:**
- [ ] `\d skills` in psql shows all four new columns.
- [ ] `\di skills*` shows `skills_description_embedding_idx` (HNSW) and `skills_always_inject_idx`.
- [ ] Existing skill seed (`src/db/seed-skills.ts`) still loads without error.
- [ ] `pgvector` extension already loaded (was added in 0005) — no `CREATE EXTENSION` needed.

**Anti-patterns:**
- Do NOT add `description_embedding vector(1536)` — the configured embedding model returns 768-dim. Mismatch will fail at insert time.
- Do NOT make `description_embedding NOT NULL` — backfill happens in Phase 2 and may fail if no embedding model is configured.
- Do NOT duplicate the `vector` custom type — import/re-export from `embeddings.ts`.

**Manual QA:**
- Run migration on a copy of prod DB. Verify zero downtime (all ALTERs are non-blocking with `IF NOT EXISTS`).
- Insert a test skill via API; confirm defaults applied (`triggers=[]`, `always_inject=false`).

---

## Phase 2 — Backfill Script + Re-Embedding Hook

**What to implement:**

1. **Backfill script** `scripts/backfill-skill-embeddings.ts`:
   - Iterate skills where `description_embedding IS NULL`.
   - For each: compute `hash = sha256(name + description)`, call `getEmbeddingService().generateEmbedding(name + '\n' + description)`, write embedding + hash.
   - Batch in groups of 20 with `Promise.allSettled` to avoid provider rate limits.
   - Log progress every batch; final summary `{ total, succeeded, failed, skipped }`.
   - **If no embedding model is configured** (catch error from `resolveModel()`): log `error` with remediation message, exit code 0 (script is opportunistic — discovery still works without embeddings via triggers/topic fallback).

2. **Re-embedding hook** in `src/db/repositories/skill-repository.ts`:
   - Wrap existing `update()` and `create()` methods (or add a post-write side effect): if `name` or `description` changed, set `description_embedding = NULL` and `description_hash = NULL`.
   - A separate background re-embed worker (or a check at discovery time — see Phase 3) refills.
   - Decision: **invalidate at write, refill lazily**. Avoids blocking the API route on embedding latency.

**Documentation references:**
- Embedding service singleton: `src/core/rag/embeddings.ts:736-739` (`getEmbeddingService()`).
- `generateEmbedding(text)` signature: `src/core/rag/embeddings.ts:54-82`.
- Existing batch script pattern (for structure): look under `scripts/` for any `seed-*.ts` or `migrate.ts` that uses `getDb()` directly.
- `coreLogger` import: `src/utils/logger.ts` (used throughout `embeddings.ts`).

**Verification checklist:**
- [ ] Run backfill twice — second run is a no-op (skip rows where embedding is non-null AND hash matches current content).
- [ ] Update a skill description via API → row's `description_embedding` and `description_hash` become NULL.
- [ ] Backfill picks up the invalidated row on next run.
- [ ] With embedding provider misconfigured: script exits cleanly with a loud error log, does NOT crash.

**Anti-patterns:**
- Do NOT block the skill update API on embedding generation. Invalidate the column; refill async.
- Do NOT silently catch embedding errors — log at `error` level with full context.
- Do NOT embed external (filesystem) skills — they live in memory only and reload on disk change.

**Manual QA:**
- Edit a skill's description in the web UI → check DB row: embedding column NULL.
- Re-run backfill → embedding repopulated, hash matches new description.

---

## Phase 3 — Discovery Module

**What to implement** — new file `src/skills/discovery.ts` exporting:

```ts
export interface DiscoveryOptions {
  topic: string;          // role's defaultTopic — used for fallback + filtering candidates
  message: string;        // user message (or task brief)
  maxByVector?: number;   // default 5
  minSimilarity?: number; // default 0.35
}

export async function discoverSkillIds(opts: DiscoveryOptions): Promise<string[]>
export async function buildPromptFragmentForMessage(opts: DiscoveryOptions): Promise<string>
```

**Algorithm (in order — short-circuit OK between sets, then union):**

1. **Always-inject set**: `SELECT id FROM skills WHERE always_inject = true AND id IN (active assignments for topic)`. These are tiny skills — cheap to include unconditionally for their topic.
2. **Trigger set**: `SELECT id, triggers FROM skills WHERE jsonb_array_length(triggers) > 0 AND id IN (active assignments for topic)`. In TS, lowercase the message once, test each trigger as case-insensitive substring. (Substring first, regex later if requested — keep it deterministic.)
3. **Vector set**: if `description_embedding` is configured AND embedding service is available:
   - Embed the message via `getEmbeddingService().generateEmbedding(message)`.
   - Query: `SELECT id, 1 - (description_embedding <=> $1::vector) AS sim FROM skills WHERE description_embedding IS NOT NULL AND id IN (active assignments for topic) ORDER BY description_embedding <=> $1::vector LIMIT maxByVector`.
   - Filter `sim >= minSimilarity`.
   - Reuse `cosineSimilarity()` helper from `src/db/schema/embeddings.ts:81-85`.
4. **Topic fallback for stale/missing-embedding rows**: rows where `description_embedding IS NULL` are added to the candidate set (so a newly-edited skill isn't dropped just because its embedding hasn't been refilled yet).
5. Union all four sets, dedupe by id, fetch via existing `skillRegistry.getByIds(ids)`, build fragment via existing `skillRegistry.buildPromptFragment(ids)`.

**Failure handling (loud):**
- Embedding generation failure → log `error` with message + model + topic, continue with triggers + always-inject + stale-fallback. Discovery returns; worker spawn proceeds.
- DB query failure → log `error`, return empty string. Worker runs WITHOUT skills (existing behavior on topic-injection failure — see `worker-spawner.ts:271`).

**Env flag for rollout:**
- `SKILL_DISCOVERY_MODE=hybrid|topic_only` — default `hybrid`. When `topic_only`, `buildPromptFragmentForMessage` delegates to existing `buildTopicPromptFragment(topic)`. Lets us roll back without redeploy.

**Documentation references:**
- Existing registry methods to extend: `src/skills/registry.ts:106-120` (`buildPromptFragment`, `buildTopicPromptFragment`).
- pgvector cosine query pattern: `src/core/rag/embeddings.ts:176-218` (`search()` method — copy the `cosineSimilarity` + `orderBy(desc(similarityExpr))` shape).
- Hybrid query example with raw SQL: `src/core/rag/embeddings.ts:251-314` (`hybridSearch`) — useful structure for combining sets in SQL if perf becomes an issue.
- `skill_topic_assignments` join: `src/db/repositories/skill-repository.ts` `findActiveByTopic` (read first, then mirror its filter).

**Verification checklist:**
- [ ] Unit: trigger matching is case-insensitive (`"Push"` matches trigger `"push"`).
- [ ] Unit: trigger matching handles word boundaries vs substring deliberately (decide and document — recommend substring, document the choice).
- [ ] Unit: vector search returns top-k filtered by minSimilarity.
- [ ] Unit: when no embedding model configured, vector set is empty, other sets still work.
- [ ] Unit: stale rows (embedding NULL) included in candidate set.
- [ ] Unit: `always_inject=true` skill always appears for its topic regardless of message.
- [ ] Unit: dedupe — skill matched by both trigger AND vector appears once.
- [ ] Unit: env flag `SKILL_DISCOVERY_MODE=topic_only` → identical output to legacy `buildTopicPromptFragment`.

**Anti-patterns:**
- Do NOT compile triggers as regex without explicit opt-in — substring is faster and predictable.
- Do NOT cache embeddings of user messages (they're unique). Cache only skill embeddings, which already live in the DB.
- Do NOT make `minSimilarity` zero — without a floor, every spawn pulls top-k unrelated skills.
- Do NOT remove the loud-error log path from `worker-spawner.ts:271` style.

**Manual QA:**
- Curl/CLI a coder spawn with message `"push to repo"` → log shows skill IDs matched via `triggers` for git skill.
- Same with `"refactor this Python function"` → vector hit on python skill (assuming description has python content).
- Disable embedding provider → spawn still works, log shows the warn-once message, only triggers + always-inject + topic-fallback used.

---

## Phase 4 — Wire-In

**What to implement** — replace 4 call sites:

| Site | File:Line | Current call | Replace with |
|---|---|---|---|
| A | `worker-spawner.ts:267` | `buildTopicPromptFragment(roleConfig.defaultTopic)` | `buildPromptFragmentForMessage({ topic: roleConfig.defaultTopic, message: task })` |
| B | `swarm/spawner.ts:859` | `buildTopicPromptFragment(childRole)` | `buildPromptFragmentForMessage({ topic: childRole, message: childMessageOrFallback })` |

**Site B note**: swarm site doesn't have user message in scope at line 859. Recovery options (decide one):
- **Preferred**: pass `childMessage` into `resolveChildModelAndExpert()` as a new param. Cleanest, no implicit globals.
- Fallback: read `parentContext.metadata.originalRequest` (already exists per `spawner.ts:538-540`). Use only if param-threading proves invasive.

**Sites C & D — expert-bound `skillIds[]` paths** (`worker-spawner.ts:115` and `:234`): **leave unchanged**. Expert-declared skills are an explicit allowlist — the human picked them. Discovery is for the implicit topic-default set only.

**Documentation references:**
- All four sites quoted in full in the Phase 0 reconnaissance — re-read those line ranges before editing.
- `RoleConfig.defaultTopic`: `src/core/orchestrator/types.ts:20-25`.

**Verification checklist:**
- [ ] `git grep "buildTopicPromptFragment"` returns only the legacy method definition + the env-flag fallback path. No live call sites in spawners.
- [ ] Existing tests in `src/core/swarm/spawner.test.ts` still pass.
- [ ] Manual spawn produces a systemPrompt with `# Domain Knowledge` block scoped to discovered skills (verify by logging the prompt at debug level temporarily).

**Anti-patterns:**
- Do NOT delete `buildTopicPromptFragment` — keep it for the env-flag rollback path and test parity.
- Do NOT change the expert `skillIds[]` paths — that's a separate, intentional injection.
- Do NOT thread `message` into the swarm spawner via a global or singleton — use a function param.

**Manual QA:**
- Spawn a coder worker with `"push my changes"` → log + DB session metadata show fewer skills injected than before, including a git-related one.
- Spawn with `"hello"` (casual) → discovery returns only `always_inject` skills (or empty); confirm no irrelevant content in systemPrompt.

---

## Phase 5 — Tests

**What to implement:**

1. `src/skills/discovery.test.ts` — unit tests covering each verification point in Phase 3.
2. `src/skills/discovery.integration.test.ts` — uses real DB (PGlite or test schema):
   - Seed 5 skills with mixed triggers / always_inject / embeddings.
   - Assert `discoverSkillIds` returns expected union for several messages.
   - Assert env flag `SKILL_DISCOVERY_MODE=topic_only` produces same set as legacy method.
3. Integration test for the wire-in: spawn a worker (mocked `agent-worker`), capture the systemPrompt passed in, assert it contains the expected skill names and excludes others. Pattern reference: `src/core/swarm/spawner.test.ts`.
4. **Test for staleness**: update a seeded skill's description, assert next `discoverSkillIds` call still includes it (via NULL-embedding fallback) and that the embedding column is NULL.

**Documentation references:**
- Bun test conventions: `src/core/swarm/spawner.test.ts:1-12`.
- Existing skill tests for mocking patterns: `src/skills/markdown.test.ts`, `src/skills/external-loader.test.ts`.

**Verification checklist:**
- [ ] `bun test src/skills/discovery` — all green.
- [ ] Coverage: every branch of `discoverSkillIds` (always_inject hit, trigger hit, vector hit, all-empty, embedding-unavailable, env-flag-off) has a test.
- [ ] No flaky tests — vector tests use deterministic mock embeddings, not the real provider.

**Anti-patterns:**
- Do NOT call the real embedding provider in unit tests — inject a mock via constructor or module mock.
- Do NOT skip the `embedding-unavailable` test path — that's the most likely real-world failure mode.

**Manual QA:**
- Run `bun test` — full suite green, no new warnings.
- Run integration test against PGlite specifically (CI path) and against postgres (dev path).

---

## Phase 6 — Rollout & Verification

**What to implement:**

1. Default `SKILL_DISCOVERY_MODE=hybrid` in `.env.example`. Document the flag in `.env.example` comments and in AGENT.md if there's a relevant section.
2. Run backfill script in dev → verify embeddings populated for all existing skills.
3. Pick 3-5 representative messages, spawn workers, capture the injected systemPrompt; compare token count before/after. Record numbers in commit message.
4. Add observability: include `discoveredSkillCount` in the existing `coreLogger.info('Worker tools resolved', ...)` log line (or adjacent log) so we can monitor skill count per spawn in production.
5. Keep `buildTopicPromptFragment` legacy path live for two weeks; remove only after monitoring confirms no spike in errors.

**Verification checklist:**
- [ ] Dev DB: 100% of skills have non-null `description_embedding` (or a logged reason why not).
- [ ] Token count for sample spawns is meaningfully lower (target: ≥40% reduction for messages that don't match many skills).
- [ ] Error rate for skill-injection log lines is unchanged or lower.
- [ ] Setting `SKILL_DISCOVERY_MODE=topic_only` in env reverts behavior bit-for-bit (verify by diffing systemPrompts).

**Anti-patterns:**
- Do NOT remove the legacy method or env flag in the same PR as the wire-in.
- Do NOT promote to prod without running the backfill — workers would silently miss skills until embeddings exist.

**Manual QA matrix:**

| Scenario | Expected |
|---|---|
| Message "push to repo", coder role | git skill via trigger; total skills ≤ topic baseline |
| Message "build a Python service", coder role | python skill via vector or trigger; architecture skill if matched |
| Message "hi", coder role | only `always_inject=true` skills (likely empty) |
| Embedding provider env unset | warn-once in log, spawn succeeds, only triggers + always_inject + stale-fallback applied |
| Edit skill description in UI, immediately spawn matching message | skill still appears (via NULL-embedding fallback); embedding column NULL until backfill or lazy refill runs |
| `SKILL_DISCOVERY_MODE=topic_only` | identical output to pre-change behavior |

---

## Open Questions to Resolve Before /do

1. **Lazy refill vs scheduled job**: should discovery itself trigger a background re-embed for stale rows it encounters, or do we run the backfill script on a cron? Recommend: scheduled job (simpler, observable). Discovery only *reads*.
2. **Trigger semantics**: substring (recommended) or word-boundary regex? Document the choice in the skill schema's column comment.
3. **Swarm message threading**: thread `childMessage` as a new param (preferred) or read from `parentContext.metadata.originalRequest`? Resolve in Phase 4.
4. **Per-org embedding models**: future workspaces may bind different embedding models per org (per memory `project_octipus_architecture.md`). Out of scope for this plan — note as follow-up if multi-workspace lands first.
