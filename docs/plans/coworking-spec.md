# Coworking — implementation spec

> **Spec, 2026-10-04.** This turns [coworking.md](coworking.md) (the concept)
> into buildable work, phase by phase, against the code on `main` at 6c47b51.
> Every statement about today's code carries a `file:line` reference so a
> reviewer can check it. Where the code contradicted the concept, the
> concept loses; those corrections are listed in §1.9.
>
> Nothing here is built. Phases S0–S6 are specified to the level of tables,
> functions and tests. S7 (several installs) is specified as a contract only,
> because it sits on the unbuilt federation transport of
> [workroom-and-swarm-federation.md](workroom-and-swarm-federation.md).

## Contents

- §1 What the code does today
- §2 Decisions
- §3 Security invariants
- §4 S0 — Groundwork (no sharing yet)
- §5 S1 — Shared spaces
- §6 S2 — Rooms
- §7 S3 — Live documents
- §8 S4 — Own models (bring your own agent)
- §9 S5 — Sponsored agent, team surface, group-channel bridge, space connectors
- §10 S6 — Guests and invite-only sign-up
- §11 S7 — Spaces across installs (contract)
- §12 Cross-cutting: config, migrations, catalog, docs, tests, PR slicing
- §13 Open questions

---

## 1. What the code does today

### 1.1 Ownership and isolation

- Every content row has one owner column, `user_id`, plus an optional
  `workspace_id`. `NULL` workspace means "visible in every workspace of this
  user" (`src/db/repositories/scoped.ts:110-117`).
- `scopedRepos(principal)` builds ten repos: sessions, messages, agents,
  documents, notifications, trajectories, hooks, pipelines, tasks (with
  comments), jobs (`scoped.ts:1368-1402`). Notes, artifacts, memories,
  knowledge links and embeddings have no scoped repo; they go through
  singleton repos that take a raw `userId`
  (`src/db/repositories/note-repository.ts`, `knowledge-link-repository.ts`,
  `src/core/memory/repository.ts`, `artifacts-repository.ts`).
- Admins skip the owner filter on by-id reads and writes, not only in
  `*Admin` methods (`scoped.ts:139,208,222`).
- Direct `userId` access outside the scoped repos is widespread:
  `sessionRepository` is used by 46 files, `messageRepository` by 14,
  `artifactsRepository` by 11.
- Postgres RLS policies exist (migrations 0034, 0035, 0038, 0085) but are never
  applied at runtime: `withRlsPrincipal` has no caller outside
  `src/security/rls.test.ts`, and `multiuser.rlsEnabled` defaults to false.
  Notes, tasks, task comments, artifacts, memories and knowledge links have no
  policy at all.

### 1.2 Workspaces

- `workspaces(id, user_id NOT NULL, slug, name, is_default, metadata)` with
  `UNIQUE(user_id, slug)` and one default per user
  (`src/db/schema/organizations.ts:74-88`, `src/db/migrations/0038_orgs_workspaces.sql:69,76-77`).
  There is no member table and no kind.
- The resolver accepts a UUID the caller owns or a `(user, slug)` match, and
  silently falls back to the caller's default for anything else
  (`src/security/workspace-resolver.ts:67-103`). The server derive swallows
  resolver errors (`src/api/server.ts:296-308`).
- The web client sends the workspace **slug** in `X-Octipus-Workspace`
  (`web/lib/workspace-context.tsx:129-132`, `web/lib/api.ts:114-116,199`).
  WebSockets carry no workspace.
- `OrgWorkspaceManager.findOwnedById / findOwnedBySlug / listOwn` filter on
  `workspaces.user_id` (`src/security/orgs.ts:388-411`). `transfer()` moves
  sessions, documents, hooks and workspace-scoped vault rows only
  (`orgs.ts:504-611`); notes, tasks, memories, artifacts, agents and links
  stay with the old owner.
- Deleting a workspace sets `workspace_id` to NULL on rows with a SET NULL
  foreign key (sessions, documents, hooks, agents, notifications, memories, …),
  which turns them into user-level rows of their author
  (`0039`, `0040`, `0053`). Tasks, notes, knowledge links, workspace repos and
  background jobs have no foreign key on `workspace_id` at all.

### 1.3 The agent ignores the selected workspace

- Each turn uses the requester's **default** workspace, not
  `sessions.workspace_id` and not the request header
  (`src/core/agent/service.ts:291-303`).
- WebSocket chat creates sessions without a workspace
  (`src/api/websocket.ts:281-288`); `resolveSession` creates missing sessions
  in the default workspace (`src/core/agent/session-resolver.ts:40-49`).
- The artifacts tool resolves the default workspace on every call
  (`src/tools/artifacts/index.ts:140-156`).
- `WorkspaceFS.forAgent` never passes a workspace, so every agent path roots
  at `users/{uid}/workspaces/default/files`
  (`src/security/workspace-fs.ts:126-142,171-212`).
- Shell `args.cwd` is not checked against the sandbox root
  (`src/tools/shell/index.ts:75,238-247`).
- Notes list ignores the workspace (`note-repository.ts:67-87`), and the
  notes routes take `workspaceId` from the request body without checking it
  (`src/api/routes/notes.ts:49,76,137,144`).

### 1.4 Sessions, turns and messages

- `sessions.user_id` is NOT NULL and is the only access key
  (`src/db/schema/sessions.ts:8`). `messages` has no author column; a user row's
  human is implied by the session owner (`src/db/schema/messages.ts`).
- Ownership is enforced at several independent points: `ScopedSessionRepo`
  (every route in `src/api/routes/sessions.ts`), `resolveSession`
  (`session-resolver.ts:36`), `handleMessage` (`service.ts:188-190`), the
  WebSocket steer paths (`websocket.ts:306-314,381`) and approvals
  (`src/security/permissions.ts:548`).
- The browser uses the legacy `/ws` socket (`web/app/chat/page.tsx:624`) and
  `/ws/permissions` (`web/lib/permission-context.tsx:153`), not the gateway
  hub. `/ws` keeps **one socket per user**: a new one closes the old with code
  4000 (`websocket.ts:46,80-85,206`). The map is used only for that and for
  cleanup on close (`websocket.ts:427-430`).
- Turns in a session queue in an in-process FIFO (`src/core/session-turn-lock.ts`).
  Over `/ws`, plain text sent while a root turn runs is **steered into that
  turn** (`websocket.ts:306-314` → `src/core/gateway/message-handler.ts:44-80`).
  `/stop` stops running agents only; queued turns still run
  (`src/core/commands/stop.ts`, `agent-manager.ts:546-555`).
- Shared-audience handling is one boolean, `sharedAudience =
  !!session.groupChannelId` (`service.ts:317`), repeated in the flow guard's DB
  lookup (`src/security/flow-guard.ts:270-291`), compaction
  (`src/core/agent/session-compaction.ts:205-207`), the learning processor
  (`src/core/learning/processor.ts:36-39`) and message aggregation
  (`sessions.ts:331-333`). When set, memories are neither loaded
  (`service.ts:624`, plan path `:470`) nor extracted (`:645-650`), and no
  learning job is queued (`:752-758`).
- The transcript holds user and assistant rows only, no speaker names
  (`src/core/session-history.ts:10-28`, `message-repository.ts:25-35`). The
  only attributed transcript is the fenced group block built from the chat
  platform (`src/core/channels/group-context.ts:85-162`).
- Sweeps: webchat sessions idle 7 days are archived and sessions idle past
  `sessions.retentionDays` are deleted; pinned sessions are exempt from both
  (`src/core/cron-runner.ts:121-145`, `session-repository.ts:319-380`).

### 1.5 Real-time

- The gateway hub drops events whose `userId` is set and differs from the
  connection's user (`src/core/gateway/hub.ts:103`), and **delivers events
  without a `userId` to every connection**. `/ws` has the same rule for root
  turn events and swarm events (`websocket.ts:113,162-171`).
- Swarm node events are published with `userId: undefined`
  (`src/core/agent/worker-spawner.ts:951-954`, `src/core/swarm/spawner.ts:2404-2420`),
  so every signed-in user's browser receives every other user's swarm node
  events. **This is a cross-user leak today**, fixed in S0.
- No presence, typing, cursor or CRDT code exists. `PresenceTracker` is never
  instantiated (`src/core/gateway/presence.ts`). No `yjs` dependency exists.
- Notes save is last-write-wins: the web posts the whole body
  (`web/app/notes/notes-workspace.tsx:104-116`) and the route has no version
  check (`notes.ts:42-64`). Session files have an optimistic 409 check that is
  not atomic (`src/core/session-files.ts:187-235`), and the agent's own file
  writes carry no version.
- Tasks emit nothing to the browser; the board polls every 30 s
  (`web/app/tasks/page.tsx:50,270-282`).

### 1.6 Tools and permissions

- `PermissionManager.check(userId, toolId, action, args, scope)` reads
  `skill_permissions` by `(user_id, tool_id, action)`, then the rule engine, then
  the manifest default (`src/security/permissions.ts:116-227`). Space, role and
  requester are not inputs.
- The default rule `filesystem(*)` is ALLOW (`src/security/permission-rules.ts:154`),
  so file writes need no approval unless a per-user policy exists.
- Both dispatch paths end in the pure `routeApproval`
  (`src/security/approval-policy.ts:96-119`): the agent loop
  (`src/core/tool-executor.ts:647-692`) and the BaseTool middleware
  (`src/tools/base-tool.ts:182-188`). MCP and connector handlers use only the
  first path; `tool:before` has no production subscriber.
- Approvals can be resolved only by the requester or an admin
  (`permissions.ts:537-548`).
- The flow guard marks reads as `private` for google-workspace and
  microsoft365 `*_read`, messaging read/list, email-processor and data
  (`flow-guard.ts:117-163`). Notes, memories and documents are not marked.

### 1.7 Models, cost and budgets

- Models are install-wide or org-wide: `model_config` has `org_id` and a
  globally unique `name`, no owner (`src/db/schema/models.ts:11,17`). The turn's
  model is picked without the user id (`src/core/agent/model-selector.ts:75-132`).
  `getModelForTopic` and `/model` ignore org visibility.
- Built-in providers read one install-wide key, env first then the system
  vault (`src/models/providers/anthropic-provider.ts:362-378`); the agent worker
  resolves `apiKeyRef` from the system vault only (`src/core/agent-worker.ts:2205-2212`).
- CLI models run with the server's `HOME`/`CODEX_HOME` and its
  `CLAUDE_CODE_OAUTH_TOKEN` (`src/core/cli-child-env.ts:15-17,34`).
- `cost_log` stores `user_id`, `session_id`, `agent_id`; no `workspace_id`, no
  funding (`models.ts:133-155`). Attribution flows through an async context
  (`src/models/providers/instrumented.ts:7-48`).
- Spend budget scopes are `user | role | workspace | group_channel`
  (`src/db/schema/spend-budgets.ts`, `0123_group_channel_budgets.sql`). The
  `group_channel` scope counts every member's rows through
  `sessions.group_channel_id` (`src/security/spend-budgets.ts:197-203`); the
  `workspace` scope counts only the budget owner's rows (`:208-212`). Every
  budget write is admin-only (`src/api/routes/admin.ts:331-490`).

### 1.8 Users and auth

- There is no single-user mode and no `multiuser.enabled` key; every request
  authenticates (`src/config/schema.ts:398-403`).
- `multiuser.orgWorkspaces` has four disagreeing defaults: `false` in the Zod
  schema (`schema.ts:443`), `true` in `src/config/defaults.ts:99`, `true` in the
  settings registry (`src/config/settings-registry.ts:1063-1070`), env-only in
  the legacy loader (`src/config/legacy-loader.ts:152`). A running server ends
  up `true`; `loadConfig()` in tests ends up `false`.
- **Deactivation does not end access.** `SessionManager.validate` checks only
  existence and expiry (`src/security/auth/session.ts:159-178`), and the server
  derive uses the session's snapshot of `isAdmin` (`server.ts:236-240`). The
  API-token path selects `id, username, isAdmin` without `isActive`
  (`server.ts:203-213`). Passkey login never checks `isActive`
  (`src/security/auth/passkey.ts`, `src/api/routes/auth.ts:531-555`).
  `revokeAllForUser` exists (`session.ts:292`) but nothing calls it.
- Self-registration is open and the first user becomes admin
  (`auth.ts:358-405`); no setting closes it.
- The install cannot send email; the only mail path is the user's own
  connected mailbox (`src/core/email/service.ts:200-215`).
- The login page always returns to `/` (`web/app/login/page.tsx:86,116`).
- Token patterns to copy: artifact share links store only `sha256`, return the
  raw token once, clamp expiry and check revocation on each read
  (`src/core/artifacts/share-link.ts:25-68`). Not to copy: the share-link
  revoke is not scoped to its artifact (`src/api/routes/artifacts.ts:546`,
  `artifacts-repository.ts:251-256`), and device pairing stores the raw code
  and redeems with a non-atomic get-then-delete (`src/api/routes/devices.ts:80-87`).

### 1.9 Corrections to the concept

| Concept said | Code says | Consequence |
|---|---|---|
| Space events go over the gateway socket | The browser uses `/ws`, not the gateway | Rooms, presence and co-editing extend `/ws` (§6.6) |
| `hub.ts:103` is the delivery rule | `/ws` has its own filters, and both leak user-less events | S0 fixes the leak first (§4.2) |
| `workspace_id` is "already on the nouns", so a space is cheap | The agent, its files and the artifacts tool ignore the workspace | S0 makes workspaces real for the agent (§4.4) |
| RLS gives defense in depth | RLS is never applied at runtime | Spaces rely on the access layer; RLS stays as it is (D11) |
| Vault `scope=workspace` is ready for space connectors | Workspace secrets are unreachable through `getByName` (`vault.ts:250-262,371-386`) and readable only by the storer | S0 fixes the read bug; space connectors get their own lookup (§9.5) |
| "Share into room" button after a personal read | The approval prompt already goes only to the requester | The approval is the consent; no separate button (D7) |
| Any editor answers space-changing approvals | Commenters get no write tools, so the requester of a write is always an editor | Approvals stay requester-only (D8) |
| A removed member loses access at once | Sessions and tokens outlive deactivation | Membership is read per request and per turn, never cached (D4) |

---

## 2. Decisions

Each decision states the choice and the reason. Later sections implement them.

- **D1 — A space is a workspace with `kind = 'shared'`.** No parallel table:
  `workspace_id` already exists on sessions, notes, tasks, documents, artifacts,
  memories and embeddings, and the resolver, picker and header key on it.
- **D2 — Two doors, never one wider door.** Personal access stays on
  `ScopedRepos` and the singleton repos keyed by `user_id`. Space access goes
  through a new `src/db/repositories/space.ts` keyed only by `workspace_id`
  after a membership check. Personal paths **never** return rows whose
  workspace is shared, including for the author and for admins (I2).
- **D3 — `user_id` on a space row means "author", not "owner".** It stays NOT
  NULL so audit and attribution keep working. It grants nothing.
- **D4 — Membership is read from the database on every request and at the
  start of every turn and tool call that touches a space.** No caching in
  sessions or sockets. This is what makes removal immediate.
- **D5 — Roles are code.** `owner | editor | commenter | viewer | guest`, with
  one `can(role, action)` table in `src/security/space-access.ts`. Changing it
  needs a code change and a test.
- **D6 — Rooms are sessions.** A room is a session with `kind = 'room'` in a
  shared workspace. `sessions.user_id` is the room's creator; access comes from
  space membership (open rooms) or `room_members` (private rooms). This keeps
  streaming, compaction, retention and the whole agent loop.
- **D7 — Every room turn runs as its requester.** `AgentContext.userId` is the
  requester, never the room creator. A room is a shared audience: private reads
  are raised to ASK and the prompt goes only to the requester, stating that the
  answer will be posted in the room. Approving is consenting to share. There is
  no separate "Share into room" step; private work belongs in the private side
  panel (§6.9).
- **D8 — Approvals stay requester-only.** A commenter's tools are capped to
  read-only (§5.7), so any write a room turn asks to approve was requested by an
  editor or owner, who can answer it.
- **D9 — Personal memories never enter a space session** (room or private
  session in a space): not loaded, not extracted, no learning. Space memory
  replaces them (§6.8).
- **D10 — The web keeps using `/ws`.** Rooms, presence and co-editing are new
  frames on `/ws`. The one-socket-per-user rule becomes a capped set of sockets
  per user (§6.6). Moving the browser to the gateway is a separate project.
- **D11 — No RLS work.** RLS is not applied today (§1.1). Adding membership
  policies that nothing enforces would be documentation, not defense. Isolation
  tests on the access layer are the guarantee.
- **D12 — Funding: "own" first, sponsor later.** Until S4, every attended turn
  is funded `own` by the requester using the install or org models the requester
  may use (a company install's models count as the member's own setup, as the
  concept says). S2 adds `cost_log.workspace_id` and `cost_log.funding` so
  history is correct from day one. S4 adds personal models; S5 adds the sponsor.
- **D13 — Install CLI models are personal subscriptions until an admin says
  otherwise.** In any space session they are excluded from model resolution
  unless the model row is marked `metadata.cliAgent.sharedUse: true` (§8.5).
  This enforces "a personal subscription only answers its owner".
- **D14 — Space deletion never releases content into personal scope.** A space
  is archived first and purged by an explicit job that deletes its rows; it is
  never removed through the `SET NULL` foreign keys (§5.9).
- **D15 — Single process.** Room fan-out, presence and document state live in
  memory, like the group buffer. Multi-process real time is out of scope and the
  docs say so.
- **D16 — One operator switch, `spaces.enabled`, default false.** This is a
  long-lived operator switch (some installs never want sharing), the kind the
  house rule allows (AGENT.md rule 9). With it off every space route returns
  404 and the picker shows no spaces. It requires `multiuser.orgWorkspaces`
  true; boot fails loudly otherwise.

---

## 3. Security invariants

Each invariant gets at least one test that drives the real route or tool path
(DESIGN.md: test that the guard rejects and that the shipping path reaches it).

- **I1 — Membership is the only door to space content.** No space row is
  reachable without a `workspace_members` row for the caller, read in the same
  request or turn.
- **I2 — Personal paths never return space rows.** `ScopedRepos`, the note,
  memory, link and artifact repos, embeddings search and every `*Admin` list
  exclude rows whose `workspace_id` names a shared workspace.
- **I3 — Non-members get 404.** Space ids, room ids, invite ids and member ids
  of other spaces answer 404, never 403.
- **I4 — No tool runs above the requester's role.** The role cap is applied in
  both dispatch paths, including MCP and connector handlers.
- **I5 — Removal is immediate.** After removal or role downgrade, the next
  request, the next tool call and the next turn see the new state; running turns
  of a removed member in that space are stopped; their room sockets are
  unsubscribed.
- **I6 — Personal data reaches a space only with the requester's consent.**
  Private reads in a room are ASK to the requester. A write into space content
  after a private read in a private space session is ASK (§5.8).
- **I7 — Personal memories never load in a space session.**
- **I8 — Invites are bearer secrets.** Only `sha256` is stored; redeem is one
  conditional UPDATE; revoke is scoped to its space; expiry is clamped.
- **I9 — Space content is never orphaned into a member's personal scope**, by
  deletion, transfer or removal.
- **I10 — Every membership, invite and role change writes an audit row** with
  the actor and the space.

---

## 4. S0 — Groundwork

S0 ships no sharing. It fixes what sharing would otherwise build on. It can
land as two PRs: S0a (§4.1–§4.3, security and config) and S0b (§4.4–§4.6).

### 4.1 Deactivation ends access

- **Derive.** After `sessionManager.validate` succeeds in the first
  `.derive()` (`server.ts:195`), read `users.is_active, is_admin, username` by
  primary key. Inactive → revoke the presented session token and continue as
  anonymous. Use the database `is_admin`, not the session snapshot. One indexed
  read per request; no cache (a cache would need a TTL tunable and would break D4).
- **API tokens.** Add `isActive` to the select at `server.ts:207`; inactive →
  anonymous.
- **Passkeys.** `/passkey/auth/verify` (`auth.ts:531-555`) rejects an inactive
  user with the same 401 as password login (`auth.ts:52-59`).
- **Device pairing.** The redeem at `devices.ts:80-99` rejects an inactive user.
- **Revocation.** `PATCH /api/admin/users/:id` with `isActive: false`
  (`admin.ts:121-172`) and SCIM deprovision (`src/api/routes/scim.ts:302-314`)
  call `sessionManager.revokeAllForUser(id)` and close the user's `/ws` sockets
  (new `closeUserSockets(userId, 4001, 'Account disabled')` in `websocket.ts`)
  and gateway connections (`connectionManager` by user).
- **WebSocket open.** `/ws` open (`websocket.ts:51-73`) re-checks `is_active`
  after validating the token.
- Tests: `src/api/auth-deactivation.isolation.test.ts` — session, API token and
  passkey of a deactivated user get 401; demoted admin loses admin routes on the
  next request; deactivation closes the socket.

### 4.2 No user-less events to users

- `/ws`: change the three filters `if (event.userId && event.userId !==
  session.userId) return` (`websocket.ts:113,163`) to
  `if (event.userId !== session.userId) return`.
- Gateway hub: events without `userId` go only to `system` and `local` trust
  connections (`hub.ts:103-110`), with one exception list
  `GLOBAL_EVENT_TYPES` in `src/core/gateway/protocol.ts` that starts empty.
- Stamp the user on the emitters that omit it: swarm node events
  (`worker-spawner.ts:951,1080,1136`, `swarm/spawner.ts:259,2408,2418`) take
  the user from the parent node; agent bridge events (`event-bridge.ts:69-101`)
  take it from the agent context; artifact events
  (`src/core/artifacts/events.ts:16-45`) gain `workspaceId` and are delivered to
  connections whose user owns that workspace (S1 extends this to members).
- Tests: a two-user `/ws` test proves user B receives none of user A's swarm or
  turn events; a hub unit test proves user-less events reach only system/local.

### 4.3 Config

- Pin `multiuser.orgWorkspaces` to default **true** in all four places
  (`schema.ts:443`, `defaults.ts:99`, `settings-registry.ts:1063-1070` with a
  corrected description, `legacy-loader.ts:152` reading the env only when set).
  Add a unit test that the four agree.
- Add `spacesConfigSchema` (`src/config/schema.ts`) under key `spaces`, with
  registry entries (`settings-registry.ts`, category `multiuser`) and env vars:

  | Key | Default | Validation | Env |
  |---|---|---|---|
  | `spaces.enabled` | `false` | boolean | `SPACES_ENABLED` |
  | `spaces.maxMembers` | `50` | int 2–1000 | `SPACES_MAX_MEMBERS` |
  | `spaces.inviteMaxTtlHours` | `720` | int 1–720 | `SPACES_INVITE_MAX_TTL_HOURS` |

  Later phases add their own keys in the same block (listed in §12.1). Every
  key must be read outside the config layer or
  `settings-registry.dead.test.ts` fails, so each key lands with its consumer.
- Boot check: `spaces.enabled && !multiuser.orgWorkspaces` throws at startup
  with a message naming both keys.

### 4.4 The turn uses the session's workspace

- `AgentService.handleMessageInner`: replace the default-workspace block
  (`service.ts:291-303`) with `turnWorkspace = session.workspaceId ??
  defaultWorkspace(userId)`. For a personal workspace, require
  `workspaces.user_id = userId`; otherwise fail the turn with "Session not
  found" (same message as `service.ts:190`). S1 adds the member branch.
- `/ws` `chat` frame gains optional `workspace` (UUID). When it creates a
  session (`websocket.ts:281-288`) it resolves the workspace through
  `resolveWorkspace` and stamps it, as REST does (`scoped.ts:189-199`).
- The web sends the active workspace **id** (not slug) in the header and in
  the `chat` frame: `api.setWorkspaceId` replaces `setWorkspaceSlug`
  (`web/lib/api.ts:89-94`). The resolver already accepts UUIDs.
- Switching workspace in the web clears the react-query cache
  (`queryClient.clear()`) and the chat page state; today only some pages refetch
  (`workspace-context.tsx`, note 03 §3).
- The artifacts tool uses `context.workspaceId`, falling back to the default
  only when absent (`src/tools/artifacts/index.ts:140-156` and its 9 call sites).
- Personal workspaces keep the per-user files root
  `users/{uid}/workspaces/default/files` (no file moves). Only spaces get their
  own root (§5.6).
- Tests: a turn in a session of a non-default personal workspace creates its
  task and artifact in that workspace; a WS-created session is stamped with the
  frame's workspace.

### 4.5 Notes honour the workspace

- `GET /api/notes` filters with the scoped rule `(workspace_id = $ws OR
  workspace_id IS NULL)` when the principal has a workspace
  (`note-repository.ts:67-120` gains a `workspaceId` parameter).
- `POST/PATCH /api/notes` ignore `body.workspaceId` and use
  `principal.workspaceId` (`notes.ts:49,76,137,144`). Remove the field from the
  body schema.
- `indexText` gains an optional `workspaceId` (`src/core/rag/embeddings.ts:361-371`);
  note and document indexing pass it (`src/core/knowledge/notes.ts:183-197`,
  `src/core/documents/processor.ts:931-953`).

### 4.6 Vault and shell fixes

- `Vault.getByName` returns workspace-scoped rows: after selecting the row it
  decrypts it under the row's own `(scope, user_id)` instead of calling
  `get(userId, id)` with the caller's inferred scope (`vault.ts:250-262,371-386`).
- `transfer()` refuses rows it cannot re-encrypt: for `scope='workspace'` v2
  rows it decrypts under the old owner and re-stores under the new owner in the
  same transaction (`orgs.ts:571-578`).
- Shell `args.cwd` must resolve inside the `WorkspaceFS` root or its allowed
  extras; otherwise the call fails with a clear error (`shell/index.ts:75`).
- Tests: a workspace secret round-trips through `getByName`; a transferred
  workspace secret still decrypts; a shell call with `cwd: '/etc'` fails.

---

## 5. S1 — Shared spaces

Users can create a space, invite members, and work on the same notes, tasks,
documents, artifacts and files, including with the agent in their own private
sessions inside the space. No shared chat yet.

### 5.1 Schema (migration `0125_spaces.sql`, journal idx 126)

Hand-written, idempotent SQL with `--> statement-breakpoint`, like 0121–0124.

```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';
ALTER TABLE workspaces ADD CONSTRAINT workspaces_kind_chk CHECK (kind IN ('personal','shared'));
ALTER TABLE workspaces ADD CONSTRAINT workspaces_shared_not_default_chk CHECK (kind = 'personal' OR is_default = false);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','commenter','viewer','guest')),
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('editor','commenter','viewer','guest')),
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  max_uses     integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 100),
  use_count    integer NOT NULL DEFAULT 0,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_invites_ws_idx ON workspace_invites(workspace_id);

-- Notes: one slug per space. De-duplicate legacy rows first (renaming the
-- younger duplicate to slug || '-' || left(id::text, 8)), then:
CREATE UNIQUE INDEX IF NOT EXISTS notes_ws_slug_uidx ON notes(workspace_id, slug) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_links_ws_to_idx ON knowledge_links(workspace_id, to_type, to_id);
CREATE INDEX IF NOT EXISTS embeddings_ws_idx ON embeddings(workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
CREATE INDEX IF NOT EXISTS audit_log_ws_created_idx ON audit_log(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
-- New audit_action enum values:
-- space_created, space_updated, space_archived, space_purged,
-- space_member_added, space_member_role_changed, space_member_removed,
-- space_invite_created, space_invite_revoked, space_invite_accepted,
-- space_content_changed
```

The existing `notes_user_ws_slug_uidx (user_id, workspace_id, slug)` stays; it
is implied by the new index for non-null workspaces and can be dropped later.
The Drizzle schema files (`organizations.ts`, `notes.ts`, `audit.ts`, new
`workspace-members.ts`) are updated by hand to match.

### 5.2 Roles

`src/security/space-access.ts`:

```ts
export const SPACE_ROLES = ['owner', 'editor', 'commenter', 'viewer', 'guest'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];
export type SpaceAction =
  | 'read' | 'comment' | 'write' | 'run_agent' | 'run_agent_write'
  | 'manage_members' | 'manage_invites' | 'manage_space';
export function can(role: SpaceRole, action: SpaceAction): boolean;
```

| Action | owner | editor | commenter | viewer | guest |
|---|---|---|---|---|---|
| read | ✓ | ✓ | ✓ | ✓ | ✓ (S6 scope) |
| comment (task comments, room messages) | ✓ | ✓ | ✓ | – | ✓ |
| write (notes, tasks, files, documents, artifacts) | ✓ | ✓ | – | – | – |
| run_agent (read-only tools) | ✓ | ✓ | ✓ | – | ✓ |
| run_agent_write (any tool the requester may use) | ✓ | ✓ | – | – | – |
| manage_invites | ✓ | – | – | – | – |
| manage_members | ✓ | – | – | – | – |
| manage_space (rename, archive, settings) | ✓ | – | – | – | – |

A space always has at least one owner: demoting or removing the last owner, or
the last owner leaving, fails with `last_owner`.

### 5.3 Workspace service changes (`src/security/orgs.ts`)

- `findOwnedById`, `findOwnedBySlug`, `listOwn` add `kind = 'personal'`
  (`orgs.ts:388-411`). The creator of a space is **not** its owner through
  `workspaces.user_id`; only `workspace_members` says who owns it. Without this
  the resolver would hand the creator a space with no membership check.
- `rename`, `delete`, `setDefault`, `transfer` refuse shared workspaces with
  `not_found` (they go through the space service instead).
- `createWorkspace` stays personal-only.

### 5.4 Space service (`src/core/spaces/service.ts`)

All functions take an actor `{ userId }`, read membership from the database,
and write one audit row with `workspace_id` set (I10).

- `createSpace(actor, { name, slug? })` → inserts `workspaces(kind='shared',
  user_id=actor)` and `workspace_members(role='owner')` in one transaction.
- `getMembership(userId, workspaceId) → { role } | null` — the single
  membership read; used by the resolver, repos, turns and sockets.
- `listSpaces(actor)` → spaces the actor is a member of, with role.
- `renameSpace`, `archiveSpace`, `unarchiveSpace` (owner).
- `listMembers` (any member), `setRole`, `removeMember`, `leaveSpace`
  (owner, or self for leave). Removal and downgrade call `onMembershipChanged`
  (§5.10).
- `maxMembers` from `spaces.maxMembers` is enforced on add.

### 5.5 Invites (`src/core/spaces/invites.ts`)

- `createInvite(actor, workspaceId, { role, expiresInHours, maxUses })` (owner):
  `token = generateToken(32)`, store `sha256(token)`, clamp
  `expiresInHours` to `[1, spaces.inviteMaxTtlHours]`, return the raw token once.
  `role = 'owner'` is rejected.
- `previewInvite(token)` → `{ spaceName, inviterName, role, expiresAt }` or
  404. No member list, no content.
- `acceptInvite(actor, token)`: one statement
  `UPDATE workspace_invites SET use_count = use_count + 1 WHERE token_hash = $1
  AND revoked_at IS NULL AND expires_at > now() AND use_count < max_uses
  RETURNING workspace_id, role`, then insert the membership with
  `ON CONFLICT DO NOTHING` (an existing member keeps their role and the use is
  refunded). Archived spaces reject.
- `revokeInvite(actor, workspaceId, inviteId)` updates
  `WHERE id = $2 AND workspace_id = $1` (not the share-link bug, §1.8).
- `listInvites(actor, workspaceId)` (owner) never returns token hashes.
- Delivery is a link only: the web shows `${origin}/join/<token>` with a copy
  button. The install has no mail transport (§1.8); sending from the inviter's
  mailbox is a later option, not in S1.

### 5.6 Access layer

**Principal.** `src/security/principal.ts` gains
`workspaceKind?: 'personal' | 'shared'` and `spaceRole?: SpaceRole`.

**Resolver.** `resolveWorkspace` (`workspace-resolver.ts:67-103`):

1. Owned personal workspace by id or slug → as today, `workspaceKind:
   'personal'`.
2. UUID of a shared workspace where `getMembership` returns a role and the
   space is not archived → `{ workspaceId, workspaceKind: 'shared', spaceRole }`.
   Archived spaces resolve read-only: the role is capped to `viewer`.
3. UUID of a shared workspace without membership → `{ workspaceId: null,
   denied: true }`. The derive sets `principal.workspaceDenied = true`, and a new
   guard after `authGuard` (`server.ts:310-315`) answers 404 `{error:'Not found'}`
   for every `/api` request carrying it. This is how a removed member's open tab
   learns, and the web resets to the default workspace on that 404.
4. Anything else → default, as today.

**Repos.** `src/db/repositories/space.ts` exports
`spaceRepos(principal): SpaceRepos`, which throws
`SpaceAccessError('not_found')` unless `principal.workspaceKind === 'shared'`
and `principal.spaceRole` is set. Every query filters `workspace_id = $space`
and nothing else; writes stamp `workspace_id = $space` and
`user_id = principal.userId` (author) and check `can(role, …)`.

- **Tasks.** Refactor `ScopedTaskRepo` (`scoped.ts:957-1362`) so its central
  `scope()` (`:1154-1159`) and insert stamping are injected:
  `new TaskRepo({ scope, stamp, canWrite })`. `ScopedTaskRepo` = owner +
  workspace filter + not-shared; `SpaceTaskRepo` = `workspace_id = $space`.
  Leases, checkout, structure checks and comments then work unchanged.
  `addComment` writes `task_comments.user_id = task.user_id` today
  (`scoped.ts:1252-1260`); in a space it writes the commenting member
  (author) and `listComments` filters by `task_id` only after the task passed
  the space scope. `wakeupContext` (`:1295-1347`) takes the same scope.
- **Notes.** New `SpaceNoteRepo` with the `NoteRepository` method set
  (`note-repository.ts`), filtering `workspace_id = $space`. `NoteService.save`
  (`src/core/knowledge/notes.ts:69-197`) takes a repo instead of a raw `userId`.
  Links and backlinks for space notes query by `workspace_id`
  (`knowledge-link-repository.ts`).
- **Documents.** `SpaceDocumentRepo`; uploads in a space go to
  `${documentsPath}/spaces/{id}/…` (`src/api/routes/documents.ts:36-47`).
- **Artifacts.** Already keyed by workspace (`artifacts.ts:20-48`). In a space,
  `private` means the creator only and is enforced on the REST routes (today it
  is not, note 05 §5). Public pages accept members
  (`artifact-pages.ts:68-77`: loop over owned workspaces **and** memberships).
- **Files.** `WorkspaceFS.forSpace(workspaceId, principal)` roots at
  `$DATA_ROOT/spaces/{workspaceId}/files`. `WorkspaceFS.forAgent(context)`
  returns it when `context.space` is set (§5.7).
- **Search.** Embedding search inside a space filters `workspace_id = $space`
  (`src/core/rag/embeddings.ts:681,757`); personal search excludes shared
  workspaces (I2).

**Dispatch.** `contentRepos(principal)` returns `spaceRepos` for a shared
principal and the personal repos otherwise. The routes for notes, tasks,
documents and artifacts switch to it, so the existing pages work inside a
space by switching the workspace picker. Hooks, pipelines, recurring tasks,
monitors, memories and personal sessions are **not** shared: in a space those
routes answer 404 (`spaces: personal-only routes`).

**I2 enforcement.** The personal filters gain `NOT EXISTS (SELECT 1 FROM
workspaces w WHERE w.id = <table>.workspace_id AND w.kind = 'shared')` for
notes, tasks, task comments (through the task), documents, artifacts,
memories, knowledge links and embeddings — in `ScopedRepos`, the singleton
repos and the `*Admin` lists. Sessions, agents, notifications, hooks and jobs
stay owner-scoped (a member's private session in a space is theirs, §5.7).

### 5.7 The agent inside a space (private sessions)

A member can open an ordinary chat while a space is selected. The session is
theirs (`sessions.user_id = member`, `workspace_id = space`), nobody else sees
it, and the agent works on space content.

- **Context.** `AgentContext` (`src/core/types.ts:6-40`) gains
  `space?: { id: string; role: SpaceRole }`. `handleMessageInner` sets it when
  the session's workspace is shared: it calls `getMembership`; no membership →
  the turn fails with "You are no longer a member of <space>"; a role without
  `run_agent` (viewer) → "Viewers can't run the agent in this space". Children
  inherit `space` like `workspaceId` (`worker-spawner.ts:699,861,901,1292`).
  `HookAgentContext` (`base-tool.ts:139-145`) carries it too.
- **Tools.** Tools that build a principal from context (`TasksTool.principalFor`,
  `src/tools/tasks/index.ts:299-311`, and the notes, documents, knowledge and
  artifacts tools) set `workspaceKind: 'shared'` and `spaceRole` from
  `context.space`, so `contentRepos` routes them to the space.
- **Role cap (I4).** `ApprovalContext` (`approval-policy.ts:13-30`) gains
  `roleCap?: 'read_only' | 'none'`. `routeApproval` returns `deny` when
  `roleCap === 'read_only'` and the action is not read-only. "Read-only" uses
  the existing signals: `isReadOnlyAction(action)` (`src/core/action-recovery.ts:24-26`)
  or a handler with `replaySafety: 'read_only'`; `shell`, `docker`, `git`,
  `browser*` and any `FILE_CHANGE_TOOLS` member (`tool-executor.ts:53-61`) are
  never read-only. Both dispatch paths pass it (`tool-executor.ts:684-692`,
  `base-tool.ts:185-188`). As a second layer, a commenter's turn is built with
  `stripMutatingTools` (`root-runner.ts:279`), as plan mode does.
- **Memories (I7).** A session in a shared workspace counts as
  `personalMemoryOff`: the same three switches as `sharedAudience` (load,
  per-turn extraction, compaction extraction) plus learning. Introduce one
  helper `sessionAudience(session) → { shared: boolean; personalMemoryOff:
  boolean }` in `src/core/agent/audience.ts` and use it at every site listed in
  §1.4. `remember_this` / `remember_about_self` are not offered in space
  sessions (`root-runner.ts:207`).
- **Personal data into the space (I6).** The flow guard gains a rule for space
  sessions: a write into space content (notes, tasks, documents, artifacts,
  files under the space root) after the session's label has `private` is
  raised to ASK, with the reason "This writes data from your personal sources
  into <space>, where N members can read it." Implemented in `applyFlowGuard`
  (`flow-guard.ts:348-365`) with the space id from the context.
- **Approvals** go to the requester as today; the session is private.

### 5.8 Routes (`src/api/routes/spaces.ts`, mounted in `server.ts`)

All routes: `requireSpacesEnabled` (404 when off), authenticated, TypeBox
bodies with `additionalProperties: false`, typed `SpaceError` → status map
(`invalid_*` 400, `not_found` 404, `forbidden_role` 404 for non-members and 403
for members lacking the role, `last_owner` 409, `space_full` 409, `archived` 409).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/spaces` | any user | spaces I'm a member of, with my role |
| POST | `/api/spaces` | any user | create; body `{name, slug?}` |
| GET | `/api/spaces/:id` | member | name, my role, member count, archived |
| PATCH | `/api/spaces/:id` | owner | `{name}` |
| POST | `/api/spaces/:id/archive` / `unarchive` | owner | |
| GET | `/api/spaces/:id/members` | member | `{userId, username, role, joinedAt}` |
| PATCH | `/api/spaces/:id/members/:userId` | owner | `{role}` |
| DELETE | `/api/spaces/:id/members/:userId` | owner, or self | |
| GET | `/api/spaces/:id/invites` | owner | no hashes |
| POST | `/api/spaces/:id/invites` | owner | `{role, expiresInHours?, maxUses?}` → `{id, token, expiresAt}` |
| DELETE | `/api/spaces/:id/invites/:inviteId` | owner | scoped to the space |
| GET | `/api/invites/:token` | public | preview; added to `auth-guard.ts` public list; rate-limited as a credential attempt (`rate-limit.ts:32-39`) |
| POST | `/api/invites/:token/accept` | any user | → `{spaceId, role}` |
| GET | `/api/spaces/:id/activity` | member | audit rows with this `workspace_id`, newest first, paged |

### 5.9 Archive and purge (I9)

- `archiveSpace` sets `archived_at`; the space resolves read-only (§5.6).
- `purgeSpace(actor, id)` (owner, archived for at least
  `spaces.purgeAfterArchiveDays`, default 7) deletes, in one transaction, every
  row with `workspace_id = $id` from notes, note revisions (S3), knowledge
  links, tasks (comments cascade), documents (and their files), artifacts
  (cascade), embeddings, memories, space memory (S2), sessions of the space
  (rooms and private sessions, messages cascade), file leases (S3), then the
  space files directory, then the workspace row. The table list lives in one
  array `SPACE_OWNED_TABLES` with a test that fails when a table with a
  `workspace_id` column is missing from it or from an explicit
  `NOT_SPACE_OWNED` list.
- The personal `DELETE /api/me/workspaces/:id` refuses shared workspaces (§5.3).

### 5.10 Membership changes take effect at once (I5)

`onMembershipChanged(workspaceId, userId)`:

- stops the user's running agents whose `context.space.id` is that space
  (`agentManager` lookup by user, then `stop('membership changed')`), only on
  removal or when the new role lacks the capability the agent was started with;
- unsubscribes the user's sockets from that space's rooms and documents (S2,
  S3);
- nothing to clear in caches, because nothing caches membership (D4).

### 5.11 Web

- **Picker.** `web/components/workspace-picker.tsx` shows two groups:
  "My workspaces" (from `/me/workspaces`) and "Shared spaces" (from
  `/api/spaces`), each space with its role badge. "New shared space" creates
  one. Transfer is hidden for spaces.
- **Space settings** at `/spaces/:id/settings`: name, members (role select,
  remove), invites (create with role and expiry, copy link, revoke), archive.
  Owner-only controls hidden for other roles.
- **Join page** `/join/:token`: preview, then "Join" (signed in) or "Sign in /
  Register to join". The login and register pages gain a `returnTo` query
  parameter, validated as a same-origin relative path
  (`web/app/login/page.tsx:86,116`).
- **Role-aware UI.** Pages read the role from `GET /api/spaces/:id` and
  disable editing for commenters and viewers (notes editor read-only, task
  board without create/drag, upload hidden).
- **Activity** tab on the space settings page.
- A removed member's next request gets 404 (§5.6); the workspace context then
  switches to the default workspace and shows "You no longer have access to
  <space>".

### 5.12 Tests

- `src/core/spaces/service.test.ts` (PGlite): create, roles, last owner,
  max members, archive.
- `src/core/spaces/invites.test.ts`: hash at rest, clamp, single use under two
  concurrent accepts, revoke scoped to its space, archived space rejects.
- `src/api/routes/spaces.isolation.test.ts`: a third user gets 404 on every
  route; a viewer cannot write; an editor cannot manage members; the real
  resolver derive is included (the existing isolation pattern skips it —
  `src/api/routes/orgs.isolation.test.ts:61-74` — so this suite mounts the
  workspace derive too).
- `src/db/repositories/space.isolation.test.ts`: I2 for every table — rows in a
  space never appear through `ScopedRepos`, note/memory/link repos, embeddings
  search or `*Admin` lists, for the author or an admin.
- `src/core/agent/space-turn.test.ts`: a member's private session creates
  tasks in the space; a commenter's write is denied in both dispatch paths and
  for an MCP handler; a removed member's next turn fails and a running one is
  stopped; personal memories are not loaded; a write after a private read asks.
- `src/core/spaces/purge.test.ts`: every `workspace_id` table is covered;
  purge leaves no orphaned personal rows.
- Playwright `tests/web/spaces.spec.ts`: create, invite link, join page with
  returnTo, role-aware editor, removed-member redirect.

---

## 6. S2 — Rooms

A space gets shared chats. Several members and the agent talk in one
conversation; the agent answers when addressed, as the member who asked.

### 6.1 Schema (migration `0126_rooms.sql`)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_chk CHECK (kind IN ('chat','room'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS room_visibility text;  -- 'space' | 'private', rooms only
ALTER TABLE sessions ADD CONSTRAINT sessions_room_visibility_chk
  CHECK ((kind = 'room') = (room_visibility IS NOT NULL) AND (room_visibility IS NULL OR room_visibility IN ('space','private')));

CREATE TABLE IF NOT EXISTS room_members (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_message_id uuid,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'own';
ALTER TABLE cost_log ADD CONSTRAINT cost_log_funding_chk CHECK (funding IN ('own','sponsor'));
CREATE INDEX IF NOT EXISTS cost_log_ws_funding_idx ON cost_log(workspace_id, funding, created_at) WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS space_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) <= 500),
  author_kind text NOT NULL CHECK (author_kind IN ('member','agent')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,   -- the member, or the requester the agent acted for
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS space_memory_ws_idx ON space_memory(workspace_id, created_at DESC) WHERE retracted_at IS NULL;
```

Rooms use `channel_type = 'room'`, `channel_id = 'room-<session uuid>'`, so the
existing unique index `(user_id, channel_type, channel_id)` holds
(`0121:32-39`). Rooms are created `pinned = true`, which exempts them from the
archive and retention sweeps (§1.4).

### 6.2 Room access

`src/core/rooms/access.ts`:

```ts
roomAccess(userId, sessionId) → { space: { id, role }, room: Session } | null
```

Null unless the session is `kind='room'`, its workspace is shared, the user is
a member (D4), and either `room_visibility='space'` or a `room_members` row
exists. `canPost` = `can(role,'comment')`; `canAsk` = `can(role,'run_agent')`.

The ownership checks listed in §1.4 change as follows. Each gets a test.

| Site | Today | Rooms |
|---|---|---|
| `resolveSession` (`session-resolver.ts:36`) | owner only | owner, or `roomAccess` |
| `handleMessage` controls (`service.ts:188-190`) | owner only | `/stop`: the running turn's requester or an editor+; `/clear` and `/model`: owner of the room or space owner; other commands: refused in rooms ("use a private chat") like group threads (`service.ts:391-397`) |
| `/ws` steer (`websocket.ts:306-314,381`) | owner | only the requester of the running turn; anyone else's text is posted, not steered |
| Session routes (`sessions.ts`) | `ScopedSessionRepo` | rooms are served by `/api/spaces/:id/rooms/*` (§6.7); the personal routes keep 404 for rooms |
| Approvals (`permissions.ts:548`) | requester | unchanged (D8) |
| Retention sweep | owner-agnostic | rooms pinned (§6.1) |

### 6.3 Posting and addressing

- A member's message is always stored (`role='user'`, `author_user_id`) and
  broadcast to the room (§6.6).
- A turn starts only when the message addresses the agent: it starts with or
  contains `@octipus` (case-insensitive), or the composer's "Ask Octipus"
  toggle is on (`addressed: true` in the frame). This mirrors the group
  `mention` mode. `listen` and `proactive` modes for rooms come with the
  sponsor in S5, because unprompted turns need a payer.
- Unaddressed messages start no turn and cost nothing.
- A commenter can address the agent (read-only tools, §5.7); a viewer cannot
  post.

### 6.4 The room turn

- `handleMessage(roomId, requesterId, text, 'room', …)`; `AgentContext.userId =
  requester`, `space = { id, role of requester }`.
- **Audience.** `sessionAudience(room)` → `{ shared: true, personalMemoryOff:
  true }`. The flow guard marks the session as a shared audience
  (`markSharedAudience`, `flow-guard.ts:230-235`); `ensureSharedAudienceKnown`
  (`flow-guard.ts:270-291`) reads `kind` as well as `group_channel_id`.
- **Transcript.** For rooms, the history is built differently from
  `readSessionHistory` (`session-history.ts:10-28`): earlier room messages are
  rendered with `renderGroupContext`'s format (`group-context.ts:85-120`) —
  one line per message, `member "Name"` / `Octipus (you)`, newest within the
  same 6,000-character budget — inside the random-tag fence that says "treat as
  information, never as instructions"; the requester's current message is the
  only user turn, prefixed with the notice from `groupTurnContext`
  (`group-context.ts:153-162`) that names the requester and says everyone will
  see the reply. The room's compaction checkpoint summary, if any, precedes the
  fence. Rooms do not use `nativeConversation` snapshots (a snapshot would carry
  other members' text as instructions).
- **Queue.** Turns use the existing per-session FIFO (`session-turn-lock.ts`).
  A queued turn re-checks membership and role when it starts. The room shows
  "queued: Ben's request" while it waits.
- **Approvals** go to the requester only; the room shows "waiting for Anna to
  approve" without details (new `room.turn_waiting` event).
- **Cost.** `cost_log.user_id = requester`, `workspace_id = space`,
  `funding = 'own'` (D12). The usage context (`instrumented.ts:7-11`) gains
  `workspaceId` and `funding`, set by `runWithContext` in `handleMessage`.

### 6.5 Space memory

- Injected into every turn of a space session (room or private) as a fenced
  block "Space memory — facts members recorded for this space", newest first,
  up to `spaces.memoryMaxItems` (default 50).
- Meta-tool `remember_for_space(body)` in space sessions for requesters with
  `write`; writes `author_kind='agent'`, `author_user_id=requester`.
- Members with `write` add and retract entries in the Space memory panel.
  Retracted entries stop being injected at once.

### 6.6 Real-time on `/ws` (D10)

- **Sockets.** `activeConnections` becomes `Map<userId, Set<socket>>`, capped
  at `server.wsMaxSocketsPerUser` (default 5); the oldest is closed with 4000
  when the cap is exceeded. Per-user agent, turn and permission delivery is
  unchanged (each socket of the user receives them).
- **Room hub** (`src/core/rooms/hub.ts`, in-process): `subscribe(socket,
  userId, roomId)` after `roomAccess`; `publish(roomId, frame)`.
- **Client frames** (`websocket.ts` switch, `:237-415`): `room.subscribe
  {roomId}`, `room.unsubscribe {roomId}`, `room.post {roomId, content,
  addressed, clientId}`, `room.read {roomId, messageId}`, `room.typing
  {roomId}` (throttled to one per 3 s per socket).
- **Server frames:** `room.message` (stored message with author), `room.turn`
  (`queued | started | waiting | done` with requester name),
  `room.delta` (text deltas of the room's running turn, relayed from the agent
  events for agents whose `sessionId` is the room), `room.presence` (members
  online in the room), `room.typing`, `room.read` (read markers),
  `room.removed` (you were removed; the client leaves the room).
- **Subscriptions are re-checked** on every `room.post` and when
  `onMembershipChanged` fires (§5.10).

### 6.7 Room routes (`src/api/routes/rooms.ts`)

| Method | Path | Who |
|---|---|---|
| GET | `/api/spaces/:id/rooms` | member: rooms visible to me, with unread counts |
| POST | `/api/spaces/:id/rooms` | editor+: `{title, visibility, memberIds?}` |
| GET | `/api/spaces/:id/rooms/:roomId/messages` | room access; paged, oldest-first windows, with authors |
| POST | `/api/spaces/:id/rooms/:roomId/messages` | `canPost`; REST fallback for `room.post` |
| PATCH | `/api/spaces/:id/rooms/:roomId` | room creator or space owner: title, visibility |
| POST/DELETE | `/api/spaces/:id/rooms/:roomId/members/:userId` | private rooms: room creator or space owner |
| GET/POST/DELETE | `/api/spaces/:id/memory[/:entryId]` | read: member; write: `write` |

A default room "General" (`visibility='space'`) is created with each space.

### 6.8 Mentions and notifications

- `@username` of a room member in a posted message notifies that member
  (`getNotificationService().notify`, `src/core/notification-service.ts:19-88`)
  with type `room_mention`, `workspace_id` set on the notification row, after a
  membership check of the target (the service itself checks nothing, note 05 §7).
- Muted rooms do not notify.

### 6.9 Private side panel

In a room, "Ask privately" opens the member's private session in the same
space (§5.7) with `context.linkedRoomId`. Its turns receive the linked room's
recent transcript in the same fence as §6.4, read-only. Answers stay private.
This is where personal reads that should not reach the room belong.

### 6.10 Web

- Space sidebar section "Rooms" with unread badges.
- Room view reuses `web/components/chat/message-timeline.tsx`: `ChatMessageData`
  gains `author?: { id, name }`; bubbles from others are left-aligned with name
  and avatar initials; mine stay right-aligned (`message-timeline.tsx:42-50,248-261`).
- Composer: text, "Ask Octipus" toggle, `@` completion for members.
- Turn strip: "Octipus — working for Anna", queued requests, "waiting for
  Anna to approve".
- Space memory panel; room members panel; "Ask privately" button.

### 6.11 Tests

- `src/core/rooms/access.test.ts`: open vs private rooms, removed member, viewer
  cannot post.
- `src/core/agent/room-turn.test.ts`: turn runs as requester; transcript fences
  other members; personal memories not loaded; private read asks the requester
  only; commenter write denied; cost row has requester, workspace, `own`.
- `src/api/websocket.rooms.test.ts`: two members get each other's posts and the
  turn's deltas; a non-member's `room.subscribe` is refused; a non-requester's
  text is not steered; removal sends `room.removed`; a user's two sockets both
  receive their own events.
- Playwright `tests/web/rooms.spec.ts` with two browser contexts and an in-test
  relay between their `routeWebSocket` handlers (the pattern of
  `tests/web/chat-delivery.spec.ts`).

---

## 7. S3 — Live documents

Members edit the same note at the same time, see each other's cursors, keep a
history, and review the agent's edits as suggestions. Workspace files get soft
leases.

### 7.1 Dependencies

`yjs`, `y-protocols` (server and web), `y-codemirror.next` (web). None is
present today (note 03 §7). Each is justified in the PR description
(AGENT.md: no dependency for something doable in 20 lines — a CRDT is not).

### 7.2 Schema (migration `0127_live_documents.sql`)

```sql
CREATE TABLE IF NOT EXISTS note_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  body text NOT NULL,
  body_sha256 text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user','agent')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_revisions_note_idx ON note_revisions(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  base_sha256 text NOT NULL,
  proposed_body text NOT NULL,
  on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','stale')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS file_leases (
  workspace_id uuid NOT NULL,
  path text NOT NULL,
  holder_kind text NOT NULL CHECK (holder_kind IN ('user','agent')),
  holder_user_id uuid NOT NULL,          -- the user, or the requester the agent acts for
  holder_ref text,                        -- agent id for agent holders
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_edit_mode text NOT NULL DEFAULT 'suggest';
ALTER TABLE workspaces ADD CONSTRAINT workspaces_agent_edit_mode_chk CHECK (agent_edit_mode IN ('suggest','direct'));
```

Live documents apply to notes in **shared** spaces. Personal notes keep the
current editor and save path.

### 7.3 Document hub (`src/core/docs/hub.ts`, in-process, D15)

- One `Y.Doc` per open space note, created on the first join from `notes.body`,
  dropped when the last socket leaves and the final state is persisted.
- **Frames on `/ws`:** `doc.join {noteId}` (needs `read`), `doc.update
  {noteId, update: base64}` (needs `write`; refused for others), `doc.awareness
  {noteId, state: base64}`, `doc.leave {noteId}`. The server answers
  `doc.sync {noteId, state: base64}` on join and relays updates and awareness
  to the other joined sockets.
- **Rate.** The client batches updates (one frame per 50 ms at most); the server
  accepts at most `spaces.docMaxUpdatesPerSecond` (default 30) per socket and
  closes the doc subscription with an error above it.
- **Persist.** After `spaces.docPersistDebounceMs` (default 2000) without
  updates, and on the last leave, the hub writes `notes.body` through the space
  note repo and appends a revision when `body_sha256` changed. Revisions of one
  author within `spaces.revisionCoalesceMinutes` (default 5) update the latest
  revision instead of adding one.
- **Other writers.** A REST save or an agent write to a note that is open in the
  hub goes through `hub.applyText(noteId, newBody, origin)`, which replaces the
  differing middle (common prefix and suffix kept) in one Yjs transaction. A
  REST save to a space note that is not open must send `baseSha256`; a stale
  one returns 409 (ends last-write-wins for space notes, §1.5).

### 7.4 The agent as co-editor

- With `agent_edit_mode = 'suggest'` (default), the notes tool's write in a
  space creates a `note_suggestions` row instead of changing the note, and the
  tool result says so. With `'direct'`, it writes through `hub.applyText` and
  records a revision with `author_kind='agent'`, `on_behalf_of = requester`.
- Accepting a suggestion (editor+) applies it through the hub if the note's
  current sha equals `base_sha256`; otherwise the suggestion becomes `stale`
  and the UI offers a three-way view.
- New notes created by the agent are created directly (there is nothing to
  overwrite) with an agent revision.

### 7.5 File leases

- The web file editor takes a lease when a member starts editing a space file
  (`POST /api/spaces/:id/files/lease {path}`), renews it every 60 s, releases it
  on save or close. TTL `spaces.fileLeaseTtlSeconds` (default 180).
- Acquire is one conditional upsert: insert, or update when expired or held by
  the same holder.
- The filesystem tool's write and delete in a space check the lease: held by
  someone else → the tool fails with "Ben is editing src/app.ts", and the agent
  reports that instead of waiting or overwriting. The agent takes a short lease
  for its own write.
- The session-file 409 check stays and becomes atomic for space files: the
  compare and the write happen while holding the lease.

### 7.6 Presence

- `space.presence {members: [{userId, name, where: {roomId?|noteId?}}]}` on
  `/ws` to the space's subscribed sockets, from the room and doc hubs.
- Web: avatar stack in the space header, cursors and selections in the note
  editor (`yCollab` awareness), "Ben is editing" on files.

### 7.7 Web

- The notes editor (`web/app/notes/markdown-codemirror.tsx:299-316`) switches
  from the controlled `value` to `yCollab(ytext, awareness)` for space notes;
  wikilink and tag completion stay (they dispatch ordinary transactions).
- Explicit save and the dirty state disappear for space notes; a "Saved"
  indicator follows persistence.
- History panel: revisions with author and on-behalf-of; restore creates a new
  revision.
- Suggestions panel with diff, accept, reject.

### 7.8 Tests

- `src/core/docs/hub.test.ts`: two simulated clients converge; persistence
  writes one revision per author window; a commenter's update is refused;
  `applyText` from REST merges with a concurrent client edit; rate cap.
- `src/core/docs/suggestions.test.ts`: suggest mode; accept; stale.
- `src/core/spaces/file-leases.test.ts`: acquire, renew, expire, agent refused.
- Playwright `tests/web/live-notes.spec.ts`: two contexts type into one note via
  an in-test relay and converge.

---

## 8. S4 — Own models (bring your own agent)

Members can add their own models and keys, or their own CLI login, and their
requests run on them, in spaces and everywhere else.

### 8.1 Schema (migration `0128_personal_models.sql`)

```sql
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS model_config_owner_idx ON model_config(owner_user_id) WHERE owner_user_id IS NOT NULL;
```

`name` stays globally unique (`models.ts:11`), because it is the identifier
used everywhere (`agent-worker.ts:2160-2168`, `cost-tracker.ts:95-101`).
Personal rows get the name `u/<username>/<label>`; the UI shows the label.

### 8.2 Model resolution

- New `resolveModel({ userId, topic, kind: 'root' | 'worker', inSpace })` in
  `src/models/model-resolution.ts`, called by
  `ModelSelector.selectForRootAgent/selectForWorker`
  (`model-selector.ts:75-132,184-208`) and `router.route`
  (`src/core/router.ts:143-150`), which now receive the user id.
- Order: the user's personal model bound to the topic (personal rows use the
  existing `topicRoles`); then install/org models **visible to the user**
  (`org_id IS NULL OR org_id IN user's orgs`, the filter that today only
  `getModelsForUser` applies, `model-registry.ts:212-222`); then the default.
- `/model` (`src/core/commands/model.ts:46-73`) lists and accepts only models
  visible to the user.
- Personal models are never used for another user's request; background
  topics (`embedding`, `vision`, `ocr`) stay install-level (`models.ts:86-98`).

### 8.3 Keys

- Personal model rows' `apiKeyRef` names a **user-scope** vault secret of the
  owner. The agent worker resolves `getByName(owner_user_id, ref)` for personal
  rows and the system vault for install rows (`agent-worker.ts:2205-2212`).
- Every built-in provider honours `options.apiKey` before env and system vault:
  anthropic, openai, deepseek, gemini, grok, mistral, moonshot, openrouter,
  typesafe, vertex, voyage, zai (`anthropic-provider.ts:362-378`,
  `openai-provider.ts:250-262`, …). This is a precondition; a provider that
  cannot accept a per-request key cannot back a personal model and is rejected
  at creation.

### 8.4 CLI logins per user

- Personal CLI models run with `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
  pointed at `$DATA_ROOT/users/{id}/cli-home` (`cli-child-env.ts:11-40`), and
  never receive the server's `CLAUDE_CODE_OAUTH_TOKEN` (`:34`).
- The login is a token the user pastes (Claude Code: the output of
  `claude setup-token`; Codex: an API key), stored in the user vault and
  injected as the CLI's own env var for that child only.
- CLI quota keys include the credential owner (`quota-tracker.ts:5-6,28-29`).

### 8.5 Install CLI models in spaces (D13)

`resolveModel(…, inSpace: true)` skips install CLI models unless
`metadata.cliAgent.sharedUse === true`. The admin model form gains that
checkbox with the text "This login may answer other people's requests (an
organisation plan, not a personal subscription)."

### 8.6 Routes and web

- `GET/POST/PATCH/DELETE /api/me/models` — the caller's personal models
  (provider, model id, label, key or CLI token, topic bindings). Admin model
  routes (`src/api/routes/models.ts:62-219`) are unchanged.
- Settings → "My models".
- Every agent reply carries the model label and, in spaces, "Anna's agent"
  (S2's `room.turn` frame gains `model` and `funding`).

### 8.7 Tests

- Resolution order; org visibility enforced; personal model never used for
  another user; per-request key reaches each provider (a provider unit test per
  provider); CLI child env for personal vs install models; install CLI model
  skipped in a space unless `sharedUse`.

---

## 9. S5 — Sponsored agent, team surface, group-channel bridge, space connectors

### 9.1 Funding

- Migration `0129_space_funding.sql`:
  `workspaces.agent_funding text NOT NULL DEFAULT 'unattended' CHECK (… IN
  ('own','unattended','sponsored'))`, `workspaces.sponsor_user_id uuid`,
  `workspaces.sponsor_models jsonb` (topic → model name; models must be the
  sponsor's personal API-key models or install/org models visible to the
  sponsor, never a CLI model unless `sharedUse`), and `spend_budgets` scope
  kinds `space` and `space_member` (CHECK change like `0123`).
- `fundingFor({ space, requesterId, attended })`:

  | `agent_funding` | attended request | unattended work |
  |---|---|---|
  | `own` | own; no usable model → "set up your models" | refused (features off) |
  | `unattended` | own | sponsor |
  | `sponsored` | sponsor, capped per member | sponsor |

  Unattended = `AgentContext.attended === false` or a room `listen`/`proactive`
  turn. No sponsor configured → unattended features are off for the space.
- Sponsored turns resolve models from `sponsor_models` and keys under the
  sponsor's id; `cost_log.user_id = requester`, `funding='sponsor'`.

### 9.2 Space budget

- `space` scope: spend = `cost_log WHERE workspace_id = $space AND funding =
  'sponsor'`; filed under the sponsor; owner-writable through
  `PUT /api/spaces/:id/budget` (the first non-admin budget writer; the admin
  routes keep full control, `admin.ts:331-490`).
- `space_member` scope: the same filter plus `user_id = member`, one limit for
  all members set on the space.
- `checkSpend` becomes funding-aware (`spend-budgets.ts:266-321`): an `own` turn
  checks the requester's budgets only; a `sponsor` turn checks the space and
  space-member budgets only. The requester's concurrency quota applies to both;
  their token quota applies to `own` only.
- An exhausted space budget pauses sponsored work and leaves own-funded turns
  running.

### 9.3 Team surface

- **My work:** `GET /api/me/work` — open tasks with `assignee_kind='user' AND
  assignee_ref = me` across my spaces and my personal workspace, grouped by
  space. Web page "My work".
- **Assignment notifies** the assignee (type `task_assigned`, membership
  checked).
- **Live board:** `task.changed {taskId, workspaceId}` frames on `/ws` to the
  space's sockets; the board refetches on it instead of polling every 30 s.
- **Room modes:** `listen` and `proactive` for rooms, reusing the gate, quiet
  hours, caps and feedback of group channels (`src/channels/group-listen.ts`),
  funded by the sponsor.

### 9.4 Group-channel bridge

Binding an enrolled group channel to a space makes each channel thread and one
room the same conversation. Changes (note 06 §4.6):

1. `group_channels.workspace_id uuid` (nullable, must be a shared space) and
   `group_channel_rooms(group_channel_id, thread_id, session_id)` mapping a thread
   to a room; the per-member unique index `(user_id, group_channel_id,
   thread_id)` (`0121:38-40`) applies only to unbound channels.
2. `resolveGroupSession` (`src/channels/group-channels.ts:443-483`) returns the
   thread's room for a bound channel; the turn runs as the requester (§6.4).
3. Channel posts by linked space members are stored as room messages with
   `author_user_id`; room posts from the web are mirrored to the thread. Posts
   by people who are not space members stay platform-only context (fenced, as
   today) and never become room messages.
4. Taken tasks go to the space board (`taken-tasks.ts:82` uses the space repo).
5. The space budget replaces the channel budget for bound channels.
6. Unprompted posts in a bound channel use the sponsor (§9.1) and are off
   without one.
7. Binding requires the channel owner to be a space owner; posting in the
   channel never grants space membership.

### 9.5 Space connectors

- `scope='workspace'` vault rows become **space secrets**: stored by an owner,
  readable for any member's turn in that space through a new
  `vault.getForSpace(workspaceId, name)`, which decrypts under the row's own
  `(scope, user_id)` (works after §4.6). Members never see the value; the
  secrets UI lists names only.
- Connector token getters gain a space variant for Atlassian, Linear and Google
  Drive folders (`src/security/oauth.ts:738-760`). GitHub as a space connector
  uses a token from a space secret passed as `GH_TOKEN` per call, instead of the
  host's `gh` login (`src/utils/gh.ts:23-25`).
- A tool call in a space uses the space connector when one is configured for
  that connector, otherwise the requester's own (hat 2, with the room rules of
  §6.4).

### 9.6 Tests

Funding table; space budget counts only sponsored rows; own turns unaffected by
an exhausted space budget; per-member cap; bound channel thread ↔ room;
non-member channel posts not stored; space connector readable by a member's
turn and not listable by value.

---

## 10. S6 — Guests and invite-only sign-up

- `auth.registration` setting: `open` (today), `invite_only`, `closed`; schema,
  registry, env `AUTH_REGISTRATION`. `invite_only` lets `POST /api/auth/register`
  succeed only with a valid space invite token in the body, redeemed in the
  same transaction. The first-user-becomes-admin rule stays for an empty install.
- `workspace_members.scope jsonb` for `guest`: `{ rooms: uuid[], folders:
  string[] }`. Guests see only those rooms and those file folders; notes, tasks
  and documents outside are 404; the member list shows only members of their
  rooms.
- `passkey/auth/verify` and the TOTP prompt are fixed before guests rely on them
  (the web checks `totpRequired` while the server returns `requiresTOTP`,
  `web/app/login/page.tsx:63`, `auth.ts:76`).
- Tests: registration modes; guest scope on every space route and tool.

---

## 11. S7 — Spaces across installs (contract)

Builds on the federation transport (identity, pairing, typed messages) of
`workroom-and-swarm-federation.md` §2.2–2.5, which does not exist yet. The
contract, from the concept's "Live, not synced":

- A space has one host. Visitors are `user@<instance-fingerprint>` members with
  a role, backed by a `peer:<id>` principal on the host; their requests run on
  their own install and models.
- Visitors act only through space operations (`space.watch`, `space.read`,
  `space.post`, `space.suggest`/`space.write`, `space.task.op`, `space.doc.sync`
  scoped to an open note), each checked on the host against role and scope.
  They never cause a host tool run.
- Nothing of the space is stored on the visitor's install; revocation closes
  live access within one heartbeat.
- Host-side execution (shell, builds, space connectors) runs only on the host's
  sponsored agent.

The membership, role, room, document-hub and funding pieces of S1–S5 are the
host side of this contract; S7 adds the peer principal and the `space.*`
message handlers that call them.

---

## 12. Cross-cutting

### 12.1 Config keys (all in `spaces` unless noted)

| Key | Phase | Default |
|---|---|---|
| `enabled`, `maxMembers`, `inviteMaxTtlHours` | S0/S1 | false, 50, 720 |
| `purgeAfterArchiveDays` | S1 | 7 |
| `memoryMaxItems` | S2 | 50 |
| `server.wsMaxSocketsPerUser` | S2 | 5 |
| `docMaxUpdatesPerSecond`, `docPersistDebounceMs`, `revisionCoalesceMinutes`, `fileLeaseTtlSeconds` | S3 | 30, 2000, 5, 180 |
| `auth.registration` | S6 | `open` |

Each is a Zod field with its default in the schema, a registry entry and an env
var, read outside the config layer by its consumer.

### 12.2 Migrations

`0125_spaces` (S1), `0126_rooms` (S2), `0127_live_documents` (S3),
`0128_personal_models` (S4), `0129_space_funding` (S5), `0130_guests` (S6).
Hand-written, idempotent, `--> statement-breakpoint` between statements, journal
entries with increasing `when` after `1789601114572`. New `audit_action` enum
values are added with `ALTER TYPE … ADD VALUE IF NOT EXISTS`.

### 12.3 Catalog and docs

- Every phase adds routes or module edges, so `npm run catalog` runs in every PR
  (CI gates on it).
- New `docs/SPACES.md` (user-facing: spaces, roles, invites, rooms, live notes,
  funding). `docs/architecture/MULTI-USER.md` gets a "Spaces" section per phase.
  `docs/CONFIGURATION.md` lists the keys. `CHANGELOG.md` `## Unreleased` per PR.
- The concept doc links here.

### 12.4 Test commands per PR

`npm run typecheck`, `npm run lint`, `npm run catalog:check`,
`npx vitest run --coverage` then `npx tsx scripts/coverage-check.ts`
(ratchet: lines 50.1, functions 51.7, tolerance 0.5), web `npx tsc --noEmit`
and `npm run lint` in `web/`, `npm run test:web` for UI phases.

### 12.5 PR slicing

One phase per PR, except S0 (two PRs, §4) and S2 (rooms backend, then rooms
web). Each PR is mergeable on its own and leaves `spaces.enabled=false`
installs unchanged, except S0, whose fixes apply to everyone.

---

## 13. Open questions

1. **Space creation rights.** Any user (proposed), or admins only, or a setting?
2. **Org attachment.** Should a space optionally belong to an org so org admins
   can see it? `org_admin` grants nothing today (`src/security/orgs.ts:200-242`);
   proposed: not in S1–S6.
3. **Room history for new members.** Proposed: new members see the full history
   of open rooms; private rooms show history from when they were added.
4. **Retention of rooms.** Rooms are pinned (exempt). Should a space owner be
   able to set room retention? Proposed: later.
5. **Yjs persistence.** Body plus revisions (proposed) vs storing the Y.Doc
   binary. Body keeps search, embeddings and Markdown export unchanged.
