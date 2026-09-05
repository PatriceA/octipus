# Daily-Driver Gaps — Plan

**Status:** Phase 0 shipped (this PR); phases 1–6 and the enterprise track are planning only
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

## Phase 1 — "tell me what to do" (highest value per line)

1. **Next-action ranking on the to-do list.** A pure `rankTasks(tasks, now)`
   (overdue → due today → priority → source recency) used by `list_tasks`, the
   briefing prompt, and a `/tasks?view=next` API. No schema. Lives beside
   `src/core/tasks/sourced.ts`.
2. **Notification inbox page.** `notifications` exists server-side
   (`src/core/notification-service.ts`) with no route in `web/app`. One page,
   mark-read, link to the run or task. The heartbeat probe already counts these.
3. **"While you were away" digest.** Fold `run_events` since the user's last
   session (`GET /api/runs/:sessionId/events` exists per run) into one list:
   runs finished, approvals waiting, tasks created by agents. Render at the top
   of `/` and inject as the briefing's first section.
4. **Heartbeat probe sources.** Add "open PR with failing checks" and "calendar
   event in the next hour" to `src/core/heartbeat.ts`'s deterministic probe so
   the silent loop wakes for the two things a developer actually wants a nudge
   on. Still off by default.

## Phase 2 — a backlog, not a list

1. **Task structure.** `parent_id`, `blocked_by uuid[]`, `estimate text`
   (S/M/L/XL or hours — the pm prompt already speaks that language) on `tasks`.
   One migration; `tasks` tool gains the fields; `list_tasks` returns children
   nested.
2. **Board view.** `/tasks` gets a column view by status with drag; grouping by
   `category` (the "still open" item from the 2026-06-10 QA pass).
3. **PM deliverables → backlog.** The `pm` role's plan output is parsed into
   tasks (phase = category, task = row, dependency = `blocked_by`) through the
   `plan` tool rather than a second parser. Pipeline `foreach` over `plan_items`
   already exists — reuse its shape.

## Phase 3 — durable background work

`pipeline_checkpoints` + the boot sweep are the model; nothing else got it.

1. **Research jobs** (`src/core/research/jobs.ts`, in-memory `Map`, 30-min TTL)
   → a `background_jobs` row (`kind`, `status`, `stage`, `payload`, `result_ref`)
   written through `kv_queue`. The route polls the row; a boot sweep marks
   `running` rows `interrupted` (never auto-resumes — same rule as pipelines).
2. **Document processing queue** (`src/core/documents/queue.ts`, in-process
   array) → the same table.
3. Surface both in the away digest (Phase 1.3).

## Phase 4 — the developer loop

1. **GitHub depth.** `src/tools/github/index.ts` is a `gh` wrapper: add
   line-level review comments, check-run + job-log fetch, PR diff, labels and
   milestones. GitLab already has job logs; match it.
2. **Review-response loop.** `review` stays read-only; a `coding` stage that
   reads open review threads and pushes fixes, wired as the existing QA
   backward edge in the *Full Development Cycle* preset (`src/db/seed-presets.ts`).
3. **Repo map.** The registry has build/test/lint commands and a dependency
   graph but no symbols. A per-repo symbol index (tree-sitter is already a dep
   for the TUI) feeds `get_repo` so a worker reads the map before the files.
4. **IDE reach.** The gateway RPC-stdio adapter on the roadmap is the cheapest
   path; a VS Code extension is out of scope until it lands.

## Phase 5 — process and analyse

1. **Data tools.** `sql_query` (read-only, over a vault-held connection string)
   and `csv_query` (DuckDB-style over a workspace file) as one `data` tool
   group; the `data` role gets them.
2. **Office output.** The document processor reads docx/xlsx/pptx; nothing
   writes them. One `documents_export` tool (markdown → docx via the existing
   `mammoth` sibling `docx`, tables → xlsx via SheetJS already in deps) so a
   client deliverable can leave as a file.
3. **PM connectors.** The Atlassian remote MCP connector
   (`src/connectors/atlassian/definition.ts`) is generic `connector_call_tool`;
   promote Jira issues / Confluence pages to named tools the `pm` role holds,
   and add Linear as a second `ConnectorDefinition`. Notion/Asana wait for a
   user who asks.
4. **Channel read.** Slack/Teams adapters only reply when addressed. Add
   `channel_history` / `channel_search` tools behind the existing permission
   levels so "what did the team decide yesterday" is answerable.
5. **Meeting notes + calendar into knowledge.** Ingest calendar events and
   pasted / uploaded meeting notes as `note` purpose with the attendees as
   profile links; a freshness column (`last_verified_at`) on knowledge chunks so
   retrieval can down-rank stale facts instead of only deleting old ones.

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

Phase 1 and Phase 3 first: both are small, both make the existing features
visible, and Phase 3's job table is what the away digest reads. Phase 2 and 4
next, in either order, by who is asking. Phase 5 by demand, connector by
connector. The enterprise track opens with E0 as soon as a second person
shares one Octipus — E0 is one migration and should not wait on E1–E4 being
designed in full.
