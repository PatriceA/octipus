# Learning from completed session work

Session learning runs through the durable `background_jobs` queue (`kind=learning`), using the configured **background** model. It does not require narrated CLI replies or call CLI subprocesses. New skills and patches to learned skills always remain proposals for review.

## Triggers

- Full execution-plan completion: all steps done or skipped, with at least one done step. A single finished step is not a milestone. Proposals, repeated status updates and stale writes do not trigger checks.
- Accumulated work: once a session has recorded `learning.reviewEveryToolCalls` tool results (default 40; it was 10) since its last check, or since it began, the next successful turn queues one. The count runs across turns, so many short turns earn one check and a long turn does not earn one per turn. Time spent is not counted: on a slow local model everything takes long. This check is also held back until `learning.minReviewIntervalMinutes` (default 30) have passed since the session's previous check was created, whatever triggered that one and however it ended; the tool results keep counting meanwhile, so the next turn after the interval queues it. The interval does not hold back plan-completion or manual checks.
- Not for one-shot sessions: a `POST /api/chat` with `oneShot: true` creates a session nobody returns to, and no automatic check is queued for it.
- **Learning → Check recent work** in the chat inspector (`POST /api/sessions/:id/learning`): checks an existing session on demand, one-shot or not. Reuses a queued/running session check instead of piling up manual requests.

When the background model is local (Ollama on a private endpoint), a queued check starts only after that provider has been idle for `learning.localIdleMs` (default 60 s), so a review never holds the GPU while a turn waits behind it. Remote models are checked at once.

Plan saves and their queued checks share a database transaction. The worker polls every 15 seconds, claims jobs atomically and resumes queued work after restart. In-flight checks interrupted by restart are reported as interrupted, not silently declared successful or automatically replayed.

## Evidence and cost

A check uses evidence recorded at or before its trigger: up to eight chat messages, eight verification records and 100 execution events, plus the milestone's plan evidence. Excerpts are redacted and capped at 2,400 characters each within a 40,000-character total budget. Older records may be omitted. This is a recent-evidence check, not an exhaustive reread of multi-day vendor transcript files.

An automatic check (tool count or plan completion) reads only the execution events and verification records created after the last check of the session whose evidence the review model actually judged: the `through` of the session's latest other learning job that ended with stage `checked`, `nothing_reusable` or `partial_failure` (the review succeeded and only some writes failed). A check that failed (no model, a timeout, truncated output), found no evidence (`insufficient_evidence`), was skipped (`skipped_*`), or was interrupted or cancelled does not move that boundary, so its evidence is read again by the next one, within the same event and character bounds. Chat messages are not narrowed: they are always the last eight. The session's first check, and every manual **Check recent work**, read the full window. An automatic check that finds no new execution or verification evidence ends as `insufficient_evidence` with the reason "No new execution evidence since the previous learning check." and calls no model.

Besides the evidence, the review is shown `existing`: up to five live skills (the owner's own, and system skills by name and description only) and up to five of the owner's open skill proposals (pending or candidate), each as `{ref, name, description, excerpt}` with a 400-character description and a 600-character excerpt of the content or draft, redacted. They are the ones nearest, by embedding, to the plan's title and goal plus the owner's last three typed messages. Without an embedding model, or with nothing to rank by, they are the ten most recent open proposals and up to 30 names of the owner's own skills, most recently used first. `existing` is capped at 8,000 characters and, like the patch targets, comes out of the 40,000-character budget. If it cannot be read the check goes on without it.

Claude/Codex tool-result excerpts already recorded by Octipus are included. Tool requests and plan/assistant success claims are labelled separately and cannot alone support a project lesson or skill. Every candidate must cite supplied evidence; personal memories may cite only user messages a person typed (Companion handoffs, monitors, schedules, internal inputs and the plan brief are stored as user rows but are labelled as requests, not user evidence) and must carry a verbatim `quote` from one of them. A memory that cites anything else is dropped on its own with a `rejected` receipt; the review's lessons and skill are kept. An `expires` date is the end of that day in your timezone. The learning reviewer does not use the legacy per-turn extractor's English first-person heuristic.

One bounded review call produces project lessons, personal facts, at most one skill candidate and at most one patch to a learned skill. Empty output is valid. Background model errors, invalid/truncated output, missing evidence and failed writes have distinct receipts.

The bar for a skill is set in the review prompt: only a user correction of how the work was done, a failure followed by a verified fix, or a non-obvious multi-step procedure, and none when a capable agent would get it right without the skill. Each skill carries a `signal` naming which of the three it is (`correction`, `recovery`, `procedure`; a missing or invalid one is read as `procedure`). The prompt asks the reviewer to prefer, in order: a patch to one of the offered learned skills; a skill with `extends: "proposal:<id>"` naming an `existing` proposal on the same topic, which is merged into that proposal; a new skill only when neither fits. An `extends` naming a proposal that was not offered is dropped (logged) and the skill is filed as a new one, through the usual deduplication. The bar is a prompt instruction, not a check the server can enforce.

## Writes and isolation

- Project lessons become workspace-scoped, indexed notes with source references. Identical normalized content reuses its note. Notes saved without successful indexing are reported as partial failures.
- Personal facts are written only when their quote is found, server-side, in a cited message of yours in the session's current conversation ([where a memory comes from](RAG.md#where-a-memory-comes-from)); otherwise the receipt says `rejected` with the reason. Accepted facts then use the existing memory judge and embedding-backed deduplication. `memory.extractionCadence=off` also disables personal memory writes from learning checks.
- Skills are filed through the same path as manual `distill_skill` (deduplication, merging into an open proposal on the same topic, rejection suppression), but as learned proposals: a new one waits as a `candidate` until it has recurred, and the caps apply ([the life of a skill proposal](#the-life-of-a-skill-proposal)). Either way it awaits human approval. The receipt's status is `proposed` (a new pending proposal), `candidate` (filed, not shown yet; "kept as a candidate" in the inspector), `merged` (folded into an existing proposal, whose id is given; "merged into an existing proposal"), `duplicate` (dropped: a live skill covers it, or it was rejected and is still suppressed) or `failed`.
- Patches to learned skills are filed as pending proposals (below). An identical patch that is pending or was already approved is not filed again, and a rejected one stays suppressed for 90 days (the same fingerprint check as skill proposals).
- Knowledge, skill and patch writes recheck the corresponding tool permission. ASK and DENY cannot be approved by the background worker.
- Session ownership and workspace are checked before evidence is read. Unscoped sessions use the user's default workspace for saved learning, matching the agent's memory scope.

## Repairing a learned skill

A check can also propose a **patch** to a learned skill instead of a second, overlapping skill: `{skillId, oldText, newText, reason, sources}`, where `sources` cites execution or verification evidence like any other candidate. Inspired by the learned skills of n8n's "nod", with one deliberate difference: nod saves a patch directly, Octipus files it for approval.

- **Which skills.** A *learned* skill is a DB skill of the session's owner that the owner has not written themselves (`owner_edited_at` is empty): typically one created by approving a proposal. The review is shown at most two of them. First come skills whose body this session loaded — a `skill_load` event recorded by the in-process `get_skill`, or a CLI agent's `get_skill` call through the MCP bridge whose recorded arguments name the skill (Claude Code records them; a CLI that records no tool arguments offers none of this kind). A skill ID merely appearing in an event, such as a `list_skills` result, does not count. Any remaining place goes, when an embedding model is configured, to the owner's patchable learned skills nearest the review's topic (the plan's title and goal plus the last typed messages), however distant; without an embedding model only loaded skills are offered. A skill offered as a patch target is not repeated in `existing`. Each is at most 8,000 characters, together at most 12,000, taken out of the same 40,000-character input budget as the evidence, and redacted like other evidence. If they cannot be read the check goes on without patch targets. A patch naming any skill that was not offered is refused. System skills, mounted filesystem `SKILL.md` skills and other users' or org members' skills never take patches; edit those at their source.
- **Exactly one passage.** `oldText` must occur exactly once in the skill's current content, compared exactly (no whitespace, case or Unicode normalisation). No match and several matches are both refused; the reviewer has to quote enough surrounding text to make the passage unique.
- **Limits.** `oldText` up to 2,000 characters, `newText` up to 2,500 (it may be empty, to delete a passage), and the patched skill up to 8,000. A patch that changes nothing is refused, and so is one whose `newText` already appears in the skill (unless it is part of `oldText`): either it was applied already or, where `newText` contains `oldText`, approving it again would apply it twice.
- **Personal data.** `newText` goes through the same deterministic PII filter as new skills (emails, phone numbers, card and ID numbers, keys and tokens, IP addresses). A new skill is redacted; a patch that trips the filter is refused, because a placeholder in the middle of a precise replacement would land in the skill as-is. The filter is pattern-based and does not catch names or free-text personal details.
- **Version check.** The proposal records the sha256 of the skill content it was made against. On approval the skill row is read with `FOR UPDATE` in the approving transaction, and the write itself only applies while the content is unchanged and the lock unset; if the content changed since (another patch was approved, the owner edited it), or the owner has edited it, the approval is refused with `409` (`code: "stale"` or `"locked"`) and the proposal stays pending for you to reject. Nothing is merged or rebased. A patch takes no `name` or `systemPrompt` override (`400`, `code: "override"`).
- **Shown at once.** A patch is never a candidate, never merged with another proposal and never counted by the caps; an identical patch is not filed twice (above).
- **Review.** Patches appear on **Skills → Proposals** with a `→ patch` badge, the reason and a line diff of the skill as it reads now against the skill with the patch applied (three lines of context), so whitespace and in-line changes show as changed lines. A patch whose skill changed since is flagged stale up front and shows only its passage; `GET /api/skills/proposals` adds `currentContent` and `stale` to patch rows. The collapsed section shows the whole skill as it would read after approval. `/proposals` in chat and the TUI lists them the same way. A refused patch shows in the check's receipt as `skill_patch: refused` with the reason; it does not fail the check.

### The owner-edit lock

`skills.owner_edited_at` is set when the owner writes a skill **in person**: creating it (`POST /api/skills`), editing it (`PATCH /api/skills/:id`), importing it, or approving a proposal with their own name or text. In person means a `user` principal on a login session — the web or mobile app — that owns the skill. These do not count: a request on an API token (scripts, and CLI agents, whose MCP bridge calls the API with one), the MCP server's own password login, an admin impersonating the user, and an admin editing someone else's skill. A skill with the lock set is never changed automatically:

- no patch proposal is filed against it, and a patch filed before the edit is refused on approval (`locked`);
- approving a new-skill proposal whose name matches it no longer overwrites it (`409 locked`); approve it under another name instead;
- the curator never archives it.

The lock covers learning and approval paths only. Agents neither set it nor are blocked by it: the in-process `update_skill` tool and a CLI agent's update through the MCP bridge leave a learned skill learned, and an agent asked in a turn to edit a skill still can. There is no unlock: a locked skill stays locked until it is deleted. A script that edits skills with a personal API token does not lock them; edit in the app to lock one.

Existing skills were not locked when the lock was added: nothing recorded until then tells a skill the owner wrote from one they approved (under another name, or merged into), a wrong lock is permanent, and a missing one costs at most a patch proposal you can reject. An existing skill locks on your next edit. Approvals now record the skill they created, merged into or patched (`skill_proposals.promoted_skill_id`).

### Usage and stale skills

`usage_count` and `last_used_at` count a skill as used when its body is loaded: the `get_skill` tool, `GET /api/skills/:id` (the MCP server's `get_skill`) and full-content injection (required and selected skills, topic skills). A one-line entry in a role's skill index is no longer counted: every skill of a role was listed on every spawn, so the index made any assigned skill look used today. Counts are debounced and may lose a few ticks on a crash.

There is no cap on the number of learned skills and no eviction when one is added. The skill curator (`runSkillCurator`) now runs once a day, as part of the [daily learning maintenance](#consolidation-and-daily-maintenance); until this release nothing scheduled it. One run covers every user of the install:

- It inspects up to 100 skills that are not archived, not system skills and not locked by an owner edit, and were last used more than 30 days ago. A skill that has never been used is measured from its creation date instead. The least recently used (or oldest never-used) come first.
- It **archives** those last used, or for a never-used skill created, more than 90 days ago. A skill younger than 90 days is never archived.
- It "flags" the others (30 to 90 days). A flag is only counted in the log line; nothing is stored or shown.
- Skills you wrote but that carry no lock are treated like learned ones: the lock is set only by an edit in person in the app (above), not by scripts or API tokens, and skills that existed before the lock was added are not locked.
- An archived skill keeps its row and gets `archived_at` and `curation_notes` (`auto-curator: <reason>`). It is no longer injected for its topics, offered as a patch target, or matched by proposal deduplication. No route or page unarchives a skill; clear `skills.archived_at` in the database to restore one.

## Offer to distil a finished task

After a turn that was both complex and successful, the web chat shows a strip above the composer: "That took several steps. Save how it was done as a skill?" with **Distil into a skill**, **Don't ask again** and **Not now** (×). It is decided when the turn ends, from what the run already recorded; no model is called to decide, and nothing is distilled until you accept.

**Accepting** runs the same distillation as `distill_skill`: one call to the background model, then filing with the usual deduplication, merge and rejection suppression ([Filing](#filing-drop-merge-or-new)). The material is the run itself: its messages from the request to the answer (each cut at 12,000 characters) and the names of the tools it used, in order of first use. The source is `session:<id>`, so it counts as that session in the proposal's session count. Like any `distill_skill` request the proposal is pending at once, and you still approve or reject it on **Skills → Proposals**. When the distillation fails (no background model, a malformed or truncated reply, the `skill-distill`/`distill` permission denied), the strip says why and the offer stays open, so you can retry. An ASK on that permission is answered by your click.

**Not now** closes the offer; **Don't ask again** closes it and turns the offers off for you (`preferences.distillNudge: false`; back on under **Settings → Profile**). Every offer takes exactly one decision, stored on the answer it follows (`messages.metadata.skillNudge`: `offered`, then `accepted` with the proposal id, or `dismissed`), so the same run is never offered twice. An offer you leave alone lapses when the next answer arrives.

**When a run is offered.** All of these, in this order (the first that fails is logged at debug as `Distil offer skipped` with its reason):

| Rule | Read from |
|---|---|
| `learning.distillNudge` is on | config |
| A person asked: trigger `user`, not a hook, cron, heartbeat, monitor or webhook turn, not voice (spoken, read aloud, `mobile-voice`) | the turn |
| The client can show the offer: it listed `skill_nudge` in `chat.send` `renders` (the web chat does; `/api/chat` may) | the turn |
| Not a one-shot request, not a Companion briefing or supervisor input, not a room, group thread or space session, not a session that keeps no content | the turn |
| It answered (`success`), was not refused by a spend budget or quota, and the output guard did not replace or withhold the answer | the turn |
| You have not turned the offers off | `users.preferences` |
| Complex: at least `learning.distillNudgeMinDistinctTools` (3) different tools, and either `learning.distillNudgeMinToolCalls` (8) tool calls or a delegation (a child agent's event, `spawn_child`, `create_pipeline`) | the run's `agent_events` (by run id, children included) |
| The checks recorded during the run passed: the latest verdict of each check (kind, stage, node); no evidence leaves it to the outcome | `verification_evidence` of the session since the run started |
| No skill was used: none was injected in full (selected, required or topic skills), loaded with `get_skill` in-process or through the MCP bridge | the skill registry, the run's events |
| The run did not call `distill_skill` itself | the run's events |
| None of your open (pending, candidate) or rejected and still suppressed proposals came from this session (`session:<id>` or `learning:<job>:session:<id>` in its sources) | `skill_proposals` |
| Your cool-down is free: at most one offer per `learning.distillNudgeCooldownHours` (24); only an offer that is made takes it | `kv_store` key `learning:distill-nudge:<user>` |

Time spent is not a signal, for the same reason the learning checks count tools: on a slow local model every turn takes long. Before a distillation nothing about the run's topic is known, so a run on the topic of a proposal from another session is still offered; filing then merges it into that proposal or drops it as suppressed, as for any `distill_skill`. The thresholds are defaults chosen when the feature was written, not calibrated.

**Other surfaces.** Only a client that says it can show the offer gets one, so the terminal UIs, the messaging channels, MCP clients and voice get nothing, and their turns do not use the cool-down. There is no chat command for it; in any channel you can ask the agent to distil the conversation into a skill, which calls `distill_skill`.

**API.** `GET /api/sessions/:id/distill-nudge`, `POST /api/sessions/:id/distill-nudge/:messageId` (`{decision}`) and `PUT /api/auth/distill-nudge` ([API](API.md#skill-proposals)). The owner of the session only, never while an admin acts as the user. The live answer also carries `skillNudge: { messageId }` on the `chat.response` result. The offer is made with `Distil offer made` (info: run id, session, the signals).

## The life of a skill proposal

A skill proposal comes from a learning check (a *learned* proposal, `sourceRef` `learning:<job>:session:<session>`) or from `distill_skill`, which you or an agent call on purpose (`text`, `session:<id>` or `trajectory:<id>`). Patches to learned skills are proposals too but follow only the rules in [Repairing a learned skill](#repairing-a-learned-skill).

### Statuses

| Status | Meaning | Shown on **Skills → Proposals** and in `/proposals` |
|---|---|---|
| `candidate` | Filed, waiting until it has recurred or a cap frees up. | No; counted under **Not shown yet (N)** on the page |
| `pending` | Waiting for your decision. | Yes |
| `merged` | Folded into another proposal (`mergedIntoId`). Cannot be approved or rejected itself. | No |
| `promoted` | Approved: the skill it created, updated or patched is `promotedSkillId`. | No |
| `rejected` | Rejected; the same skill is not filed again for 90 days (`rejected_until`). | No |

You can approve or reject a candidate directly (the page's **Not shown yet** section offers **Show now** and **Reject**; the API accepts approve too). Rejecting a proposal also rejects, with the same `rejected_until` and in the same transaction, every proposal that was merged into it, so their names stay suppressed as well.

The page and `GET /api/skills/proposals` list pending proposals with the most observations first, then oldest first (before this release: oldest first). `/proposals` in chat and the TUI uses a stable order instead: oldest shown first (`surfaced_at`, or `created_at` when it has none), then oldest filed, then id. A proposal keeps its number when counts change or proposals are added, so `/proposals approve <n>` names the row you read; a proposal approved, rejected or merged away between the list and the command still shifts the rows after it. The list adds `×N` after a name seen more than once. The page adds "seen N× in M sessions", "similar to skill X (NN%)" when a live skill's similarity is at or above `relatedSimilarity`, a select-all box with **Reject selected**, and **Merge into…** on each non-patch card.

### Filing: drop, merge or new

Filing a skill decides, cheapest check first:

1. **Same name.** The name is normalised (lower case, runs of other characters as `-`) and fingerprinted per user. If your latest proposal with that fingerprint is pending or a candidate, the new one is merged into it. If it was rejected and is still suppressed, the new one is dropped. If it was merged, the proposal it was merged into is checked the same way (one hop). If it was approved, filing goes on to the next step.
2. **A live skill covers it.** A non-archived skill of yours, or a system skill, with the same normalised name, or with an embedding similarity of name and description at or above `learning.duplicateSimilarity` (0.85): dropped, and the result names that skill.
3. **Your other proposals, by meaning** (non-patch only, compared by their stored embeddings, all of them, not a recent subset):
   - a rejected, still suppressed proposal at or above `duplicateSimilarity`: dropped. Before this release a rejection suppressed only the same name;
   - the learning reviewer's `extends` names one of your open proposals: merged into it (this needs no embedding);
   - the nearest open proposal at or above `duplicateSimilarity`: merged into it;
   - the nearest open proposal from `learning.relatedSimilarity` (0.70) up to `duplicateSimilarity`: the merge model decides; if it answers that they are different skills, or cannot judge (below), a new proposal is filed.
4. Otherwise a new proposal is filed.

If the proposal chosen in step 1 or 3 is approved, rejected or merged away while the observation is being merged into it, filing decides once more against its new state (now covered by the live skill, suppressed, redirected, or new). A second such race fails the filing with an error.

Every decision is logged as `Skill proposal dedup decision` with `{decision, similarity, against}`, which is the data the thresholds can later be calibrated on. The thresholds are defaults chosen when the feature was written; they have not been calibrated against real proposals. Vectors from an earlier embedding model (another dimension) are skipped, not compared.

Embeddings are filled in automatically. Before each comparison, up to 20 skills whose `description_embedding` is missing or out of date, and up to 20 of your open or still suppressed proposals without an `embedding`, are embedded; the daily consolidation embeds all of them. Until this release only the manual `npm run db:backfill-skill-embeddings` wrote skill embeddings, so semantic comparison against learned skills never matched. Without an embedding model only the name checks and `extends` work.

### Merging

A merge makes one call to the **background** model with both texts. It answers `merged` (the incoming observation adds steps, gotchas or corrections: a new description and draft are written, and the old draft is kept as `previousDraft`, which the page shows as a diff under **Updated by a merge**), `unchanged` (nothing new: the text stays), or, only in the related band, `distinct` (nothing is written). The merged draft goes through the PII filter and is cut at 8,000 characters. The proposal's name and fingerprint never change.

`merged` and `unchanged` both count the observation: `exemplarCount` goes up by one (by the absorbed proposal's own count when two proposals are merged), the source is appended to `sourceRefs` (newest last, the latest 50 kept), `lastExemplarAt` is set, and `signal` keeps the stronger of the two (`correction` over `recovery` over `procedure`). `sourceRef` stays the first source.

When the background model is not bound, fails, or returns truncated or malformed output, what happens depends on why the two were matched:

- Same name, `extends`, or similarity at or above `duplicateSimilarity`: the merge falls back to counting. The counters and sources change, the text does not, and the result says so (`mergeDegraded`; in a consolidation report `degraded`). The same count-only merge happens when another merge changed the draft while the model was answering, so that merge's text is not overwritten.
- The related band: only the model's verdict could make them one skill, so they stay separate. Filing files a new proposal; consolidation leaves the pair apart for this run (not counted in `degraded`) and asks again on its next run.

### What counts as a session

The session count of a proposal (`sessionCount`, "seen N× in M sessions" on the page) is the number of distinct sources in `sourceRefs`: every `learning:<job>:session:<id>` and `session:<id>` counts by its session id, and every other ref (`text`, `trajectory:<id>`) counts as one source of its own. Two checks of the same session therefore count once; two `distill_skill` calls on pasted text also count once (`text`). Only the latest 50 refs are kept, so a proposal seen more than 50 times may count fewer sessions than it had.

### When a candidate is shown

A new proposal is pending at once when you asked for it (`distill_skill`), when its signal is `correction`, or when `learning.recurrenceSessions` is 1. Any other learned proposal starts as a candidate. A candidate becomes pending when a merge brings its session count to `recurrenceSessions` (2) or its signal to `correction`, as long as neither cap is reached:

- `learning.maxSkillProposalsPerDay` (2): learned proposals that became pending in the last 24 hours, per user, counting those approved, rejected or merged since;
- `learning.maxPendingSkillProposals` (10): your pending non-patch proposals of any origin.

A learned proposal that would be pending while a cap is reached is filed, or stays, as a candidate; it is reconsidered at its next merge and by consolidation. Patches never count towards either cap.

When you merge a pending proposal into a candidate by hand, the candidate becomes pending regardless of the caps: the topic was already in front of you. (Consolidation never does this: it keeps the pending one.)

**Show now** on the page (`POST /api/skills/proposals/:id/surface`) makes a candidate pending at once, without the gate or the caps. It then counts towards the day's cap like any learned proposal surfaced that day.

What `distill_skill` bypasses: the gate and both caps. A request that ends in a new proposal is pending at once; one that is merged into a candidate makes that candidate pending at once (`surfaced_at` set), however many sessions it was seen in. The tool's result then ends with "It is now shown for review." A shown proposal surfaced this way is a learned one when its first source was a learning check, so it counts towards that day's cap for later learned proposals.

### Consolidation and daily maintenance

Consolidating one user's proposals:

1. Brings that user's proposal embeddings, and all skill embeddings, up to date.
2. Merges the user's open (pending and candidate) non-patch proposals pairwise, most similar pair first: a pair at or above `duplicateSimilarity` is merged; a pair in the related band is merged only when the merge model says they are one skill. A pair it calls different, or cannot judge, is not asked again in that run and costs nothing of the run's merge budget; the next run asks again. The proposal kept is the pending one; between two pending ones the one with more observations; otherwise the older. The other becomes `merged`. At most 20 proposals are absorbed per run; run it again for more.
3. Deletes candidates whose `lastExemplarAt` is older than `learning.candidateTtlDays` (30) and that never qualified (not seen in `recurrenceSessions` sessions, no `correction` signal), together with the proposals merged into them. A candidate that already qualified and is only waiting for room under a cap is kept, however long it waits. Deletion happens only here, not when a proposal is filed.
4. Shows the remaining candidates that qualify, oldest first, until a cap is reached.

It returns `{merged, expired, promoted, embedded, degraded}`. **Consolidate now** on the page runs it for you and prints the report as a sentence; `POST /api/skills/proposals/consolidate` does the same and only ever touches the caller's own proposals, admins included. Without an embedding model step 2 merges nothing; steps 3 and 4 still run.

The **daily learning maintenance** runs consolidation for every user with open proposals and then the skill curator ([Usage and stale skills](#usage-and-stale-skills)). The server ticks every hour, the first time one minute after start, and runs it when the last completed run finished at least 24 hours ago. A run is claimed with one conditional write to `kv_store` (`learning:maintenance:last-run`) that holds a 2-hour lease, so several server processes on one database run it once between them; when it finishes, the finish time is recorded and the next run is due 24 hours later. A run cut short by a restart is retried once the lease has expired, about 2 hours after it started. A user whose consolidation fails, or a failing curator, is logged and the rest goes on.

If the process dies while two proposals are being merged: the absorbed proposal is marked `merged` first and its count is added to the target after the model answers. Dying in between leaves it merged into a target that lacks its count and sources (an undercount); it is not shown twice or counted twice, and its name still redirects to the target. A merge of a newly filed skill writes the count in one transaction after the model call, so dying before that loses the observation. This follows from the order of the writes; no test simulates a crash.

### Tuning

| To | Change |
|---|---|
| see learned proposals without waiting for a second session (turn the gate off) | `learning.recurrenceSessions` to 1 |
| require more recurrence before a proposal is shown | `learning.recurrenceSessions` up |
| see more or fewer learned proposals a day | `learning.maxSkillProposalsPerDay` (0: none appear on their own) |
| allow a longer open list | `learning.maxPendingSkillProposals` |
| review more or less often | `learning.reviewEveryToolCalls`, `learning.minReviewIntervalMinutes` (0: no interval) |
| merge more or less eagerly | `learning.duplicateSimilarity`, `learning.relatedSimilarity` |
| keep unseen candidates longer | `learning.candidateTtlDays` |
| offer to distil finished tasks more or less often | `learning.distillNudgeMinToolCalls`, `learning.distillNudgeMinDistinctTools`, `learning.distillNudgeCooldownHours`; `learning.distillNudge` off for none |

An admin changes these under **Settings → Configuration → Agent & Root agent → Learning**, or with `PUT /api/settings/learning.<name>` and body `{"value": …}`. They apply to the whole install, take effect without a restart, and are checked against the bounds in [CONFIGURATION.md](CONFIGURATION.md#learning-config). There is no environment variable for them. Per proposal you also have **Show now**, approve or reject on a candidate, **Reject selected**, **Merge into…** and **Consolidate now**.

### After upgrading

- Migration `0197_skill_proposal_consolidation` adds the `candidate` and `merged` statuses and the columns `embedding`, `source_refs`, `signal`, `previous_draft`, `merged_into_id` and `surfaced_at`. It sets `source_refs` to the existing `source_ref`, `surfaced_at` to `created_at` for pending proposals (so those created in the last 24 hours count towards the day's cap), and `exemplar_count` to 1 where it was 0.
- Existing pending proposals stay pending; nothing already shown is hidden. They have no embedding until one is computed. Press **Consolidate now**, or wait for the daily run, to merge the backlog: at most 20 merges per run, so a large backlog may take several presses. New learned proposals from now on start as candidates.
- Needs an embedding model: merging by meaning (filing and consolidation), suppression of rejected proposals by meaning, "similar to skill X" on a card, the nearest skills and proposals in `existing`, and the nearest learned skills as patch targets.
- Needs a background model: the learning checks themselves, a merge that rewrites the text, and any merge in the related band. Without it, other merges only count.
- Works without either: name matching, `extends`, the recurrence gate, the caps, candidate expiry, promotion, **Show now**, approve, reject, bulk reject and manual merge (count-only without the background model).
- The skill curator now runs daily, first about a minute after the server starts. It archives non-system skills without an owner-edit lock that were last used, or if never used created, more than 90 days ago, across all users ([Usage and stale skills](#usage-and-stale-skills)). There is no route or page to unarchive a skill.

## Visibility

The chat inspector's **Learning** disclosure lists the latest 30 checks, reasons, output IDs and partial failures. It does not add chat messages. Authenticated session-scoped `GET /api/sessions/:id/learning` exposes the same receipts; `POST` queues a manual check and requires chat scope. Raw evidence is not returned by this API. Completed/error/interrupted jobs also appear in the existing away digest.

Checks created after deployment run automatically; existing long sessions can be reviewed using **Check recent work**. Existing skill proposals and patches still need approval on the Skills page.

In the Notes navigator, unpinned `session-learning` notes appear in a collapsed
**Session learnings** group below ordinary notes. Search and explicit tag filters
show matching learning notes normally. A user pin keeps a learning visible, and
the automatic tag is listed after ordinary tags regardless of its count.

Note listing prioritizes pins and ordinary notes before automated learnings
before applying the page limit. Selecting a tag queries that tag on the server,
so a large automated collection cannot hide older user notes from the first page.
