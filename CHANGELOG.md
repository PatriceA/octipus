# Changelog

Notable changes worth calling out for operators and integrators.
The format draws from [Keep a Changelog](https://keepachangelog.com)
without forcing strict semver — Octipus is pre-1.0; "minor" / "major"
labels reflect blast radius, not contract guarantees.

## Unreleased

### Multi-user + TUI follow-ups (2026-05 batch b)

Carry-overs from the May feature work — the Web UI / org-shared
resources / vault workspace / SSO / billing / TUI iteration v2
items the prior multi-user and pi-tui PRs deferred.

#### Web

- **Workspace + org pickers.** `WorkspaceProvider` now wraps the
  app under `AuthProvider`. Header gets a workspace combobox that
  lists the user's workspaces, supports inline "Create
  workspace…", and (for admins) shortcuts to `/admin/orgs`. The
  picker writes the active workspace id to `localStorage` under
  `octipus.activeWorkspace` and tells the API client the active
  *slug*, which is sent on every request as `X-Octipus-Workspace`.
- **Admin orgs page** at `/admin/orgs`: list, create, expand to
  view members. Uses the existing `/api/admin/orgs` surface; gated
  on `multiuser.orgWorkspaces` (returns 404 → page renders an
  inline "feature is disabled" hint).
- **Secrets page** wires the active workspace through: GET `/vault`
  passes `?workspaceId=<id>`, the Add modal exposes a Scope select
  (User / Workspace) when a workspace is active, and workspace-scoped
  secrets are listed alongside user-scoped ones.

#### Backend

- **`org_id` on `model_config` and `skills`** (migration `0042`).
  Visibility rule `org_id IS NULL OR user_id = U OR org_id IN
  org_members(U)` lives in `src/services/org-membership.ts` and is
  applied by `SkillRepository.findAll`, the `/api/skills` GET, and
  the new `ModelRegistry.getModelsForUser` (admins still see
  everything via the existing `getAllModelsIncludeDisabled`). New
  endpoints: `POST /api/admin/orgs/:id/{models,skills}` to assign
  rows to an org, `DELETE` to unassign.
- **Vault `scope=workspace` on the route.** POST accepts `scope`
  (`system | user | workspace`) + `workspaceId`; GET accepts
  `?workspaceId=` and forwards it to `vault.list`. The DEK
  derivation, encryption, and read path landed in Phase 4
  follow-up; this is the route surface that exposes them.
- **SCIM 2.0** at `/api/scim/v2`: List / Get / Create / PATCH /
  DELETE Users + List Groups, RFC-7643/7644 shapes. Per-org Bearer
  auth — the token is stored in vault under `scope='system'` and
  referenced by `org_sso_config.scim_token_vault_ref`. Auth-guard
  exempts `/api/scim/`; the routes do their own bearer check.
- **SAML SSO** at `/api/saml/:orgSlug/{metadata,login,acs}`,
  fully implemented via `samlify`. Migration `0043_org_sso_config`
  adds the per-org config (entityId, ssoUrl, x509Cert, attributeMap,
  plus the SCIM token ref). On a successful ACS the handler
  verifies the assertion signature, maps attributes via the org's
  `samlAttributeMap` (defaults match Okta/Azure AD/OneLogin),
  upserts the user, ensures `org_members` membership, and mints
  the same `session_token` HttpOnly cookie the password-login
  path uses. RelayState is honored but sanitized to same-origin
  paths. New `GET/PATCH /api/admin/orgs/:id/sso` endpoint and
  admin web page at `/admin/orgs/[id]/sso` for IdP paste-in
  config (entity ID, SSO URL, x509 cert, attribute map, SCIM
  toggle + vault-ref). Schema validator defaults to a noop;
  operators wanting strict XSD validation can install
  `@authenio/samlify-xsd-schema-validator` and set
  `SAML_SCHEMA_VALIDATOR=strict`.
- **Billing hooks.** `BillingProvider` interface
  (`src/services/billing/provider.ts`) with `noop` (default) and
  `stripe` (stub) implementations, env-gated by `BILLING_PROVIDER`.
  `CostTracker.logUsage` fires `recordUsage` after every cost-log
  insert — fire-and-forget so a billing outage never blocks chat.
  New `GET /api/admin/orgs/:id/usage` aggregates spend per org
  (joins `cost_log` to `org_members`).

#### TUI

- **Tree-sitter highlighter.** `web-tree-sitter` +
  `tree-sitter-{typescript,python,rust,go,java}` are dependencies;
  grammar `.wasm` files load directly from `node_modules/` via
  `Bun.resolveSync`. `setHighlighter()` is hooked at startup; the
  buffer-oriented adapter parses on `setSource(lang, text)` (called
  on every `openFile`) and caches per-line tokens. Falls back to
  the regex highlighter on grammar-load failure or for languages
  without a grammar (markdown, yaml, …).
- **Workspace-switch instant reconnect.** `GatewayAdapter` gained
  `reconnectWithWorkspace(slug)` — closes the WS, swaps the slug,
  reuses the exponential-backoff reconnect. New `/workspace
  <slug>` slash command (or `/workspace -` for the default).
- **Scrollable messages pane.** PageUp / PageDown move
  `scrollOffset` in 30-row pages; an `↓ N newer messages`
  indicator surfaces when the user is reading history. New
  messages auto-pin to the bottom *only* when the user is
  already there, so a long agent reply mid-scroll doesn't yank
  history away.
- **Vim named registers + IME-aware INSERT.** `VimState.registers`
  is a `Record<string, string>` keyed by register name. `"x` in
  NORMAL mode selects the register for the next `y` / `d` / `p`,
  then resets to the default `"` register. New `VimKey.composing`
  flag suppresses leader matching during IME composition so a
  multi-byte CJK / dead-key sequence can't fire `gg` / `dd` /
  `yy` mid-compose.

#### Migrations

- `0042_org_scoped_models_skills.sql` — adds `org_id` columns + indexes.
- `0043_org_sso_config.sql` — per-org SAML + SCIM config.

Both are additive and idempotent (`IF NOT EXISTS`); single-user
installs see no behavior change.

### Multi-user is the default

Multi-user isolation (`multiuser.enabled`, `enforcePermissions`,
`orgWorkspaces`) flipped from opt-in to default-on. The
`MASTER_KEY` Bearer fallback is suppressed by default — every
HTTP and WebSocket request now must carry either a real session
token (cookie, after logging in) or a personal `octi_…` api
token. Existing installs that want the legacy single-user path
can set `MULTIUSER=false` in `.env`.

#### Master key role
- Stays as the **vault encryption root** (HKDF derives per-user
  DEKs from it). Rotating the master key still goes through
  `scripts/rotate-vault-keys.ts`.
- No longer authenticates HTTP / WS clients on its own. The
  Bearer fallback remains only when `multiuser.enabled=false`.

#### MCP / CLI clients — automatic bootstrap token
- On startup (when multi-user is on), the backend mints a
  personal api token named `mcp-bootstrap` for the first active
  admin user and writes the plaintext to `~/.octipus/mcp-token`
  (mode 600). Idempotent — a second restart keeps the existing
  token if the file + DB row are still valid.
- `bin/octi` now reads `~/.octipus/mcp-token` first when
  regenerating `.mcp.json` and the user-scope `gemini mcp`
  registration. The .mcp.json regen is called twice during
  `octi start` — once before launching the backend (so legacy
  installs still work) and once after backend health (so the
  freshly minted bootstrap token lands in the file). Rotating
  the MCP key is now `rm ~/.octipus/mcp-token` then
  `octi restart`.

#### WebSocket gateway accepts api-tokens
- `connection-manager.ts:auth_method=api_key` previously matched
  only against `MASTER_KEY`. It now validates `octi_…` tokens
  against the `api_tokens` table (the same path the REST `.derive`
  middleware uses) and only honors `MASTER_KEY` when multi-user
  is off. The browser extension's WS connection now works with
  any personal api token from Settings → API Tokens.

#### Bug fixes from the QA exercise
See the previous Unreleased entries — this release rolls them in:
session 404 status leak, missing `multiuser.orgWorkspaces` registry
entry, env-var fallback dead in `settings-service.warmCache`, admin
sidebar nav, impersonation banner placement, and `session.token`
splicing for `/admin/impersonate/*`.



### TUI rewrite on pi-tui

Both terminal surfaces — the chat shell (`octi tui`,
`src/tui-pi/`) and the editor (`octi edit`, `src/tui-editor/`) —
were rewritten on top of [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui),
replacing the previous Ink (React for the terminal) implementation.

#### Why
- Pi-tui's differential renderer is materially faster on long chats
  and large file buffers (only changed cells are written; no virtual
  DOM diff).
- The same `Editor` primitive backs **both** the chat composer and
  the file-buffer editor, so paste markers, undo, history nav,
  fuzzy file completion (`@…`, `./…`), and slash-command
  autocomplete behave identically across surfaces.
- Pi-tui exposes a small `KeybindingsManager` we extend with app
  ids (`app.palette.open`, `app.tree.toggle`, …) and let users
  override via `~/.octipus/keybindings.json`.

#### Chat shell (`octi tui`)
- Status bar + welcome + scrolling messages pane (markdown for
  assistant, plain wrap for user/system).
- Composer with slash command + fuzzy file autocomplete.
- Activity line (live tool spinner with hold-on-completion).
- Permission prompt overlay, command palette (`Ctrl+P` / `F4`).
- TUI-local commands `/exit`, `/quit`, `/cost`, `/project`
  short-circuit before hitting the gateway; everything else flows
  through the standard slash registry.

#### Editor (`octi edit`)
- Three-pane layout (file tree / buffers / chat) with `Ctrl+B`,
  `Alt+J`, `Ctrl+\` toggling and `Alt+,` / `Alt+.` cycling buffers.
- File picker (`Ctrl+O`) with case-insensitive substring filter on
  the relative path.
- Find / replace overlays, diff overlay (accept/reject agent edits),
  workspace picker, MCP server list, scrollable hotkeys overlay (`F5`).
- Vim mode toggle (`editorMode: 'modeless' | 'vim'`) covering
  hjkl / w / b / 0 / $ / gg / G / i / a / o / O / v / x / dd / yy
  / p / u / Ctrl+R, with VISUAL-mode delete + yank.
- Persisted layout / cursor / open-buffer state at
  `~/.octipus/tui-editor.json`.
- New `octi edit` command in `bin/octi`.

#### Key-binding rationale (defaults avoid terminal collisions)
- `Ctrl+M`, `Ctrl+H`, `Ctrl+J`, `Ctrl+I`, `Ctrl+[` are
  indistinguishable from `Enter`, `Backspace`, `LF`, `Tab`, `Esc`
  on terminals without the Kitty keyboard protocol — none are
  bound by default. (`Ctrl+H` was previously `app.replace.open`
  and `Ctrl+M` was `app.mcp.list`; both silently ate `Enter` /
  `Backspace` in overlays.)
- `Ctrl+Tab` doesn't reach most terminals — buffer cycle moved to
  `Alt+,` / `Alt+.` (also `F2` / `F3`).
- `F1` is hijacked by many terminals as a help key — hotkeys
  overlay rebound to `F5`.

#### Glyphs
- Tree / status emojis replaced with a glyph table that defaults
  to ASCII (`[+]`, `·`, `❯`) on terminals whose fonts lack the
  emoji subset, and switches to emoji only when a known
  emoji-capable terminal is detected (`kitty`, `wezterm`,
  `iterm.app`, `vscode`, `apple_terminal`, `ghostty`). Override
  with `OCTIPUS_TUI_ICONS=emoji|ascii`.

#### E2E tests
- New harness at `tests/tui/harness.ts` (spawn under fixed
  `COLUMNS` / `LINES`, send raw bytes, ANSI-strip, `waitFor`).
- Suites `tests/tui/chat.e2e.test.ts`, `tests/tui/editor.e2e.test.ts`
  cover launch, focus cycling, slash commands, the picker filter,
  the command palette, and `/quit` exit code. Skipped when the
  gateway isn't reachable.

#### Notable bug fixes during the rewrite
- Chat submit dropped to a no-op because the editor's
  `submitValue()` clears state *before* invoking `onSubmit`, and
  the host then read back the (empty) state via
  `getExpandedText()`. Now uses the `rawText` argument the editor
  passes through.
- Editor pane height collapsed to the floor (5 rows) via a
  feedback loop where `setHeight(N)` was sourced from the previous
  render's `editorLines.length`. Heights now derive from
  `tui.terminal.rows` directly.
- Markdown hyperlinks (`OSC 8`) leaked into the visible-width
  count so cursor moves shifted the editor↔chat divider in by ~7
  cells. `SplitPane.fitTo` uses pi-tui's `visibleWidth` (CSI + OSC
  + wide-char aware).
- Hotkeys overlay shrank instead of scrolling — it now reads the
  terminal height (matching the 85% `maxHeight` in
  `overlays/registry.ts`), reserves rows for chrome, and emits a
  fixed-size viewport every render with a position indicator.

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
| `multiuser.enabled` | `MULTIUSER` | `true` | Master switch. Strict scoped reads, audit logging, and MASTER_KEY bypass disabled. Opt out with `MULTIUSER=false` for the legacy single-user / MASTER_KEY path. |
| `multiuser.auditShadow` | `MULTIUSER_AUDIT_SHADOW` | `true` | Writes one `audit_log` row per state-changing API request (no behavioral effect). |
| `multiuser.enforcePermissions` | `MULTIUSER_ENFORCE_PERMISSIONS` | `true` | Orchestrator gate: every tool call goes through `checkToolCall`. The legacy `isSystemUser` bypass is honored only when this is `false`. |
| `multiuser.rlsEnabled` | `MULTIUSER_RLS` | `false` | Sets the RLS GUC on every authenticated query. PGlite ignores. Requires a non-superuser app role; opt-in. |
| `multiuser.orgWorkspaces` | `MULTIUSER_ORG_WORKSPACES` | `true` | Enables `/api/me/workspaces`, `/api/me/orgs`, `/api/admin/orgs`, the workspace resolver, and scopedRepo workspace filtering. |
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
