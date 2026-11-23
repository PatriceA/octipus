# Learning notes and learned-skill discovery

Status: implemented. "As built" notes below say where the code differs from
this plan; the code and docs/SESSION-LEARNING.md are the reference. Follows `self-learning-consolidation.md` and
`recall-hardening.md`.

"Skill discovery" here is choosing which of a user's skills reach a prompt.
Browsing skills others published (skill registries) is separate and lives in
[SKILL-EXCHANGE.md#registries](../SKILL-EXCHANGE.md#registries); a skill
installed from a registry is an ordinary personal skill to this discovery.

## Problem

1. **Approved learned skills are not discovered.** Approval inserts a skill
   with no row in `skill_topic_assignments`; every path of
   `discoverSkillIds` joins that table. A learned skill reaches no prompt
   unless it is assigned by hand or an agent calls `list_skills`.
2. **Notes and skills overlap.** The review asks notes for "problem, failed
   approach, correction" and skills for "a failure followed by a verified
   fix": one lesson can land in both.
3. **Learning notes have no controls.** Up to 3 per review, deduplicated by
   exact text only, no merge, no expiry.
4. **They crowd out the user's own notes.** The notes index lists the 15 most
   recently changed notes with no filter. Recall cannot tell them from the
   user's notes (both `purpose = 'note'`), and since recall now runs before
   every agent start and shows a chunk whole, the evidence footer in each note
   body is injected verbatim.

## Goal

One lesson goes to exactly one place:

| Store | Holds | Reaches an agent by |
|---|---|---|
| Memory | Facts about the user | memory block (unchanged) |
| Skill | How to do something | skill discovery, by meaning |
| Lesson note | What was decided and why, constraints, project and environment facts | recall, as its own kind |

## Design

### A lesson note

A note written by a learning review has `note_kind = 'lesson'`, keeps the tag
`session-learning`, and is indexed in `embeddings` with `purpose = 'lesson'`
(`NoteService` chooses the purpose from `note_kind`; every other note stays
`'note'`). `'lesson'` joins `EmbeddingPurpose` and `RECALL_PURPOSES`.

Body: the lesson only. Evidence (session ids, evidence ids, learning job ids)
lives in `frontmatter` (`sessions: string[]`, `learningJobIds: string[]`,
`sources: string[]`, each capped at 50, newest last) plus
`frontmatter.lessonKind`: `decision` | `constraint` | `fact`, and
`frontmatter.sightings: number`.

Migration `0200_lesson_notes.sql` (pure SQL, idempotent):
`notes.note_kind = 'lesson'` where the tag `session-learning` is present and
`note_kind = 'note'`; `embeddings.purpose = 'lesson'` for those notes' rows
(`source_id = 'note:' || id`), skipping rows that would collide with the
unique dedup index. Bodies are not rewritten by the migration.

> As built: 0200 converts only notes a learning review wrote: the tag, a
> `learning-%` slug and a `learningJobId` key, in a personal workspace or at
> user level (never a space's note, never one the user tagged by hand). A
> leftover `note` row whose `lesson` twin exists is deleted. Migration 0201
> adds `notes_archived_source_idx` (archived notes only) for the archived-note
> filter in every knowledge search, and 0202 adds `lesson` to stored recall
> purposes (see Recall). The frontmatter also carries `mergedInto`,
> `archivedBy: 'expiry'` and `distinctFrom`.

### Review (`src/core/learning/review.ts`, `processor.ts`, `evidence.ts`)

- `knowledge` items become: `{title, content, kind, extends?, sources}`, at
  most 2 (was 3). `kind` is `decision` | `constraint` | `fact` (missing or
  invalid: `fact`). `extends` is `"note:<id>"` of a lesson offered in the
  input; an unoffered one is dropped and logged, as for skills.
- Prompt: a note states what is true about the project or what was decided and
  why (a decision names the alternative that was rejected). Not a procedure
  (that is a skill), not about the user (that is a memory), not a diary of the
  session. A lesson goes to exactly one of memories, knowledge, skills,
  patches. If nothing stays true after this session, return none.
- `existing` gains `notes`: up to 5 nearest lesson notes of the user in this
  workspace (`ref: "note:<id>"`, title, 600-character excerpt), within the
  existing 8,000-character bound. Without embeddings: the 10 most recently
  updated.

### Filing a lesson (`src/core/learning/lesson-notes.ts`)

`fileLessonNote(item, ctx)` with `ctx = { userId, workspaceId, sessionId,
jobId }`, in order:

1. `extends` names a lesson note of this user and workspace -> merge into it.
2. Nearest lesson note by embedding (same user and workspace, not archived):
   at or above `learning.duplicateSimilarity` -> merge; in the related band
   -> merge with `allowDistinct`.
3. Otherwise create it (slug `learning-<hash of normalized content>`, as now).

Merge: one background-model call returning `{verdict: 'merged' | 'unchanged'
| 'distinct', title, content}`, the same contract and degradation rules as
`mergeIntoProposal` (count-only when the model is unavailable, `distinct` in
the related band). A merge updates the note through `NoteService.save` (so it
is re-linked and re-indexed), appends to the frontmatter lists, and increments
`sightings`. Content is PII-filtered and capped at 4,000 characters. A note
that is pinned is still merged into; a note the user archived is never
revived: a duplicate of an archived lesson is dropped.

Result: `{ status: 'saved' | 'merged' | 'duplicate' | 'saved_unindexed',
id, merged?, mergeDegraded?, detail? }`. Receipts for kind `knowledge` gain
the status `merged`.

Without an embedding model: step 1 and exact-slug dedup only.

> As built:
> - The order is `extends`, then the same slug (counted without a model
>   call), then by meaning, then new.
> - A duplicate is judged as a note, not by its best chunk pair: every chunk
>   of the shorter note must have a match at `duplicateSimilarity`
>   (`noteLevelDuplicate`). A pair that shares only some passages is treated
>   as related (`allowDistinct`). Consolidation uses the same rule.
> - An archived match is not always dropped. Archived by consolidation
>   (`mergedInto`): counted on the live note it leads to (at most 5 hops).
>   Archived by expiry (`archivedBy: 'expiry'`): revived and counted.
>   Archived by the user (no mark; archiving through the notes API, UI or tool
>   clears the marks): dropped as `duplicate`.
> - The related band is checked against the nearest live note only.
> - The frontmatter is merged by compare-and-set, retried once
>   (`NoteService.save` no longer writes back the frontmatter it read).

### Consolidation and expiry (`src/core/learning/consolidation.ts`)

`consolidateProposals` keeps its name and gains two steps for lesson notes of
the user (all workspaces the user owns personally, never a shared space):

- merge near-duplicate lesson notes pairwise with the same target rule as
  proposals (pinned first, then more `sightings`, then older), bounded by
  `maxMerges` shared with proposal merges; the absorbed note is archived with
  `frontmatter.mergedInto = <id>`. A rewritten note has any legacy
  "Evidence: session ..." footer removed from its body.
- archive lesson notes that are not pinned, older than `learning.lessonTtlDays`
  (default 90, 0 = never), and whose embedding rows have no
  `last_accessed_at` within that many days.

The report gains `notesMerged` and `notesArchived`.

> As built:
> - Expiry measures from the later of `updated_at` and the chunks' latest
>   `last_accessed_at`, not from creation, so a lesson a review saw again is
>   kept. `updated_at` moves on every save and on pin or unpin.
>   `last_accessed_at` is no longer stamped by re-indexing, by link
>   suggestions or ghost-link resolution, or by a semantic search with
>   `skipAccess`. Expired notes are marked `archivedBy: 'expiry'`.
> - Besides `maxMerges`, a run makes at most 20 merge-model calls for lesson
>   pairs (`MAX_LESSON_MERGE_CALLS`) and 20 for proposal pairs
>   (`MAX_PROPOSAL_MERGE_CALLS`), distinct verdicts included. A pair judged
>   distinct is recorded on both notes (`distinctFrom`).
> - A pinned note is never absorbed; two pinned near-duplicates are skipped.
> - No count-only merge of different texts: when the model cannot judge, or
>   the target changed during the call, nothing is written (deferred). The
>   target is written before the absorbed note is archived; a crash between
>   the two overcounts `sightings` on the next run.
> - Archived notes are left out of every knowledge search (not in the plan),
>   so an archived or merged-away lesson is no longer recalled.
> - The daily maintenance also runs for users with live lesson notes and no
>   open proposals.

New settings (registered like the other `learning.*` keys):
`learning.lessonTtlDays` (90), `learning.maxLessonsPerReview` (2).

### Recall (`src/shared/context-hooks.ts`, `src/core/context-hooks/kinds.ts`)

- `'lesson'` in `RECALL_PURPOSES`; label `Lesson "<title>"` in the passage
  line; "Lessons" checkbox on the Recall page. A hook whose stored `purposes`
  predates this keeps its stored list, so lessons are off for it until ticked;
  the built-in default includes them.

  > As built: migration 0202 adds `lesson` to every stored list that has
  > `note` (once), so a hook that recalled learning notes as notes keeps
  > recalling them; a list without `note` is left alone. Passage labels are
  > `Note`, `Lesson` and `Document`.
- Notes index: counts and lists only notes whose `note_kind` is not `lesson`.

### Skill discovery (`src/skills/discovery.ts`)

`discoverSkillIds` takes `userId`. A **learned skill** of that user (own, not
system, not archived, with no active row in `skill_topic_assignments` for any
topic) is a candidate for every role: ranked by the vector path with the same
`minSimilarity` and `maxByVector` as assigned skills, and matched by its
triggers. `always_inject` never applies to it. Without an embedding model the
10 most recently used learned skills are listed. A learned skill that has been
assigned to a topic follows the assignment rules only. Every caller passes the
turn's user. Approval computes the new skill's embedding right away
(`ensureSkillEmbeddings`), so it is discoverable on the next agent start.

> As built:
> - A learned skill has **no row at all** in `skill_topic_assignments`, active
>   or inactive: an inactive row means the user switched it off for a role.
>   Who wrote it does not matter. Not a candidate in a shared space.
> - With a query embedding, up to 3 learned skills not yet embedded stay
>   candidates (most recently updated first).
> - The root turn, which runs no role discovery, gets a `# Learned Skills`
>   index by the same rule (`learnedSkillsBlock`), bounded by
>   `START_DEADLINE_MS` (4.5 s), and only after a one-query check that the user
>   has a learned skill. Worker and swarm discovery wait for the query
>   embedding at most `START_DEADLINE_MS`.
> - Three fixes to existing discovery: archived skills are left out, lane-name
>   assignments match in every hybrid set, and the result is ranked best first
>   (triggers, vector by similarity, standing, stale, recent) instead of by
>   name.

### Web

- Recall page: "Lessons" purpose checkbox.
- Proposals page: the consolidate sentence mentions merged and archived notes
  when above zero.
- Notes navigator: the "Session learnings" group selects by `noteKind ===
  'lesson'` or the tag, and shows `×N` for `sightings > 1`.
- Learning panel: `knowledge: merged` label.

## Work packages

| Id | Scope | Files owned |
|---|---|---|
| S | Skill discovery | `src/skills/discovery.ts`, its callers (`src/core/agent/worker-spawner.ts`, `src/core/swarm/spawner.ts`, others found), `src/services/skill-proposal-service.ts`, tests |
| N | Lesson notes: write path, merge, consolidation, config, migration | `src/core/learning/**`, `src/core/knowledge/notes.ts`, `src/core/rag/embeddings.ts` (the type only), `src/config/schema.ts`, `src/config/settings-registry.ts`, `src/shared/learning.ts`, `src/db/migrations/0200*`, `src/db/schema/notes.ts`, `src/api/routes/skill-proposals.ts` (report only) |
| R | Recall, notes index, web | `src/shared/context-hooks.ts`, `src/core/context-hooks/**`, `web/**`, `tests/web/**` |
| D | Docs and changelog | `docs/**`, `CHANGELOG.md` |

S, N and R run in parallel on this contract; D after them.

## Validation

`npm run typecheck && npm run lint && npm test && npm run catalog:check`, the
Playwright specs for the Recall, proposals and notes pages, and database tests
for: a learned skill with no assignment is discovered for any role by meaning
and another user's is not; two reviews of one decision end as one lesson note
with `sightings = 2`; the notes index omits lessons; recall labels a lesson
and a hook without the purpose does not return it; expiry archives only
unpinned, unaccessed, old lessons. The review prompt changes, so the
`npm run eval` suites apply; they need a live model.

> As built: the `npm run eval` suites were not run (they need a live model).
