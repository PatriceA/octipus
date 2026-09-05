# Enrichment Features

End-user-facing capabilities layered on top of the agent runtime. Each ships as
a tool/service + REST route + web page.

## Reader

Fetch a URL, extract the readable content, and run reader actions on it.

- Code: `src/core/reader/` (`fetch.ts`, `extract.ts`, `actions.ts`)
- Route: `src/api/routes/reader.ts`
- Web: `web/app/reader/page.tsx`

The fetcher is SSRF-guarded. Extraction strips boilerplate to readable text.

## Deep Research

Bounded, multi-source investigation that produces a **cited report**.

- Code: `src/core/research/` (`jobs.ts`, `gather.ts`, `synthesis.ts`, `render.ts`,
  `persist.ts`, `service.ts`)
- Route: `src/api/routes/research.ts`
- Web: `web/app/research/page.tsx`

Flow: plan queries → gather sources (SSRF-guarded fetch) → synthesize a sectioned,
cited report → render. Depth (`quick` / `standard` / `deep`) bounds fan-out width
and source count (`DEPTH_BUDGET`).

**Output is always a document.** On completion the report is serialized to Markdown,
saved as a `Documents` record (category `Research`), and indexed into the knowledge
base so future agent turns can retrieve and cite it (`persist.ts` →
`getEmbeddingService().indexText`). Knowledge indexing is fail-soft: if no embedding
model is configured the document is still saved (and the reason logged). The web page
links the finished report to the Documents view.

> Live **job tracking** (progress/stage) is held in an in-memory map with a TTL
> (`jobs.ts`) — it does not survive a restart and is process-local. The **report
> itself** is durable once persisted as a document, and so is the follow-up
> to-do the run creates (see [To-Do List → Provenance](#to-do-list)).

## To-Do List

The user's personal to-do list. Agents can add, update, and complete items.

- Tool: `src/tools/tasks/` (`TasksTool`, displayed as **To-Do List**; tool id stays
  `tasks`, route `/tasks`)
- Route: `src/api/routes/tasks.ts`, recurring items via `routes/recurring-tasks.ts`
  + the scheduler
- Web: `web/app/tasks/page.tsx` (sidebar entry **to-do**)

Distinct from `src/tools/task-state/` — a read-only inter-agent/workflow state tool
that shares neither storage nor concept.

**Provenance.** Every task carries `source` (`user | agent | reader | research |
email`) and a `sourceRef` linking back to where it came from. The producers live
in `src/core/tasks/sourced.ts`:

| Source | How a task gets created |
|---|---|
| `reader` | **save as to-dos** on a Reader *Action items* result (`POST /api/reader/tasks`) — one task per bullet, linked to the article URL, category *Reading*. |
| `email` | **To-do** on an open message (`POST /api/email/message/:id/task`) — subject as title, sender + snippet in notes, triage priority mapped onto task priority, category *Email*. The email-processor tool also tells the agent to `create_task` for mail that needs the user. |
| `research` | Automatic on every finished Deep Research run — one *Review research: …* task pointing at the saved document (`sourceRef.documentId`), category *Research*. |

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
