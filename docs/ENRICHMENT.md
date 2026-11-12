# Enrichment Features

End-user-facing capabilities layered on top of the agent runtime. Each ships as
a tool/service + REST route + web page.

## Reading a web page

The core no longer has a reader of its own. Reading a page in a clean view is
the example plugin, Reader (`plugins/reader`, see
[PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#bundled-plugins)), which an admin
installs under Admin → Plugin packages → Bundled.

What stays in the core is the fetch and extraction that the plugin host
scope `web:read` runs (`src/core/web-read/`: `fetch.ts`, `extract.ts`). The
fetcher is SSRF-guarded and capped at 5 MB. Extraction strips boilerplate and
rebuilds the article from an allowlist of tags.

## Deep Research

The core no longer has a research module of its own. Researching a question in
the background is the example plugin, Research (`plugins/research`, see
[PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#bundled-plugins)), which an admin
installs under Admin → Plugin packages → Bundled. It is the core research
module moved out, with what changed:

| | The core module (removed) | The plugin |
|---|---|---|
| Start | `POST /api/research { question, depth }`, a background job | `start_research` (write: the page asks the user), host scope `agent:run`: a background run of the host's own `research` agent, as the user |
| The work | A fixed pipeline on the `research` lane: plan sub-queries, SearXNG search, SSRF-guarded fetch of each hit, one synthesis call returning JSON, citations checked against the fetched sources (`quick` / `standard` / `deep`: 1-4 searches, 4-14 sources) | The `research` role's agent with web search and fetch (the host's own tools, under the user's rules), the user's knowledge and documents; the depth sets how many searches and sources the prompt asks for; the report asks for numbered sources the agent actually read. Bounded by the host: runs and starts per hour, a token budget per run, the daily plugin allowance, spend budgets, 20 minutes |
| Status | `GET /api/research/:jobId`: stage (planning, searching, reading, synthesizing) and the structured report | `research_status` (read): status, stage and the Markdown report; withheld above the plugin's protection level (1) |
| Saving | Always, as a document (category *Research*) indexed into the knowledge base, plus one *Review research* to-do | When the user asks (`save_report`, `documents:write`): a document (category *Research*, indexed when an embedding model is there), and saving again updates it; no to-do |
| Spaces | Personal only | Personal only (`agent:run` is refused in a space) |

What stays in the core is what the plugin runs on: the `research` role and
lane, the web search tool, the guarded fetch, the documents and the
background-job table.

## To-Do List

The user's personal to-do list. Agents can add, update, and complete items.

- Tool: `src/tools/tasks/` (`TasksTool`, displayed as **To-Do List**; tool id stays
  `tasks`, route `/tasks`)
- Route: `src/api/routes/tasks.ts`, recurring items via `routes/recurring-tasks.ts`
  + the scheduler
- Web: `web/app/tasks/page.tsx` (sidebar entry **to-do**)

Distinct from `src/tools/task-state/` — a read-only inter-agent/workflow state tool
that shares neither storage nor concept.

**What next.** `GET /api/tasks?view=next` (and `list_tasks` with `view: "next"`)
returns open tasks in next-action order — overdue → due today → high priority →
new from email / research / reading in the last 48h → due this week → backlog —
each with a `bucket` and a one-line `reason`. "Today" is the user's calendar
day: the page passes the browser's zone as `?tz=`, the tool uses the user's
saved timezone preference, and both fall back to UTC — never the server's
zone. The ranking is one pure function (`src/core/tasks/rank.ts`) shared by
the tool, the API and the tasks page's *what next* grouping (the default); the
Daily Briefing asks the tool for this view rather than re-sorting.

**Provenance.** Every task carries `source` (`user | agent | email | channel`,
and `reader` or `research` on tasks made by the removed core reader and
research module) and a `sourceRef` linking back to where it came from. The producers live
in `src/core/tasks/sourced.ts`:

| Source | How a task gets created |
|---|---|
| `agent` | Also what the Reader example plugin's `create_tasks` writes (host scope `tasks:write`): one task per item, category *Reading*, with a `sourceRef` naming the plugin, the tool and the article URL. Older tasks from the removed core reader keep `source: reader`. |
| `email` | **To-do** on an open message (`POST /api/email/message/:id/task`) — subject as title, sender + snippet in notes, triage priority mapped onto task priority, category *Email*. The email-processor tool also tells the agent to `create_task` for mail that needs the user. |
| `research` | Kept on existing tasks: the removed core research module made one *Review research: …* task per run, pointing at the saved document (`sourceRef.documentId`). The Research example plugin makes no task. |

## While you were away

One list of what happened to the user's work since they last looked: agents
that finished or failed, pipelines that completed or now wait on them,
approvals blocking a run, to-dos other things created for them, and the unread
notifications that arrived in the window (older unread mail is the inbox's
business, so "nothing happened" stays reachable). A pipeline that is still
running is not news yet and is left out. Approvals and failures come first —
they are the only items where nothing moves until the user acts.

- Core: `src/core/digest/away.ts` — `collectAwayDigest` folds `agents`,
  `pipelines`, `tasks`, `notifications` and the in-process approval list;
  `renderAwayDigest` is the deterministic markdown of the same facts.
- Route: `GET /api/digest/away?since=<iso>` (default: 24h; clamped to 30d).
- Web: the first card on the dashboard (`web/components/dashboard/away-digest.tsx`).
  **caught up** remembers the moment in the browser and starts the next "away"
  there.
- Briefing: a `spawn_agent` hook with `actionConfig.awayDigestHours` gets the
  rendered digest prepended to its prompt — the seeded Daily Briefing uses 24 —
  so the agent reads facts instead of spending a turn collecting them.

## Inbox (notifications)

Every notification the platform raises for a user — an agent finished or
failed, a pipeline completed, stopped or errored, an approval is waiting — lands
in the `notifications` table and in the header bell. The **inbox** page is the
full view of the same rows: filter by unread / agents / pipelines / approvals,
mark one or all read, and follow each row to the thing that happened (the
agent view, the pipelines page, the chat that is waiting for the approval).

- Routes: `src/api/routes/notifications.ts` (`GET /api/notifications`
  with `?unread=1`, `?type=<prefix>`, `limit`, `offset` — filters apply in
  SQL so paging is over the filtered set; `POST /api/notifications/:id/read`,
  `POST /api/notifications/read-all`)
- Web: `web/app/notifications/page.tsx` (sidebar entry **inbox**)
- Producers: `worker-spawner.ts`, `pipeline-manager.ts`, `approval-manager.ts`
  via `getNotificationService().notify(...)`; the `metadata` they attach
  (`workerId`, `pipelineId`, `requestId`) is what the inbox links on.

## Email triage

Batch, per-email AI classification and actions over Gmail / Microsoft 365.

- Tool: `src/tools/email-processor/` (`EmailProcessorTool`)
- Core: `src/core/email/` (send/normalize)
- Route: `src/api/routes/email.ts` (send is gated)
- Web: `web/app/email/page.tsx`

## Hardware-aware onboarding (hwfit)

Recommends local Ollama models that fit the host's hardware.

- Code: `src/capabilities/hwfit/` (`catalog.json`/`catalog.ts` curated catalog,
  `scorer.ts`, `sizing.ts` LIVE registry manifest sizing, `install.ts`)
- Driver: `src/capabilities/service.ts`
- Route: `src/api/routes/capabilities.ts`
- Web: `web/app/setup/page.tsx`

Combines a curated model catalog with live registry manifest sizing and a hardware
budget score to surface installable models the machine can actually run.
