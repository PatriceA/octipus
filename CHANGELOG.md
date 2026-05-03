# Changelog

Notable changes worth calling out for operators and integrators.
The format draws from [Keep a Changelog](https://keepachangelog.com)
without forcing strict semver — Octipus is pre-1.0; "minor" / "major"
labels reflect blast radius, not contract guarantees.

## Unreleased

Nothing pending right now. The multi-user track closed; the TUI
editor track is in flight on a separate branch.

## 2026-05 — Multi-user feature complete

The multi-user architecture has reached feature completeness across
five phased PRs (0–4 + Phase 4 follow-ups). Every behavioral change
is gated behind a feature flag that defaults off; existing single-
user installs see byte-for-byte unchanged behavior until an operator
flips a flag.

Full design + per-phase rationale lives in
[`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md).
Manual validation steps in
[`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise).

### Added

- **Identity primitives.** `Principal` type + `principalFromUser` /
  `principalFromMasterKey` / `ANONYMOUS_PRINCIPAL` /
  `SYSTEM_PRINCIPAL`. Server `.derive()` produces it on every
  request alongside the legacy `user`.
- **Scoped repositories.** `scopedRepos(principal)` factory wraps
  eight entities (sessions, messages, agents, documents,
  notifications, trajectories, hooks, pipelines). Cross-tenant
  reads collapse to `null`/`[]` so attackers can't enumerate UUIDs.
- **Vault scoping.** `scope` enum (`system`/`user`/`workspace`),
  per-user data-encryption keys via
  `HKDF(masterKey, salt=userId, info=scope:userId)`, opportunistic
  v1 → v2 re-encryption on read,
  `scripts/rotate-vault-keys.ts` for batch rotation, master-key
  rotation tooling (`scripts/rotate-master-key.ts`).
- **Per-user workspace filesystem.** `WorkspaceFS.forAgent(ctx)`
  with traversal / absolute-path / symlink-escape blocks.
  Filesystem tools rewired through it so single-user (flat) and
  per-user (nested) layouts share one call site.
- **Personal access tokens.** `octi_<43-char-base64url>` Bearer
  format with SHA-256 hash storage. `/api/auth/api-tokens` CRUD
  + web UI under `/settings/api-tokens`. Lets CI / MCP /
  scripted clients authenticate as a real user.
- **Admin console.** `/admin/users`, `/admin/audit`,
  `/admin/quotas`, `/admin/impersonate`. User CRUD, audit log
  viewer with filters, per-user quota dashboard, "Act as" with
  banner.
- **Channel binding.** `channel_identities` table + manager with
  O(1) `(channel_type, external_id)` lookup. JSONB fallback +
  lazy backfill for legacy bindings. Web `/link-account` page
  + 6-character one-time codes.
- **Postgres Row-Level Security.** 19 user-owned tables get
  `enable rls + policy` with the "bypass on missing GUC" pattern.
  `withRlsPrincipal(principal, fn)` / `withRlsBypass(fn)`
  wrappers. Defense-in-depth alongside the application-layer
  scoping.
- **Quotas.** Per-user concurrent-agents / daily-tokens /
  API-rate caps. Admin REST + web; runtime enforcement in
  `agent-manager.spawn()`, `agent-worker` pre-LLM-call, and the
  rate-limit middleware. `QuotaExceededError` returned as `429`.
- **Admin impersonation.** `impersonation_sessions` table +
  `ImpersonationManager`. Server `.derive()` swaps the request's
  identity to the target user but stamps `principal.actorUserId`
  so audit can dual-tag (every state-changing request writes one
  row keyed under the actor and one under the target).
- **Shell sandbox.** bubblewrap / firejail wrapper
  (`security.shellSandbox = 'off' | 'auto' | 'required'`) for the
  shell tool. Pairs with WorkspaceFS for filesystem-level +
  process-level isolation.
- **Docker tool isolation.** Per-user `octipus.user_id=<uuid>`
  label + `octipus_user_<short-uuid>` bridge network.
  `list_containers` filters; targeted ops verify ownership via
  `docker inspect` and surface mismatches as "container not
  found" so attackers can't enumerate.
- **Org / workspace scaffolding.** `organizations` +
  `org_members` + `workspaces` tables.
  `OrgWorkspaceManager` with admin-gated org CRUD, per-user
  workspace CRUD, atomic default-promotion via tx, "cannot
  delete default" guard.
- **Workspace_id adoption.** Nullable `workspace_id` on every
  user-owned table (sessions, documents, hooks, agents,
  notifications, trajectory_runs, pipelines, embeddings,
  agent_events, swarm_nodes, vault). FK `ON DELETE SET NULL`
  so workspace deletion falls back to user-level rather than
  cascading. ScopedRepos filter on
  `(workspace_id = $1 OR workspace_id IS NULL)` and stamp the
  principal's workspaceId onto new rows.
- **Workspace resolver.** `X-Octipus-Workspace` request header
  (slug / uuid / `all` / `default`) maps to a workspace owned by
  the principal. Cross-tenant headers collapse to default.
- **Backfill script.** `scripts/backfill-workspace-id.ts` walks
  every user, ensures a default workspace, and updates rows
  with NULL `workspace_id` across all 11 user-owned tables.
  Idempotent (`--dry-run`, `--user=<uuid>`).
- **REST surface.** `/api/me/workspaces` + `/api/me/orgs`
  (caller-scoped) and `/api/admin/orgs` (admin) surface the
  org/workspace data.

### Configuration

New feature flags (all default off):

| Flag | Env | Default | Effect |
|------|-----|---------|--------|
| `multiuser.enabled` | `MULTIUSER` | `false` | Master switch. Turning it on enables strict scoped reads, audit logging, and rejects MASTER_KEY bypass. |
| `multiuser.auditShadow` | `MULTIUSER_AUDIT_SHADOW` | `true` | Writes one `audit_log` row per state-changing API request (no behavioral effect). |
| `multiuser.enforcePermissions` | `MULTIUSER_ENFORCE_PERMISSIONS` | `false` | Orchestrator gate: every tool call goes through `checkToolCall`. |
| `multiuser.rlsEnabled` | `MULTIUSER_RLS` | `false` | Sets the RLS GUC on every authenticated query. PGlite ignores. |
| `multiuser.orgWorkspaces` | `MULTIUSER_ORG_WORKSPACES` | `false` | Enables `/api/me/workspaces`, `/api/me/orgs`, `/api/admin/orgs`, the workspace resolver, and scopedRepo workspace filtering. |
| `security.shellSandbox` | `SHELL_SANDBOX` | `off` | `off` / `auto` / `required` — wraps shell-tool spawns in bubblewrap/firejail. |
| `security.dockerIsolation` | `DOCKER_ISOLATION` | `off` | `off` / `enforce` — Docker tool per-user labels + networks. |

### Tests

- 11 new test files added under `src/security/` and
  `src/db/repositories/` covering the multi-user changes
  (scoped repos, vault DEK + isolation, RLS gating, quotas,
  impersonation, shell sandbox, docker isolation, orgs,
  workspace resolver, workspace-scoped repos, channel
  bindings).
- 6 isolation test files under `src/api/routes/` for
  cross-tenant 404 collapse on every changed route.
- Total impact: ≈ +130 multi-user tests.

### Documentation

- [`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md)
  — design doc, threat model, per-phase implementation notes.
- [`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise)
  — manual validation steps for the full multi-user feature.
- This `CHANGELOG.md`.

### Out of scope (future)

- Web UI workspace + org pickers (REST surface is in place).
- Org-shared resources (system models, shared skills) routed
  through `org_members` — needs `org_id` on `models` and
  `skills` first.
- SCIM provisioning + SAML SSO.
- Per-user billing hooks.
