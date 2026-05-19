# Live Artifacts — Cookbook

Agent-facing reference for building and debugging hosted artifacts (dashboards, RSS feeds, tables, news pages). Source of truth for *what's possible right now* — if a capability isn't documented here it almost certainly isn't wired.

If you're an LLM, read this end-to-end before grepping source. The toolbox is self-introspecting via `artifacts_toolbox.art_toolbox_{list,search,describe,validate}`; this file just spells out the things you can't see from the introspection calls (intent, recipes, current limitations).

---

## 1. Mental model

```
   ┌── sources ──┐    ┌── transforms ──┐    ┌── widgets ──┐
   │ HTTP / RSS  │ →  │ filter / sort  │ →  │ table       │ → page
   │ MCP / tool  │    │ group_count    │    │ list / pie  │
   └─────────────┘    │ jsonpath / diff│    │ kpi / chart │
                      └────────────────┘    └─────────────┘
                              ↓
                      ┌── exports ──┐
                      │ csv / json  │ → /a/<slug>/export/<id>
                      │ markdown    │
                      └─────────────┘
```

Each source produces a named value. Each transform reads `inputName` and produces another named value. Widgets and exports bind their inputs to those names via dotted paths (`bind: { rows: "issues" }`, `bind: { data: "top_authors.items" }`).

`html_template` placeholders use the same name space: `{{data.<sourceOrTransformName>.<path>}}`. Without an html_template, widgets auto-lay-out via `position`.

---

## 2. Pipeline shape (the canonical JSON)

The shape `art_toolbox_validate` accepts and `artifacts.get_live_artifact` returns:

```json
{
  "sources": [
    { "name": "issues",
      "toolId": "art_collect_http_json",
      "params": { "url": "https://api.github.com/search/issues?q=repo:OWNER/REPO+type:issue" },
      "refreshSeconds": 600 }
  ],
  "transforms": [
    { "name": "open_issues",
      "toolId": "art_transform_filter",
      "inputName": "issues",
      "params": { "field": "state", "op": "eq", "value": "open" },
      "position": 1 }
  ],
  "widgets": [
    { "slot": "issues_table",
      "toolId": "art_widget_table",
      "bind": { "rows": "open_issues" },
      "params": { "columns": ["number","title","user.login","created_at"] },
      "position": 1 }
  ],
  "exports": [
    { "exportId": "issues_csv",
      "toolId": "art_export_csv",
      "bind": { "rows": "open_issues" } }
  ]
}
```

**Naming rules** (the validator enforces these — see `src/core/artifacts/toolbox/validator.ts`):

- `source.name` / `transform.name`: identifier `[a-zA-Z_][a-zA-Z0-9_]*` — unique within their array.
- `widget.slot`: unique per artifact.
- `bind` values: dotted path starting with a source or transform name. The path's first segment must resolve to a declared name; deeper segments are not type-checked (best effort).
- Every `required` param must come either from `params` (literal) or `bind` (from upstream). The validator flags missing required params *taking binds into account*.

---

## 3. Tool inventory

### 3.1 Collectors (`family: 'collect'`)

| id | What it does | Required params | Returns |
|---|---|---|---|
| `art_collect_http_json` | Fetch a JSON endpoint, optionally narrow with a dotted `jsonpath`. | `url` | parsed JSON or value at `jsonpath` |
| `art_collect_http_text` | Same but for non-JSON (HTML/XML/CSV/plain). | `url` | `{ body, status, contentType }` |
| `art_collect_html_scrape` | Fetch HTML and extract repeating rows via CSS-subset selectors. | `url`, `rowSelector`, `fields` | `{ items, count }` |
| `art_collect_rss` | Fetch RSS/Atom, normalize to a common shape. | `url` | `{ items: [{ title, link, pubDate, summary }] }` |
| `art_collect_mcp` | Call a tool on an external MCP server through the bridge. | `server`, `tool` | whatever the MCP tool returns |
| `art_collect_octipus_tool` | Call an internal Octipus tool by id. | `toolId` | whatever the tool returns |

`http_json` and `http_text` accept optional `method` (`GET`/`POST`), `headers`, `body`. Header values can reference `${vault.<key>}` placeholders — **but vault resolution is currently a stub** (see §6).

### 3.2 Transforms (`family: 'transform'`)

| id | What it does | Required params | Returns |
|---|---|---|---|
| `art_transform_jsonpath` | Pull a sub-tree via dotted path. Numeric segments index arrays. | `path` | the value at the path |
| `art_transform_filter` | Keep rows where `field <op> value`. | `field`, `op`, `value` | filtered array |
| `art_transform_sort` | Stable sort an array by a field path. | `field` | sorted array (copy) |
| `art_transform_top_n` | Take the first `n` rows (pair with sort). | `n` | array of length ≤ n |
| `art_transform_group_count` | Bucket rows by a path, count occurrences. `[]` fans out arrays. | `by` | `[{ key, count }]` sorted desc |
| `art_transform_diff` | Compare against previous snapshot — added / removed / changed. | `keyField` | `{ added[], removed[], changed[] }` |

`art_transform_filter.op` is one of: `eq | neq | in | gt | lt | contains`.

### 3.3 Widgets (`family: 'widget'`)

All widgets return `{ html, css }`. All `data` / `rows` / `items` params are array-shaped unless noted.

| id | Best for | Required bind/params |
|---|---|---|
| `art_widget_table` | Tabular rows | `bind: { rows: "..." }`, optional `params.columns` (array of dotted paths) |
| `art_widget_list` | Title + link + summary feeds (news, PR queue) | `bind: { items: "..." }`, optional `params: { titleField, linkField, summaryField }` |
| `art_widget_kpi_card` | One big number | `bind: { value: "..." }`, optional `params: { label, unit, delta }` |
| `art_widget_bar_chart` | Horizontal bars over `[{key,value\|count}]` | `bind: { data: "..." }` |
| `art_widget_pie_chart` | Pie/donut from `[{key,value\|count}]` | `bind: { data: "..." }` |
| `art_widget_heatmap` | 2D bucket grid `[{x,y,v}]` | `bind: { data: "..." }` |
| `art_widget_json_tree` | Debug: collapsible JSON viewer | `bind: { data: "..." }` |
| `art_widget_markdown` | Static prose / instructions | `params: { body: "markdown" }` (no bind) |
| `art_widget_mermaid` | Mermaid diagram source | `params: { source: "graph TD; A-->B" }` |

### 3.4 Exports (`family: 'export'`)

All emit a downloadable file at `/a/<slug>/export/<exportId>`.

| id | Required bind | Params |
|---|---|---|
| `art_export_csv` | `bind: { rows: "..." }` | optional `columns: ["a","b","c.d"]` |
| `art_export_json` | `bind: { value: "..." }` (any value, not just arrays) | optional `pretty: true` |
| `art_export_markdown` | `bind: { rows: "..." }` | optional `columns`, `title` |

---

## 4. GitHub recipes

GitHub's REST endpoints have well-known quirks. Use the right one or the data will look wrong.

### 4.1 Issues only (not PRs) — `/search/issues`

The plain `/repos/{owner}/{repo}/issues` endpoint **conflates issues and pull requests** (a PR is an issue, internally, on GitHub). Always reach for `/search/issues` with `type:issue` when you want issues *only*.

```json
{ "name": "issues",
  "toolId": "art_collect_http_json",
  "params": {
    "url": "https://api.github.com/search/issues?q=repo:PatriceA/octipus+type:issue+is:open",
    "jsonpath": "items"
  },
  "refreshSeconds": 600 }
```

Returns an array of issue objects on `items` already, after the jsonpath. Each has `number`, `title`, `state`, `user.login`, `labels[]`, `created_at`, `html_url`.

**Caveats:**
- Search API rate limit (anon: 10/min; authed: 30/min). Don't refresh faster than 60s.
- Returns max 100 per page. For huge repos add `&per_page=100` and paginate manually (more sources, or scripted upstream).

### 4.2 Pull requests — `/repos/.../pulls`

PRs have their own endpoint. Use it; don't filter `/issues` for `pull_request != null`.

```json
{ "name": "prs",
  "toolId": "art_collect_http_json",
  "params": {
    "url": "https://api.github.com/repos/PatriceA/octipus/pulls?state=all&per_page=100&sort=updated&direction=desc"
  } }
```

`state` is `open | closed | all`. `closed` includes merged. Returned objects have `number`, `title`, `state`, `merged_at`, `user.login`, `head.ref`, `base.ref`, `html_url`.

### 4.3 Recent commits on main — `/repos/.../commits`

```json
{ "name": "commits_main",
  "toolId": "art_collect_http_json",
  "params": {
    "url": "https://api.github.com/repos/PatriceA/octipus/commits?sha=main&per_page=100"
  } }
```

Returns an array. Each commit has `sha`, `commit.message`, `commit.author.{name,date}`, `author.login`, `html_url`. **Default branch may be `main` or `master`** — set `sha` to the actual default branch name.

### 4.4 Pagination beyond 100

GitHub caps `per_page` at 100. The `art_collect_http_json` collector doesn't auto-follow `Link` headers. Workarounds:
- Multiple named sources: `commits_main_p1`, `commits_main_p2`, each with `page=N`. Concatenate via a thin transform (or just bind them to separate widgets).
- Use the `/search` endpoints which support more flexible filters in a single call (still 100 cap, but you can usually narrow the query).

For "last 100 commits on main" the single-page form is sufficient.

### 4.5 Anonymous vs authenticated

For **public repos**, anonymous works. Rate limits: 60/hour for core API, 10/min for search. Confirmed for `PatriceA/octipus` (HTTP 200, no auth).

For **private repos or higher limits**, you need an `Authorization: Bearer <token>` header. **See §6 — vault is stubbed today, so this doesn't actually work in production right now.** Track the wiring task before authoring private-repo artifacts.

---

## 5. Worked example — the `qa-issues` dashboard

This is the spec the user actually wants: open/closed issues, all PRs, last 100 commits on `main`. Paste it as the body of an `art_toolbox_validate` call, then mirror it into `create_live_artifact` + `add_artifact_*` calls (or fix the existing artifact's wiring).

```json
{
  "sources": [
    { "name": "issues_open",
      "toolId": "art_collect_http_json",
      "params": {
        "url": "https://api.github.com/search/issues?q=repo:PatriceA/octipus+type:issue+is:open&per_page=100",
        "jsonpath": "items"
      },
      "refreshSeconds": 600 },

    { "name": "issues_closed",
      "toolId": "art_collect_http_json",
      "params": {
        "url": "https://api.github.com/search/issues?q=repo:PatriceA/octipus+type:issue+is:closed&per_page=100",
        "jsonpath": "items"
      },
      "refreshSeconds": 1800 },

    { "name": "prs",
      "toolId": "art_collect_http_json",
      "params": {
        "url": "https://api.github.com/repos/PatriceA/octipus/pulls?state=all&per_page=100&sort=updated&direction=desc"
      },
      "refreshSeconds": 600 },

    { "name": "commits_main",
      "toolId": "art_collect_http_json",
      "params": {
        "url": "https://api.github.com/repos/PatriceA/octipus/commits?sha=main&per_page=100"
      },
      "refreshSeconds": 900 }
  ],

  "transforms": [
    { "name": "prs_open",
      "toolId": "art_transform_filter",
      "inputName": "prs",
      "params": { "field": "state", "op": "eq", "value": "open" } },

    { "name": "prs_closed",
      "toolId": "art_transform_filter",
      "inputName": "prs",
      "params": { "field": "state", "op": "eq", "value": "closed" } }
  ],

  "widgets": [
    { "slot": "kpi_open_issues",
      "toolId": "art_widget_kpi_card",
      "bind": { "value": "issues_open.length" },
      "params": { "label": "Open issues" },
      "position": 1 },

    { "slot": "kpi_open_prs",
      "toolId": "art_widget_kpi_card",
      "bind": { "value": "prs_open.length" },
      "params": { "label": "Open PRs" },
      "position": 2 },

    { "slot": "issues_table",
      "toolId": "art_widget_table",
      "bind": { "rows": "issues_open" },
      "params": { "columns": ["number","title","user.login","created_at"] },
      "position": 3 },

    { "slot": "prs_list",
      "toolId": "art_widget_list",
      "bind": { "items": "prs" },
      "params": { "titleField": "title", "linkField": "html_url",
                  "summaryField": "user.login" },
      "position": 4 },

    { "slot": "commits_list",
      "toolId": "art_widget_list",
      "bind": { "items": "commits_main" },
      "params": { "titleField": "commit.message", "linkField": "html_url",
                  "summaryField": "commit.author.name" },
      "position": 5 }
  ],

  "exports": [
    { "exportId": "issues_csv",
      "toolId": "art_export_csv",
      "bind": { "rows": "issues_open" } },
    { "exportId": "prs_csv",
      "toolId": "art_export_csv",
      "bind": { "rows": "prs" } },
    { "exportId": "commits_md",
      "toolId": "art_export_markdown",
      "bind": { "rows": "commits_main" },
      "params": { "title": "Recent commits — main" } }
  ]
}
```

Notes:
- The `issues_open.length` / `prs_open.length` binds rely on the data-bus resolving `.length` on arrays. If your validator flags it, swap to a small transform that emits `{ count: N }` and bind to `count`.
- Two separate sources for open / closed issues is cheaper than one source + filter, because the `/search/issues` API filters server-side and returns smaller payloads.

---

## 6. Auth & vault

The `http_json` / `http_text` / `html_scrape` collectors resolve `${vault.<key>}` placeholders in `headers` against the real vault at fetch time. Resolution runs as the source's `principalId` (the user who created the source) and respects workspace scoping. Missing keys throw — no silent placeholder fallback.

### 6.1 Storing a secret

Two paths:

**API (one-shot):**

```bash
curl -X POST http://localhost:3005/api/vault \
  -H 'Authorization: Bearer <session-token>' \
  -H 'content-type: application/json' \
  -d '{
    "name": "github_token",
    "value": "ghp_xxxxxxxxxxxxxxxxxxxx",
    "credentialType": "api_key",
    "description": "PAT for artifact refresh — repo + read:project"
  }'
```

`scope` defaults to `user`. Pass `"scope": "workspace"` + `"workspaceId": "<uuid>"` to bind to one workspace; pass `"systemLevel": true` for app-wide secrets like OAuth client IDs.

**From `gh` CLI on your machine:** mirror the token in once, then reference by name from artifact configs.

```bash
TOKEN=$(gh auth token)
curl -X POST http://localhost:3005/api/vault \
  -H 'Authorization: Bearer <session-token>' \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg v "$TOKEN" '{name:"github_token", value:$v, credentialType:"api_key", description:"mirrored from gh CLI"}')"
```

Rotate by re-POSTing the same name — the endpoint updates in place.

### 6.2 Referencing a secret from a source

In the source config, drop `${vault.<name>}` anywhere inside `headers`. The collector substitutes it before fetching:

```json
{ "name": "issues",
  "toolId": "art_collect_http_json",
  "params": {
    "url": "https://api.github.com/search/issues?q=repo:PatriceA/octipus+type:issue+is:open",
    "headers": {
      "authorization": "Bearer ${vault.github_token}",
      "x-github-api-version": "2022-11-28"
    },
    "jsonpath": "items"
  } }
```

Authentication multiplies your rate limit (5k/hr for core, 30/min for search) and unlocks private repos.

### 6.3 Resolution semantics

- **Tenant key**: the source's `principalId` — set at source creation time, immutable thereafter.
- **Scope precedence**: workspace-scoped row wins over user-scoped row of the same name when the source's artifact has a `workspaceId`; user-scoped row wins over system fallback.
- **Failure modes** (all loud — surface as `last_error` on the source row):
  - Missing key → `vault: secret "X" not found for principal <uid>` — store the secret, or fix the placeholder name.
  - Missing principal context → `resolveVaultHeaders: missing principalId` — internal bug, file an issue.
- **What you don't get**: substitution in `url`, `body`, or `params`. Only `headers`. Future work, but for now if you need a token in a query string, put it in a header and have the upstream API support that (most do, including GitHub).

### 6.4 `gh` CLI cannot be called directly by collectors

Collectors run server-side via HTTP. Your local `gh` keychain (`~/.local/share/keyrings`) is invisible to the server. The pattern in §6.1 — mirror the token into the vault — is the only safe bridge.

For **public repos** none of this matters — anonymous works (60/hr core, 10/min search).

---

## 7. Common pitfalls

| Symptom | Real cause |
|---|---|
| "No data" in an issues widget | Either zero issues actually exist *or* the URL was `/issues` (conflates with PRs) and `state` is wrong. Check via `gh api /repos/.../issues -f state=open --jq 'length'` and `--jq '[.[]\|select(.pull_request==null)]\|length'` to distinguish. |
| Empty PR list | Default `state=open` — pass `state=all` to include closed/merged. |
| 401 / 403 from GitHub | You have `Authorization` header set to a vault placeholder (resolver is stubbed) — drop the header and go anonymous, or implement vault first. |
| `bind path "X" does not resolve` | The first segment of your bind path is not a declared source or transform name. Names are case-sensitive. |
| `required parameter "rows" is missing` | Widget needs it from `bind` *or* `params`. You probably forgot to declare `bind: { rows: "..." }`. |
| Dashboard refreshes too aggressively / hits rate limit | Bump `refreshSeconds`. Search API needs ≥ 60s anon; core API needs ≥ 60s anon. |
| Hand-authored `html_template` with placeholders failing | Every `{{data.NAME...}}` must match a declared source or transform name. Prefer leaving `html_template` empty and letting widget `position` auto-layout. |

---

## 8. Debugging an existing artifact

Use the agent path:

1. `artifacts.get_live_artifact({ slug: "qa-issues" })` → full spec (sources/transforms/widgets/exports).
2. `artifacts_toolbox.art_toolbox_validate` on those four arrays → see structural errors.
3. If `ok: true` but data is empty → `artifacts.refresh_live_artifact({ id })` and read `last_status` + `last_error` per source.
4. Only after that — verify the upstream actually has data. For GitHub, `gh api` with the same URL is the ground truth.

Do **not** grep the source tree, guess at HTTP status codes, or invent token-scope diagnoses. If you don't have a real tool result, you don't have a diagnosis.
