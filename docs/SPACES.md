# Shared spaces

A **space** is a workspace several people share. Members see the same notes,
tasks, documents, artifacts and files, and each works with the agent in their
own private sessions inside the space. Spaces are always available; who may
create one is a policy setting.

This page describes what is built. The full design, including the parts
still to come (rooms, live documents, sponsored agents, guests), is
[docs/plans/coworking-spec.md](plans/coworking-spec.md).

> **Status (coworking S1).** Spaces, members, roles, invites, archive and
> purge are in place, with their REST routes, the content routes acting on a
> space (see "Working in a space") and the web screens (see "In the web").

## The model

- A space is a row of `workspaces` with `kind = 'shared'`. It has no owning
  user (`user_id` is NULL); `created_by` records who made it. A personal
  workspace (`kind = 'personal'`) always has its owner. A database CHECK ties
  the two together.
- Who may do what is `workspace_members (workspace_id, user_id, role)`. It is
  read from the database on every request — never from a cached session —
  through one function, `getMembership(userId, workspaceId)`
  (`src/core/spaces/service.ts`).
- A space never appears in the personal workspace list of its creator or its
  members, and the personal workspace routes (`/api/me/workspaces`) cannot
  rename, transfer or delete it.

## Roles

Roles are code (`src/security/space-access.ts`, `can(role, action)`):

| Action | owner | editor | commenter | viewer | guest |
|---|---|---|---|---|---|
| read | ✓ | ✓ | ✓ | ✓ | ✓ in scope |
| comment (task comments; room posts later) | ✓ | ✓ | ✓ | – | ✓ in scope |
| write (notes, tasks, files, documents, artifacts) | ✓ | ✓ | – | – | – |
| run the agent with read and comment tools | ✓ | ✓ | ✓ | – | ✓ in scope |
| run the agent with write tools | ✓ | ✓ | – | – | – |
| manage members, invites and the space | ✓ | – | – | – | – |

- The **last owner** cannot be removed, demoted or leave. Make another member
  an owner first.
- A user who is the last owner of a space, or who authored content in one
  (tasks, task comments, notes, documents, links, artifacts), **cannot be
  deleted** (`assertDeletable`, `src/security/user-deletion.ts`): the account
  cascade would take that content with it. The refusal names the spaces. A
  user who may be deleted first leaves each space they belong to, with its
  audit row and the consequences below.
- Guests see only their own membership until rooms exist.

Someone who is not a member gets **404** for every space id — the same answer
as for an id that does not exist. A member whose role lacks an action gets
**403**.

## Creating a space

`POST /api/spaces {"name": "Launch"}`. The creator becomes its owner. With
`spaces.creation = admins`, only admins may create spaces (403 for others).

## Invites

An owner creates an invite link for a role (`editor`, `commenter`, `viewer`,
`guest` — never `owner`):

```http
POST /api/spaces/<id>/invites
{"role": "editor", "expiresInHours": 48, "maxUses": 1}
→ 201 {"id": "…", "token": "<64 hex>", "role": "editor", "expiresAt": "…", "maxUses": 1}
```

- The token is shown **once**, in this response. Only `sha256(token)` is
  stored; listings never show it.
- The lifetime is clamped to between 1 hour and `spaces.inviteMaxTtlHours`
  (default 720 = 30 days); without `expiresInHours` it is 7 days.
- `maxUses` is 1–100 (default 1). Each accept takes one use with a single
  conditional update, so two people racing for a single-use link cannot both
  get in.
- The link to share is `<your web origin>/join/<token>`. Octipus does not send
  mail.
- `GET /api/invites/<token>` (no sign-in needed) previews it: space name,
  inviter, role, expiry — no member list, no content.
  `POST /api/invites/<token>/accept` (signed in) joins. Both are rate-limited
  per IP like a login attempt.
- Someone who already is a member keeps their role; the use is not consumed.
- An invite is good only while its creator may still invite: removing an
  owner, demoting them or their leaving revokes the links they made (one
  `space_invite_revoked` row each), and the accept itself refuses a link
  whose creator is no longer an owner.
- A space is limited to `spaces.maxMembers` members (default 50); an accept
  into a full space answers 409 `space_full`.
- Revoking (`DELETE /api/spaces/<id>/invites/<inviteId>`) works only through
  the invite's own space.

## When a membership changes

Removing a member, downgrading their role or changing a guest's scope takes
effect at once (`onMembershipChanged`, `src/core/spaces/membership.ts`):

- their running agents in the space stop;
- their queued background jobs there (learning checks, document processing)
  are cancelled;
- their pending permission and approval prompts raised there expire;
- the invite links they made are revoked (see above);
- the data sources they own on the space's artifacts pause (they resume when
  the person is again a member who may write);
- an in-process membership version is bumped, for paths that check
  membership at keystroke rate.

The change itself is committed first. If one of these follow-up steps fails,
the failure is logged and the response still succeeds, with a `warning`
naming the failed step (`DELETE …/members/<userId>` → `{"success": true,
"warning": "…"}`), rather than a 500 a client would retry against a member
who is already gone. An owner's own membership is read locked for the length
of the operation, so an owner demoted or removed meanwhile cannot finish a
removal, an invite or a purge.

## Archive and delete

- **Archive** (`POST /api/spaces/<id>/archive`, owner): the space becomes
  read-only — reads work; no writes, no new invites, no new chats, no agent
  runs. Every agent running in it stops, its queued background jobs are
  cancelled, and every pending permission and approval prompt raised in it
  expires. **Unarchive** undoes it.
- **Delete for good** (`DELETE /api/spaces/<id>`, owner) only for a space
  archived at least `spaces.purgeAfterArchiveDays` days (default 7). In one
  transaction it deletes every row of the space — every table listed as
  `delete` in `WORKSPACE_TABLES` (`src/db/workspace-tables.ts`), plus rows
  keyed by the space's sessions — checks that none is left (and aborts,
  changing nothing, if one is), writes a
  `space_purged` audit row and deletes the space. Its directories
  (`<workspace.rootPath>/spaces/<id>` and `<workspace.documentsPath>/spaces/<id>`)
  are removed afterwards; an hourly sweep retries any that could not be.
- The audit log and the cost log keep their rows (with the space's id): the
  space's history and billing outlive it.
- Nothing of a space ever falls back into a member's personal scope — not on
  removal, not on purge, not when an account is deleted.

## Activity

Every change — creation, rename, archive, membership, role, invite created,
revoked or accepted, purge — writes one audit row carrying the space's
`workspace_id`. When an admin acts while impersonating a member, the row's
`details.impersonatedBy` names the admin. Members read them, newest first, at
`GET /api/spaces/<id>/activity?limit=50&before=<timestamp>`.

## Working in a space

The web sends the selected workspace in `X-Octipus-Workspace` (an id or a
slug). When it names a space the caller is a member of, the server marks the
request's principal shared, with the member's role, read from the database
for that request.

- **Which routes act on the space.** `SPACE_ROUTES`
  (`src/api/space-routes.ts`): notes, tasks and comments, documents,
  artifacts and their hosted pages, knowledge, sessions (the member's own
  private chats in the space, and their files), spaces and notifications.
  Every other route — chat approvals, models, search, settings, memories… —
  runs in the caller's default personal workspace, so a personal route never
  acts on space rows. Agents and pipelines addressed by id
  (`/api/agents/:id`, `/api/pipelines/:id`, `?sessionId=`) follow their
  session's workspace for reads and stops only (`GET`, agent stop and
  removal, pipeline stop and pause), so a member's chat in a space still
  lists and stops its agents. Anything that runs the model — starting an
  agent or a pipeline, a follow-up message, resuming or approving a pipeline
  — runs personal, where a space's session is not found; a space principal
  is refused there outright. `src/api/space-routes.test.ts` classifies every
  mounted route by method and path.
- **Not a member.** A header naming a space you are not a member of (or no
  longer are) answers 404 on every `/api` and `/v1` route, except
  `/api/auth/*`, `/api/health`, `/api/me/workspaces` and `GET /api/spaces`,
  so a removed member's client can recover. The body is
  `{"error": "Space not found", "code": "workspace_denied"}`; the code tells
  a client its selected workspace went away, not a missing resource.
- **The access layer.** Space routes go through `contentRepos(principal)`
  (`src/db/repositories/content.ts`): the personal repositories for a
  personal principal, `spaceRepos` (`src/db/repositories/space.ts`) for a
  shared one, with the same methods. In a space every query filters
  `workspace_id = <space>`; writes stamp the space and the member as author
  (`user_id`, attribution only) and check the role: viewers read, commenters
  also comment on tasks, editors and owners write. Opening a chat, posting
  to it, asking for a learning check, sending a monitor event or plan
  feedback is an agent run: commenters and up. A refused write is 403; an
  archived space is read-only (409), the member's own chats included. A
  member's sessions, agents, pipelines and notifications stay theirs inside
  the space.
- **The personal door never writes into a space.** A personal-scope create
  (sessions, agents, documents, tasks, notes, artifacts) given a space's id —
  from an agent context in the space, or a caller's `workspaceId` — throws:
  space writes go through `contentRepos` with the space principal.
- **Personal paths never return space rows**, for their author or an admin:
  the personal repositories carry the predicate `notInSharedWorkspace` (a
  row is personal when it has no workspace or a personal one — a row naming a
  workspace that no longer exists is nobody's), and so do the raw readers
  outside them (notes graph, global search, memory routes, role-agent and
  heartbeat probes, the weekly review, channel tasks). The admin lists of
  sessions, agents and pipelines, and live agents, never include a space's.
  `src/db/repositories/space.isolation.test.ts` fails on a new raw read of
  any table of `WORKSPACE_TABLES` (any case, aliased imports included)
  outside its allowlist; reads in the unscoped stores each carry an `i2:`
  comment saying why they cannot reach a personal caller.
- **Notes and links.** `NoteService` takes a `NoteScope` (personal, or a
  space). Links resolve inside one scope: a `[[link]]` in a space binds only
  to the space's notes, a personal one only to personal notes. Vault sync is
  personal-only.
- **Files and documents.** A space's files live in
  `<workspace.rootPath>/spaces/<id>/files` (`WorkspaceFS.forSpace`), with no
  extra allowed prefixes; uploads go to
  `<workspace.documentsPath>/spaces/<id>/`. Both go with a purge.
- **Knowledge.** Space notes, documents and files are indexed with the
  space's workspace id; the knowledge routes search the space's rows in a
  space and personal rows elsewhere. A search in a space reaches none of the
  member's personal repositories, and repository scans of a space never
  include `workspace.additionalPaths`.
- **Artifacts.** In a space `private` means the creator only. Hosted pages
  look an artifact up among the viewer's personal workspaces first, then the
  spaces they belong to (not as a guest), so a personal page link never opens
  a space's page of the same slug. Live updates (`artifact:<id>` on the
  gateway) reach members of the artifact's space the same way. A data source of a space artifact refreshes only while its
  owner may write in the space, and pauses otherwise.
- **Tasks.** Closing a blocker wakes the dependent task's author and user
  assignee, whoever closed it — each only while still a member, checked when
  the notification is sent. A space task's user assignee must be a member;
  a personal task can be assigned only to its owner, and a personal task's
  notifications go to its owner alone. Role agents are personal automation:
  a space task is never assigned to a role or a node (400) and never wakes a
  role heartbeat.
- **Guests** have no content access yet: guest scopes arrive with S6.

### The agent in a space

A member's private chat in a space runs the agent in the space.

- **Contexts.** `buildAgentContext` (`src/core/agent/context.ts`) is the only
  place an agent context is built; `resolveAgentScope` reads the session's
  workspace and the requester's membership and fails closed: a viewer (role
  without `run_agent`), a removed member and an archived space are refused,
  and `schedule` / `monitor` runs never start in a space. Every context
  carries `space`, `trigger` (`user`, `room`, `schedule`, `monitor`,
  `listen`, `remote`) and `funding` (`own` until sponsors arrive); children
  inherit all three, and every spawn re-reads the membership.
- **Tools.** Content tools use `reposFor(context)` — `contentRepos` of the
  agent's principal, which carries the space and the role — so the agent
  reads and writes exactly what the member may. Writes go only through
  containers known to act on the space (`SPACE_TOOL_IDS`, an allowlist in
  `src/security/space-tools.ts`: content tools, files, shell, version control,
  sandboxes); personal-only tools (scheduling, monitors, pipelines and
  recipes, memory, profile and skill tools such as `update_skill`,
  `sync_vault`, `index_file`/`index_directory`, meeting notes, MCP server
  administration, skill distillation) and every write through the member's
  personal connections (OAuth connectors and `connector_call_tool`, their MCP
  servers, their real browser through `browser-ext`, the named connector
  tools) are not offered and are refused; the prompt says why. Reads through
  those connections run and mark the session `private` (I6). A coding agent's
  configuration under the space's files (`.claude/`, `.codex/`, `.gemini/`,
  `.agents/`, `.vibe/`, `.mcp.json`) is never written, by the file tools or a
  CLI model's native writes: a CLI model run in the space would read it.
- **Decisions.** `routeApprovalFor` (`src/security/approval-route.ts`) is the
  one decision for every tool call: it re-reads the membership, applies the
  role cap first (commenters and guests run only `COMMENTER_TOOLS`,
  `src/security/space-tools.ts`), then the I6 rule — after a private read
  (the session's flow label holds `private`), any call that is not a read
  asks, whatever `agent.flowGuard` says — then the stored ALLOW/ASK/DENY.
  The flow label is stored on the session (`sessions.flow_label`), so a
  restart or another process still asks. A space this process has not seen
  yet is looked up in the database, so a context that names a space without
  its scope is refused.
- **Memories and profile.** `sessionAudience`
  (`src/core/agent/audience.ts`) switches the requester's personal memories,
  learning and profile facts off in a space session, child workers included.
- **CLI models.** Each adapter declares the mode it runs in inside a space
  (`CLI_SPACE_MODES`): Claude-binary tools use `--permission-mode default`
  with the stdio permission tool (pre-approved `allowedTools` are dropped)
  and read no user, project or local settings file (`--setting-sources=`
  plus a locked `--settings` file: no allow rules, bypass disabled, the shell
  guard as the only hook),
  Codex the `read-only` sandbox, Antigravity `--mode plan`; Mistral Vibe has
  none and is refused. Commenters' turns use API models only, and an install
  CLI model serves spaces only when marked `metadata.cliAgent.sharedUse: true`.
- **Pipelines and artifacts.** A stage's verify command runs in the space's
  files under the space's role cap and I6; a pipeline resumes only while its
  starter may still write there. A space artifact takes no `tool` or `mcp`
  data source (they run as the member's personal agent).
- **Cost.** Each turn runs inside one usage context: every `cost_log` row of
  a space turn carries the space's `workspace_id` and the turn's `funding`;
  install-topic calls (compaction, embeddings, memory extraction, toolshim,
  decision, vision, OCR) are stamped `install`.
- **Approvals.** Permission requests carry `workspace_id`; the admin queue
  and its resolve routes never show or answer a request of a space the admin
  is not a member of.

## Own models

Any user can add their own models under **Settings → My models**
(`/api/me/models`) and bind them to text lanes (`build`, `everyday`,
`verify`, `research`). Their turns — in their own sessions and in spaces
alike — then run on that model, on their key.

- **Rows.** A personal model is a `model_config` row with `owner_user_id`
  set, named `u/<userId>/<slug>`. Ownership is the column; the name is never
  parsed. Bindings live in `user_model_bindings(user_id, topic, model_name)`,
  apart from the install's `topic_roles`. A personal row may bind text lanes
  only; `background`, `decision`, `embedding`, `vision`, `ocr` and compaction
  stay install-level.
- **Never anyone else's.** Every install-level registry query filters
  `owner_user_id IS NULL`: a personal row is never a default, a lane binding,
  a backup or a fallback for others, never enters a global cache, and never
  appears in another user's lists (`/models`, `/model list`, `GET
  /api/models`, `/v1/models`). The admin model and topic routes refuse
  personal rows.
- **Resolution.** `resolveModel` (`src/models/resolve-model.ts`) is the one
  resolver: the user's binding, then the install binding, then (root agent
  only) the default. An explicit model — `/model <name>`, `POST /api/agents`
  `model`, `POST /api/agents/route` `preferredModel`, a pipeline stage model,
  a lane's executor model, the `/v1` passthrough, an evaluation run —
  resolves only to a row that user may see; another user's personal model is
  "not available", never passed through. `/model` overrides are per
  (session, user).
- **Identity.** `AgentContext.model` stays the provider model id; the row is
  `AgentContext.modelName`, passed to providers as
  `CompletionOptions.modelConfigName`. A personal row and an install row can
  share a model id without ever swapping.
- **Keys.** `resolveModelKey` resolves a row's key under its owner (the
  system vault for an install row, the owner's vault for a personal one),
  never under the requester. A personal row whose key is missing fails loud;
  it never runs on the install's env key. Providers that can back a personal
  row (anthropic, openai, deepseek, gemini, grok, mistral, moonshot,
  openrouter, zai and the custom providers) honour the per-request key.
- **Safety.** The row is built from an allowlist (provider, model id, label,
  endpoint for custom providers, key or CLI token, lanes) — no
  `inheritApiKeys`, `extraArgs`, `mcpConfigPath`, `permissionMode` or
  `extraHeaders`. A custom endpoint is resolved and checked against private,
  loopback and link-local ranges on every request, the connection is pinned
  to the checked address, and redirects are not followed.
- **CLI logins.** A personal CLI row (Claude Code, Codex, Gemini, Vibe) runs
  with `cliEnvFor(owner)`: `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` under
  `<workspace.rootPath>/users/<id>/cli-home`, every server auth variable
  stripped and only the owner's token injected. The credential owner is part
  of the vendor-session store key, the resume fingerprint and the quota key,
  so a resume never crosses owners and one person's exhausted subscription
  blocks nobody else. **Limit:** the CLI still runs as the server's OS user;
  this separates vendor state and credentials, not file permissions. In a
  space, your own personal CLI model serves your turns; an install CLI model
  still needs `sharedUse`.

## In the web

- **Picker** (the header's workspace button): "my workspaces" (your own,
  with transfer) and "shared spaces" (with your role as a badge, the member
  count, and a gear to the space's settings); "new shared space…" creates one
  and switches to it. Switching sends the space's id in `X-Octipus-Workspace`.
- **Space settings** `/spaces/<id>/settings`: name, members (role, remove;
  "leave" for yourself), invites (role, expiry, uses; the link is shown once,
  with a copy button; revoke), activity, archive / unarchive and delete for
  good. Every member can open it; only owners see the controls that change
  the space.
- **Join page** `/join/<token>`: anyone with the link sees the preview; a
  signed-in user joins with one click, anyone else signs in or registers and
  comes back to the page (`returnTo`).
- **Role-aware pages.** Commenters and viewers (and everyone in an archived
  space) get a read-only notes reader, a task list and board without create,
  edit, drag or delete, and no document upload or delete; commenters still
  comment on tasks. A banner says the role, or that the space is archived.
  The role is read again (`GET /api/spaces/<id>`) on every switch and when
  the window regains focus.
- **Removed.** When the server answers `workspace_denied` for the selected
  space, the web switches to the default workspace and says "You no longer
  have access to <space>" — also at the next load, if the removal happened
  while away.
- Personal-only pages keep working with a space selected; the secrets page
  scopes to the default personal workspace, as the server does.

## Live documents

Space notes are edited together (S3, `src/core/docs/hub.ts`). Opening a
note in the editor joins its live document over the gateway (`doc.join`);
every member with it open sees the others' text, cursors and selections as
they type, and an avatar for each in the note's header. There is no Save
for the text: the server saves it after `spaces.docPersistDebounceMs` of
quiet and when the last editor leaves, and the editor says "Saved". Save
stores the title, tags and kind only. Commenters and viewers watch the
text change live but cannot edit (their updates are refused); so is
everyone in an archived space.

- **Other writers merge.** Everything else that writes a space note — a
  REST save, quick capture, meeting notes, the agent, accepting a proposal,
  restoring a revision — names the text it started from (its *base*). The
  server merges that change into the live text (a three-way merge, lines
  first, then words) or refuses it as stale; it never overwrites what
  someone typed meanwhile. A read of an open note returns the live text and
  its sha, which the server keeps as a base for `spaces.docBaseTtlMinutes`.
  Archiving an open note saves what was typed first, then closes it for
  everyone.
- **History.** Every save is a revision with its authors (and the member an
  agent wrote for). The notes page's right panel has a *history* tab: open a
  revision to read it, restore it as a new revision.
- **Edit proposals.** In `suggest` mode (the default; owners switch with
  `PUT /api/spaces/<id>/agent-edit-mode`), what the agent writes into a
  space note becomes a proposal. The *proposals* tab shows each with a diff;
  accept applies it through the same merge (if it collides with a newer
  edit it turns stale and the three texts are shown), reject closes it.
  (The agent's note tool switches to proposals in a later step; the
  proposals table, the service and the accept/reject routes are in place.)
- **File leases.** A member editing a space file holds a lease on it
  (`POST /api/spaces/<id>/file-leases`, renewed while the editor is open,
  lapsing after `spaces.fileLeaseTtlSeconds`), so others see "Ben is
  editing". A lease on a directory covers its files; a directory operation
  conflicts with a lease anywhere under it. Changes are pushed as
  `file.leases` to the space's gateway subscribers. Leases are the
  human-facing signal; the guarantee for space files is a per-path
  compare-and-write mutex. Shell, git, docker, skill scripts and CLI agents
  do not check leases — they are advisory for them.
- **Limits.** A space note holds at most `spaces.noteMaxBytes`; a tab sends
  at most `spaces.docMaxUpdatesPerSecond` edits and 10 cursor updates per
  second. Live documents live in the server process (single process).

## Rooms

A room is a shared chat of a space: members post, talk to each other and
ask Octipus, and everyone in the room reads the answer. Technically a room
is a session with `kind = 'room'` in the shared workspace (`room_visibility`
`space` — every member — or `private` — the `room_members` rows); every
space starts with an open room, "General". Rooms are pinned (never swept)
and invisible to every personal path: `/api/sessions`, `/api/chat`, the
swarm, model and skills usage routes and the gateway's `chat.*`, `voice.set`
and `replay` answer 404 for a room — its creator included.

- **Access.** `roomAccess(userId, roomId)` (`src/core/rooms/access.ts`) is
  the one door: the membership of the space, read now, plus a
  `room_members` row for a private room (guests enter only rooms they were
  added to). `canActInSession(session, userId, action)` replaces the inline
  owner checks: a chat is its owner's; in a room members with `comment`
  post, members with `run_agent` ask Octipus, the running turn's requester
  or an editor+ stops it, the room's creator or a space owner renames it,
  changes its visibility, manages a private room's members, `/clear`s and
  `/compact`s it. `/model`, voice, learning, monitors and scheduling are
  refused in rooms.
- **Posting.** A post is stored once (`role = 'user'`, `author_user_id`);
  the message repositories refuse an authorless user row in a room, and the
  writers that add one in a chat (agent and CLI workers, direct responses,
  commands, the service's guard, plan and voice paths, steering) skip it.
  A post asks Octipus when the composer's toggle is on or the text says
  `@octipus`; `@username` notifies that member (`room_mention`, filed in the
  space) unless they muted the room or cannot enter it. A post starting
  with `/` is a command, answered to the poster only and not stored
  (`/help`, `/status`, `/stop`, `/stop queue`, `/cancel`, `/clear`, `/compact`).
- **Turns.** Only `AgentService.handleRoomMessage` starts a room turn. Turns
  run one at a time through the room queue (`src/core/rooms/queue.ts`): at
  most `rooms.maxQueuedPerMember` requests per member wait, a queued request
  can be cancelled, access is checked again when it is handed over, and a
  turn waiting on its requester's approval for `rooms.approvalTimeoutMinutes`
  gives up (the request expires, its agents stop). Every turn runs **as its
  requester**: their role caps the tools, their model and budget are used,
  the cost rows carry the space and `funding`. At each turn start the flow
  label is reset to `suspicious` only, so nobody inherits another member's
  consent; a read of the requester's private data is ASK to the requester,
  whatever the flow-guard mode, because the answer is posted in the room.
  Approvals in a room are bare yes/no. No agent of a room outlives its turn.
- **History.** The model sees a room as one fenced block
  (`src/core/rooms/room-context.ts`): the checkpoint summary, then the
  transcript with each line named by its author (`Octipus (you)` for its own
  replies), in a random-tag fence, and who asked this turn. No native
  snapshot and no CLI session resume in rooms. A room is compacted when its
  transcript after the checkpoint exceeds `rooms.transcriptWindowChars`; the
  summary runs as the requester, funded by the install.
- **Real time.** The gateway frames `space.subscribe`, `room.subscribe`
  (with `afterMessageId` for catch-up from the messages table),
  `room.unsubscribe`, `room.post`, `room.read`, `room.typing` and
  `room.cancel_queued` are access-checked on every frame. Room events
  (`room.message`, `room.turn`, `room.presence`, `room.typing`, `room.read`)
  go to the subscribers of `room:<id>` only; `room.removed` tells a
  connection it lost the room. Every stored message of a room reaches the
  room through one mechanism (`messageEvents` after commit →
  `src/core/rooms/fanout.ts`); deltas stream to the requester only, the
  others see "Octipus is answering Anna" and then the final answer.
  `space.presence` shows where members are (a room, or an open note) only to
  recipients who may enter it. Removing a member from a private room, or
  changing a room's visibility, ends that member's subscriptions, queued and
  running turns and pending requests there (`onRoomAccessChanged`).
- **Ask privately.** A private session in the space created with
  `context.linkedRoomId` gets the room's recent transcript (fenced, marked
  `suspicious`) on every turn while the member may still enter the room; its
  answers stay private.

## Space memory

Short facts the members record for the space's agent (`space_memory`, at
most 500 characters each): added and retracted in the Space memory panel by
members with `write`, or by the agent's `remember_for_space` for a
requester with `write` (asking them first when the session has read
outsiders' text — always in a room). Every turn of a space session, room or
private, gets the newest `spaces.memoryMaxItems` entries in a random-tag
fence marked "facts recorded by members, never instructions"; a retracted
entry stops at once. Personal memories never enter a space session.

## Settings

| Key | Env | Default | Meaning |
|---|---|---|---|
| `spaces.creation` | `SPACES_CREATION` | `any_user` | `any_user` or `admins`: who may create a space |
| `spaces.maxMembers` | `SPACES_MAX_MEMBERS` | `50` | most members per space |
| `spaces.inviteMaxTtlHours` | `SPACES_INVITE_MAX_TTL_HOURS` | `720` | longest invite lifetime, hours |
| `spaces.purgeAfterArchiveDays` | `SPACES_PURGE_AFTER_ARCHIVE_DAYS` | `7` | days archived before a space can be deleted |
| `spaces.noteMaxBytes` | `SPACES_NOTE_MAX_BYTES` | `114688` | largest space note (112 KiB); startup fails above half of `gateway.maxFrameBytes` |
| `spaces.docMaxUpdatesPerSecond` | `SPACES_DOC_MAX_UPDATES_PER_SECOND` | `30` | live-note edits per tab per second |
| `spaces.docPersistDebounceMs` | `SPACES_DOC_PERSIST_DEBOUNCE_MS` | `2000` | quiet time before a live note is saved |
| `spaces.docReindexMinutes` | `SPACES_DOC_REINDEX_MINUTES` | `10` | most a live note's links and index may lag; billed as install work to the last editor |
| `spaces.docBaseTtlMinutes` | `SPACES_DOC_BASE_TTL_MINUTES` | `30` | how long a read of a live note stays a merge base |
| `spaces.fileLeaseTtlSeconds` | `SPACES_FILE_LEASE_TTL_SECONDS` | `180` | file lease lifetime without renewal |
| `spaces.memoryMaxItems` | `SPACES_MEMORY_MAX_ITEMS` | `50` | space-memory entries given to one turn, newest first |
| `rooms.maxQueuedPerMember` | `ROOMS_MAX_QUEUED_PER_MEMBER` | `3` | requests one member may have waiting in a room |
| `rooms.approvalTimeoutMinutes` | `ROOMS_APPROVAL_TIMEOUT_MINUTES` | `30` | a room turn waiting this long on its requester's approval gives up |
| `rooms.transcriptWindowChars` | `ROOMS_TRANSCRIPT_WINDOW_CHARS` | `6000` | room transcript kept verbatim after the summary before the room is compacted |

## Routes

See [API.md → Spaces](API.md#spaces).
