# Live Artifacts — Implementation Plan

**Goal:** Add a new first-class object — the **live artifact** — a persistent, hosted HTML page (or RSS/JSON feed) tied to a workspace, that re-fetches data from configured sources on a schedule and pushes updates to open browsers in real time.

**Why:** Users want octipus to host dashboards, news feeds, RSS streams, status pages, and other "always-fresh" surfaces produced by agents. Today, agents emit one-shot text replies and at most attach static file references (`extractArtifacts()` in `src/core/orchestrator/handoff.ts`). There is no persistent, refreshable, shareable surface. The Cowork "Live Artifacts" feature inspired this, but the self-hosted multi-user model means we go further: artifacts are server-hosted, shareable, and integrate with the existing tool/skill/scheduler stack.

**Non-goals (V1):**
- A full no-code dashboard builder. Templates only; custom JS is gated to Phase 3.
- Editing artifact source HTML in the browser with a WYSIWYG editor.
- Cross-workspace artifact federation.
- Replacing the existing chat-thread `inputArtifacts` metadata (`src/core/swarm/types.ts`) — different concept, retained.

---

## Cross-Phase Principles (apply to every phase)

- **Reuse, don't reinvent.** Octipus already has the WS gateway hub (`src/core/gateway/hub.ts`), Redis-backed scheduler (`src/core/scheduler.ts`), tool executor, vault per-tool ACL (`src/security/vault.ts`), session auth (`src/security/auth/session.ts`), and hooks. Every feature in this plan layers on those primitives — no new infrastructure subsystems.
- **Loud failure.** Refresh errors, template render errors, snapshot DB writes — all log at `error` via `coreLogger`. No silent `try/catch`. Pattern: `src/core/orchestrator/worker-spawner.ts:271-278`.
- **Cross-tenant isolation is the security invariant.** A bug in artifact rendering must not leak data across workspaces or escape the iframe sandbox. Every phase has CSP + sandbox + scoped-token tests.
- **Drizzle journal entry required** for every migration (per `feedback_drizzle_journal.md`).
- **Bun:test** for unit tests, Playwright for E2E. Mock conventions per `src/core/swarm/spawner.test.ts:1-12`.
- **Embedded mode parity.** Everything must work with PGlite + in-memory pub-sub (single-user mode), not just Postgres + Valkey. The scheduler and gateway already abstract this; new code must not introduce a hard Redis dependency.

---

## Concept & Architecture

```
agent / user
   │
   ▼
artifacts ─── artifact_versions  (HTML / JS / CSS / schema_json)
   │
   ├── artifact_data_sources  (kind, config, refresh_seconds, principal_id)
   │       │
   │       ▼ scheduler.ts (existing Redis queue + wake-gates + retry)
   │       │
   │       ▼ tool-executor.ts (existing 59+ tools)
   │       │
   │       ▼ artifact_data_snapshots (latest JSON per source, history bounded)
   │       │
   │       ▼ gateway hub.publishEvent("artifact:<id>", "artifact.data_updated")
   │
   ▼
GET /a/:slug/embed  (iframe, locked-down CSP, served from artifacts.<host>)
   │
   ▼
octipus-artifact-client.js  ── WS subscribe → patches DOM on push
```

---

## Phase 1 — MVP (private/workspace, manual refresh, declarative templates)

### 1.1 Schema migration

**What to implement** — five new tables.

| Table | Key columns |
|---|---|
| `artifacts` | `id`, `slug` (unique), `workspace_id`, `created_by_user_id`, `created_by_agent_id` (nullable), `title`, `type` (`dashboard`\|`table`\|`rss`\|`news`\|`html`), `visibility` (`private`\|`workspace`\|`signed`\|`public`), `current_version_id`, `created_at`, `updated_at` |
| `artifact_versions` | `id`, `artifact_id`, `html`, `js_bundle_sha256` (nullable), `css`, `schema_json`, `change_summary`, `created_at`, `created_by_user_id` |
| `artifact_data_sources` | `id`, `artifact_id`, `name` (unique per artifact), `kind` (`tool`\|`http`\|`rss`\|`mcp`\|`skill_query`), `config_json`, `refresh_seconds`, `principal_id`, `last_run_at`, `last_status` (`ok`\|`error`\|`pending`), `last_error` (text, nullable) |
| `artifact_data_snapshots` | `id`, `source_id`, `payload_json`, `captured_at`, `ttl_seconds` |
| `artifact_share_links` | `id`, `artifact_id`, `token_hash` (sha256), `scope_json`, `expires_at`, `created_by_user_id`, `revoked_at` (nullable) |

**Documentation references — copy from these:**
- Schema patterns: `src/db/schema/skills.ts:1-28` (jsonb default `[]`, boolean default false).
- Workspace-scoped table FK pattern: any existing schema in `src/db/schema/` that scopes by workspace — e.g. `agents`, `sessions`. Mirror the `workspace_id` FK + index.
- Migration SQL conventions: `src/db/migrations/0042_org_scoped_models_skills.sql:17-26` (ALTER TABLE … ADD COLUMN IF NOT EXISTS).
- Drizzle journal: see how `_journal.json` is updated — bump `idx`, append entry, do NOT renumber existing entries.

**Steps:**
1. Add five files in `src/db/schema/`: `artifacts.ts`, `artifact-versions.ts`, `artifact-data-sources.ts`, `artifact-data-snapshots.ts`, `artifact-share-links.ts`. Re-export from `src/db/schema/index.ts`.
2. Run `bun run db:generate` to produce `src/db/migrations/<next>_artifacts.sql`.
3. Hand-edit the generated SQL: add indexes on `artifacts(workspace_id)`, `artifacts(slug)` unique, `artifact_data_sources(artifact_id)`, `artifact_data_snapshots(source_id, captured_at DESC)`, `artifact_share_links(token_hash)`.
4. Append journal entry to `src/db/migrations/meta/_journal.json`.
5. Add a repository module `src/db/repositories/artifacts-repo.ts` with: `create`, `getById`, `getBySlug`, `listByWorkspace`, `update`, `softDelete`, plus version + source + snapshot + share-link sub-repos. Mirror the structure of `src/db/repositories/agent-repo.ts`.

**Verification checklist:**
- [ ] `\d artifacts` shows all columns + workspace FK + unique slug.
- [ ] Migration runs cleanly against PGlite (embedded mode) and Postgres.
- [ ] Repository unit tests cover create/get/list/update + cascade delete (deleting an artifact removes its versions, sources, snapshots, share links).

**Anti-patterns:**
- Do NOT make `slug` globally unique. Make it `(workspace_id, slug)` unique and globally indexed for fast `getBySlug`.
- Do NOT store the full HTML on `artifacts` — it goes on `artifact_versions`. The `artifacts` row points to `current_version_id`.
- Do NOT leave `principal_id` nullable. Every data source must have an attributed principal so vault ACLs apply at refresh time.

### 1.2 REST API surface

**Routes** in `src/api/routes/artifacts.ts` (new file, registered in `src/api/server.ts:361` route group):

- `POST   /api/artifacts` — create (body: title, type, visibility, initial template)
- `GET    /api/artifacts` — list, workspace-scoped
- `GET    /api/artifacts/:id` — metadata + current version
- `PUT    /api/artifacts/:id` — update (creates new `artifact_versions` row, bumps `current_version_id`)
- `DELETE /api/artifacts/:id` — soft delete
- `GET    /api/artifacts/:id/versions` — version list
- `POST   /api/artifacts/:id/data-sources` — add source
- `DELETE /api/artifacts/:id/data-sources/:sourceId` — remove
- `POST   /api/artifacts/:id/refresh` — force refresh now (V1: synchronous; V2: enqueue)
- `GET    /api/artifacts/:id/data/:sourceName` — JSON snapshot fetch (used by the inner doc / SDK)
- `POST   /api/artifacts/:id/share-links` — mint signed link
- `DELETE /api/artifacts/:id/share-links/:linkId` — revoke

**Hosted page routes** (separate router, mounted on the `artifacts.<host>` subdomain — see 1.4):
- `GET /a/:slug` — outer chrome (refresh button, version label, owner controls if logged-in workspace member)
- `GET /a/:slug/embed` — inner sandboxed doc (CSP-locked)

**Documentation references:**
- Elysia route group registration: `src/api/server.ts:361` (existing route registration block).
- Auth guard pattern: `src/api/middleware/` — reuse the existing `authGuard`. Hosted `/a/:slug` and `/a/:slug/embed` routes must support both session auth AND the signed-link bearer token (see 1.6).
- Workspace resolution: existing `X-Octipus-Workspace` header handling.

**Verification:**
- [ ] CRUD round-trips via REST.
- [ ] Cross-workspace access denied (user in workspace A cannot read an artifact in workspace B even with the artifact id).
- [ ] Updating an artifact creates a new `artifact_versions` row; old version is preserved.

### 1.3 Data sources V1: `tool` and `rss`

**`tool` source kind** — config: `{ tool: "<tool_name>", params: {...} }`. Refresh worker calls `tool-executor.run(tool, params, { principalId })`.

**`rss` source kind** — config: `{ url: "https://..." }`. Refresh worker fetches the URL, parses with an XML library, normalizes to `{ items: [{ title, link, pubDate, summary }, ...] }`.

**Refresh entrypoint:** `src/core/artifacts/refresh.ts` (new). Function `refreshSource(sourceId)`:
1. Load source + its principal.
2. Dispatch by `kind`.
3. Write `artifact_data_snapshots` row.
4. Update `last_run_at`, `last_status`, `last_error` on the source.
5. Phase 1: return synchronously to the REST handler. Phase 2: emit gateway event.

**Anti-patterns:**
- Do NOT call tool-executor with the *requesting user's* principal. Use the source's `principal_id` — that's the whole point of attribution. A workspace viewer must not be able to escalate via someone else's vault secrets.
- Do NOT keep an unbounded snapshot history. Cap at 50 per source via a periodic cleanup task (added in Phase 2).

### 1.4 Hosted page serving with isolation

**Subdomain split:**
- App and API: `<host>` (existing).
- Hosted artifact embeds: `artifacts.<host>` (new).

The subdomain split is the security invariant. It puts hosted user-influenced HTML on a different origin so it cannot read app cookies, ride `localStorage`, or hit `/api/*` directly with credentials.

**Implementation:**
- A new Elysia subapp registered to listen on the artifacts subdomain (or behind a reverse-proxy host header check). Single-binary deploy: same process, different `Host:` matcher.
- Self-hosted defaults: if `ARTIFACTS_HOST` env is unset, fall back to a path-prefix mode (`/__artifacts__/a/:slug`) with a documented security caveat — still sandbox via `<iframe sandbox>` from the main app, but no origin separation. Document this in `docs/CONFIGURATION.md`.

**CSP for `/a/:slug/embed`:**
```
default-src 'none';
connect-src 'self' wss://gateway.<host>;
script-src 'self' 'sha256-<artifact-client-sdk-hash>';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
frame-ancestors 'self' https://<host>;
```

**Outer page `/a/:slug`** wraps the embed in `<iframe sandbox="allow-scripts" src="/a/:slug/embed">`. The outer page is server-rendered with the chrome (title, refresh, share controls). Refresh button calls `POST /api/artifacts/:id/refresh` then reloads the iframe.

**V1 template rendering:**
- Server-side string replacement with safe expressions: `{{ data.<source>.<jsonpath> }}`, escaped via the same HTML-escape used elsewhere in the codebase.
- Three built-in templates in `src/core/artifacts/templates/`: `dashboard.html`, `news.html`, `table.html`. `html` (raw) and `rss` types route to bespoke renderers.
- No `<script>` from user-supplied content in V1 — only the fixed SDK script tag (Phase 2). Strip via a sanitizer if anything sneaks in.

**Anti-patterns:**
- Do NOT enable `allow-same-origin` on the iframe in path-prefix mode — that breaks the only isolation we have.
- Do NOT inline data into the HTML if it's large; for V1 it's acceptable for declarative templates because the snapshot is server-fetched; for Phase 2 push-driven updates the SDK fetches via `/api/artifacts/:id/data/:source`.

### 1.5 Agent-authoring tools

**New tool group** `src/tools/artifacts/` registered in the existing tool registry:

- `create_live_artifact({ type, title, template, visibility, sources })` — returns `{ id, slug, url }`.
- `update_live_artifact({ id, title?, template?, visibility? })` — creates new version.
- `add_artifact_data_source({ artifactId, name, kind, config, refresh_seconds })`.
- `remove_artifact_data_source({ artifactId, sourceId })`.
- `refresh_live_artifact({ id })` — returns new snapshots.

**Documentation references:**
- Tool definition pattern: any existing tool group in `src/tools/` — mirror filesystem or github group structure.
- Tool registration: existing tool registry (look for the tools index file in `src/tools/`).
- Permission gating: artifact-write tools must be gated by the existing 3-tier ALLOW/ASK/DENY system. Default permission: `ASK` for `create_live_artifact` and `update_live_artifact` until a user-level `auto-approve artifact tools` toggle is set.

**Verification:**
- [ ] Agent can create + populate an artifact end-to-end via tools.
- [ ] Agent in workspace A cannot create an artifact in workspace B (principal/workspace check at tool-executor layer).

### 1.6 Sharing & visibility (V1: `private`, `workspace`, `signed`)

- `private` — only `created_by_user_id` can access.
- `workspace` (default) — any session in the artifact's `workspace_id`.
- `signed` — server adds `?t=<token>` to a generated URL; token resolves to a short-lived artifact-scoped JWT redeemed at page load. Token in `artifact_share_links.token_hash` (sha256).
- `public` — V3 only.

**Auth flow on `/a/:slug`:**
1. If session cookie / Bearer present → use existing session auth, check `workspace_id` membership and visibility.
2. Else if `?t=<token>` → look up `artifact_share_links` by hash, verify `expires_at`, mint a short-lived (5-min) artifact-scoped JWT, set as cookie scoped to the artifacts subdomain.
3. Else → 404 (do not 401; 401 leaks existence).

**Anti-patterns:**
- Do NOT log raw share-link tokens. Log only the hash + last 4 chars.
- Do NOT make share links idempotent by URL; revocation must be effective immediately by checking `revoked_at` on every read.

### 1.7 Web UI (Next.js)

`web/app/artifacts/`:
- `page.tsx` — list view: title, type, last refresh, source health badges.
- `[id]/page.tsx` — detail view: outer chrome wrapping `<iframe src={artifactsHost + '/a/' + slug + '/embed'}>`, side panel for versions, sources, refresh, share-link.
- `new/page.tsx` — wizard: pick type → choose template → add sources → save.

Reuse `web/lib/api.ts` HTTP client and the existing auth context.

**Verification:**
- [ ] Page loads, iframe renders, refresh button updates content.
- [ ] Cross-workspace artifact ID typed into URL → 404.

### 1.8 Phase 1 acceptance

- Bun unit tests for repos, refresh, template render. Coverage target: >80% on new modules.
- Playwright E2E: agent creates artifact via chat → user opens URL → sees rendered data → clicks refresh → sees updated data.
- Migration runs on PGlite + Postgres without warnings.

---

## Phase 2 — Live updates, scheduling, more sources, sharing polish

### 2.1 Scheduler-driven recurring refresh

Each `artifact_data_sources` row registers a recurring task on octipus's existing scheduler (`src/core/scheduler.ts`):
- Task id: `artifact:refresh:{sourceId}`.
- Interval: `refresh_seconds`.
- Wake-gate: skip if no one has loaded the artifact in the last `max(2 * refresh_seconds, 1h)`. This prevents idle artifacts from grinding on tools forever.

**Documentation references:**
- Recurring task registration: existing scheduler API. Look at how cron hooks register today.
- Wake-gate pattern: `src/core/scheduler.ts` — read existing wake-gate code and use the HTTP/tool-based gate variant.

**Lifecycle:**
- Source created/updated → upsert recurring task.
- Source deleted → cancel task.
- Artifact deleted → cascade-cancel all source tasks.

### 2.2 Live push via gateway WS + SDK

**Protocol additions** in `src/core/gateway/protocol.ts`:
- inbound: `artifact.subscribe { artifactId, token }`
- outbound: `artifact.data_updated { artifactId, sourceName, snapshotId }`
- outbound: `artifact.version_updated { artifactId, versionId }`
- outbound: `artifact.source_error { artifactId, sourceName, error }`

Channel naming: `artifact:{artifactId}` on the existing pub-sub bus.

**SDK** — `web/public/octipus-artifact-client.js` (built with esbuild as part of the Next.js build, output with deterministic content hash):
- Reads artifact-scoped JWT from a `<meta name="octipus-artifact-token">` tag injected at server-render time.
- Connects to `wss://gateway.<host>/gateway` (existing endpoint).
- Sends `artifact.subscribe`.
- On `data_updated`: fetches `/api/artifacts/:id/data/:sourceName`, calls the template's `render(data)` to produce a DOM patch, swaps the relevant `data-bind="<sourceName>"` element.
- Reconnects with exponential backoff; flushes a "stale" badge if disconnected >30s.

**SDK SRI:** the `<script src="/octipus-artifact-client.js" integrity="sha256-...">` hash is pinned in CSP, computed at build time, baked into the embed renderer.

**Anti-patterns:**
- Do NOT use the user's session JWT for the artifact subscription. Mint a separate short-lived artifact-scoped token at embed render time, audience `artifact:<id>`, that the gateway hub validates against the artifact's visibility.
- Do NOT push the snapshot payload over WS — push the *event* (snapshotId), then SDK fetches via REST. This keeps WS messages small and lets caching headers work.

### 2.3 Versioning UI

- `GET /api/artifacts/:id/versions` already exists from Phase 1.
- Add `GET /api/artifacts/:id/versions/:versionId/diff?against=<otherVersionId>` — server-side text diff (use a small diff library; `diff` package is fine).
- Add `POST /api/artifacts/:id/versions/:versionId/restore` — creates a new version cloning the chosen one.
- Web UI: side panel lists versions with timestamp + change_summary; click to view diff; "Restore" button.

### 2.4 Source kinds: `http`, `mcp`, `skill_query`

- `http` — config `{ url, method, headers?, body?, jsonpath? }`. Uses the existing HTTP tool; `headers` may include `${vault.<key>}` references resolved via vault.ts at refresh time under the source's principal.
- `mcp` — config `{ server, tool, params }`. Calls a registered MCP server through `src/mcp/`.
- `skill_query` — config `{ skill, prompt }`. Runs a skill in a one-shot, non-interactive mode and uses its returned JSON. **Caveat:** model calls cost money and tokens; document a workspace-level rate limit setting before enabling.

### 2.5 RSS export

`GET /a/:slug.rss` renders the artifact's news/RSS-typed sources as a syndicated feed. Items deduplicated across sources by URL. Useful for monitoring an octipus artifact in any external RSS reader.

### 2.6 Snapshot retention & cleanup

Periodic task `artifacts:cleanup` (runs every 1h):
- Per source, keep latest 50 snapshots. Delete older.
- Delete soft-deleted artifacts older than 30 days (and cascade).
- Revoke share links past `expires_at`.

### 2.7 Phase 2 acceptance

- E2E: open artifact → wait for scheduled refresh → verify DOM updates without manual reload.
- Stress test: 100 simultaneous viewers on one artifact → single source refresh → all viewers receive update within 2s p95.
- Disconnect/reconnect: kill WS mid-session → SDK reconnects, fetches latest snapshot, no duplicate updates.

---

## Phase 3 — Custom JS, public artifacts, hooks, embed allow-list

### 3.1 Custom JS bundles

- Authoring: artifact source includes a `script.js` and optional `style.css`. On save, server runs esbuild to produce a self-contained bundle, computes sha256, stores in `data/artifacts/<artifactId>/<versionId>/bundle.js` (consistent with self-hosted ethos — no S3 dependency).
- CSP: `script-src 'self' 'sha256-<sdk-hash>' 'sha256-<bundle-hash>'`. Per-version bundle hash is added to CSP at embed render time.
- The bundle gets the same scoped token + WS subscription helper from the SDK; it can call `octipus.subscribe(sourceName, callback)` and `octipus.fetchData(sourceName)`.
- Build sandboxing: reject imports outside an allow-list; no `fs`, no `child_process`, no network at build time.

### 3.2 Public visibility

- New value `public` for `artifacts.visibility`.
- A workspace-level setting `artifacts.allow_public` defaults to `false`.
- Each tool manifest gains a `safe_for_public_artifacts: boolean` flag. Sources whose tools lack the flag (or whose `kind` is `mcp`/`skill_query`) are auto-rejected when the artifact's visibility is set to `public`.
- Public artifacts are served without auth, with strong rate limiting (per-IP) and a `noindex` meta tag by default unless the creator opts in.

### 3.3 Hooks

New events for the existing hook manager (`src/hooks/manager.ts`):
- `artifact:created`
- `artifact:updated`
- `artifact:data_refreshed` (per source)
- `artifact:viewed` (per page load — sampled to avoid hook spam)

Use cases: auto-post a Slack message when a dashboard's "errors" source crosses a threshold; trigger a downstream agent run when an RSS source has new items.

### 3.4 Embed elsewhere (third-party iframe allow-list)

- Per-artifact `allowed_embed_origins: string[]`. CSP `frame-ancestors` includes those origins.
- A workspace-level allow-list backstops it.

### 3.5 Phase 3 acceptance

- Custom JS bundle: write a small charting artifact using a local copy of a charting library; verify CSP doesn't block; verify cross-version SRI works.
- Public artifact: open in an incognito browser, no auth, rate-limit kicks in past N requests/min/IP.
- Hook fires: `artifact:data_refreshed` triggers a webhook; payload includes `artifactId`, `sourceName`, snapshot summary.

---

## Open Architectural Decisions (decide before Phase 1 starts)

1. **Subdomain vs path-prefix isolation for the embed.** Strong recommendation: subdomain (`artifacts.<host>`) when `ARTIFACTS_HOST` is configured; fall back to path-prefix with a security caveat in docs. This must be settled before 1.4.
2. **Custom JS in V1 or only declarative templates?** Recommendation: declarative only in V1, custom JS in Phase 3. Every CSP/sandbox bug becomes a cross-tenant leak with custom JS in the mix; Phase 1 must be auditably small.
3. **Are public artifacts in scope at all?** Recommendation: gate behind a workspace setting, off by default, Phase 3 only.
4. **Storage for custom JS bundles.** Recommendation: filesystem under `data/artifacts/` to match the self-hosted ethos. Postgres bytea is rejected (size, replication cost). S3-compatible is rejected (new deploy dep).
5. **Artifact-scoped JWT signing key** — reuse the existing session signing key, or mint a separate key? Recommendation: separate key with separate rotation, scoped audience `artifact:*`, so an artifact token leak cannot impersonate a session.

---

## Appendix A — Gateway Protocol Additions (canonical reference)

```ts
// inbound (client → server)
type ArtifactSubscribe = {
  type: 'artifact.subscribe';
  artifactId: string;
  token: string; // artifact-scoped JWT, audience artifact:<id>
};

// outbound (server → client)
type ArtifactDataUpdated = {
  type: 'artifact.data_updated';
  artifactId: string;
  sourceName: string;
  snapshotId: string;
  capturedAt: string; // ISO8601
};

type ArtifactVersionUpdated = {
  type: 'artifact.version_updated';
  artifactId: string;
  versionId: string;
};

type ArtifactSourceError = {
  type: 'artifact.source_error';
  artifactId: string;
  sourceName: string;
  error: string;
};
```

Add to the Zod protocol union in `src/core/gateway/protocol.ts`.

---

## Appendix B — File Map (new code)

```
src/
├── api/routes/artifacts.ts                # REST handlers
├── api/routes/artifact-pages.ts           # /a/:slug, /a/:slug/embed (subdomain mounted)
├── core/artifacts/
│   ├── refresh.ts                         # Source dispatch + snapshot write
│   ├── render.ts                          # Server-side template render
│   ├── templates/
│   │   ├── dashboard.html
│   │   ├── news.html
│   │   ├── table.html
│   │   └── rss.xml
│   ├── share-link.ts                      # Mint/verify signed links
│   └── token.ts                           # Artifact-scoped JWT mint/verify
├── db/schema/
│   ├── artifacts.ts
│   ├── artifact-versions.ts
│   ├── artifact-data-sources.ts
│   ├── artifact-data-snapshots.ts
│   └── artifact-share-links.ts
├── db/repositories/artifacts-repo.ts
├── db/migrations/<next>_artifacts.sql
└── tools/artifacts/                       # Agent-authoring tools
    ├── create.ts
    ├── update.ts
    ├── add-source.ts
    ├── remove-source.ts
    └── refresh.ts

web/
├── app/artifacts/
│   ├── page.tsx
│   ├── [id]/page.tsx
│   └── new/page.tsx
└── public/octipus-artifact-client.js      # Built by esbuild, SRI-pinned

docs/
└── ARTIFACTS.md                           # User-facing docs (ship with Phase 1)
```
