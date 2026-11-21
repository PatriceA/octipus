# Self-learning: fewer, better skill proposals

Status: in implementation. Reference for behaviour once shipped: `docs/SESSION-LEARNING.md`.

## Problem

After a few days of work the Skills → Proposals list holds 20+ proposals, many
about the same topic. Causes, all in the current code:

1. A review runs every 10 tool calls (`learning.reviewEveryToolCalls`) and on
   every completed plan; each may file one skill.
2. Each review reads the latest 100 events up to its trigger, not the events
   since the previous review, so consecutive reviews see ~90% the same evidence.
3. The reviewer is not shown existing skills or open proposals.
4. Nothing in `src/` writes `skills.description_embedding` (only the manual
   backfill script), so semantic dedup against live skills never matches a
   learned skill.
5. Dedup compares name + description at cosine >= 0.85, against the 20 newest
   pending proposals only, and never against rejected ones.
6. A duplicate is dropped: nothing is merged, `exemplar_count` stays 0.
7. One occurrence of any "reusable procedure" is enough for a proposal.
8. No cap, no expiry; the curator is never scheduled.

## Goals

- The same topic lands in the same proposal (merged text, a counter, sources).
- A proposal is shown only when it has proven itself: seen in two sessions, or
  it comes from a user correction, or the user asked for it (`distill_skill`).
- Reviews run less often and read only new evidence.
- The existing backlog can be collapsed with one action.

Non-goals: auto-approving anything; changing memory extraction; changing patch
approval semantics.

## Design

### Data model (migration `0197_skill_proposal_consolidation.sql`)

`skill_proposal_status` gains `candidate` (filed, not yet shown) and `merged`
(absorbed into another proposal).

New `skill_proposals` columns:

| Column | Type | Meaning |
|---|---|---|
| `embedding` | `vector` (same type as `skills.description_embedding`), null | Embedding of `name\ndescription`. Null until computed. |
| `source_refs` | `jsonb` not null default `[]` | Every `sourceRef` merged in, newest last, capped at 50. |
| `signal` | `text` null | `correction` \| `recovery` \| `procedure` (what kind of evidence). |
| `previous_draft` | `text` null | The draft before the last merge. |
| `merged_into_id` | `uuid` null, FK self `ON DELETE SET NULL` | For status `merged`. |
| `surfaced_at` | `timestamptz` null | When it became `pending`. Backfill: `created_at` for existing pending rows. |

Backfill in the migration: `source_refs = [source_ref]` where `source_ref` is
set; `exemplar_count = 1` where it is 0 and kind is not `expert`.
New rows start with `exemplar_count = 1`.

Session count of a proposal = distinct session ids parsed from `source_refs`
(`learning:<job>:session:<id>` and `session:<id>`); other refs (`text`,
`trajectory:<id>`) each count as one distinct source. Pure helper
`sessionCountOf(sourceRefs)` in `src/shared/skill-proposals.ts`.

### Config (`learning`)

| Key | Default | Meaning |
|---|---|---|
| `reviewEveryToolCalls` | 40 (was 10) | Tool calls between automatic reviews. |
| `minReviewIntervalMinutes` | 30 | No automatic tool-count review sooner than this after the session's previous check was created. Plan-completed and manual checks are not held back. |
| `recurrenceSessions` | 2 | Sessions a learned proposal must be seen in before it is shown. 1 turns the gate off. |
| `maxSkillProposalsPerDay` | 2 | Learned skill proposals surfaced per user per rolling 24 h. |
| `maxPendingSkillProposals` | 10 | Above this many pending non-patch proposals, learned ones wait as candidates. |
| `duplicateSimilarity` | 0.85 | At or above: the same skill. |
| `relatedSimilarity` | 0.70 | From here to `duplicateSimilarity`: the merge model decides. |
| `candidateTtlDays` | 30 | A candidate not seen again for this long is deleted. |

`distill_skill` (the user asked) is exempt from the gate and both caps.
Patches are exempt from all of it.

### Embeddings (`src/skills/embedding-backfill.ts`)

`ensureSkillEmbeddings({ limit })`: embeds DB skills whose embedding is null or
whose `description_hash` is stale (same rule as the script, which now calls
this function). `ensureProposalEmbeddings(userId, { limit })`: the same for open
proposals. Both return counts, do nothing when the embedding capability is off,
and throw only on unexpected errors (a missing embedding model is logged once
and returns 0). Called before every dedup comparison (limit 20) and by the
daily consolidation.

### Dedup and filing (`src/tools/skill-distill/dedup.ts`, `src/services/file-skill-proposal.ts`)

`fileSkillProposal(distilled, userId, sourceRef, opts)` with
`opts = { origin: 'manual' | 'learning', signal?, extendsProposalId? }`.
Order:

1. Fingerprint (normalized name) hit on this user's latest proposal:
   `pending`/`candidate` -> merge into it; `rejected` and still suppressed ->
   drop; `merged` -> follow `merged_into_id` once and treat that row the same
   way; `promoted` -> continue.
2. Live skill with the same normalized name, or cosine >= `duplicateSimilarity`
   -> drop ("already covered by skill X").
3. Open or suppressed-rejected non-patch proposals of the user, compared in SQL
   by `embedding` (no limit of 20):
   - best suppressed-rejected >= `duplicateSimilarity` -> drop (suppressed).
   - `extendsProposalId` names an open proposal of the user -> merge into it.
   - best open >= `duplicateSimilarity` -> merge into it.
   - best open in the related band -> merge with `allowDistinct`.
4. Otherwise insert. Status is `pending` when `origin = 'manual'`, or
   `signal = 'correction'`, or `recurrenceSessions <= 1`; otherwise `candidate`.
   A learned proposal that would be `pending` stays `candidate` while a cap is
   reached.

Every decision logs `{ decision, similarity, against }` (calibration data).
Without an embedding model, steps 1 and 2 (name) and `extendsProposalId` still
work.

`mergeIntoProposal(target, incoming, sourceRef, { allowDistinct })` in
`src/services/skill-proposal-merge.ts`: one background-model call (topic
`background`, JSON) that returns `{verdict: 'merged' | 'unchanged' | 'distinct',
description, content}`. `merged`: `previous_draft` = old draft, new draft and
description, embedding recomputed. `unchanged`: text stays. Both: `exemplar_count
+ 1`, `source_refs` appended, `last_exemplar_at = now`, `signal` upgraded
(`correction` > `recovery` > `procedure`). `distinct` (only with
`allowDistinct`): the caller files a new row. Name and fingerprint of the
target never change. Model unavailable, truncated or malformed: counted and
logged as a count-only merge (no text change), reported in the result
(`mergeDegraded: true`). Merged content is PII-filtered and capped at 8,000
characters. After a merge `promoteIfEligible(proposal)` moves a candidate to
`pending` (sets `surfaced_at`) when `sessionCountOf >= recurrenceSessions` or
its signal is `correction`, within the caps.

Result shape of `fileSkillProposal` keeps `distilled`, `deduped`, `proposalId`,
`name`, `status`, `message` and adds `merged?: boolean`, `status` may be
`'candidate'`.

### Review (`src/core/learning/`)

- `queue.ts`: `minReviewIntervalMinutes` gate in `enqueueTurnLearning`.
- `evidence.ts`: `gatherEvidence(..., { since })` reads execution events and
  verification records created after `since`; chat messages keep the last 8.
  `since` = `through` of the session's previous learning job with status `done`
  or `error` (not the job itself), for automatic triggers; manual checks read
  the full window.
- `processor.ts`: builds `existing` for the review input: up to 5 nearest live
  skills and up to 5 nearest open proposals (`ref`, `name`, `description`,
  600-character excerpt), ranked by embedding of the plan title/goal plus the
  last typed user messages; without embeddings, the 10 most recent open
  proposals and up to 30 learned-skill names. Patch targets become: skills the
  session loaded (as today) plus the nearest patchable learned skills, still at
  most `MAX_PATCHABLE_SKILLS` within `MAX_PATCH_TARGET_CHARS`. Passes
  `origin: 'learning'`, `signal`, `extendsProposalId` to `fileSkillProposal`;
  receipts gain statuses `merged` and `candidate`.
- `review.ts`: skill candidates carry `signal` (required) and optional
  `extends: "proposal:<id>"`. The prompt raises the bar: a skill needs a user
  correction, a failure followed by a verified fix, or a non-obvious multi-step
  procedure; "if a capable agent would get this right without the skill, return
  none"; prefer `patches` for a learned skill in the input, `extends` for an
  open proposal on the same topic, and a new skill only when neither fits.

### Consolidation (`src/core/learning/consolidation.ts`)

`consolidateProposals(userId, { maxMerges = 20 })`:
1. `ensureSkillEmbeddings`, `ensureProposalEmbeddings`.
2. Greedy clustering of open non-patch proposals: pairs >= `duplicateSimilarity`
   merge; pairs in the related band merge with `allowDistinct`. The target is
   the pending member with the highest `exemplar_count`, else the oldest. An
   absorbed row becomes `merged` with `merged_into_id`; its `source_refs` and
   `exemplar_count` are added to the target.
3. Candidates with `last_exemplar_at` older than `candidateTtlDays` are deleted.
4. `promoteIfEligible` for remaining candidates, oldest first.
Returns `{ merged, expired, promoted, embedded, degraded }`.

Scheduling: `startLearningQueue` also runs `runDailyLearningMaintenance()` on an
hourly tick; it runs at most once per 24 h (last run stored in `kv_store`),
consolidates every user with open proposals, then calls `runSkillCurator()`.
Failures are logged, never thrown into the timer.

### API

| Method | Path | Change |
|---|---|---|
| GET | `/api/skills/proposals` | Still pending only, sorted `exemplar_count` desc then oldest. Adds `sessionCount`, `sourceRefs`, `signal`, `previousDraft`, `surfacedAt`, `similarSkill: {id, name, similarity} \| null`, and top-level `candidateCount`. `?include=candidates` also returns candidates (`status: 'candidate'`). The `embedding` column is never returned. |
| POST | `/api/skills/proposals/bulk-reject` | `{ ids: string[] }` (1-100) -> `{ rejected: string[], notFound: string[] }`. |
| POST | `/api/skills/proposals/:id/merge` | `{ intoId }` -> merges `:id` into `intoId` (both open, same owner, non-patch) with the merge model; `:id` becomes `merged`. `409` when either is not open. |
| POST | `/api/skills/proposals/:id/surface` | Promote a candidate to pending now (the owner overrides the gate; caps do not apply). |
| POST | `/api/skills/proposals/consolidate` | Runs `consolidateProposals` for the caller -> its report. |

Approve and reject accept `pending` and `candidate` rows. Rejecting a `merged`
row is not possible; rejecting the target suppresses the fingerprints of its
absorbed rows too (they are set to `rejected` with the same `rejected_until`).

`/proposals` (gateway and TUI) lists pending only, with `×N` after the name
when `exemplar_count > 1`.

### Web (`web/app/skills/proposals/page.tsx`)

Sorted as served. Each card: "seen N× in M sessions", "similar to skill X"
when `similarSkill` is set, a diff `previousDraft` -> draft when merged, a
"merge into…" select. Header: select-all checkbox, "Reject selected",
"Consolidate now" (shows the report), and a collapsed "Not shown yet (N)"
section listing candidates with "Show now" and "Reject".

## Work packages

| Id | Scope | Files owned |
|---|---|---|
| A | Migration, schema, config, shared types, embeddings, dedup, merge, filing | `src/db/migrations/0197*`, `meta/_journal.json`, `src/db/schema/skill-proposals.ts`, `src/config/schema.ts`, `src/shared/skill-proposals.ts`, `src/skills/embedding-backfill.ts`, `scripts/backfill-skill-embeddings.ts`, `src/tools/skill-distill/*`, `src/services/file-skill-proposal.ts`, `src/services/skill-proposal-merge.ts` |
| B1 | Review pipeline | `src/core/learning/{queue,evidence,processor,review,triggers}.ts`, `src/shared/learning.ts` |
| B2 | Consolidation, service, API, commands | `src/core/learning/consolidation.ts`, `src/services/skill-proposal-service.ts`, `src/api/routes/skill-proposals.ts`, `src/core/gateway/commands.ts`, `src/tui-pi/slash-commands.ts`, `src/index.ts`, generated catalog |
| B3 | Web page and Playwright spec | `web/app/skills/proposals/page.tsx`, `tests/web/skill-proposals.spec.ts`, learning panel labels |
| C | Docs, changelog, full verification | `docs/SESSION-LEARNING.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `CHANGELOG.md` |

A runs first; B1, B2, B3 run in parallel on A's contract; C last.

## Validation

`npm run typecheck && npm run lint && npm test && npm run catalog:check`, the
Playwright spec for the proposals page, and a database test that drives the
whole path: three reviews of one topic in two sessions produce one pending
proposal with `exemplar_count = 3`. The review prompt changed, so the
`npm run eval` suites apply; they need a live model.
