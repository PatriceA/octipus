# Daily-Driver Gaps — Plan

**Status:** Phases 0, 1 and 3 shipped 2026-09-05 (#328, #329, #330); Phases 2, 4 and 5 shipped 2026-09-06 (#331, #332, and the PR after it); phase 6 and the enterprise track are planning only
**Created:** 2026-09-05
**Scope:** What a developer / product owner / technical consultant needs before
Octipus can run their working day, ordered by what blocks that first. Written
after a read of the whole tree (tools, roles, memory, tasks, hooks, web routes,
the roadmap) against three questions: *does it tell me what to do, does it help
me process and analyse, and does the work land where I keep it.*

Read `DESIGN.md` first. Every item below reuses an existing primitive where one
exists and names the file; the argument for a new one is inline.

---

## 0. Where the product stands (verdict)

The runtime is further along than the daily surface. Budgeted swarms,
checkpointed pipelines, evidence gates, multi-tenant isolation and the eval
harness are real and tested. What a working consultant touches each morning is
thin: the proactive loop is off, work that other features produce does not
reach the backlog, the two roles a PO and a developer lean on are under-tooled
for their own prompts, and memory did not know which client it was talking
about. Those four were small enough to fix at once — that is Phase 0.

## Phase 0 — shipped in this PR

| Gap | What changed | Files |
|---|---|---|
| Memory ignored the workspace column | `MemoryAccessScope.workspaceId`; `retrieveTop` and `searchSimilar` filter `workspace_id ∈ {NULL, current}` (same rule as `workspaceFilter` in `scoped.ts`); the root turn, the plan path and every worker pass the workspace; the judge dedupes within it. No workspace context → no filter (pre-scoping behaviour), so nothing is silently hidden. | `src/core/memory/repository.ts`, `judge.ts`, `src/core/agent/service.ts`, `worker-spawner.ts`, `repository.test.ts` |
| Reader / email / research never produced tasks | One producer module with pure builders + one DB write: `readerItemsToTasks`, `emailToTask`, `researchFollowUpTask`, `createTasksFromSource`. Routes `POST /api/reader/tasks`, `POST /api/email/message/:id/task`; Deep Research creates one *Review research* task per run. Buttons on the Reader and Email pages; link on the Research page. `TaskSourceRef.documentId` added. | `src/core/tasks/sourced.ts` (+test), `src/api/routes/{reader,email}.ts`, `src/core/research/jobs.ts`, `web/app/{reader,email,research}/page.tsx` |
| `pm` could not read or write a backlog; `coding` could not open a PR | `pm` gains `tasks`, `knowledge`, `github`; `coding` gains `github`. Prompts (full + lite) tell each role when to use them; `review` stays read-only on purpose. | `src/core/agent/roles/{pm,coding}/*`, `docs/TOOL-ROUTING.md`, `docs/AGENT-ARCHITECTURE.md` |
| No proactive turn on by default | One seeded, enabled `schedule` hook per user at registration — **Daily Briefing**, weekdays 08:00, integration-agnostic prompt (to-dos + notifications always; calendar / mail / GitHub only when connected; ends with "Next three"). `POST/DELETE /api/hooks/briefing` for earlier users. The old *Morning Briefing* suggestion is retired. | `src/core/briefing.ts` (+integration test), `src/api/routes/{auth,hooks}.ts`, `src/hooks/suggestions.ts`, `docs/HOOKS.md` |

Not done in Phase 0, on purpose: the briefing has no timezone UI (the hook is
editable on the Hooks page; the API accepts `timezone`); tasks created from
email are not deduplicated against an earlier task for the same message.

---

## Phase 1 — "tell me what to do" — SHIPPED (2026-09-05)

What each item became, and what the per-step review changed:

1. **Next-action ranking.** `rankTasks` in `src/core/tasks/rank.ts` — overdue →
   due today → high priority → inbound from email/research/reading (48h) →
   due this week → backlog — with a one-line reason per task. Shared by
   `list_tasks` (view `next`), `GET /api/tasks?view=next`, the tasks page's
   default grouping, and the Daily Briefing. Review caught two real bugs: the
   scoped list's priority-ordered 200-row cap could hide a low-priority
   overdue task (the view now scans wide), and "today" was the server's
   calendar day (now the user's: browser zone → saved preference → UTC, with
   DST-exact boundaries). A bare `YYYY-MM-DD` due date is now the end of that
   day in the user's zone rather than UTC midnight.
2. **Inbox page.** `/notifications`, filters applied in SQL (`?unread=1`,
   `?type=`) so paging is over the filtered set; links to the agent, pipeline
   or chat behind each row; react-query key shared with the header bell.
   Nothing pushes notifications to the browser, so the page polls — the first
   cut listened for an event nobody dispatched.
3. **Away digest.** `src/core/digest/away.ts` folds finished/failed agents,
   pipelines finished or waiting, pending approvals, sourced to-dos and the
   unread notifications that arrived in the window. Dashboard card with
   "caught up"; `GET /api/digest/away`; prepended to any `spawn_agent` hook
   with `awayDigestHours` (the seeded briefing uses 24, and rows seeded before
   the change are brought forward). It reads `agents` / `pipelines` / `tasks`
   directly rather than folding `run_events` as first planned: the state
   tables already carry the per-user answer and `run_events` has no user id.
4. **Heartbeat probes.** `src/core/heartbeat-probes.ts`: open PRs with red
   checks (one cross-repo GraphQL search, drafts excluded) and calendar events
   starting within the lookahead window (Google and Microsoft). Two rules
   from review: the server's `gh` is the operator's identity, so the GitHub
   probe runs only for admins (a per-user credential is enterprise-track E2);
   and a red PR has no "done" a user can click, so each hook keeps a seen set
   and only a new item wakes it. Still off by default.

## Phase 2 — a backlog, not a list — SHIPPED (2026-09-06)

1. **Task structure** (migration 0093): `parent_id` (self-FK, `ON DELETE SET
   NULL` — deleting a phase frees its children), `blocked_by uuid[]`,
   `estimate text`, and a fourth status, `in_progress`. The rules that make
   the columns mean something live in `src/core/tasks/structure.ts`, pure and
   shared with the web bundle: only an *active* blocker blocks (a done or
   deleted id in the array is inert, so nobody rewrites arrays when a task
   completes); a parent with active sub-tasks is *waiting* the same way a
   blocked task is; nesting is a view over flat rows. The scoped repo checks
   every parent and blocker for ownership (a foreign id is "not found"),
   refuses self-links and parent loops. The ranker gains two buckets:
   *In progress* first (finish what is started), *Waiting on other tasks*
   last, judged against the whole active set — so `nextActions` now ranks
   everything and filters by category afterwards, or a blocker in another
   category would look inert. `list_tasks` defaults to active tasks, nests
   `children` and says why a task is `waiting`; `status: "all"` is explicit.
2. **Board view.** `/tasks` has a list | board toggle (remembered per browser).
   The board is one column per status (Open, In progress, Done — archived
   stays out of the way, as in the list), category lanes inside each column
   so a plan's phases read as rows across it, HTML5 drag between columns with
   arrow buttons for keyboards, and cards carrying estimate, sub-task progress,
   due date and the waiting reason. The list nests sub-tasks under their
   parent within a group and shows `[>]` for in progress.
3. **PM deliverables → backlog.** Not a parser over the pm's markdown and not
   the pipeline `plan` tool either — that tool is scoped to the running
   pipeline's `plan_items`, which is a different table with a different owner.
   What was reused is its *shape*: `tasks__add_tasks` takes the same
   `{ title, detail }` items plus `category` (the phase; children inherit
   it), `estimate`, `priority`, `dueAt`, `blockedBy` (another item's title,
   its `#n` position, or an existing task id) and `children`. Parsing is pure
   (`src/core/tasks/backlog.ts`) and validates every reference before a row
   is written; a dependency that resolves to nothing fails the call. The pm
   prompts now write plans through it and mark tasks `in_progress` on start.

Not done in Phase 2, on purpose: no drag-to-reorder within a column (order is
still the ranker's or the list's); no board lane for archived tasks; the
board does not nest cards (a sub-task is a card that names its parent).

## Phase 3 — durable background work — SHIPPED (2026-09-05)

`pipeline_checkpoints` + the boot sweep were the model; the two lighter kinds
of work now follow it.

1. **`background_jobs`** (`src/db/schema/background-jobs.ts`, migration 0092):
   one row per research run or document going through extraction — `kind`,
   `status` (`queued` → `running` → `done` | `error` | `interrupted`), `stage` /
   `detail` as the progress line, `payload` for what the worker needs, `result`
   for what the poller wants back, `result_ref` for the durable thing the run
   produced. The row is the queue: `claimNext` takes the oldest `queued` row of
   a kind under `FOR UPDATE SKIP LOCKED`, so a second process cannot run the
   same document twice. Not written through `kv_queue` as first sketched — a
   second table holding the same fact (what is waiting) would have meant two
   writes per job and a reconcile between them; one table with a locked claim
   is the same durability with nothing to keep in step.
2. **Research jobs.** `startResearch` writes the row as `running` and reports
   stages into it; `GET /api/research/:jobId` reads it back through the scoped
   repo, same shape as before. A run the restart killed reads as `error` with
   "Interrupted by a restart" rather than a 404.
3. **Document queue.** `enqueue` is a row; the worker drains rows it did not
   enqueue itself, which is how an upload survives a restart (`resume()` at
   boot after the sweep). A document whose extraction failed is now a failed
   job with the document's own error — the old queue emitted `completed`
   regardless, because the processor swallows its errors.
4. **Boot sweep** (`src/core/jobs/recover.ts`): `running` → `interrupted`
   (never auto-resumed — the pipeline rule), the document behind an
   interrupted job marked `failed` with the reason, terminal rows pruned after
   thirty days.
5. **Away digest** gains a `jobs` section — failures and interruptions with
   the "needs you" sections, finished runs with the finished ones — on the
   dashboard card, in the briefing block and in the markdown rendering.

Found while writing the claim: an `UPDATE … WHERE id IN (SELECT … LIMIT 1 FOR
UPDATE SKIP LOCKED)` claimed more than one row under PGlite — the semi-join
rescans the subquery per candidate. `id = (subquery)` is planned once and is
the shape `kv_queue`'s pop already used.

## Phase 4 — the developer loop — SHIPPED (2026-09-06)

1. **GitHub depth.** The `github` tool gains the reads a reviewer needs and
   the writes a coder answering a review needs: `pr_diff` (unified, or files
   only; capped), `pr_review_threads` (GraphQL: file, line, resolved state,
   comments, thread id), `pr_review_comment` (a line comment on the head
   commit, or a reply inside a thread), `pr_resolve_thread`, `pr_checks`
   (tolerates gh's "pending" and "failed" exit codes — the JSON is the
   answer either way), `job_log` (the *tail* of a job or a run's failed
   steps; CI logs are megabytes and the failure is at the end), `label_list`
   / `set_labels`, `milestone_list` / `set_milestone`. Every id and repo is
   validated before it reaches `gh` (`assertNumber` rejects `"7; rm"`, which
   `parseInt` would have read as 7). The review prompts list the new reads
   as allowed and the new writes as forbidden; the coding prompts describe
   the loop: threads → fix → reply with the commit → resolve.
2. **Review-response loop.** Not a backward edge after all: QA's `qa_fail`
   edge still targets Implementation (re-reviewing an unchanged tree was the
   argument, and it holds). What was missing was the stage the read-only
   reviewer's findings reach. *Address Review* is a `coding` stage between
   Code Review and QA in the loop body, with `github`: it lists the
   actionable findings, adds the open PR threads when the work is on a PR,
   fixes, runs the checks for what it touched, commits, replies in each
   thread and resolves it. It declares neither `producesArtifacts` nor
   `runsCommands` on purpose — a clean review is a legitimate no-op, and
   either flag would fail the stage for having nothing to do; QA, next,
   proves the tree still holds.
3. **Repo map.** `workspace_repos.symbol_index` (migration 0094) holds
   top-level declarations per file — functions, classes, interfaces, types,
   enums, structs, traits, modules, constants, and members as
   `Owner.member` — with line numbers and an exported/public flag where the
   language has one. Parsed at scan time with the tree-sitter grammars the
   TUI already ships (TypeScript/TSX/JS, Python, Go, Rust, Java), through a
   grammar loader now shared with the editor (`utils/tree-sitter-grammars`).
   Bounded: 2,500 files, 400 KB per file, 20,000 symbols, build and vendor
   directories skipped; a grammar that will not load skips its language
   instead of failing the scan. `get_repo` returns an *outline* (busiest
   files first, exported names, capped) and `find_symbol` searches the whole
   index (exact, prefix, then substring). The index is never sent to RAG.
4. **IDE reach.** The gateway now speaks its protocol over stdin/stdout as
   strict-LF JSON lines: `octipus --stdio` (or `GATEWAY_STDIO=1`) attaches
   the process's own stdio as one more connection to the same hub, so the
   auth deadline, rate limits, budgets and the event-visibility rule apply
   unchanged; logs move to stderr so the pipe stays clean; stdin's end shuts
   the process down. Lines are handled strictly in order. A VS Code
   extension stays out of scope; it now has a transport to sit on.

Not done in Phase 4, on purpose: no request-id correlation on the stdio
transport (the protocol has none on the socket either; replies correlate by
`sessionId` and event type); no incremental re-index (a scan rebuilds the
symbol index); no import-graph edges between files.

## Phase 5 — process and analyse — SHIPPED (2026-09-06)

1. **Data tools.** A `data` tool group the `data` role holds. `sql_query` runs
   one read-only statement against a database the user registered; `csv_query`
   runs SQL over a CSV, TSV or spreadsheet in the workspace, and returns the
   schema first when called without a query so the model does not have to
   guess column names. Read-only is enforced twice: a lexical guard
   (`core/data/sql-guard.ts`) that blanks strings and comments before scanning
   for writes, so a data-modifying CTE and a second statement after a
   semicolon are both refused with a message the model can act on, and a
   `SET TRANSACTION READ ONLY` transaction with a statement timeout that would
   refuse the write anyway. The connection is named, never pasted: the model
   passes a vault entry *name*, and only entries the user tagged `database`
   resolve — so the tool cannot be pointed at an API key or at a database the
   user did not mean to expose. `list_connections` shows what is available.

2. **Office output.** `documents.export_document` turns markdown into a `.docx`
   or its tables into an `.xlsx`, lands the file in the user's Documents as a
   `completed` row and returns a download URL. Roles that produce deliverables
   — `writing`, `research`, `data` and `general` — now hold the `documents`
   group, which no role previously did.

3. **PM connectors.** Jira and Confluence are named tools (`atlassian`) the
   `pm` role holds: sites, issue search by JQL, read / create / update /
   comment / transition, and Confluence search, read, create and update.
   Linear is a second `ConnectorDefinition`, which meant generalising the
   connector OAuth path — dynamic client registration, token storage, refresh
   and the HTTP routes were all written around the literal string
   `atlassian` in seven places. They are now definition-driven, so a third
   connector is a definition file and one line.

4. **Channel read.** `messaging.channel_history` and `channel_search`, behind
   a new `read` permission (ALLOW). Slack reads history, threads and replies
   on the bot token; Teams reads through the signed-in user's Graph token, so
   an agent sees exactly the conversations its user can see. Slack's wire
   markup is turned back into readable text with real names.

5. **Meeting notes + calendar into knowledge.** `notes.write_meeting_note`
   saves a meeting as a `note`-purpose note with an edge to every attendee —
   bound to their profile when one exists, left as a ghost that binds
   automatically when the profile is created later, including retroactively
   for meetings already recorded. `notes.import_calendar_meetings` creates one
   such note per calendar event around today, and never overwrites a note
   somebody has written into, so it is safe on a schedule. `last_verified_at`
   (migration 0096) is stamped when a chunk is written or re-confirmed, and
   retrieval multiplies its score by a bounded freshness factor — at most a
   40% penalty, reached at one year — so a stale fact ranks below a fresh one
   without ever being hidden. `verify_knowledge` is how a fact that is still
   true gets its standing back, and search results now report the age.

**Deviations from the plan above, and why.**

- **No new dependencies.** The plan named DuckDB for `csv_query` and the `docx`
  package for the Word export. Both would have been dependencies for something
  the tree can already do: `csv_query` loads the file into an in-memory PGlite
  (the embedded storage backend, already a dependency), which also means both
  data tools speak the same PostgreSQL dialect; the docx writer builds the
  OOXML package on `jszip`, already used to read pptx speaker notes. The
  export is verified by reading it back with `mammoth` — the same library the
  document processor uses to read Word files — so the test proves a real Word
  reader can open it, not merely that the XML is what we wrote.
- **Named connector tools resolve, they do not hard-code.** A capability
  declares candidate remote tool names and candidate argument names, and
  resolves against the connector's own `tools/list` at call time. Hard-coding
  `getJiraIssue` would make the tool group silently dead the next time
  Atlassian renames something; when nothing matches, the error names the tools
  that DO exist so the model can fall back to `connector_call_tool`.
- **Teams reads through Graph, not the bot.** `TeamsChannel` holds a Bot
  Framework credential and an in-memory map of conversations it has seen — it
  cannot read history at all. The `microsoft365` delegated token can, which is
  also the right privacy answer.
- **Slack search needs a user token.** Slack does not expose `search.messages`
  to bot tokens. `slack.userToken` is a new optional setting; without it,
  `channel_search` scans one named channel's history and says in the result
  that it did (`method: "scan"`) rather than returning an empty list as if
  nothing matched.
- **Attendees bind on an exact match only.** `profiles` has no email column,
  so an attendee is matched by an `email` fact or an exact name. A partial
  name match is refused: binding "Ada" to "Ada Lovelace" is a guess, and a
  wrong edge on a meeting record is worse than a ghost that resolves later.

Not done, on purpose: Linear has a definition and OAuth but no named tools
(the capability table it would need is the same shape as the Atlassian one);
`sql_query` speaks PostgreSQL only; the freshness decay is a fixed curve
rather than a per-purpose policy.

## Phase 6 — memory quality

Workspace scoping shipped. Still open: semantic recall was removed in favour of
access-count + recency (`retrieval.ts`); with per-workspace corpora now small,
reinstating a vector rerank inside the 250-token budget is cheap and safe.
Decide after measuring recall on the `recalls_memory` eval assertion.

---

## Enterprise track — the central connector

Sharing a to-do list or a note with a colleague is not a feature on the
`tasks` table. It is an **organisation** owning identity, content and policy,
with users inside it. Octipus already has the bones — `organizations`,
`org_members`, `workspaces` (`src/db/schema/organizations.ts`), SAML SSO and
SCIM (`src/api/routes/{saml,scim}.ts`), Postgres RLS, per-user DEKs, the
scoped-repository layer, quotas and audit — but every content table is keyed by
`user_id`, and org membership gates *admin*, not *content*. That is the
distance between "multi-user" and "a company runs on it".

This is a bigger, separate path — *Octipus goes enterprise* — and it should be
planned as one, not as a sharing flag bolted onto notes. The shape:

**The connector is Octipus itself in org mode**, not a second product. One
instance (or a hub instance in the federation plan's terms,
`docs/plans/workroom-and-swarm-federation.md` Part 2) becomes the
organisation's system of record for:

- **Identity and membership** — already SSO/SCIM; add teams (`org_teams`,
  `team_members`) because sharing is to a team far more often than to a person.
- **Content ownership** — `org_id` and a `visibility` column
  (`private | workspace | team | org`) on `tasks`, `notes`, `documents`,
  `pipelines`, `knowledge` chunks, `artifacts`. The scoped-repository filter
  gains one clause; RLS gains one policy per table. Sharing is then a write to
  `visibility` (or an `acl` row for one-off grants), never a copy.
- **Connectors configured once** — a Jira / Confluence / M365 / GitHub app
  registered by the org admin, with per-user consent stored in the vault under
  the user's DEK. Today every user wires their own OAuth client.
- **Policy** — `approval-policy.ts` already has `unattendedDenyActions`; the
  org sets it. Add egress rules (the open item in Wave 3) and per-team model /
  budget policy through `ModelRegistry` topic bindings scoped to the org.
- **Audit and retention** — the audit log and retention policies exist per
  user; the org reads them across users.

**Phasing.**
E0 · `org_id` + `visibility` on content tables, default `private`, no UI — a
migration and the scoped-repo clause. Nothing changes for a single user.
E1 · Share a note or a to-do list with a team; a shared list appears on the
recipient's `/tasks` with the owner's name. Team briefing = the daily briefing
over a shared list.
E2 · Org-level connector registry (`src/connectors/registry.ts` grows an
`orgId` and an admin-configured app per connector); per-user consent flow.
E3 · Policy and audit centre under `/admin` (`web/app/admin/*` exists).
E4 · Team surfaces: shared backlog board, org knowledge base with visibility,
approvals routed to a role rather than a person.

**What it is not.** Not a hosted service, not a break from local-first: a
single-user install stays exactly what it is (E0 is invisible without an org).
Federation (peer installs) and the hub (one org install) are complementary,
not competing — federation is how two hubs talk.

---

## Sequencing

Phases 0 to 5 are done. Phase 6 after measuring recall on the
`recalls_memory` eval assertion. The enterprise track opens with E0 as soon as
a second person shares one Octipus — E0 is one migration and should not wait on
E1–E4 being designed in full.
