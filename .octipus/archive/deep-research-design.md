# Deep Research → Cited Report

> Design note, 2026-06-01. Feature #5 from `end-user-enrichment-plan.md`.
> Odysseus's headline "multi-step synthesis into reports." Octipus already has
> the hard parts (a `research` role with the right tools, the swarm, RAG, the
> artifacts host) — what's missing is the **product flow**: a destination that
> takes a question, runs a bounded multi-source investigation, and produces a
> **cited, shareable report**. This is mostly orchestration + a template over
> existing subsystems.

## What we already have (reuse, don't rebuild)
- **`research` role** (`src/core/orchestrator/roles/research/{config.ts,prompt.md}`)
  with tools: `browser`, `browser-ext`, `websearch`, `knowledge`, `task_state`,
  `filesystem`, `profiles`, `artifacts`, `artifacts_toolbox`, `mcp`. Default
  topic `research`.
- **`websearch.fetch_page`** — extracts page text via headless browser, now
  behind the H3 SSRF guard (validate + post-connect address check).
- **Swarm** — fan-out to parallel sub-investigations with budgets/cancel.
- **RAG / knowledge** — index + hybrid (BM25+vector) retrieval over fetched
  sources and the user's existing knowledge base.
- **Artifacts host** (`src/core/artifacts/`) — server-side template renderer
  (`renderTemplate`), CSP, share-links, versioning. The report renders here.
- The `deep-research` skill/workflow pattern (fan-out searches → fetch →
  adversarial verify → synthesize) already exists as a harness concept.

## Goal & non-goals
**Goal:** a "Deep Research" panel where a user asks a question and gets back a
structured report — sections, inline **citations** to real sources, and a
confidence/limitations note — saved as a shareable artifact, in minutes not
seconds, with the work visible (ties into the work-stream feature #1).

**Non-goals (this wave):** autonomous scheduled research, a citation manager,
PDF export polish, multi-report projects. One question → one report.

## Flow
1. **Input** — question + optional knobs: depth (quick / standard / deep →
   maps to swarm fan-out width + max sources), source scope (web / my knowledge
   base / both), and recency hint.
2. **Plan** — the research role decomposes the question into sub-queries
   (existing role prompt; add a planning step that emits a typed list).
3. **Gather (fan-out)** — spawn bounded sub-investigations: `websearch` →
   `fetch_page` the top hits → extract → dedupe. Each fetched source gets a
   stable **source id** (url + title + retrieved-at + a content hash) so
   citations are verifiable. Respect swarm budgets (this is where cost/time is
   bounded — expose depth as the budget knob).
4. **Verify** — an adversarial pass (the `deep-research` pattern): for each key
   claim, check it's supported by ≥1 fetched source; drop or flag unsupported
   claims. Fail loud on "no sources found" rather than hallucinating a report.
5. **Synthesize** — produce a structured **ReportDoc** (typed):
   ```
   ReportDoc {
     question, generatedAt, depth
     sections: { heading, markdown, citations: SourceRef[] }[]
     sources: Source[]        // id, url, title, retrievedAt, hash
     limitations: string      // honest "what I couldn't verify / gaps"
   }
   ```
   Citations are **SourceRef → Source** (by id), rendered as inline footnotes;
   never invent a URL.
6. **Render + persist** — render `ReportDoc` through the artifacts template
   renderer → a hosted, share-linkable report artifact. Also offer "save as
   document" (documents subsystem) and "open in file view" (feature #2).

## Surfaces
- **Web**: a "Research" destination (new `web/app/research/`) — question box +
  depth selector → live progress via the work-stream transport (feature #1)
  showing "Searching… / Reading 4 sources… / Verifying… / Writing report" →
  rendered report with clickable citations.
- **Chat**: a chat message that triggers research (orchestrator routes
  research-shaped prompts to this flow per the chat/work split, feature #3)
  returns a short summary + a link that opens the report artifact.
- **CLI/channels**: `research "<question>"` returns the report's share link.

## Key design decisions
- **Citations are first-class and verifiable** — every claim ties to a fetched
  source with a content hash; this is the trust differentiator over a plain
  "summarize the web" answer. The verify pass enforces it.
- **Depth = budget** — "deep" means more sources + wider fan-out, governed by
  the existing swarm budget system, so cost/latency stay bounded and visible.
- **Honest limitations** — the report always states what couldn't be verified
  (DESIGN.md fail-loud spirit, applied to content).
- **No new model bindings** — uses the `research` topic via `ModelRegistry`
  (rule #2); a deployment can bind a stronger model to `research` if desired.

## Testing
- **Eval scenarios** (`bun run eval`) — this touches orchestrator routing
  (research-shaped → research flow) and prompt/synthesis quality; add eval
  cases: a question with known sources should yield a report citing them, and
  an unanswerable question should produce a "couldn't verify" report, not a
  fabricated one.
- **Unit**: the `ReportDoc` synthesis/citation-linking is pure given gathered
  sources — test that every `SourceRef` resolves to a `Source` and unsupported
  claims are dropped.
- Source-gathering (browser/network) is integration-only; mock at the
  `fetch_page` boundary for unit coverage.

## Sequencing
1. `ReportDoc` type + synthesis/citation-linking (pure, test-first) + the report
   artifact template.
2. The fan-out gather + verify flow over the research role (eval-gated).
3. Web "Research" destination + work-stream progress.
4. Chat/channel triggers.

## Dependencies
- Best with **feature #1 (work stream)** for live progress (degrade to a poll
  if not ready).
- Renders via the **artifacts host** (exists).
- Routing change is **eval-gated** (shares the chat/work-split eval work).
