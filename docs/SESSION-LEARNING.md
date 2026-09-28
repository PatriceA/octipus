# Learning from completed session work

Session learning runs through the durable `background_jobs` queue (`kind=learning`), using the configured **background** model. It does not require narrated CLI replies or call CLI subprocesses. New skills always remain proposals for review.

## Triggers

- Execution-plan steps newly marked done: one check per revision, even if several steps finish together.
- Full execution-plan completion: all steps done or skipped, with at least one done step. This replaces the final step check rather than adding a second check. Proposals, repeated status updates and stale writes do not trigger checks.
- Successful substantial turns: at least six recorded tool-result events, or at least two minutes with a recorded result. Work already covered by a check during the turn is excluded; substantial work after that milestone can trigger another check.
- **Learning → Check recent work** in the chat inspector: checks an existing session. Reuses a queued/running session check instead of piling up manual requests.

Plan saves and their queued checks share a database transaction. The worker polls every 15 seconds, claims jobs atomically and resumes queued work after restart. In-flight checks interrupted by restart are reported as interrupted, not silently declared successful or automatically replayed.

## Evidence and cost

A check uses evidence recorded at or before its trigger: up to eight chat messages, eight verification records and 100 execution events, plus the milestone's plan evidence. Excerpts are redacted and capped at 2,400 characters each within a 40,000-character total budget. Older records may be omitted. This is a recent-evidence check, not an exhaustive reread of multi-day vendor transcript files.

Claude/Codex tool-result excerpts already recorded by Octipus are included. Tool requests and plan/assistant success claims are labelled separately and cannot alone support a project lesson or skill. Every candidate must cite supplied evidence; personal memories may cite only user messages. The learning reviewer does not use the legacy per-turn extractor's English first-person heuristic.

One bounded review call produces project lessons, personal facts and at most one skill candidate. Empty output is valid. Background model errors, invalid/truncated output, missing evidence and failed writes have distinct receipts.

## Writes and isolation

- Project lessons become workspace-scoped, indexed notes with source references. Identical normalized content reuses its note. Notes saved without successful indexing are reported as partial failures.
- Personal facts use the existing memory judge and embedding-backed deduplication. `memory.extractionCadence=off` also disables personal memory writes from learning checks.
- Skills use the same semantic/exact deduplication and rejection suppression as manual `distill_skill`, then await human approval.
- Knowledge and skill writes recheck the corresponding tool permission. ASK and DENY cannot be approved by the background worker.
- Session ownership and workspace are checked before evidence is read. Unscoped sessions use the user's default workspace for saved learning, matching the agent's memory scope.

## Visibility

The chat inspector's **Learning** disclosure lists the latest 30 checks, reasons, output IDs and partial failures. It does not add chat messages. Authenticated session-scoped `GET /api/sessions/:id/learning` exposes the same receipts; `POST` queues a manual check and requires chat scope. Raw evidence is not returned by this API. Completed/error/interrupted jobs also appear in the existing away digest.

Checks created after deployment run automatically; existing long sessions can be reviewed using **Check recent work**. Existing skill proposals still need approval on the Skills page.
