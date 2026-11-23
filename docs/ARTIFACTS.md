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
artifacts_toolbox__search({ query: "github issues" })
artifacts_toolbox__describe({ id: "art_collect_http_json" })

// 2. Validate the wiring before creating anything.
artifacts_toolbox__validate({
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

Discovery surface: `artifacts_toolbox__list`, `artifacts_toolbox__search`,
`artifacts_toolbox__describe`, `artifacts_toolbox__validate`. All four are permission
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

See `artifacts_toolbox__describe({ id })` for parameters, return shape, examples,
and tips on any of them.

## Render pipeline

Every embed page request runs through the same four stages
(`src/api/routes/artifact-pages.ts:handleEmbed`):

1. **Data bus** — `buildDataBus(artifactId)` reads the newest snapshot
   per source (plus the second-newest as `previousInput` for diff
   transforms), then runs `artifact_transforms` rows in `position`
   order. Transform output lands under its own `name` in the bus.
   Per-transform errors do not poison the bus; the failing entry is
   set to `null` and the error message is collected for the slot's
   error block. (`src/core/artifacts/pipeline.ts`)
2. **Widgets** — `renderWidgets(artifactId, bus)` looks up each
   `artifact_widgets` row's `tool_id`, resolves its `bind_json` paths
   against the bus, merges with `params_json`, and calls the widget's
   `execute()`. Each return must be `{ html, css? }`; non-conforming
   widgets render the red `aw-slot-error` block but never crash the
   page. (`src/core/artifacts/widget-render.ts`)
3. **Template splicing** — if the version row carries an
   `htmlTemplate`, `<x-widget id="<slot>"/>` placeholders are replaced
   by each rendered widget's HTML. If no template exists,
   `renderDefaultLayout()` emits a CSS-grid layout (`.aw-grid`,
   `params.span` 1–4) using the same widget HTML. Either way,
   `renderTemplate()` then resolves any `{{data.<source>.…}}`
   substitutions and `{{#each …}}` loops, with `<script>` and inline
   handlers stripped by `sanitizeTemplate()`.
4. **Export downloads** — `GET /a/:slug/export/:exportId` rebuilds
   the data bus fresh, resolves the export's binds + params, and
   calls the export tool. The tool returns
   `{ filename, contentType, body }`; the route sets
   `Content-Disposition: attachment` and streams the body.
   Permission check matches the artifact's visibility (same
   `authorizeForRequest` flow as the embed page).

The toolbox itself is auto-discovered on first import via folder scan
of `src/core/artifacts/toolbox/{collectors,transforms,widgets,exports}/`.
Drop a new tool file in the right folder and it appears in the
catalogue on next restart — no manual registration. The four
discovery tools (`artifacts_toolbox__list/search/describe/validate`) are
the ONLY agent-facing surface for the toolbox; widget and transform
ids are referenced by name in pipeline JSON, never invoked by the
LLM directly.

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
| `skill_query`| `{ skill, prompt }`                                           | **Not enabled.** Accepted when a source is added, but every refresh fails with "skill_query refresh not yet enabled". To have an agent regenerate a page, use [agent refresh](#agent-refresh) instead. |

## Agent refresh

A data source re-fetches data; an **agent refresh** re-runs an agent to
regenerate the whole page. It is the way to keep a page current when its
content is written by an agent (a weekly digest, a summary of what changed)
rather than bound to a feed.

**What a refresh is.** One agent run, owned by the artifact's owner, from the
**refresh instruction** stored with the artifact. The agent that creates the
page may store one (`create_live_artifact({ …, refresh_instruction })`); it is
shown as **set by agent — review before enabling** until the owner saves it.
That tool cannot set a schedule or knowledge access. The owner sees and edits
the instruction on the artifact page (**Agent refresh**) or with
`PUT /api/artifacts/:id/agent-refresh`. The run is an unattended `research`
worker of the owner, in the artifact's workspace; anything that would ask for
approval is refused. It must reply with exactly one fenced `html` block (and
at most one `css` block), each fence on a line of its own; that is the new
page. A reply with no html block, two of them, or a fence left open is a
failed refresh.

**Tools: web or knowledge, never both.**

| Mode | Tools | Default |
|---|---|---|
| Web | `websearch__search`, `websearch__fetch_page` | yes |
| Knowledge (owner opt-in per artifact) | `knowledge__search_knowledge`, `knowledge__read_knowledge` | no |

No run gets files, commands, messaging or any artifact tool.

**The injection boundary, as it really is.** The run's task is a fixed frame
plus the stored instruction: never the current page, its data, or anything a
viewer sent or did. What the agent reads with its tools is not trusted, and
the boundary is that untrusted web content and private data never meet in
one run:

- A **web** run reads pages anyone can write, so a page can steer it. It has
  nothing private to leak (no knowledge base, no files), and the worst it can
  do is put bad or hostile content on the page. That page renders in the
  sandboxed embed like any other version (no access to the app, its cookies
  or the API), but it may load `https:` images and, like every artifact,
  can show anything to whoever views it.
- A **knowledge** run reads the owner's private knowledge and has no web
  tool, so no fetched page can instruct it and it has no tool that sends data
  anywhere. **Whatever it reads may end up on the page**, which anyone who can
  view the artifact sees (everyone, for a public or share-linked one), and the
  page itself can load `https:` images — so content in the knowledge base that
  carries instructions (an indexed web page, a forwarded document) could make
  the page show or send private data to whoever views it or to an image host.
  Turn it on only for artifacts whose viewers may see that knowledge, and
  whose knowledge you trust; the web app shows this warning next to the switch.

**Who can trigger it.** Only the owner (the artifact's creator):

| Who | Can |
|---|---|
| Owner | edit the instruction, set or clear the schedule, switch knowledge access, **Refresh with agent** (`POST /api/artifacts/:id/agent-refresh/run`) |
| Workspace member who can view or edit the artifact | nothing: `403`, `code: "not_owner"` (a refresh spends the owner's budget) |
| Anyone else, signed in | `404`, as for every artifact route |
| Embed viewer (viewer token, share link, public page) | nothing: no `/api` route accepts a viewer token, and the hosted page routes have no refresh |

Viewer-triggered refresh does not exist. Agent refresh is not available on an
artifact in a shared space (it runs as the owner's personal agent): `PUT` is
refused there with `code: "refresh_unavailable"`.

**What it costs.** The run's model calls are the owner's, recorded in
`cost_log` like any agent of theirs, and counted by their
[spend budgets](SPEND-BUDGETS.md) and quotas. A paused budget refuses the
refresh before any agent starts; budgets and quotas are checked again at the
spawn and before each model call, as for every agent.

**Atomic update.** A new version (change summary `agent refresh`) becomes
current only when the run succeeded, returned a non-empty page under 512,000
characters, its script built, and the artifact still shows the version the run
started from. Otherwise the current version stays, the unused version row is
removed, and the attempt is recorded as failed: an edit, restore or delete
while the run was going wins over the refresh. A version a crashed run left
behind is removed by the next run. Open viewers reload on success. A page
identical to the one the last refresh made current writes no version; only
the 5 newest versions written by refreshes are kept (never the current one,
never a version a person saved). A refresh does not count as activity for
[retention](#cleanup-and-retention): it does not touch the artifact's edit
time.

**State.** The owner sees last refreshed, the last attempt's outcome
(`success`, `failed`, `refused`) and error, whether one is running, the next
scheduled run, and why a schedule was switched off
(`GET /api/artifacts/:id/agent-refresh`). A refusal (spend budget, quota,
concurrent-agent limit, disabled owner, shared space, refresh job off) is
recorded like a failure, with its reason, and changes nothing on the page.

**Schedule.** Off by default: a refresh runs only when the owner asks. The
owner may set one (every hour, 6 hours, day or week in the web app; the API
takes any whole number of minutes from 60 to 10,080; setting the interval it
already has changes nothing). It runs on the shared task scheduler
(`getScheduler`, task type `artifact:agent-refresh`), the primitive
data-source refresh and cleanup use. A task only starts the run and returns;
the next is queued when the run ends, so no scheduler worker waits on an
agent. Changing or clearing the schedule replaces its chain, so a task already
queued for the old one ends without running; every boot re-arms the stored
schedules under a new chain (an embedded install's queue is in memory),
spread over 10 minutes.

**Limits.**

- At least 60 minutes between scheduled runs.
- One refresh of an artifact at a time: a second request while one runs is
  `409`, `code: "refresh_in_flight"`, and runs nothing (a conditional claim on
  the row, so this holds across processes; a claim older than 15 minutes is
  presumed dead).
- At most 3 agent refreshes run at once per server process: a manual request
  beyond that is `429`, `code: "refresh_capacity"`; a scheduled one tries
  again 5–10 minutes later, without counting as a failure.
- 10 minutes per run; the worker is then stopped and the attempt fails.
- A scheduled attempt that fails or is refused backs off: the next one comes
  after the interval × 2 per failure in a row, capped at a day — but never
  sooner than the interval itself, so a daily or weekly schedule keeps its
  interval. After 5 in a row the schedule switches itself off, says why on the
  artifact page, and the owner gets a notification (`artifact_refresh_disabled`).
  A success resets the count; setting the schedule again turns it back on.
- The schedule pauses (`artifact_refresh_paused`, once, with the reason on the
  page) when nobody has opened the artifact for the retention window
  (`artifacts.retentionDays`), or for 30 days when no retention is set,
  counted from the last view or from when the schedule was set.
- The schedule stops when the artifact is deleted or expires under
  [retention](#cleanup-and-retention) (at once for an expiry, at its next run
  for a deletion), or when the owner's account is disabled. While the
  `artifacts-refresh` job of the `artifacts` module is off, scheduled runs are
  skipped and resume when it is back.

Tables: `artifact_agent_refresh` (migration `0205_artifact_agent_refresh.sql`),
one row per artifact, removed with it. Code: `src/core/artifacts/agent-refresh.ts`
(claim, atomic landing, schedule) and `agent-refresh-runner.ts` (the run, its
tools and its deliverable).

## Templates

`{{data.<source>.<dotted.path>}}` for value substitution; HTML-escaped.
`{{#each data.<source>.items}}…{{this.field}}…{{/each}}` for iteration.
`<script>` and inline `on…=` handlers are stripped by the sanitizer. To
ship custom JS, pass it as a bundle (see "Custom JS" below).

Three built-in templates are available out of the box for the `dashboard`,
`news`, and `table` artifact types.

## Slugs

A slug (lowercase letters, digits and dashes, 1–64 characters) is unique per
workspace among live artifacts; deleting an artifact frees its slug at once.
A slug that is taken is a `409` from `POST /api/artifacts` (and the same
result from `create_live_artifact` and "save as artifact" in the chat):

```json
{ "error": "slug \"report\" is already used in this workspace",
  "code": "slug_taken", "slug": "report", "suggestedSlug": "report-2" }
```

`suggestedSlug` is the first free `<slug>-<n>` (null when none up to `-99`
is free). It is advice only: nothing is reserved, and the retry goes through
the same unique index. Two creates racing for one slug are decided by that
index, so exactly one succeeds and the other gets this `409`, never a server
error. The web app's "new artifact" form and the chat's save dialog show the
conflict with a button to take the suggestion; the agent tool returns
`code` and `suggested_slug`.

Public links (`/a/<slug>`) name no workspace, so a public artifact needs a
slug no other workspace has public: creating or switching an artifact to
`public` under such a slug is a `409` with `code: "public_slug_taken"`. This
is a check before the write, not an index (installs may already hold such a
pair); if two workspaces publish one slug at the same moment, or held a pair
from before the check, the oldest artifact keeps the public link.

## Visibility

| Value      | Who can view |
|------------|--------------|
| `private`  | Creator only |
| `workspace`| Any user in the artifact's workspace (default) |
| `signed`   | Authorized workspace viewers, or anyone with a valid `?t=<token>` URL |
| `public`   | Anyone (no auth). Per-IP rate limit applies. |

Signed share links expire (default 1h, max 30d). Revocation is immediate
via `DELETE /api/artifacts/:id/share-links/:linkId` — checked on every
read.

## Real-time updates

The embed page mints a viewer token (5-minute TTL, HMAC-signed with a key
separate from session JWTs) and injects it into a `<meta>` tag. The SDK
opens a WebSocket to the gateway, signs in with it (`artifact_token`) and
subscribes to `artifact:<id>`. On `artifact.data_updated` it reads the new
snapshot from the embed's own data route, `GET <embed URL>/../data/<source>?vt=<token>`
(`/a/<slug>/data/<source>`, or under `/__artifacts__` in path-prefix mode),
and patches the DOM.

The viewer token is the embed's only credential, and it is scoped:

- **One artifact.** It is signed for one artifact id (`aud: artifact:<id>`)
  and the workspace it was minted in; the data route also checks that the
  slug in the URL names that artifact. It opens no other artifact's
  events or data.
- **Read-only.** Its scope is always `view`; a token claiming anything else
  is refused. On the gateway it may only ping and subscribe to its own
  artifact; the data route is `GET` only. No `/api` route accepts it — not as
  `Bearer`, not as `ArtifactToken`, not in the query — so it cannot refresh,
  edit, list or read anything through the app API.
- **Expiring.** 5 minutes; an open gateway connection is closed when it
  expires. Reloading the page re-checks access and mints a new one.
- **Revocable.** Deleting the artifact, changing its visibility, or revoking
  the share link a page was opened with closes its live viewer connections
  and refuses the tokens issued before that moment (process-local cutoff).
  A token minted from a share link records the link (`slid`) and stops
  working as soon as the link is revoked or expires.

If the WS disconnects, the SDK attempts exponential-backoff reconnect and
flips the embed's `data-octipus-stale` attribute after 30s.

Links opened from another site may initially omit the strict session cookie.
The outer page establishes a same-site entry and retries authorization; visitors
without a session see a sign-in/share-link message. This entry reveals no artifact
metadata, and protected embeds still return 404 without authorization. Agent
links use the authenticated app route for signed/private/workspace artifacts;
only public artifacts get a bare outer URL.

## Custom JS bundles

A page's own JavaScript is written inline, the way a hand-made page would be:
`<script>` blocks and `onclick="…"` attributes in `html_template`. When a
version is written — by the agent tool or through the REST API (create, edit,
restore), all through `src/core/artifacts/version-writer.ts` — the scripts and
handlers are lifted out of the template into one source, built with esbuild
(no imports allowed; the V1 allow-list is empty) and stored per version under
the bundles directory (`<artifactId>/<versionId>/bundle.js`). Handlers become
`data-octi-h` markers bound by `addEventListener` in the bundle, so neither
`'unsafe-inline'` nor `'unsafe-eval'` is needed. The embed includes the built bundle inline under its exact SHA-256 CSP hash.
This keeps private artifacts functional inside an opaque sandbox, where a
separate bundle request would lose SameSite login cookies. The bundle is not
served as a file on any route: artifact-authored JavaScript only ever runs
inside the sandboxed embed.

A script that does not build does not fail the write: the version is saved,
renders without behaviour, and the caller gets the compiler message as a
warning. An edit that changes only the CSS, or one that sends back the stored
template (which no longer holds scripts), carries the previous bundle forward;
a restore copies the restored version's bundle.

## Sandboxing

The outer page and the web app frame the embed with `sandbox="allow-scripts"`
(an opaque origin). The embed's CSP header also carries `sandbox
allow-scripts` (never `allow-same-origin`), so an embed URL opened directly — in
path-prefix mode it is on the app's own origin — still runs without the app's
cookies and storage.

Response headers on hosted artifact responses:

| Response | Headers |
|----------|---------|
| Embed (`/embed`) | `Content-Security-Policy` (`default-src 'none'`, script hashes only, `frame-ancestors 'self'` plus `allowedEmbedOrigins`, `sandbox allow-scripts`), `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` |
| Outer page | CSP `default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors …` (no script), `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer` |
| Export, data | CSP `default-src 'none'; frame-ancestors 'none'; sandbox` (inert if opened), `nosniff`, `no-store`; the data route adds `Access-Control-Allow-Origin: *` without credentials |

`allowedEmbedOrigins` takes web origins only (`https://host[:port]` or
`https://*.host`); anything else is refused with a 400, and invalid stored
entries are dropped from the policy, so an entry cannot add a CSP directive.
No artifact response reflects the request's `Host` header; links are built
from configuration (`ARTIFACTS_HOST`, `PUBLIC_URL`).

Which host serves what, and why the artifact host serves nothing but these
pages, is in [CONFIGURATION.md](./CONFIGURATION.md#artifacts-hosting).

## Saved interactive answers

An [interactive answer](INLINE-UI.md) saved from the chat becomes an `html`
artifact with `network = 'none'`: the embed CSP allows no fetch or socket
(`connect-src 'none'`) and images only from `data:` and `blob:`, and the page
carries no SDK, gateway address or viewer token — a static copy without live
refresh. Its markup went through the same sanitizer rules as the chat frame
(on the server), and its script runs as the version's bundle after a shim for
`octi`, whose methods say "not available here". Visibility is `private` or
`workspace`.

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

## Cleanup and retention

A recurring `artifact:cleanup` task runs hourly (the `artifacts-cleanup` job
of the `artifacts` module; off, it deletes nothing) and:

- **Expires inactive artifacts — only when configured.** With
  `artifacts.retentionDays` (env `ARTIFACTS_RETENTION_DAYS`) above 0, an
  artifact that has not been edited, viewed, or had a data refresh for that
  many days is moved to the trash, as if its owner had deleted it: it
  disappears from lists and its pages and viewer tokens stop working, but
  nothing is removed yet. A view is any render of its embed (the web app's
  frame, the outer page, a share link), recorded in `last_viewed_at` at most
  once an hour per artifact, so a viewed artifact does not expire, even a
  static one or one whose refreshes fail. Artifacts not viewed since the
  upgrade that added the column fall back to their edit and refresh times. At most 500 expire per pass; each is
  logged (`artifact.cleanup.expired`, with workspace and slug). The default is
  `0`: nothing expires, which is how every install behaved before the setting
  existed.
- **Empties the trash** after `artifacts.trashDays` (env
  `ARTIFACTS_TRASH_DAYS`, default 30 — the window that was always used):
  the row goes with its versions, sources, snapshots, transforms, widgets,
  exports and share links (database cascade), and its bundle directory is
  removed from disk (`artifact.cleanup.purged`).
- Prunes snapshots beyond the newest 50 per source.
- Keeps the bundles of the current version and the 5 newest versions of each
  artifact, removing older ones from disk.
- Removes expired share links.

These removals are written to the server log, not the audit log: they are
unattended sweeps like session retention (`sessions.retentionDays`), which
is not audited either. A deletion a user makes goes through the API and is
recorded by the request audit like any other change.
