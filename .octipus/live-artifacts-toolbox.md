# Live Artifacts Toolbox — Design Plan

> Status: **proposal** · Branch: `claude/plan-artifacts-toolbox-uY6C9`
> Supersedes the prompt-only authoring flow described in
> [`docs/ARTIFACTS.md`](../docs/ARTIFACTS.md).

## 1. Why this exists

The current live-artifacts surface is a single fat tool
(`src/tools/artifacts/index.ts`) plus five raw source kinds
(`rss`, `http`, `tool`, `mcp`, `skill_query`) and a two-pass Handlebars-ish
template renderer (`src/core/artifacts/render.ts`).

What this forces the agent to do, every single time:

- Hand-author HTML for each layout (table, list, RSS reader, dashboard).
- Pick raw source primitives (`http`/`rss`) and embed the URL inline.
- Re-derive transforms (sort, slice, jsonpath, regex extract) in either
  the template or by prompting yet another tool call.
- Re-invent rendering for charts, maps, kanbans — there are none today, so
  agents fall back to `<pre>{{json}}</pre>` or skip them.
- Re-invent exports (CSV, JSON, XLSX). None exist.

The proof-of-life was an RSS reader. That is the floor, not the ceiling.

**Goal.** Replace prompt-extension with a *discoverable toolbox*:
single-purpose composable tools for **collecting**, **transforming**,
**displaying**, and **exporting** live data, with a discovery surface so an
agent can ask *"what do I have?"* instead of being handed everything up
front.

## 2. Non-goals

- Building a general BI tool. We are not Looker.
- Per-channel adapters. Artifacts stay HTML pages served by the gateway.
- A WYSIWYG drag-and-drop editor. Agents author; humans tweak via PR/API.
- Replacing the existing snapshot/refresh/scheduler core
  (`src/core/artifacts/{refresh,scheduler,events}.ts`). Those stay; we
  layer above them.

## 3. Mental model

Today: **one tool** with five source kinds and a free-form HTML field.

Proposed: **four families of small tools**, all auto-discovered from
`src/tools/artifacts-toolbox/`, all routed through the existing
`ToolRegistry`, all wired into an artifact via a typed pipeline:

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  COLLECT   │─▶│ TRANSFORM  │─▶│   BIND     │─▶│   RENDER   │─▶│   EXPORT   │
│ (sources)  │  │ (pipelines)│  │ (named)    │  │ (widgets)  │  │ (download) │
└────────────┘  └────────────┘  └────────────┘  └────────────┘  └────────────┘
       │                                                              │
       └────── snapshot store (existing) ─────────────────────────────┘
```

An artifact becomes a small JSON document:

```jsonc
{
  "title": "Repo health",
  "sources": [
    { "name": "issues", "tool": "art_collect_github_issues",
      "params": { "repo": "patricea/octipus", "state": "open" },
      "refresh_seconds": 600 },
    { "name": "stars",  "tool": "art_collect_http_json",
      "params": { "url": "https://api.github.com/repos/patricea/octipus" },
      "refresh_seconds": 3600 }
  ],
  "transforms": [
    { "name": "top_labels", "tool": "art_transform_group_count",
      "input": "issues", "params": { "by": "labels[].name", "top": 8 } }
  ],
  "widgets": [
    { "id": "kpi_stars",     "tool": "art_widget_kpi_card",
      "bind": { "value": "stars.stargazers_count", "label": "Stars" } },
    { "id": "labels_pie",    "tool": "art_widget_pie_chart",
      "bind": { "data": "top_labels" } },
    { "id": "issues_table",  "tool": "art_widget_table",
      "bind": { "rows": "issues" },
      "params": { "columns": ["number","title","labels[0].name","updated_at"] } }
  ],
  "exports": [
    { "tool": "art_export_csv", "bind": { "rows": "issues" } }
  ]
}
```

The template field becomes optional. If absent we render a layout from the
declared widgets. If present, widgets are placeable inline via
`<x-widget id="kpi_stars" />` tags.

## 4. The toolbox

All tools live under `src/tools/artifacts-toolbox/<family>/<name>.ts`,
extending `BaseTool`. The folder structure is the registry — discovery is
the existing folder-scan in `src/tools/discovery.ts`. Naming convention:
`art_<family>_<name>` so they cluster in tool-list UIs and grep.

### 4a. Collectors (`art_collect_*`)

| Tool | Purpose | Notes |
|------|---------|------|
| `art_collect_http_json` | GET/POST a JSON endpoint, optional JSONPath. | Replaces inline `http` kind for JSON. |
| `art_collect_http_text` | Raw text/HTML/XML fetch. | Pairs with scrape transforms. |
| `art_collect_rss` | RSS/Atom → `{items[]}`. | Wraps existing `parseRss`. |
| `art_collect_html_scrape` | Fetch + CSS-selector extract → rows. | One per repeating selector, e.g. `{ url, row: "article.post", fields: { title: "h2", href: "a@href", date: "time@datetime" } }`. |
| `art_collect_mcp` | Call an MCP tool by `server`+`tool`. | Wraps existing `mcp` kind, but lookup-able by name. |
| `art_collect_octipus_tool` | Call any registered Octipus tool by id. | Wraps existing `tool` kind. |
| `art_collect_sql_readonly` | Run a parameterized SELECT against a workspace-bound datasource. | Phase 2; opt-in per workspace. |
| `art_collect_webhook` | Receive pushes into a named buffer (no polling). | Phase 2; uses existing `/webhooks` plumbing. |

All collectors share a return contract: `{ ok, payload, fetchedAt,
contentHash }`. The hash lets the refresh layer skip diff-less snapshots.

### 4b. Transforms (`art_transform_*`)

Pure functions over the snapshot bus. Cheap, deterministic, no I/O.

| Tool | Purpose |
|------|---------|
| `art_transform_jsonpath` | `{ path }` — extract a sub-tree. |
| `art_transform_filter` | `{ where: { field, op, value } }` — `eq/neq/in/gt/lt/contains`. |
| `art_transform_sort` | `{ by, dir }`. |
| `art_transform_top_n` | `{ n }`. |
| `art_transform_group_count` | `{ by, top? }` → `[{ key, count }]`. |
| `art_transform_aggregate` | `{ by, agg: sum|avg|min|max|count, field }`. |
| `art_transform_join` | Inner/left join two named sources on a key. |
| `art_transform_pivot` | Long ↔ wide shape change. |
| `art_transform_diff` | Diff a snapshot against its prior version (drives "what changed" widgets). |
| `art_transform_regex_extract` | `{ pattern, group?, on }` over text rows. |
| `art_transform_columns` | Project / rename a row set into a stable schema. |

Each transform takes the *name* of its input (a source or earlier
transform) and writes under its own name into the data bus.

### 4c. Widgets / renderers (`art_widget_*`)

Each widget is a tool whose `execute()` returns
`{ html, css?, js?, deps? }`. The artifact bundler concatenates them under
the same CSP we already pin (`src/core/artifacts/csp.ts`).

| Tool | Renders | Bind shape |
|------|---------|------------|
| `art_widget_kpi_card` | Single big number + label + delta. | `{ value, label, delta? }` |
| `art_widget_table` | Sortable HTML table. | `{ rows, columns[] }` |
| `art_widget_list` | Title + link + summary list (replaces today's RSS template). | `{ items }` |
| `art_widget_kanban` | Columns of cards. | `{ items, columnBy }` |
| `art_widget_timeseries` | Line chart. | `{ series: [{x,y}] }` |
| `art_widget_bar_chart` | Categorical bars. | `{ data: [{key,value}] }` |
| `art_widget_pie_chart` | Pie/donut. | `{ data: [{key,value}] }` |
| `art_widget_heatmap` | 2D bucket heatmap. | `{ data: [{x,y,v}] }` |
| `art_widget_mermaid` | Mermaid diagram (flow/seq/erd/gantt). | `{ source }` |
| `art_widget_geo_map` | Pin/heat map. Bundled tiles via tile-proxy. | `{ points }` |
| `art_widget_markdown` | Markdown block (server-rendered, sanitized). | `{ text }` |
| `art_widget_json_tree` | Collapsible JSON viewer. Useful debug fallback. | `{ data }` |
| `art_widget_status_dot` | Up/down dot + last-check. | `{ ok, checkedAt }` |
| `art_widget_iframe_proxy` | Embed an allow-listed URL inside the CSP sandbox. | `{ url }` |

Charting library: pick **one** (proposal: `uPlot` for time/bar/line,
`d3-shape` for pie, `mermaid` for diagrams) and bundle once into
`web/public/octipus-artifact-widgets.js`. House rule #10: no fresh
dependency per widget.

### 4d. Exporters (`art_export_*`)

Exporters do not render; they register a *download endpoint* on the
artifact and a button in the chrome.

| Tool | Output |
|------|--------|
| `art_export_csv` | RFC4180 CSV from a row set. |
| `art_export_json` | Pretty JSON snapshot. |
| `art_export_xlsx` | Multi-sheet XLSX. |
| `art_export_markdown` | Markdown report (title + each widget's text form). |
| `art_export_png` | Server-side render of a single widget (headless via existing browser tool). |
| `art_export_share_link` | Issue a signed share link (wraps `share-link.ts`). |

Endpoint pattern: `GET /a/:slug/export/:exportId` (auth = artifact's
visibility rules).

## 5. Discovery (the part that matters most)

The toolbox is **deliberately too big to fit in a prompt**. We mirror the
skill-discovery pattern (`src/skills/discovery.ts` —
hybrid keyword + vector, summary first, full on demand):

- **`art_toolbox_list({ family?, intent? })`** — returns the *index*: one
  line per tool (`id`, one-sentence purpose, family). Tiny tokens.
- **`art_toolbox_search({ query, k? })`** — hybrid match (substring on
  description/keywords + cosine on a description embedding) → top-k tool
  ids with their one-liners. Embeddings are computed once at startup and
  cached the same way `SkillRegistry.loadExternal()` does it.
- **`art_toolbox_describe({ id })`** — full manifest: parameter schema,
  return shape, **a worked example**, and a `tips` block with common
  gotchas (e.g. "csv exporter expects rows of flat objects — run
  `art_transform_columns` first").
- **`art_toolbox_validate({ pipeline })`** — dry-runs the wiring without
  hitting the network: do all `bind` paths resolve? Do widget bindings
  match the transform output schemas? Are required widget params present?
  Returns a list of typed errors. Wired into `create_live_artifact` and
  `update_live_artifact` so we fail loud before publish.

A single short paragraph in the agent prompt teaches the discovery flow
("find with search → confirm with describe → wire → validate → publish").
That replaces the current ~60-line `SOURCES_PARAM_DESCRIPTION` blob in
`src/tools/artifacts/index.ts:46-58`.

The same four discovery tools are surfaced over MCP in
`mcp-server/src/tools/artifacts-toolbox.ts` so external agents and IDEs
see the same catalog.

## 6. Wiring into existing core

We do **not** rewrite the refresh/snapshot core. Mapping to what exists:

| New concept | Existing implementation it reuses |
|-------------|-----------------------------------|
| `art_collect_*` execution | `refreshSource()` in `src/core/artifacts/refresh.ts` — new kind `toolbox` that dispatches to a registered toolbox tool by id, replacing the bespoke `runTool/runHttp/runRss/runMcp` switch over time. |
| Snapshots, scheduler | `scheduler.ts`, `lifecycle-bus.ts`, `events.ts` — unchanged. |
| `art_transform_*` execution | New `src/core/artifacts/pipeline.ts` runs transforms in-process whenever any upstream source's `contentHash` changes. Memoized by hash. |
| Widget output bundling | Extend `src/core/artifacts/bundler.ts` to merge each widget's `{html,css,js,deps}` into the final page; keep CSP sha pinning. |
| Validation | New `pipeline-validate.ts` next to `pipeline.ts`, called by both the agent tool and the REST `POST/PUT /artifacts/:id` routes. |
| Exporters | New routes in `src/api/routes/artifact-exports.ts`. |

DB additions (one migration, generated via `bun run db:generate`):

- `artifact_data_sources.tool_id text NULL` — when set, picks a toolbox
  collector. Existing `kind` stays for back-compat; both populated for new
  rows during transition, old read path untouched.
- New table `artifact_transforms` — `{ id, artifact_id, name, tool_id,
  input_name, params_json, position }`.
- New table `artifact_widgets` — `{ id, artifact_id, slot, tool_id,
  bind_json, params_json, position }`.
- New table `artifact_exports` — `{ id, artifact_id, tool_id, bind_json,
  filename_pattern }`.

All four tables soft-delete (`deleted_at`) to match
`src/db/schema/artifacts.ts`.

## 7. Permission & safety model

Per `CLAUDE.md` rule #6 — no SECURITY_PREAMBLE edits, no bypassing the
permission system.

- Every toolbox tool registers through `BaseTool.registerTool()`, so the
  middleware in `src/tools/base-tool.ts` (permission check → vault inject
  → execute) applies unchanged.
- Default permission tiers:
  - `art_toolbox_*` (discovery), `art_widget_*`, `art_transform_*`,
    `art_export_csv|json|markdown` → **ALLOW** (pure / local).
  - `art_collect_http_*`, `art_collect_html_scrape`,
    `art_collect_rss` → **ASK** the first time per host per workspace;
    cache the consent (existing permission overrides table).
  - `art_collect_sql_readonly`, `art_collect_octipus_tool`,
    `art_collect_mcp`, `art_export_png` → **ASK**, no auto-allow.
- Collectors run as the source's `principalId` (already enforced in
  `refresh.ts:6` comment). Toolbox does not weaken this.
- HTML/CSS produced by widgets is concatenated through
  `sanitizeTemplate()` and the existing CSP. Widget JS is allowed only via
  the bundler with a pinned sha256 — unchanged from today.
- New: per-workspace **fetch budget** for `art_collect_html_scrape` (it's
  the most abuseable). Counter lives next to existing
  `src/core/artifacts/rate-limit.ts`.

## 8. Agent ergonomics

The artifacts agent role (`src/core/orchestrator/roles/artifacts/`,
to be added if missing) gets:

- A short prompt fragment (≤30 lines) that teaches the discovery flow and
  shows ONE worked example end-to-end.
- Tool allowlist: `art_toolbox_*` + `create_live_artifact` +
  `update_live_artifact` + `list_live_artifacts`. Note: the role does
  **not** get direct access to every `art_widget_*` / `art_transform_*` —
  those are invoked at render time inside the pipeline, not by the agent
  in chat. The agent just *names* them in the pipeline JSON. (House
  rule #3 — one job per role, minimal allowlist.)
- A `dry_run: true` mode on `create_live_artifact` that returns the
  validator's findings + a preview render, so the agent can iterate
  without polluting the workspace with abandoned artifacts.

## 9. Migration & rollout

No feature flag — house rule #9 says ship it or don't. We sequence
instead:

**Phase 1 — toolbox plumbing & discovery (no behavior change for users):**

1. Create `src/tools/artifacts-toolbox/` skeleton + family folders.
2. Implement `art_toolbox_list/search/describe/validate`.
3. Wrap existing source kinds as four collectors
   (`art_collect_http_json`, `art_collect_http_text`, `art_collect_rss`,
   `art_collect_octipus_tool`, `art_collect_mcp`). Implementations *just
   call* the existing functions in `refresh.ts`. Old `kind` field still
   works.
4. Add `tool_id` column to `artifact_data_sources` via Drizzle migration.

**Phase 2 — transforms + first real widgets:**

5. Add `artifact_transforms` table + `pipeline.ts`.
6. Implement five transforms: `jsonpath`, `filter`, `sort`, `top_n`,
   `group_count`. Each with unit tests under
   `src/core/artifacts/pipeline.test.ts`.
7. Bundle one chart library (`uPlot`) into
   `web/public/octipus-artifact-widgets.js`; ship widgets `table`,
   `list`, `kpi_card`, `timeseries`, `bar_chart`, `markdown`,
   `json_tree`.
8. Add `artifact_widgets` table and a default layout renderer (CSS grid,
   one widget per row, sized by `params.span`).

**Phase 3 — exports + scraping + diagrams:**

9. `art_export_csv` + `art_export_json` + the `/export/:id` route.
10. `art_collect_html_scrape` (using existing browser tool under the
    hood for JS-rendered pages, plain `fetch` + a tiny selector engine
    otherwise).
11. `art_widget_mermaid` + `art_widget_pie_chart` + `art_widget_heatmap`.
12. `art_transform_diff` and a "what changed since last refresh" widget.

**Phase 4 — kill the old surface:**

13. Mark the inline `kind` field deprecated in
    `src/tools/artifacts/index.ts:46-58`; switch the agent prompt to
    discovery-only. Old data sources read fine; new writes go via
    toolbox.
14. Remove `BUILTIN_TEMPLATES` once `news`, `table`, `dashboard` types
    have widget-based equivalents.

Each phase is one PR, one logical change (house rule).

## 10. Tests & eval

- Unit tests next to each new file (`*.test.ts`), Bun's runner.
- `eval/artifacts/` scenarios:
  - "make me a dashboard of open issues in repo X" — should pick
    `art_collect_http_json` + `art_widget_table` + `art_export_csv`
    without HTML-by-hand.
  - "show me my top labels as a pie chart" — should pick
    `art_transform_group_count` → `art_widget_pie_chart`.
  - "diagram the relationships between these services from this JSON" —
    should pick `art_widget_mermaid` with a generated source.
  - Negative: agent tries to wire a non-existent transform → validator
    rejects, agent recovers via `art_toolbox_search`.
- `bun run eval` must pass before merging phases 2+.

## 11. Open questions

1. **Charting deps.** uPlot (~50 KB) covers line/bar/area. Pie + geo need
   d3-shape / Leaflet. Acceptable, or stay pure-SVG for v1?
2. **Scraper engine.** Server-side `cheerio`-style selector parser, or
   reuse the existing browser tool's headless path for everything?
   Headless is heavier but handles JS-rendered pages.
3. **Per-widget refresh granularity.** Today every snapshot triggers a
   full page re-render via DOM patch. With many widgets, do we want
   per-widget WS topics? Probably yes in phase 3.
4. **Export size cap.** What's the ceiling for `art_export_xlsx` before
   we stream to S3 instead of inlining?
5. **Public-visibility scrapers.** Should `art_collect_html_scrape` ever
   be allowed on a `visibility: public` artifact? My instinct: no —
   force `workspace` or `signed`.

## 12. Out of scope (for now)

- Cross-workspace artifact sharing.
- Editing widgets in a web UI.
- Per-viewer personalization (the snapshot is shared).
- Streaming sources (Kafka, SSE). Webhook collector in phase 2 is the
  closest we get.
