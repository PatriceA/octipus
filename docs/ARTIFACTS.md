# Live Artifacts

Persistent, hosted HTML pages tied to a workspace that re-fetch data on a
schedule and push updates to open browsers in real time. Use them for
dashboards, news/RSS feeds, status pages, and anything else that should stay
fresh without a chat loop.

## Mental model — toolbox edition

Artifacts are now wired as a typed pipeline of four small parts; each part
is a registered toolbox tool that the agent picks by name via discovery
(no prompt extension required).

```
┌──────────┐   ┌────────────┐   ┌─────────┐   ┌──────────┐
│ COLLECT  │──►│ TRANSFORM  │──►│ WIDGET  │──►│ EXPORT   │
│ sources  │   │ pure funcs │   │ render  │   │ download │
└──────────┘   └────────────┘   └─────────┘   └──────────┘
      │                                            │
      └─── snapshot store (artifact_data_…) ───────┘
```

Storage tables: `artifacts`, `artifact_versions`,
`artifact_data_sources` (`kind='toolbox'` + `tool_id`),
`artifact_data_snapshots`, `artifact_transforms`,
`artifact_widgets`, `artifact_exports`, `artifact_share_links`.

The page handler (`GET /a/:slug/embed`) calls `buildDataBus()`
(sources + transforms), then `renderWidgets()` (every widget runs
through its toolbox tool), then either splices into the template via
`<x-widget id="..."/>` placeholders or auto-lays-out via
`renderDefaultLayout()`.

## Quick start — toolbox flow (recommended)

```ts
// 1. Discover. The agent never invents tool ids.
art_toolbox_search({ query: "github issues" })
art_toolbox_describe({ id: "art_collect_http_json" })

// 2. Validate the wiring before creating anything.
art_toolbox_validate({
  sources: [
    { name: "issues", toolId: "art_collect_http_json",
      params: { url: "https://api.github.com/repos/PatriceA/octipus/issues" },
      refreshSeconds: 600 },
  ],
  transforms: [
    { name: "by_label", toolId: "art_transform_group_count",
      inputName: "issues", params: { by: "labels[].name", top: 8 } },
  ],
  widgets: [
    { slot: "labels", toolId: "art_widget_pie_chart",
      bind: { data: "by_label" } },
    { slot: "table", toolId: "art_widget_table",
      bind: { rows: "issues" },
      params: { columns: ["number", "title", "state"] } },
  ],
  exports: [
    { exportId: "csv", toolId: "art_export_csv", bind: { rows: "issues" } },
  ],
})

// 3. Create the shell (no html_template; widgets render via default grid).
create_live_artifact({
  slug: "octipus-issues",
  title: "Octipus issues",
  type: "dashboard",
  visibility: "workspace",
  sources: [
    { name: "issues", kind: "toolbox", tool_id: "art_collect_http_json",
      config: { url: "https://api.github.com/repos/PatriceA/octipus/issues" },
      refresh_seconds: 600 },
  ],
})

// 4. Attach the rest — transforms, widgets, exports.
add_artifact_transform({ artifact_id, name: "by_label",
  tool_id: "art_transform_group_count", input_name: "issues",
  params: { by: "labels[].name", top: 8 } })

add_artifact_widget({ artifact_id, slot: "labels",
  tool_id: "art_widget_pie_chart", bind: { data: "by_label" } })
add_artifact_widget({ artifact_id, slot: "table",
  tool_id: "art_widget_table", bind: { rows: "issues" },
  params: { columns: ["number", "title", "state"], span: 4 } })

add_artifact_export({ artifact_id, export_id: "csv",
  tool_id: "art_export_csv", bind: { rows: "issues" } })
```

Download: `https://artifacts.<host>/a/octipus-issues/export/csv`.

## Toolbox catalogue (Phase 3 baseline)

Discovery surface: `art_toolbox_list`, `art_toolbox_search`,
`art_toolbox_describe`, `art_toolbox_validate`. All four are permission
tier ALLOW — the agent can browse freely.

| Family    | Tool                                                                 | One-liner |
|-----------|----------------------------------------------------------------------|-----------|
| collect   | `art_collect_http_json`                                              | GET/POST JSON; optional JSONPath. |
| collect   | `art_collect_http_text`                                              | Raw text/HTML/XML/CSV. |
| collect   | `art_collect_rss`                                                    | RSS / Atom → `{ items: [{title,link,pubDate,summary}] }`. |
| collect   | `art_collect_octipus_tool`                                           | Invoke any registered Octipus tool by handler name. |
| collect   | `art_collect_mcp`                                                    | Call a tool on an external MCP server. |
| collect   | `art_collect_html_scrape`                                            | CSS-subset selector scrape into rows + fields. |
| transform | `art_transform_jsonpath`                                             | Pluck a sub-tree by dotted path. |
| transform | `art_transform_filter`                                               | eq/neq/in/gt/lt/contains row filter. |
| transform | `art_transform_sort`                                                 | Stable sort by path. |
| transform | `art_transform_top_n`                                                | Slice first N rows. |
| transform | `art_transform_group_count`                                          | Count by key (with `[]` fanout). |
| transform | `art_transform_diff`                                                 | added/removed/changed vs previous snapshot. |
| widget    | `art_widget_table`                                                   | HTML table; picks columns by path. |
| widget    | `art_widget_list`                                                    | Title + link + summary list. |
| widget    | `art_widget_kpi_card`                                                | Big number + delta + label. |
| widget    | `art_widget_markdown`                                                | Safe-subset markdown block. |
| widget    | `art_widget_json_tree`                                               | Collapsible JSON viewer (debug fallback). |
| widget    | `art_widget_bar_chart`                                               | CSS bar chart. |
| widget    | `art_widget_pie_chart`                                               | SVG pie / donut. |
| widget    | `art_widget_heatmap`                                                 | 2D bucket heatmap. |
| widget    | `art_widget_mermaid`                                                 | Captures Mermaid source — SVG renderer ships with the bundler. |
| export    | `art_export_csv`                                                     | RFC4180-ish CSV. |
| export    | `art_export_json`                                                    | Pretty JSON. |
| export    | `art_export_markdown`                                                | Markdown table (optional title). |

See `art_toolbox_describe({ id })` for parameters, return shape, examples,
and tips on any of them.

## Source kinds (legacy)

The original inline-`kind` config is still accepted for back-compat —
artifacts created before the toolbox shipped keep working. Do not author
new artifacts with these; use `kind: "toolbox"` + `tool_id` instead.

| Kind         | Config example                                                | Notes |
|--------------|---------------------------------------------------------------|-------|
| `toolbox`    | `{ url: … }` (whatever the collector takes)                   | Set `tool_id` to the registered collector. |
| `tool`       | `{ tool: "websearch__search", params: { query: "..." } }`     | Runs as the source's principal. Vault ACLs apply. |
| `http`       | `{ url, method, headers?, body?, jsonpath? }`                 | `headers` may use `${vault.<key>}` placeholders. |
| `rss`        | `{ url }`                                                     | Normalized to `{ items: [{title, link, pubDate, summary}] }`. |
| `mcp`        | `{ server, tool, params }`                                    | Routed through the MCP bridge. |
| `skill_query`| `{ skill, prompt }`                                           | Spends model tokens. Gated by workspace rate-limit. |

## Templates

`{{data.<source>.<dotted.path>}}` for value substitution; HTML-escaped.
`{{#each data.<source>.items}}…{{this.field}}…{{/each}}` for iteration.
`<script>` and inline `on…=` handlers are stripped by the sanitizer. To
ship custom JS, pass it as a bundle (see "Custom JS" below).

Three built-in templates are available out of the box for the `dashboard`,
`news`, and `table` artifact types.

## Visibility

| Value      | Who can view |
|------------|--------------|
| `private`  | Creator only |
| `workspace`| Any user in the artifact's workspace (default) |
| `signed`   | Anyone with a valid `?t=<token>` URL |
| `public`   | Anyone (no auth). Per-IP rate limit applies. |

Signed share links expire (default 1h, max 30d). Revocation is immediate
via `DELETE /api/artifacts/:id/share-links/:linkId` — checked on every
read.

## Real-time updates

The embed page mints an artifact-scoped JWT (5-minute TTL, signed with a
key separate from session JWT) and injects it into a `<meta>` tag. The SDK
opens a WebSocket to the gateway and subscribes to `artifact.*` events.
On `artifact.data_updated`, it re-fetches via REST and patches the DOM.

If the WS disconnects, the SDK attempts exponential-backoff reconnect and
flips the embed's `data-octipus-stale` attribute after 30s.

## Custom JS bundles

Ship a self-contained bundle:

```
update_live_artifact({
  id,
  html_template: "<canvas data-bind=\"chart\"></canvas>",
})
```

Then POST the JS to a future bundle endpoint (see step 6 of the rollout
plan). The build pipeline runs Bun's bundler with no external imports
allowed (V1 allow-list is empty), computes sha256, persists under
`data/artifacts/<artifactId>/<versionId>/bundle.js`, and the embed
renderer pins that hash in CSP `script-src` per version.

## Hosting / DNS

See [CONFIGURATION.md](./CONFIGURATION.md#artifacts-hosting) for the
subdomain vs path-prefix tradeoff. TL;DR: add one DNS record for
`artifacts.<your-host>` and set `ARTIFACTS_HOST` env. Without it,
artifacts serve at `/__artifacts__/a/:slug` on the main host with weaker
isolation.

## Hooks

Subscribe to lifecycle events in-process via
`artifactLifecycleBus.on('artifact:data_refreshed', fn)`. Currently
fired:

- `artifact:created`
- `artifact:updated`
- `artifact:data_refreshed`
- `artifact:viewed` (sampled 1/50)

DB-backed user hook bindings will arrive in a follow-up `trigger_type`
enum migration.

## Cleanup

A recurring `artifact:cleanup` task runs hourly and:

- Prunes snapshots beyond the newest 50 per source
- Deletes soft-deleted artifacts older than 30 days (cascade)
- Removes expired share links
