# End-User Enrichment — Master Plan

> Strategic roadmap, 2026-06-01. Octipus is strong on the professional/platform
> side (swarm, typed roles, multi-channel, multi-tenant security) but thin on
> **end-user daily-driver features** and the "fun" side. Triggered by the
> Odysseus (8.6k★) / opencode comparison — they out-adopt us on first-run UX and
> breadth of *destinations a non-developer opens daily*, not on engineering.
>
> This is the umbrella plan. Each feature below has its own detailed design
> note (all written as of 2026-06-01):
> - Work stream + file view + chat/work split → `end-user-ux-design.md`
> - Hardware-aware onboarding → `hardware-onboarding-design.md`
> - Deep Research → `deep-research-design.md`
> - Reader → `reader-design.md`
> - Tasks/TODOs → `tasks-todos-design.md`
> - Email (triage-lite) → `email-triage-design.md`
>
> Owners decide sequencing — features are ordered by value-to-effort with
> dependencies called out.

## North star
Turn Octipus from "a platform builders configure" into "a workspace a person
opens every day." Keep the engineering discipline; add the surfaces that make
the agent feel like a capable, visible collaborator. Reuse existing subsystems
(artifacts host, filesystem + WorkspaceFS, gateway events, RAG, research role,
email-processor, scheduling) — extend, don't reinvent.

---

## Feature inventory & current-state audit

| # | Feature | Backend today | UI today | Verdict |
|---|---------|---------------|----------|---------|
| 1 | **Rich work stream** | `action` event emits only `toolName`; **results never reach client** | `agent-activity-card` shows "used file_read" | extend event + add renderers |
| 2 | **In-chat file view** | `artifacts/` host, `filesystem`+WorkspaceFS | artifacts iframe only | new Files tab, reuse host |
| 3 | **HW-aware local model onboarding** | `ModelRegistry`, providers (Ollama/…) | manual model add | **greenfield** scan+recommend+serve |
| 4 | **Reader (article/page rewrite)** | `websearch.fetch_page`, RAG, summarize | none | **greenfield** UI; thin backend |
| 5 | **Deep Research → report** | `research` role + tools, RAG, artifacts | none (no product flow) | wire a flow over existing role |
| 6 | **Tasks / TODOs** | `recurring-tasks` (cron), `task_state` (agent-internal) | `/tasks` redirects to Hooks | **greenfield** personal todo |
| 7 | **Email client** | `email-processor` + gmail/m365 mail tools (AI triage, headless) | none | new UI over existing backend |

The recurring theme: **most of these are "surface + polish an existing
backend," not greenfield logic.** That's the leverage — we already did the hard
agent/security work.

---

## 1. Rich agent work stream  *(spec: `end-user-ux-design.md` Thread 1)*

**Root cause found:** `agent-worker.ts` emits `action` with only
`{ toolName, toolId }`; tool *results* go into the model's message list and
**never reach the client**. The UI cannot show more than "used file_read"
because the data never arrives.

**Plan:** typed `ToolActivityEvent` (started/completed/failed) emitted from
`tool-executor.ts` (has args + result), + a server-side **per-tool renderer
registry** → `{ title, inputPreview, resultPreview }` ("Edited poem.md (+8 −0)"
with a diff; "Ran npm test → exit 0" with the tail). Caps + M2 redaction on
previews. Renders in the existing activity card and TUI gateway-adapter.
**Highest value/risk ratio; unblocks the diff view. Do first.**

## 2. In-chat file view + edit-and-continue  *(spec: `end-user-ux-design.md` Threads 2–3)*

A "Files" tab in chat `side-panel.tsx`: text/code (CodeMirror-class, not an
IDE), image, and diff modes; session-scoped `GET/PUT /api/sessions/:id/files`
backed by WorkspaceFS (H2-grade containment) + scoped-repo tenancy; versioned
for **edit-and-continue** (user tweaks the file → agent's next turn sees the
current version, no copy-paste). Plus the **chat/work split** (inline answer vs
work-in-file) as an eval-gated orchestrator routing change.

## 3. Hardware-aware local-model onboarding  *(Odysseus "Cookbook"/`hwfit`)*

The single biggest **adoption** unlock for the local-first audience — removes
"which model can I run, and how do I serve it?"

**Plan:**
- A `hwfit`-style probe: detect GPU/VRAM/RAM/CPU (nvidia-smi / `/proc` / OS
  APIs; degrade gracefully when absent). Server-side, no new heavy deps.
- A **recommendation scorer**: given hardware + a model catalog (Ollama library
  + known GGUF/quant sizes), rank models that fit VRAM with quant-awareness,
  tagged by use (chat/code/vision/embeddings → maps to our topic bindings).
- **Click-to-install/serve** via the existing Ollama provider (`ollama pull`);
  bind the result to a topic in `ModelRegistry` so it's immediately usable.
- Surface inside `octi setup` (CLI) **and** a web "Models → Recommended" panel.
- Honors house rule #2 (no hardcoded models — recommendations resolve to topic
  bindings, not literals in source).

This deserves its own design note before build (`hardware-onboarding-design.md`).

## 4. Reader (article / page rewrite)

A clean, distraction-free reading view: paste a URL → fetch → extract main
content → render readable; AI actions on top (summarize, simplify, translate,
"rewrite at a 10-year-old level", extract action items → Tasks #6).

**Plan:** backend is thin — `websearch.fetch_page` already retrieves pages
(with the H3 SSRF guard); add a readability-style main-content extractor
(small, ~one lib or ~100 lines) and reuse RAG/summarize. UI is a focused
reader page + a "send to chat / save as document" affordance. Pairs naturally
with the file view (#2) and documents.

## 5. Deep Research → report

Odysseus's headline "multi-step synthesis into reports." We already have the
**`research` role** (browser, websearch, knowledge, RAG, artifacts) and the
swarm to fan out — what's missing is the *product flow*: a research panel that
takes a question, runs a bounded multi-source investigation (reuse the
`deep-research` workflow pattern), and produces a **cited report artifact**
(reuse the artifacts host for rendering + share-link).

**Plan:** a thin orchestration over the research role + a report template +
the artifacts renderer. Eval scenarios for research quality/citations. The
heavy lifting (agents, RAG, hosting) exists.

## 6. Tasks / TODOs (personal)

User-facing TODOs are effectively **greenfield**: `recurring-tasks` is cron
automation and `task_state` is agent-internal sibling discovery — neither is a
personal task list, and `/tasks` currently just redirects to Hooks.

**Plan:** a `tasks` table (tenant-scoped via scoped repos), CRUD API, and a
real `/tasks` page (list, due dates, done/undone, priority). The **agent
integration is the differentiator**: agents can create tasks ("remind me to…",
research that produces action items → tasks), complete them, and the work
stream / chat can deep-link to them. Wire into the existing scheduling/hooks for
reminders.

## 7. Email client  *(the one you're torn on)*

**Backend already exists and is the strong part**: `email-processor` (one-by-one
AI classification + actions) + gmail/m365 mail tools (read/send) — but it's
**headless**. There is no inbox UI.

**The case for it:** email is the killer "agent does real work you can watch"
demo — AI triage, draft replies, "summarize this thread", "what needs my
response today" — and it's *visual* and *daily*. It directly showcases the
work stream (#1) and file/draft view (#2). It also leans on capabilities we
already shipped.

**The case against / risks:** a real email client is a deceptively large
surface (folders, threading, search, compose, attachments, real-time sync,
offline) and a heavy *trust* surface (full mailbox access). It can balloon and
distract from the cheaper wins.

**Recommendation — scope it as a "triage assistant," not a full mail client:**
a focused inbox view that lists recent messages, shows the AI triage/priority
the `email-processor` already computes, and offers one-click agent actions
(summarize thread, draft reply in the file/draft view, archive, create task).
**Read + assist, defer full compose/folders/search.** This delivers the visual,
daily, "watch the agent work" value at a fraction of the cost and reuses the
existing backend. Revisit "full client" only if the triage view earns it.
*Decision deferred to owner; this note recommends the lite scope.*

---

## Cross-cutting foundations these share
- **Work stream (#1)** is the connective tissue — every other feature looks
  better when the agent's actions are legible. Build it first.
- **Artifacts host** backs file view (#2), reader output (#4), research reports
  (#5).
- **Scoped repositories + per-user vault** (our multi-tenant moat) back tasks
  (#6) and email (#7) safely — a real advantage over Odysseus's coarse role
  gating.
- **Eval gate**: anything touching orchestrator routing (#2 split, #5 research)
  must pass `bun run eval`.

## Proposed sequencing
1. **#1 Work stream** — unblocks/improves everything; lowest risk.
2. **#2 File view (read-only → editor → edit-and-continue)** — the core
   collaborator UX.
3. **#3 HW-aware onboarding** — biggest adoption unlock; parallelizable (own
   design note + branch, independent of 1–2).
4. **#5 Deep Research** and **#4 Reader** — high-visibility, mostly surface over
   existing backends.
5. **#6 Tasks** — greenfield but small; enables agent "remember/act later".
6. **#7 Email (triage-lite)** — last of this wave; biggest surface/trust cost,
   decision pending.

Each feature: its own design note (where greenfield) → its own PR(s),
typecheck/lint/eval green per the audit workflow. Marketing/positioning
(README user-outcome framing, blind model comparison demo) tracked separately.

## Explicitly out of scope (this wave)
Full IDE/LSP, full email client (compose/folders/search/offline), real-time
multiplayer, mobile-native apps.
