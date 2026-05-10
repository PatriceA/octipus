# Live Artifacts

Persistent, hosted HTML pages tied to a workspace that re-fetch data on a
schedule and push updates to open browsers in real time. Use them for
dashboards, news/RSS feeds, status pages, and anything else that should stay
fresh without a chat loop.

## Mental model

```
artifact ──► artifact_versions   (HTML / CSS / JS bundle / schema)
   │
   ├─► artifact_data_sources     (kind, config, refresh_seconds, principal)
   │       │
   │       ▼ scheduler (recurring + wake-gate)
   │       ▼ tool-executor / fetch / RSS / MCP
   │       ▼ artifact_data_snapshots (newest 50 retained)
   │       ▼ gateway publishEvent("artifact.data_updated")
   │
   ▼
GET /a/:slug/embed   (sandboxed iframe, locked-down CSP)
   ▼
octipus-artifact-client.js → WS subscribe → DOM patch on push
```

## Quick start (CLI / agent)

Have an agent create one:

```
create_live_artifact({
  slug: "ops-dash",
  title: "Ops Dashboard",
  type: "dashboard",
  visibility: "workspace",
  html_template: "<p>Latest: <span data-bind=\"feed\">{{data.feed}}</span></p>",
  sources: [
    { name: "feed", kind: "rss", config: { url: "https://hnrss.org/frontpage" }, refresh_seconds: 300 }
  ]
})
```

The tool returns `{ id, slug, url }`. Open the URL in a browser; the SDK
attaches over WebSocket and patches `[data-bind="feed"]` whenever the next
refresh lands.

## Source kinds

| Kind         | Config example                                                | Notes |
|--------------|---------------------------------------------------------------|-------|
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
