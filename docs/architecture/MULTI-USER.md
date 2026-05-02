# Multi-User Architecture Plan

> Status: **Phases 0, 1a, 1b, 1c landed.** Phase 0 added the feature
> flag, Principal type, schema additions, and shadow-mode audit
> middleware. Phase 1a added scoped repositories with cross-tenant
> isolation enforced in SQL plus the API-route sweep. Phase 1b added
> vault scoping, per-user DEKs (HKDF), the WorkspaceFS sandbox, the
> vault rotation script, and the filesystem tool wiring. Phase 1c
> closed the cross-tenant gap on `permissionManager.approve/deny` and
> gated the legacy `isSystemUser` bypass on `multiuser.enforcePermissions`.
> Phase 2 (admin console, channel binding, API tokens UI) and Phase 3
> (Postgres RLS, shell sandbox, master-key rotation) still pending.
> Scope: extend Octipus from a single-tenant self-hosted instance into a
> central backend serving multiple authenticated users (and, optionally,
> organizations) with strict data, secret, and execution isolation.

## Phase 0 — what landed

- `multiuser.{enabled,auditShadow,enforcePermissions}` config flags
  (env: `MULTIUSER`, `MULTIUSER_AUDIT_SHADOW`,
  `MULTIUSER_ENFORCE_PERMISSIONS`). Defaults: `false`, `true`, `false`.
- `src/security/principal.ts` — `Principal` type + helpers
  (`principalFromUser`, `principalFromMasterKey`, `ANONYMOUS_PRINCIPAL`,
  `SYSTEM_PRINCIPAL`, `canActOnUser`).
- `src/api/server.ts` — auth `.derive()` now returns `principal`
  alongside the legacy `user` field; `MASTER_KEY` Bearer fallback is
  suppressed when `multiuser.enabled === true`.
- Migration `0029_multiuser_phase0.sql` — adds nullable owner columns
  (`embeddings.user_id`, `agent_events.user_id`, `swarm_nodes.user_id`,
  `hook_executions.user_id`, `users.org_id`) plus indexes, and the
  `audit_action='api_request'` enum value.
- `src/api/middleware/audit-shadow.ts` — Elysia plugin that writes one
  `audit_log` row per state-changing API request, gated on
  `multiuser.auditShadow`. Never blocks: any error is swallowed.
- Tests: principal helpers (8), `resourceTypeFromPath` (3), end-to-end
  audit middleware against ephemeral PGlite (7). Net +19 passing,
  zero regressions.

## Phase 1a — what landed

- `src/db/repositories/scoped.ts` — `scopedRepos(principal)` factory
  returning `ScopedSessionRepo`, `ScopedMessageRepo`, `ScopedAgentRepo`,
  `ScopedDocumentRepo`. Every default read filters by
  `principal.userId`; cross-tenant reads return `null` / `[]` so the
  caller can't distinguish from "row does not exist", blocking UUID
  enumeration. Mutations check ownership in the WHERE clause and strip
  `user_id` from caller-supplied patches. Admins get widened reads via
  `isAdmin(principal)`; admin-only methods (`listAllAdmin`) throw for
  non-admins.
- Cross-tenant isolation tests (`scoped.isolation.test.ts`, 21 tests
  against PGlite) cover every method on every scoped repo.
- `/api/sessions` route fully converted: every handler now goes through
  `scopedRepos(principal)`; the hand-rolled per-handler "is admin or
  owner?" checks are gone — the scope IS the check.
- Route-level isolation test (`sessions.isolation.test.ts`, 6 tests)
  proves user A cannot read/list/mutate/delete user B's sessions or
  messages through the actual Elysia handler.
- `apiContext` now exposes `principal` to all routes (anonymous default
  for unauthenticated requests).
- Net +27 passing tests, zero regressions.

## Phase 1a — sweep complete

The follow-up sweep converted every per-user-data route to
`scopedRepos(principal)`:

- **agents + documents** — DB-history reads scoped; documents 403→404
  to prevent ID enumeration.
- **notifications** — fixed cross-tenant `markRead` (any user could
  flip any notification's read flag); list/count already user-scoped.
- **trajectories** — fixed cross-tenant list (every user's runs were
  visible); admins still see all.
- **chat** — `getPendingApprovals` was global (leaked pending
  approvals between users); `resolveApproval` had no ownership check.
  ApprovalRequest gained `userId` + `sessionId`; `peek(requestId)`
  added so callers verify ownership before resolving.
- **hooks + recurring-tasks** — all per-id endpoints (GET, PATCH,
  DELETE, toggle, test, executions) use scoped lookups.
- **pipelines** — `findById` for pipelines; **closed two complete-bypass
  gaps** on `PUT /pipelines/templates/:id` and `DELETE
  /pipelines/templates/:id` (pre-Phase-1a these had NO auth check —
  any authenticated user could mutate any template, including system
  presets).

ScopedRepos bundle now exposes: `sessions, messages, agents, documents,
notifications, trajectories, hooks, pipelines`. Every member is
Principal-bound; cross-tenant reads return null/[] (collapsing 403/404
to 404 across the board).

Cumulative test count: **1061 pass / 9 fail / 62 skip** (the 9 are the
same pre-existing StdioTransport failures from before Phase 0). Net
+24 cross-tenant isolation tests across hooks, pipelines, chat,
notifications, trajectories — all backed by ephemeral PGlite, no
Docker required.

Routes that intentionally stay unscoped: `/api/auth/*`, `/api/health/*`,
`/api/webhooks/*`, `/api/oauth/*` (different threat models).

## Phase 1b — vault scoping, per-user DEKs, WorkspaceFS

Three commits, each independently shippable:

### Phase 1b-1 — vault scope enum + strict reads
- New `vault.scope` enum (`system | user | workspace`) with backfill:
  legacy `user_id='system'` → `scope='system'`; everything else →
  `scope='user'`. NOT NULL after backfill.
- `getSystemSecret(name)` is now strict — pre-Phase-1b it had a
  fallback that scanned ALL users' secrets, leaking another user's
  private key under the right conditions. The fallback is gone.
- New `vault.getForAgent({ userId, toolId, agentId }, name)` is the
  scope-aware lookup the secret-injector uses: user → system, with
  the per-row `allowed_tools` / `allowed_agents` allowlist applied.
- 12 PGlite-backed isolation tests covering scope reads,
  cross-tenant denial, allowlist enforcement.

### Phase 1b-2 — per-user data-encryption keys (DEK)
- New `vault.key_version` column. v1 = legacy PBKDF2 (single key for
  every row). v2 = HKDF(masterKey, salt=userId, info=`scope:userId`).
- `deriveDek(masterKey, scope, userId)` in `src/utils/crypto.ts` —
  deterministic per (master, scope, user) triple. Same call always
  yields the same key, so DEKs are never persisted.
- New writes default to v2. Reads dispatch on `key_version`, fall
  through legacy schemes if needed, and opportunistically re-encrypt
  to v2 on success (no batch-rotation tool yet — separate commit).
- Cross-user isolation: alice's ciphertext can't be decrypted with
  bob's DEK even if the master key is constant.
- 9 unit + integration tests against PGlite.

### Phase 1b-3 — WorkspaceFS path sandbox
- New `WorkspaceFS.forPrincipal(p)` in `src/security/workspace-fs.ts`.
  Per-user filesystem root at
  `$DATA_ROOT/users/{user_id}/workspaces/{workspace_id}/files/`.
- `resolve(userPath)` enforces:
  - relative paths land under root
  - absolute paths must be under root (or an extra-allowed prefix)
  - `..` traversal that escapes the root → throws
  - symlinks pointing outside the root → throws (via `realpath`)
  - null bytes / non-string inputs → throws
- Cross-tenant property: `aliceFs.resolve('foo')` and
  `bobFs.resolve('foo')` produce paths in disjoint trees; alice
  cannot reach bob's root via `../` traversal.
- 19 unit tests covering construction, relative paths, traversal,
  absolute paths, symlinks, cross-tenant disjoint roots, and the
  `extraAllowedPrefixes` escape hatch.

Phase 1b cumulative: **1101 pass / 9 fail / 62 skip** (the 9 are still
the pre-existing StdioTransport tests). Net +40 isolation tests across
1b-1, 1b-2, 1b-3.

### Phase 1b — cleanup landed

- **Vault key rotation script** (`scripts/rotate-vault-keys.ts`).
  Walks every `key_version=1` row and forces the lazy v1 → v2
  re-encrypt that `vault.get` does on read. `--dry-run` reports
  candidates without writing; `--batch=N` tunes batch size; rows that
  fail to decrypt stay at v1 and are logged so an operator can
  investigate without aborting the run. 3 PGlite tests.
- **Filesystem tool wiring**: `src/tools/filesystem/index.ts`'s
  `validatePath` now delegates to `WorkspaceFS.forAgent(context)`.
  Same call site, same exceptions; behavior diverges by config:
    - `multiuser.enabled=false` → flat root at `config.workspace.rootPath`
      (legacy single-user behavior, byte-for-byte identical).
    - `multiuser.enabled=true` → per-user root at
      `<workspace.rootPath>/users/{userId}/workspaces/default/files`.
  Both modes preserve `additionalPaths` and the legacy `/tmp/assistant-`
  prefix. `WorkspaceFS.withRoot` and `forAgent` factories added; new
  tests cover the flat root path and the legacy prefix back-compat.

Phase 1b totals: **1107 pass / 9 fail / 62 skip** (the 9 are still the
pre-existing StdioTransport tests). Net +46 isolation tests across
1b-1, 1b-2, 1b-3, plus the rotation + filesystem cleanup.

## Phase 1c — orchestrator permission gate

The chokepoint was already in place — `BaseTool.executeWithMiddleware`
calls `permissionManager.check(userId, toolId, action, args)` and on
ASK calls `requestApproval` then `waitForApproval`. Phase 1c closes
the gaps that made the chokepoint untrustworthy:

- **`approve` / `deny` cross-tenant gap.** Pre-Phase-1c the WHERE clause
  matched `(id = requestId AND status = 'pending')` only — no user
  filter. The gateway handler called `approve(requestId, ctx.userId)`
  but `ctx.userId` was used as the `resolvedBy` audit field, NOT the
  ownership filter. Any authenticated caller with a leaked requestId
  could approve or deny another user's pending request. Now the WHERE
  also requires `user_id = resolvedBy`; cross-tenant attempts return
  `false` (silent no-op, indistinguishable from "already resolved" or
  "doesn't exist"). New `{ admin: true }` opt-in lets the future admin
  console resolve any user's request.
- **`isSystemUser` bypass.** The legacy bypass that lets MCP / API
  bridges skip the permission prompt is now gated on
  `multiuser.enforcePermissions`. With the flag off, behavior is
  unchanged. With it on, every tool dispatch goes through
  `permissionManager.check` — system pseudo-users can no longer skip.
- **`getPendingRequests(userId)`** is already user-scoped (filters by
  `permission_requests.user_id`); verified and covered by tests.

Phase 1c totals: **1114 pass / 9 fail / 62 skip**, net +7 isolation
tests, zero regressions. With this commit, **every cross-tenant gap
identified in the original Phase 1 audit is closed.** Phase 1 is done.

## Phase 2a — personal access tokens (backend)

The `MASTER_KEY` Bearer fallback was the only non-browser auth path.
With `multiuser.enabled = true` it gets suppressed (Phase 0), which
means CI / MCP / scripted clients couldn't authenticate at all once
the flag flipped. Phase 2a fills that gap with proper per-user
personal access tokens.

- New `api_tokens` table (migration `0032`): `(id, user_id, name,
  token_hash, prefix, scopes, expires_at, last_used_at, revoked_at,
  metadata, created_at)`. `token_hash` is SHA-256 hex of the
  plaintext, unique-indexed for O(1) validation lookup.
- Token format: `octi_<43-char-base64url>` (32 bytes of randomness +
  a recognizable prefix). Plaintext is shown ONCE at creation; only
  the hash is persisted. The first 12 chars (`octi_abc1...`) are
  stored as `prefix` for display in the list view so users can
  identify tokens without revealing the secret.
- `src/security/api-tokens.ts` — `ApiTokenManager` with
  `issue / validate / listForUser / revoke / countActive`. Validation
  enforces revocation + expiry, updates `last_used_at` in the
  background, and uses `looksLikeApiToken()` as a cheap pre-check so
  non-token Bearer values skip the DB roundtrip.
- `.derive()` in `src/api/server.ts` now tries: (1) session token,
  (2) **api token** (new), (3) `MASTER_KEY` fallback if multiuser is
  off. The api-token path loads the user record and returns a normal
  `principalFromUser` — every downstream `scopedRepos(principal)`
  call works identically to a browser session login.
- `/api/auth/api-tokens` REST surface: `GET /` (list, no plaintext or
  hash), `POST /` (issue, plaintext returned exactly once,
  `201 Created`), `DELETE /:id` (revoke; cross-tenant attempts return
  `404` to prevent ID enumeration).
- 22 PGlite-backed tests: 15 unit (format, hash determinism, validate
  happy/revoked/expired/unknown/malformed, list scoping, cross-tenant
  revoke + admin override, double-revoke, countActive) and 7 route
  (POST 201 + plaintext, 401 on anonymous, 400 on bad date, GET shape
  doesn't leak hash, cross-tenant DELETE returns 404, owner can
  revoke). Verified resilient to the `commands.test.ts` `mock.module`
  ordering issue.

Phase 2a totals: **1136 pass / 9 fail / 62 skip**, net +22, zero
regressions. With this commit, deployments can flip
`MULTIUSER=true` without breaking CI / MCP / scripted clients —
operators just rotate from `MASTER_KEY` to per-user tokens before
the cutover.

The web UI (settings page + one-time copy modal + revoke button) is
the next slice (Phase 2b). Backend is mergeable on its own; admins /
CI can manage tokens via the REST API in the meantime.

## Phase 2b — API tokens web UI

Settings page gains an "API Tokens" tab between Security and Voice.
Three things happen here:

1. List existing tokens (no plaintext, no hash on the wire).
2. Generate a new token. The plaintext appears in a one-time copy
   modal that the user must dismiss explicitly. After dismissal the
   plaintext is gone from React state.
3. Revoke a token (with a confirm step — a misclick shouldn't kill
   a CI integration).

The plaintext modal is the load-bearing UX. Copy button uses
`navigator.clipboard.writeText` with a textarea fallback for older
browsers / `http://`. Active and revoked tokens are listed
separately; revoked rows stay visible (dimmed, struck through) for
audit. No backend changes — purely consumes the Phase 2a REST.

## Phase 2c — admin console (users + audit)

`/api/admin/*` routes guarded by `requireAdmin(ctx)`: anonymous → 401,
non-admin → 403. Admin → route body. Self-demotion and
self-deactivation guard returns 400 to prevent the only admin from
locking themselves out.

- `GET /api/admin/users` — list every user (no password hashes / TOTP
  secrets).
- `POST /api/admin/users` — create user; optional initial password
  (argon2id-hashed); `isAdmin / isActive` flags; audit row written.
- `PATCH /api/admin/users/:id` — update one user (email, password,
  isAdmin, isActive); audit row written; unknown id → 404.
- `GET /api/admin/audit` — filterable audit-log viewer (`action`,
  `userId`, `limit ≤ 1000`).

Web `/admin/*` tree gated by `useAuth().user.isAdmin` in
`AdminLayout`. Server-side check is the security boundary; the redirect
is purely UX so a non-admin doesn't land on a page where every API
call returns 403. `/admin/users` is a table with disable / enable +
grant / revoke admin actions; self-actions are disabled in the UI to
mirror the server's 400 guard. `/admin/audit` is a filterable viewer.

Out of scope for this slice: impersonation (start/stop with banner),
quotas dashboard (no per-user quotas instrumented yet), password
reset flow.

## Phase 2d — channel binding (table + helper + link-account flow)

The legacy `users.channelBindings` JSONB column was the only mapping
from a channel external_id (Telegram chat_id, Slack user_id, …) to an
Octipus user. That made channel-side lookups O(N) over the user
table and gave no place to enforce uniqueness — two users could
silently share the same external_id. Phase 2d replaces it with a
proper relational schema plus a one-time code flow for new bindings.

### Schema (migration `0033`)

- `channel_identities (id, user_id, channel_type, external_id,
  external_handle, metadata, verified_at, created_at)` with a unique
  index on `(channel_type, external_id)` so lookup is O(1).
- `channel_link_codes (id, code, channel_type, external_id,
  external_handle, expires_at, redeemed_at, redeemed_by_user_id,
  created_at)` for the one-time code redemption.

### `ChannelBindingManager` (`src/security/channel-bindings.ts`)

- `findUserByExternalId(channelType, externalId)` — checks
  `channel_identities` first, falls back to scanning the legacy JSONB
  column, opportunistically backfilling matches into the new table.
- `createPendingLink(channelType, externalId, externalHandle?)` —
  mints a 6-character code from an unambiguous alphabet
  (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `0/O`, `1/I/L`) with a 15
  min TTL.
- `redeem(userId, code)` — case-insensitive; rejects unknown,
  expired, or cross-user-claimed codes; idempotent for the same user
  re-redeeming their own code.
- `listForUser`, `unbind` (cross-tenant safe; admin override), and
  `reapStaleCodes` for housekeeping.

### REST surface

- `GET /api/auth/channel-bindings` — list the principal's bindings.
- `POST /api/auth/channel-bindings/redeem` — body `{ code }`.
  - 201 on success.
  - 400 on `unknown_code` / `expired` / `already_redeemed`.
  - 409 on `already_bound_to_another_user`.
- `DELETE /api/auth/channel-bindings/:channelType/:externalId` —
  unbind. Cross-tenant attempts return 404.

### Web `/link-account`

Authenticated page; if `?code=ABC123` arrives in the URL it pre-fills
the input. Big single-purpose code box, 6+ digit alphanumeric mask.
On success: green confirmation banner. On error: human-readable
message (`That code has expired. Send a fresh message in your channel
to get a new one.`). Lists existing bindings with an unbind button.

### Tests

- 11 unit (`channel-bindings.test.ts`): code shape, happy round-trip,
  case-insensitive redemption, unknown / expired / cross-user
  rejection, idempotent same-user replay, legacy-JSONB fallback +
  backfill, cross-tenant unbind.
- 7 route (`channel-bindings.isolation.test.ts`): GET 401/200,
  POST 201/400/409, DELETE 200/404 cross-tenant + owner.

### Out of scope for this slice (follow-ups)

- Channel adapters reading the new helper. Adapters today still call
  `userRepository.findByChannelBinding`; Phase 2e will swap them to
  `channelBindingManager.findUserByExternalId` so the adapter sends
  a deep-link reply when the lookup misses.
- Bulk migration of `users.channelBindings` JSONB → `channel_identities`
  (the lazy backfill on read does this incrementally, but a one-shot
  script would speed up the cutover).

## Phase 2 status

With 2a/2b/2c/2d landed:

- `MULTIUSER=true` is now safe to flip in production. CI / MCP /
  scripted clients use API tokens; admins can manage users via
  `/admin/users`; channel adapters can adopt the binding flow at
  their own pace.
- Phase 2 cumulative: **1164 pass / 9 fail / 62 skip** — same 9
  pre-existing StdioTransport failures, net **+50 isolation tests**
  across the four slices, zero regressions.
- Out: Phase 3 — Postgres RLS, master-key rotation, shell sandbox
  via bubblewrap, Docker-in-Docker per-user labels, optional
  org/workspace grouping layer.

---

## 1. Goals & Non-Goals

### Goals
1. **Identity** — every request, WebSocket frame, channel message, agent
   execution, and tool call is attributable to exactly one principal
   (user or service account).
2. **Isolation** — by default, no user can read, write, or influence
   another user's sessions, messages, files, embeddings, secrets,
   settings, or running agents.
3. **Permissioning** — the existing ALLOW / ASK / DENY tool permission
   model becomes *enforced* at the orchestrator/tool boundary, scoped per
   user.
4. **Administration** — admins can manage users, roles, quotas, system
   secrets, and audit history through a first-class UI and API.
5. **Backwards compatibility** — existing single-user `STORAGE_MODE=embedded`
   deployments continue to work; a single bootstrap user is created on
   first boot.
6. **Operability** — per-user quotas, rate limits, and audit make a shared
   instance safe to run.

### Non-Goals (this iteration)
- Full SaaS multi-tenancy with billing / metering / Stripe.
- Cross-region replication / sharding.
- End-to-end encryption of message content (vault remains AES-GCM at rest;
  server can read messages — required for orchestration).
- Marketplace / public skill sharing (covered by the existing roadmap).

### Threat Model
| Threat | In scope |
|---|---|
| Authenticated user A reads user B's session/messages/documents | Yes |
| Authenticated user A invokes an agent that exfiltrates user B's vault entry | Yes |
| Authenticated user A's filesystem tools escape into user B's workspace | Yes |
| Channel adapter (Telegram, Slack) impersonates a user | Yes |
| Compromised browser extension acts as another user | Yes |
| Admin abuse (impersonation without audit trail) | Yes |
| Network attacker (TLS termination) | Out — handled by reverse proxy |
| Physical disk theft (vault key derivation) | Partially — covered by `MASTER_KEY` rotation |

---

## 2. Tenancy Model

Two-layer model that degrades gracefully:

```
Organization (optional, default = "personal")
  └── User (required principal)
        └── Workspace (1..N per user; default = "default")
              └── Sessions, Documents, Embeddings, Hooks, …
```

- **User** is the canonical principal and the unit of isolation.
- **Organization** is an optional grouping for shared admin and shared
  resources (system models, shared skills). For single-tenant
  installs the default `personal` org is invisible.
- **Workspace** scopes data within a user — equivalent to a project.
  Sessions, documents, vault entries, hooks all belong to a workspace.
  This replaces the current global `WORKSPACE_ROOT`.

Every isolated row carries `(org_id, user_id, workspace_id)` (the latter
two nullable only for org-scoped or system-scoped data). All read paths
filter on `user_id` (or `org_id` for shared resources) before returning.

---

## 3. Identity & Authentication

### 3.1 Principals
| Principal | Source of truth | Use |
|---|---|---|
| `user` | `users` table | Human via web UI, channel, or API token |
| `service_account` | new `service_accounts` table | CI, MCP clients, browser ext |
| `system` | sentinel UUID | Background jobs (cron, compaction) |

### 3.2 Auth methods (already present, to be hardened)
- **Password + TOTP** — existing in `users.passwordHash`, `users.totpSecret`.
- **WebAuthn passkey** — existing in `users.passkeyCredentials`.
- **OAuth/SSO** — Google, GitHub, Slack, Teams; map external ID to local
  user via `oauth_identities` (new) instead of stuffing into `users`.
- **API tokens** — new `api_tokens` table: `token_hash`, `user_id`,
  `scopes[]`, `expires_at`, `last_used_at`. Display token once on
  creation. Bearer in `Authorization: Bearer otk_…`.
- **Channel binding** — Telegram chat IDs, Slack user IDs, etc. live in a
  new `channel_identities` table (one row per (channel, external_id)) so
  one user can bind multiple accounts and we can revoke individually.

### 3.3 Sessions (auth sessions, distinct from chat sessions)
- Rename current chat `sessions` table mental model is fine — it's
  already conversational. Auth sessions live in Redis keyed by an opaque
  token; row in `auth_sessions` (new) for revocation and audit.
- Web UI: HttpOnly + Secure + SameSite=Lax cookie containing the token.
  Drop localStorage usage in `web/lib/auth-context.tsx`. CSRF: double-submit
  cookie pattern on state-changing requests.
- WebSocket: token passed as `Sec-WebSocket-Protocol` subprotocol, validated
  in the gateway upgrade handler before the connection is accepted —
  **never** trust a `userId` field sent by the client over an open socket.

### 3.4 First-boot / migration
- On first boot with `STORAGE_MODE=embedded`, auto-provision a single
  `admin` user with a printed one-time password (or
  `ADMIN_BOOTSTRAP_TOKEN` env). All existing data is owned by that user.
- A migration script (`scripts/migrate-to-multiuser.ts`) backfills
  `user_id` columns where they're nullable today.

---

## 4. Authorization (Two Layers)

### 4.1 Layer 1 — Role-Based Access Control (system actions)
Coarse-grained, governs *administrative* and *system* operations.

| Role | Examples |
|---|---|
| `system_admin` | Manage users, system vault, model bindings, hooks for any user, view all audit |
| `org_admin` (multi-org only) | Manage users in their org, org-scoped settings |
| `user` | Default; full access to their own data |
| `viewer` | Read-only on their own data; no agent execution |

Stored in `users.roles text[]` (or pivot `user_roles` for org-scoped roles
once orgs land). RBAC is checked at API route entry via middleware.

### 4.2 Layer 2 — Permission Policies (agent/tool actions)
Reuse and **enforce** the existing `skill_permissions` schema:
`(user_id, tool_id, action, level, conditions, expires_at)` with levels
`ALLOW | ASK | DENY`.

Add a single chokepoint in the orchestrator:

```ts
// src/security/policy/check.ts (new)
async function checkToolCall(
  ctx: { userId: UUID; sessionId: UUID; agentId: UUID; workspaceId: UUID },
  toolId: string,
  action: 'read' | 'write' | 'execute',
  args: ToolArgs,
): Promise<'allow' | { ask: PermissionRequestId } | 'deny'>
```

`checkToolCall` is called from **every** tool invocation site (search the
codebase for the current direct dispatcher and route through this gate).
On `ask`, the orchestrator inserts a `permission_requests` row, pauses
the agent, emits a `permission.request` gateway event to the user's
client, and resumes when the response arrives or times out (deny on
timeout).

Conditions JSON (already in schema) supports:
- `path_pattern` — glob matched against resolved absolute path
- `time_window` — only weekdays 9–17, etc.
- `rate_limit` — N calls per window
- `network_allowlist` — for HTTP tools
- `redact_secrets` — strip vault values from logs

### 4.3 Default policies (seeded per new user)
Conservative defaults installed on user creation:
- Filesystem `read` / `write`: `ASK` outside the user's workspace.
- Shell `execute`: `ASK` always; `DENY` for `rm -rf`, `dd`, `mkfs`, etc.
- Network egress: `ALLOW` for HTTPS, `ASK` for non-standard ports.
- Vault read: `ALLOW` for own entries, `DENY` for `system` entries
  unless explicitly granted.
- Browser extension: `ASK` on first use of a new origin.

---

## 5. Data Isolation

### 5.1 Schema changes
Every row that today is implicitly global must carry an owner. Concrete
columns to add or backfill (NOT NULL after migration):

| Table | Add columns | Notes |
|---|---|---|
| `agents` | `user_id`, `workspace_id`, `session_id` | Agents are children of a session; cascade delete |
| `agent_events` | `user_id` (denormalized) | Hot-path filter; index `(user_id, ts)` |
| `swarm_nodes` | `user_id`, `session_id` | Already conceptually per-session |
| `embeddings` | `user_id`, `workspace_id`, `document_id` | Critical — currently global RAG |
| `documents` | `workspace_id` | `user_id` exists already |
| `hook_executions` | `user_id`, `workspace_id` | |
| `pipelines` | `user_id` (nullable for system pipelines), `org_id` | |
| `recurring_tasks` | `user_id`, `workspace_id` | |
| `notifications` | `user_id` | Likely present; verify NOT NULL |
| `audit` | `actor_user_id`, `target_user_id`, `org_id` | |
| `trajectory_runs` | `user_id`, `workspace_id` | |
| `settings` | `scope` enum (`system|org|user|workspace`), `scope_id` | Rework — see §8 |
| `vault` | `scope` enum (`system|user|workspace`), `scope_id` | Rework — see §6 |

New tables:
- `organizations` (id, name, slug, created_at, settings)
- `workspaces` (id, user_id, org_id, name, slug, root_path, created_at)
- `oauth_identities` (provider, external_id, user_id)
- `channel_identities` (channel_type, external_id, user_id, workspace_id)
- `api_tokens` (id, user_id, token_hash, scopes, expires_at, last_used_at, name)
- `auth_sessions` (id, user_id, created_at, expires_at, ip, user_agent, revoked_at)
- `service_accounts` (id, name, owner_user_id, scopes, created_at)
- `user_roles` (user_id, org_id nullable, role)

### 5.2 Defense-in-depth: Postgres Row-Level Security
Where feasible enable RLS so a query bug can't leak across tenants:

```sql
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_owner ON sessions
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

The DB connection pool sets `SET LOCAL app.current_user_id = $1` per
request inside a transaction. RLS is bypassed when the connection
authenticates as the migration role. PGlite (embedded mode) does not
support RLS — there application-layer filters are the only line of
defense.

### 5.3 Repository layer
Drizzle repositories under `src/db/repositories/` are refactored so every
query takes a `principal: Principal` parameter:

```ts
// src/db/repositories/sessions.ts
async function findSession(
  principal: Principal,
  sessionId: UUID,
): Promise<Session | null> {
  const row = await db.select().from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, principal.userId)))
    .limit(1);
  return row[0] ?? null;
}
```

Repositories never accept a raw `userId` string — only a `Principal`
constructed by middleware. This makes "forgot to filter" a type error,
not a runtime bug.

### 5.4 API enforcement
Every Elysia route under `src/api/routes/` gets:

```ts
.use(authGuard())          // populates ctx.principal or 401s
.use(rateLimit('user'))    // per-user bucket
.derive(({ principal }) => ({ repo: scopedRepos(principal) }))
```

`scopedRepos(principal)` returns repository instances with the principal
pre-bound, so route handlers cannot accidentally call an unscoped
repository.

---

## 6. Secrets & Vault

### 6.1 Scopes
Vault entries gain a `scope` column:
- `system` — readable only by system-admin tools (e.g., shared OpenAI
  key for orgs that pool quotas).
- `user` — owned by one user; default for personal API keys.
- `workspace` — shared across agents in one workspace; owned by user
  who created it.

A vault read query is always `(scope='user' AND scope_id=:userId) OR
(scope='workspace' AND scope_id=:workspaceId) OR (scope='system' AND
explicitly granted)`.

### 6.2 Tool/agent allowlist
The existing `allowed_tools` and `allowed_agents` columns become
**enforced** by the vault accessor. A vault entry is only handed to a
tool whose ID is in `allowed_tools`; otherwise the read raises a
`VaultAccessDenied` error logged to audit.

### 6.3 Encryption keys
- One `MASTER_KEY` (existing) derives a per-user data-encryption-key
  (DEK) via HKDF(`MASTER_KEY`, `salt=user_id`). Vault rows store
  `(iv, ciphertext, auth_tag)` encrypted with the per-user DEK.
- This isolates the blast radius if one DEK is somehow leaked and lays
  groundwork for KMS / per-user envelope encryption later.
- Key rotation: `scripts/rotate-master-key.ts` re-encrypts all rows in a
  background job; vault row carries `key_version`.

### 6.4 Secret injection
Today the orchestrator pulls vault entries unscoped. The replacement:

```ts
// src/security/vault/inject.ts (new)
async function injectSecrets(
  agent: AgentContext,            // carries userId, workspaceId, allowedTools
  toolId: string,
  template: string,               // "Authorization: Bearer ${secrets.openai_key}"
): Promise<string>
```

Resolution order: workspace → user → system (only if granted). Misses
become hard errors, never empty strings.

---

## 7. Sessions & Conversations

### 7.1 Ownership
`sessions.user_id` is already present; make it NOT NULL and add
`workspace_id`. Every API route handler verifies
`session.user_id === principal.user_id` *before* returning messages,
agent events, or accepting new input.

### 7.2 Sharing (later)
A future `session_shares (session_id, shared_with_user_id, role)` table
allows a user to grant read or comment access to a teammate. Out of
scope for v1; design the API to accept it later (`X-On-Behalf-Of`
header, denied unless a share row exists).

### 7.3 Channel binding integrity
`channel_identities` is the **only** mapping from a channel external ID
to a user. Channel adapters in `src/channels/*` resolve incoming
messages via this table; no fallback to `'local'` or `'system'`. If a
binding is missing, the channel replies with a one-time signup link
instead of routing to a default user.

---

## 8. Workspaces, Filesystem & Settings

### 8.1 Per-user workspace roots
Replace the global `WORKSPACE_ROOT` env with a per-user directory layout:

```
$DATA_ROOT/
  users/{user_id}/
    workspaces/{workspace_id}/
      files/        ← rootPath for that workspace
      documents/    ← uploaded docs
      cache/
  system/
    skills/         ← read-only seed data
    extensions/
```

Filesystem tools take a `WorkspaceFS` handle, not raw paths. `WorkspaceFS`:
- Resolves user-supplied paths relative to the workspace root.
- Rejects `..` traversal, absolute paths, and symlinks that escape root.
- Logs every read/write to the audit trail with the resolved absolute
  path.
- Optionally chroot's the spawned shell tool process (Linux user
  namespaces or `bwrap` when available).

### 8.2 Shell sandboxing
Shell tools currently run as the Octipus container user with full FS
access. Tighten:
- Run shell tools in a `bubblewrap`/`firejail` profile that bind-mounts
  only the user's workspace.
- For Docker-in-Docker tools, label spawned containers with
  `octipus.user_id=…` and a user-scoped network so a runaway container
  cannot reach another user's containers.
- Per-user CPU/memory cgroup limits via Docker `--cpus`/`--memory`.

### 8.3 Settings hierarchy
The `settings` table becomes hierarchical:

```
effective(key) = workspace[scope_id=ws] ?? user[scope_id=u] ?? org[scope_id=o] ?? system
```

- Bootstrap settings (`STORAGE_MODE`, `DATABASE_URL`, `MASTER_KEY`,
  `JWT_SECRET`, `SESSION_SECRET`) stay in env — never in DB.
- System settings (e.g., default model bindings) editable only by
  `system_admin`.
- User and workspace overrides (model preference, theme, default
  channel) editable by their owner.
- The settings service exposes `getSetting(principal, key, scopeOverride?)`
  and resolves through the chain.

`src/config/runtime-loader.ts` is rewritten to maintain a per-principal
lazy view rather than a single global config object. Hot-reload events
fan out to subscribers filtered by scope.

---

## 9. Knowledge Base / RAG / Embeddings

The current `embeddings` table is the most dangerous global pool — a
user's documents become retrievable as RAG context for *any other
user's* agent.

Required:
- Add `(user_id, workspace_id, document_id)` to embeddings; backfill
  from `documents`.
- All RAG queries filter by `user_id` (and optionally allow
  `workspace_id IN (…shared workspaces…)`).
- For the optional org/system knowledge base, embeddings carry
  `scope='org'|'system'`; agents may opt in to system knowledge but it
  is clearly separated in the prompt context.
- pgvector index becomes partial per-user where the volume justifies
  it, or a single index with the user_id filter pushed into the ANN
  query (HNSW + filter).

---

## 10. Channels (Telegram, Slack, Teams, WhatsApp, WebChat)

Channel adapters are reworked around `channel_identities`:

1. Inbound message arrives with `(channel_type, external_id)`.
2. Adapter looks up `channel_identities` to resolve `user_id`,
   `workspace_id`.
3. If not found: emit "binding required" reply with a deep-link to the
   web UI's "Link account" page (which generates a one-time code).
4. If found: build a `Principal` and hand off to the gateway exactly as
   a web-authenticated session would.

Outbound DMs to a user use the binding in reverse. Group/channel
contexts (e.g., Slack channel mentions) require an explicit
`group_bindings` row authorizing the bot to act there, and messages are
attributed to the user who triggered them.

---

## 11. Agent Execution Isolation

- Every spawned agent record carries `(user_id, workspace_id, session_id)`.
- Orchestrator queues are partitioned per user; a runaway user cannot
  starve others. Concurrency cap per user (default 5 agents, admin
  configurable).
- Token budgets: per-user daily / monthly token cap, evaluated on every
  LLM call. Soft warning at 80%, hard stop at 100%, surfaced in UI.
- Swarm tree (`swarm_nodes`) gets `user_id`; orphan reaper only reaps
  within a user.
- Trajectory log files split per user: `trajectory/{user_id}/YYYY-MM-DD.jsonl`.

---

## 12. Admin Console & User Administration

New web routes under `/admin` (system_admin only):

| Page | Capabilities |
|---|---|
| `/admin/users` | List, create, disable, reset password, force-logout, set role, set quotas |
| `/admin/users/[id]` | Profile, channel bindings, vault entries (metadata only — never plaintext), running agents, audit |
| `/admin/orgs` | (optional) Create/edit orgs, assign users |
| `/admin/system/settings` | Edit system-scope settings |
| `/admin/system/vault` | Manage system-scope secrets |
| `/admin/system/models` | Default model bindings, provider keys |
| `/admin/audit` | Filter audit log by user/action/time |
| `/admin/quotas` | Per-user limits dashboard |
| `/admin/impersonate` | Start an impersonation session — strongly audited |

Admin APIs sit under `/api/admin/*` and require both `system_admin` role
and a recent re-auth (`max_age=300s`). Impersonation creates an
`impersonation_sessions` row, banners the UI, and tags every action with
both the actor and the impersonated user in audit.

---

## 13. Audit & Compliance

- Every state-changing API call writes an `audit` row via middleware:
  `(actor_user_id, target_user_id, org_id, action, resource_type,
  resource_id, ip, user_agent, request_id, payload_hash, ts)`.
- Every tool invocation, vault read, settings write, permission
  decision, and admin action goes through audit.
- Per-user retention policy (default 90 days, admin-configurable).
- Audit log is append-only; users can read their own entries; admins can
  read all.
- Optional sink to external SIEM via webhook.

---

## 14. Rate Limiting & Quotas

| Limit | Scope | Default | Storage |
|---|---|---|---|
| API requests | user | 600/min | Redis sliding window |
| WebSocket messages | connection | 60/min | In-memory token bucket |
| Concurrent agents | user | 5 | DB count + Redis lock |
| LLM tokens | user/day | 1M (admin override) | Postgres counter |
| Tool executions | user/min | 120 | Redis |
| Auth attempts | IP + username | 10/15min | Redis, with lockout |

All limits surface as `429` with `Retry-After`; the UI shows quota
usage in the user menu.

---

## 15. API Surface Changes

- New base path `/api/v2` for all multi-user-aware endpoints. `/api/v1`
  remains for the bootstrap admin until extension consumers migrate.
- All `v2` endpoints require `Authorization: Bearer …` or a session
  cookie; anonymous mode is removed.
- `userId` query parameters are eliminated — the principal comes from
  the auth context only.
- Pagination, filtering, and listing endpoints always include
  `WHERE user_id = :principal` server-side; the client cannot widen.
- WebSocket `/gateway` upgrade requires auth; connection event payload
  is sanitized server-side; clients never send `userId` themselves.

---

## 16. MCP Server & Browser Extension

- **MCP server** (`mcp-server/`) — MCP clients (Claude Desktop, Claude
  Code) authenticate via API token. Each MCP connection is bound to one
  user; tool calls execute in that user's context.
- **Browser extension** — connection is upgraded with the user's API
  token (entered once in the popup, stored in extension's secure
  storage). The bridge endpoint validates the token and binds the
  connection to a `(user_id, workspace_id)` before forwarding any
  Playwright commands.

---

## 17. Where the Code Changes — Concrete Map

| Concern | Files / dirs to touch |
|---|---|
| Auth middleware | `src/api/middleware/auth-guard.ts` (rewrite — current Bearer-or-MASTER_KEY fallback must go) |
| Principal type | `src/security/principal.ts` (new) |
| Repositories | `src/db/repositories/**/*.ts` (every read/write takes `Principal`) |
| Schema migrations | `src/db/schema/*.ts` + `drizzle/migrations/*` |
| Vault accessor | `src/security/vault.ts`, `src/security/vault/inject.ts` |
| Permission gate | `src/security/policy/check.ts` (new); call sites in `src/core/orchestrator/worker-spawner.ts`, every `src/tools/*/index.ts` dispatcher |
| Settings hierarchy | `src/config/runtime-loader.ts`, `src/config/settings-service.ts` |
| Workspace FS | `src/security/workspace-fs.ts` (new); `src/tools/filesystem/*`, `src/tools/shell/*` |
| Gateway auth | `src/core/gateway/hub.ts` (upgrade handler), `src/core/gateway/message-handler.ts` (drop `'local'`/`'system'` fallback at L10–L24) |
| Channel bindings | `src/channels/*/handler.ts`, new `src/channels/binding-resolver.ts` |
| Embeddings filter | `src/core/rag/*.ts` |
| Admin API | `src/api/routes/admin/*.ts` (new) |
| Web auth | `web/lib/auth-context.tsx` (cookies not localStorage), `web/lib/api.ts` (CSRF) |
| Web admin pages | `web/app/admin/*` (new) |
| Quotas | `src/security/quotas.ts` (new); call from orchestrator and API middleware |
| Audit | `src/security/audit.ts` (new); middleware + repository hooks |
| MCP auth | `mcp-server/src/server.ts` |
| Extension auth | `browser-extension/src/background.ts`, `src/api/routes/browser-bridge.ts` |

---

## 18. Migration & Rollout Plan

### Phase 0 — Preparation (no behavior change)
- Land `Principal` type, `auth-guard` rewrite behind a feature flag
  (`MULTIUSER=false` keeps current behavior).
- Land schema additions as nullable columns; backfill in a script;
  flip to NOT NULL in a follow-up migration.
- Add audit middleware in shadow mode (writes rows, doesn't enforce).

### Phase 1 — Enforce isolation (breaking)
- Flip `MULTIUSER=true` default. Single-user installs auto-create the
  bootstrap admin and own all existing rows.
- Wire permission gate into orchestrator; defaults are permissive for
  the bootstrap user, restrictive for new users.
- Per-user workspaces; data migration script moves files into
  `$DATA_ROOT/users/{admin_id}/workspaces/default/files/`.

### Phase 2 — Admin & UX
- Ship `/admin/*` pages, user CRUD, quotas dashboard, audit viewer.
- Channel binding flow (signup link from Telegram/Slack).
- API tokens UI under user settings.

### Phase 3 — Hardening
- Postgres RLS turned on (external mode).
- Per-user DEKs; key rotation script.
- Shell sandboxing via bubblewrap; Docker-in-Docker per-user labels and
  network.
- Optional org layer.

### Phase 4 — Optional
- Session sharing.
- Org-shared knowledge base.
- SCIM provisioning, SAML SSO.
- Per-user billing hooks (token cost accounting already exists).

Each phase is independently shippable with a kill switch
(`MULTIUSER`, `ENFORCE_PERMISSIONS`, `RLS_ENABLED`,
`SHELL_SANDBOX_ENABLED`).

---

## 19. Testing Strategy

- **Authorization unit tests** per repository: "user A cannot read user
  B's row" matrix.
- **Integration tests** in `tests/multiuser/`: two-user fixtures hitting
  every API route, asserting cross-user reads return 404 and writes
  return 403.
- **Red-team plugin** (existing eval harness) gains a "cross-tenant
  exfiltration" suite — agent prompted to leak another user's data;
  must always fail.
- **Property test** on `WorkspaceFS`: random path inputs never resolve
  outside the workspace root.
- **Migration test**: snapshot of a v1 single-user DB → run migration →
  assert all rows owned by bootstrap admin and round-trip via v2 API.

---

## 20. Open Questions

1. **Org layer in v1 or v2?** Recommendation: ship users-only first;
   add `org_id` columns now (nullable) so the migration is cheap later.
2. **Session sharing UX?** Read-only share vs. comment vs. co-edit.
3. **Embedded mode (PGlite) multi-user?** Probably yes for small
   deployments, but RLS isn't available — application-layer filtering
   must be considered the security boundary.
4. **Shared agents / public skills?** Marketplace already on roadmap;
   needs signing + per-install permission review.
5. **Quota enforcement during streaming LLM calls** — abort
   mid-generation when quota exceeded vs. wait for next call?
6. **Anonymous read-only "share link" pages** for sessions/documents?
   Useful for support, but a cross-tenant leak risk; defer.

---

## 21. Estimated Effort

| Phase | Engineer-weeks |
|---|---|
| 0 — Preparation | 2 |
| 1 — Enforce isolation | 3 |
| 2 — Admin & UX | 2 |
| 3 — Hardening | 3 |
| **Total to production-ready multi-user** | **~10 weeks** for one engineer; ~5 weeks for a pair |

Schema is already 80% ready; the dominant cost is the enforcement
sweep through repositories, the orchestrator gate, and the admin UI.
