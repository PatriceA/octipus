# Learning from completed session work

Session learning runs through the durable `background_jobs` queue (`kind=learning`), using the configured **background** model. It does not require narrated CLI replies or call CLI subprocesses. New skills and patches to learned skills always remain proposals for review.

## Triggers

- Full execution-plan completion: all steps done or skipped, with at least one done step. A single finished step is not a milestone. Proposals, repeated status updates and stale writes do not trigger checks.
- Accumulated work: once a session has recorded `learning.reviewEveryToolCalls` tool results (default 10) since its last check, or since it began, the next successful turn queues one. The count runs across turns, so many short turns earn one check and a long turn does not earn one per turn. Time spent is not counted: on a slow local model everything takes long.
- Not for one-shot sessions: a `POST /api/chat` with `oneShot: true` creates a session nobody returns to, and no automatic check is queued for it.
- **Learning → Check recent work** in the chat inspector (`POST /api/sessions/:id/learning`): checks an existing session on demand, one-shot or not. Reuses a queued/running session check instead of piling up manual requests.

When the background model is local (Ollama on a private endpoint), a queued check starts only after that provider has been idle for `learning.localIdleMs` (default 60 s), so a review never holds the GPU while a turn waits behind it. Remote models are checked at once.

Plan saves and their queued checks share a database transaction. The worker polls every 15 seconds, claims jobs atomically and resumes queued work after restart. In-flight checks interrupted by restart are reported as interrupted, not silently declared successful or automatically replayed.

## Evidence and cost

A check uses evidence recorded at or before its trigger: up to eight chat messages, eight verification records and 100 execution events, plus the milestone's plan evidence. Excerpts are redacted and capped at 2,400 characters each within a 40,000-character total budget. Older records may be omitted. This is a recent-evidence check, not an exhaustive reread of multi-day vendor transcript files.

Claude/Codex tool-result excerpts already recorded by Octipus are included. Tool requests and plan/assistant success claims are labelled separately and cannot alone support a project lesson or skill. Every candidate must cite supplied evidence; personal memories may cite only user messages a person typed (Companion handoffs, monitors, schedules, internal inputs and the plan brief are stored as user rows but are labelled as requests, not user evidence) and must carry a verbatim `quote` from one of them. A memory that cites anything else is dropped on its own with a `rejected` receipt; the review's lessons and skill are kept. An `expires` date is the end of that day in your timezone. The learning reviewer does not use the legacy per-turn extractor's English first-person heuristic.

One bounded review call produces project lessons, personal facts, at most one skill candidate and at most one patch to a learned skill. Empty output is valid. Background model errors, invalid/truncated output, missing evidence and failed writes have distinct receipts.

## Writes and isolation

- Project lessons become workspace-scoped, indexed notes with source references. Identical normalized content reuses its note. Notes saved without successful indexing are reported as partial failures.
- Personal facts are written only when their quote is found, server-side, in a cited message of yours in the session's current conversation ([where a memory comes from](RAG.md#where-a-memory-comes-from)); otherwise the receipt says `rejected` with the reason. Accepted facts then use the existing memory judge and embedding-backed deduplication. `memory.extractionCadence=off` also disables personal memory writes from learning checks.
- Skills use the same semantic/exact deduplication and rejection suppression as manual `distill_skill`, then await human approval.
- Patches to learned skills are filed as pending proposals (below). An identical patch that is pending or was already approved is not filed again, and a rejected one stays suppressed for 90 days (the same fingerprint check as skill proposals).
- Knowledge, skill and patch writes recheck the corresponding tool permission. ASK and DENY cannot be approved by the background worker.
- Session ownership and workspace are checked before evidence is read. Unscoped sessions use the user's default workspace for saved learning, matching the agent's memory scope.

## Repairing a learned skill

A check can also propose a **patch** to a learned skill instead of a second, overlapping skill: `{skillId, oldText, newText, reason, sources}`, where `sources` cites execution or verification evidence like any other candidate. Inspired by the learned skills of n8n's "nod", with one deliberate difference: nod saves a patch directly, Octipus files it for approval.

- **Which skills.** A *learned* skill is a DB skill of the session's owner that the owner has not written themselves (`owner_edited_at` is empty): typically one created by approving a proposal. The review is shown at most two of them: only skills whose body this session loaded — a `skill_load` event recorded by the in-process `get_skill`, or a CLI agent's `get_skill` call through the MCP bridge whose recorded arguments name the skill (Claude Code records them; a CLI that records no tool arguments offers no patch targets). A skill ID merely appearing in an event, such as a `list_skills` result, does not count. Each is at most 8,000 characters, together at most 12,000, taken out of the same 40,000-character input budget as the evidence, and redacted like other evidence. If they cannot be read the check goes on without patch targets. A patch naming any other skill is refused. System skills, mounted filesystem `SKILL.md` skills and other users' or org members' skills never take patches; edit those at their source.
- **Exactly one passage.** `oldText` must occur exactly once in the skill's current content, compared exactly (no whitespace, case or Unicode normalisation). No match and several matches are both refused; the reviewer has to quote enough surrounding text to make the passage unique.
- **Limits.** `oldText` up to 2,000 characters, `newText` up to 2,500 (it may be empty, to delete a passage), and the patched skill up to 8,000. A patch that changes nothing is refused, and so is one whose `newText` already appears in the skill (unless it is part of `oldText`): either it was applied already or, where `newText` contains `oldText`, approving it again would apply it twice.
- **Personal data.** `newText` goes through the same deterministic PII filter as new skills (emails, phone numbers, card and ID numbers, keys and tokens, IP addresses). A new skill is redacted; a patch that trips the filter is refused, because a placeholder in the middle of a precise replacement would land in the skill as-is. The filter is pattern-based and does not catch names or free-text personal details.
- **Version check.** The proposal records the sha256 of the skill content it was made against. On approval the skill row is read with `FOR UPDATE` in the approving transaction, and the write itself only applies while the content is unchanged and the lock unset; if the content changed since (another patch was approved, the owner edited it), or the owner has edited it, the approval is refused with `409` (`code: "stale"` or `"locked"`) and the proposal stays pending for you to reject. Nothing is merged or rebased. A patch takes no `name` or `systemPrompt` override (`400`, `code: "override"`).
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

There is no cap on the number of learned skills and no eviction when one is added. The curator (`runSkillCurator`) flags skills unused for 30 days and archives them after 90, least recently used first, skipping system and owner-edited skills; nothing schedules it yet, so it runs only when invoked.

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
