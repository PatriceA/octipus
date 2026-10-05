# Changelog

Notable changes worth calling out for operators and integrators.
The format draws from [Keep a Changelog](https://keepachangelog.com)
without forcing strict semver — Octipus is pre-1.0; "minor" / "major"
labels reflect blast radius, not contract guarantees.

## Unreleased

### Fixed

- **Sponsor, budgets and team surface (review of S5a).** A personal CLI
  model can no longer be a sponsor model, nor run or release its
  credential for anyone but its owner. Only the sponsor makes the space pay
  for more (raising `own` → `unattended` → `sponsored`); an impersonating
  admin can neither name the owner sponsor nor choose their models.
  Sponsored work re-reads the space's funding at every spawn and every 30s
  of a running worker, so it stops once the sponsor is gone, in any
  process; a sponsor's account deletion is audited as such; `POST
  /api/agents/:id/message` re-checks the funding and runs inside the
  sponsor context. Room and bound-channel listen probes are install work
  attributed to the space, gated by the space budget only (never the
  sponsor's personal budget nor a member cap); a room's probe is claimed
  in the database before it is paid (migration 0134), and a proactive
  probe is skipped when the question's author may not ask the agent.
  `listen` turns only read. Their answers take 👍 / 👎, and recent 👎 slow
  the gate of rooms and channels down. Space spend sums use the
  `cost_log` workspace index. `task.changed` reaches non-guest members
  only, and the board debounces its refetch. A bound channel's turns pause
  on the space budget only when the space sponsors them. A sponsor's own
  install-type calls on a sponsor model are stamped `sponsor`. Writing the
  same space budget again no longer resets its notices; budget audits carry
  the previous value; a budget author who left is not told the space's
  spend. My work leaves out archived spaces.

- **Rooms (review of S2).** `remember_for_space` goes through
  `routeApprovalFor` as a space write (role cap, and an ASK after a private
  read in a private space session). The space memory and a side panel's
  linked-room transcript are injected per turn only, never stored with the
  turn (`metadata.promptContext`, native snapshots) nor replayed. Room turns
  carry a stop signal checked at handover, before the root agent spawns and
  before the answer is stored; `/stop`, removal and the approval timeout
  stop only the turn they decided about, and tool decisions in a room
  re-check `roomAccess`. `/compact` refuses while a turn runs. Room history
  and compaction page past the 400-row cap; a turn compacts first when its
  transcript exceeds `rooms.transcriptWindowChars` and its history stays in
  that window. A room `yes` resolves its approval by id. A requester's
  limit refusal posts a neutral line in the room (details to the requester
  only), and failed turns no longer broadcast error text. The swarm routes'
  admin bypass never reaches rooms or space sessions. A room creator's
  manage rights need a write role. Queue turns alternate between members;
  `requester` checks the running turn's requester; pruned subscriptions
  clear presence; `room.subscribe` re-checks access after joining.

### Added

- **The agent as co-editor, and file leases enforced (spaces).** In a space
  whose agent edit mode is `suggest` (the default), the notes tool's
  changes to existing notes — `write_note`, `capture_note`, `archive_note`
  — become the session's pending edit proposal and answer
  `{ proposed: true, proposalId, status: 'pending', baseSha256 }`;
  `read_note` shows that pending proposal; new notes are still created.
  `direct` mode writes through the live document as before. Members with
  the note open hear of proposal changes live (`doc.proposals`; the
  *proposals* tab shows the pending count). An accepted proposal on a
  closed note refreshes its links and index. Every file-changing
  filesystem tool now checks space file leases (prefix matching for a
  recursive delete or a directory move) and refuses a leased path with who
  holds it and until when, the check and the write under one per-path
  mutex. Shell, git, docker, skill scripts and CLI agents stay advisory
  (docs/SPACES.md).
- **Space funding, budgets and the team surface** (coworking S5,
  `docs/SPACES.md` → "Funding and budgets", "The team surface"). A space's
  owners choose who pays for the agent — each member (`own`), members for
  their own turns and a sponsor for unprompted work (`unattended`, the
  default), or a sponsor for everything (`sponsored`, each member under a
  per-member cap) — and an owner can sponsor the space with their own
  models. Space budgets cap the sponsor's spend for the whole space and per
  member (Space settings → Budget); a member at their cap is paused alone.
  Sponsored spend never moves a member's personal budget or token quota.
  "My work" lists my open tasks across my spaces; assigning a space task
  notifies the assignee; the space's board updates live from `task.changed`
  instead of polling. Rooms get `listen` and `proactive` modes with the
  group channels' gate (quiet hours, caps, 👍/👎 feedback), paid by the
  sponsor. Migration `0132_space_funding`.
- **Group channels bound to a space** (coworking §9.4). A group channel's
  owner who also owns a space can bind the channel to it (Settings →
  Channels → *Bind to space room*, with the acknowledgement that everyone
  in the channel can read what the room shows; audited). Each thread is then
  a room of the space: members' requests run as room turns as themselves,
  linked people outside the space get a private hint and no turn, the room
  is posted back in the thread, taken tasks land on the space's board (one
  per message) and the space's budget replaces the channel's. Binding closes
  the members' own thread sessions of that channel. Migration
  `0133_space_bridge_connectors`.
- **Space connectors** (coworking §9.5). Space settings get *Connectors*:
  owners connect GitHub (a token) and Atlassian / Linear (OAuth, with their
  own connect, callback and refresh flows) for the whole space. Their
  credentials are a new vault scope, `space`, keyed by the space
  (`dekForRow`, also used by both rotation scripts), readable only through
  the space access layer and never through `{{secret:}}`. In a space the
  shell, the GitHub tool and CLI agents run with an empty per-space
  `GH_CONFIG_DIR` (CLI agents also an empty `HOME`), so a space session
  never acts with the host's GitHub login.

- **Rooms in the web.** With a shared space selected, the sidebar gets
  *rooms* (with the unread count) and `/rooms` lists the space's rooms with
  unread badges. A room shows everyone's posts (others on the left with name
  and initials, mine on the right) and Octipus's answers; the composer has
  an "Ask Octipus" toggle and `@` completion of the room's members; a turn
  strip says "Octipus — answering Anna", "waiting for Anna to approve" and
  who is queued (cancel for my own requests). Side panels: members (a
  private room's creator and space owners add and remove), space memory
  (add and retract with `write`), settings (title, visibility). Also mute,
  "Ask privately" (opens my private chat in the space linked to the room),
  new room for editors and owners, presence avatars in the header saying
  where each member is, catch-up after a reconnect (`afterMessageId`), and
  a notice when the room is taken away (`room.removed`). `/chat?session=<id>`
  opens that chat.
- **Rooms.** A space's shared chats (coworking S2, backend): sessions with
  `kind = 'room'` (`space` or `private`), every space starting with
  "General". Members post, `@mention` each other and ask Octipus; each turn
  runs as its requester through a per-room queue
  (`rooms.maxQueuedPerMember`, `rooms.approvalTimeoutMinutes`), sees the room
  as one fenced, attributed transcript (compacted past
  `rooms.transcriptWindowChars`), and its answer reaches every member while
  the stream reaches the requester only. New gateway frames `space.subscribe`
  and `room.*`, events `room.*` and `space.presence`, routes under
  `/api/spaces/:id/rooms`. Space memory (`/api/spaces/:id/memory`, the
  agent's `remember_for_space`, `spaces.memoryMaxItems`) is injected fenced
  into every space session. Private side panel: a space chat with
  `context.linkedRoomId`. Migration `0129_rooms`. Rooms are invisible to
  every personal route, their creator included; a room's user row is
  written once, with its author (the repositories refuse any other).
  `notify()` takes the workspace as an argument. See docs/SPACES.md.
- **Live space notes.** Members of a shared space edit a note together: the
  notes editor binds to a shared document (Yjs over the gateway: `doc.join`,
  `doc.update`, `doc.awareness`, `doc.leave`), shows the others' cursors and
  avatars, and saves by itself ("Saved"). Every other writer — REST saves,
  quick capture, meeting notes, the agent's note tool, restores, accepted
  proposals — is merged into the live text from the base it read (three-way
  merge) or refused as stale (409), never reverting typing; `read_note` and
  `GET /api/notes/:id` return the live text and its sha. Space notes get a
  history (revisions with authors, restore), the agent's edit proposals
  (`note_edit_proposals`: diff, accept, reject; `workspaces.agent_edit_mode`),
  and space files get leases ("Ben is editing", `file_leases`). Migration
  `0130_live_documents`; new settings `spaces.noteMaxBytes`,
  `docMaxUpdatesPerSecond`, `docPersistDebounceMs`, `docReindexMinutes`,
  `docBaseTtlMinutes`, `fileLeaseTtlSeconds` — startup now fails when
  `spaces.noteMaxBytes` exceeds half of `gateway.maxFrameBytes`. New
  dependencies: `yjs`, `y-protocols`, `node-diff3` (server) and
  `y-codemirror.next` (web): a CRDT and a three-way merge are not 20 lines.
  See docs/SPACES.md.
- **Own models.** Settings → My models (`/api/me/models`) adds a personal
  model — provider, model id, your key or CLI token, a custom endpoint for
  custom providers — and binds it to text lanes; your turns then run on it,
  in your sessions and in spaces. Personal rows (`model_config.owner_user_id`,
  `user_model_bindings`, migration `0131_personal_models`) never appear in
  anyone else's lists, routing, defaults or caches; admin model and topic
  routes refuse them. Keys resolve under the row's owner, a custom endpoint is
  SSRF-checked on every request, and personal CLI rows run with a per-user
  CLI home and the owner's token. See docs/SPACES.md ("Own models").

### Changed

- Install-topic model calls (compaction and its chunk summaries, learning,
  link resolver, weekly review, evaluators, document processing, the group
  listen probe) are now stamped `install` in `cost_log` whatever turn they
  run in, through `withInstallUsage`. Spend budgets' `user_id` is nullable
  for space budgets (author only); a user's own budgets are still deleted
  with their account (a trigger replaces the cascade).

- **Live space notes: review fixes** (coworking S3). Nothing typed is lost
  on a reconnect: a closed note stays in memory for a minute (a member whose
  connection blipped keeps the epoch and Yjs merges what they typed
  offline), and after a rebuild (a restart, a reload) the editor merges its
  unsent text back through the hub (`POST /api/notes/:id/merge`, three-way
  from the last server text it synced) — a clash keeps the member's text
  with a notice and a "Copy my version" button. Shutdown saves every open
  note. A body write to an existing space note must name its base
  (`baseSha256`; `write_note`'s `base_sha256`): without one it is refused
  (400 `base_required`) instead of reverting what changed since its read;
  meeting re-imports merge from the body they last rendered. The hub owns
  awareness (a connection holds at most two client ids, never another's,
  and its states name its member), refuses updates that write outside the
  note's text (other root types, embeds, formats, `\r`) and caps the
  encoded document, builds notes with `\n` line endings (CRLF bodies are
  normalized and saved) and normalizes every writer's text. The live
  reindex keeps explicit and meeting tags; capture appends to an open daily
  note instead of merging; an archived note opens read-only; a membership
  change during a join takes effect on the next frame; a failed save keeps
  its authors; read bases outlive persist-only ones. See docs/SPACES.md.

- **Model identity is the row name.** Agent contexts carry `modelName`
  beside the provider `model` id, and providers re-read rows by
  `modelConfigName`; a modelId lookup returns install rows first, then the
  requester's own. `/model` overrides are per (session, user). Explicit model
  names (`/model`, `POST /api/agents`, `/api/agents/route`, pipeline stage and
  executor models, `/v1/chat/completions`, evaluation runs) resolve only to a
  model the caller may use; a registered model they may not use is refused
  instead of passed through. `GET /api/models/:name` returns only models the
  caller may see. Custom providers resolve an install row's key from the
  system vault only (no longer the requester's vault first).

- **Shared spaces in the web.** The workspace picker lists "my workspaces"
  and "shared spaces" (with role badges) and creates a space; a space has a
  settings page (`/spaces/<id>/settings`: name, members, invites with a
  copyable link, activity, archive, delete) and invite links open a join page
  (`/join/<token>`) that signs in or registers and comes back. Notes, tasks
  and documents follow the member's role (read-only for commenters and
  viewers, and in an archived space). A removed member is switched back to
  the default workspace and told so; the server's 404 for a denied workspace
  now carries `code: "workspace_denied"`. See docs/SPACES.md.

### Security

- **Own models: review fixes** (coworking S4). A personal CLI model's
  one-shot completions (mail triage, reader, research, `/plan`, the casual
  path) run without native tools (`--tools=`, no settings files) in a
  directory under the owner's CLI home, never in the shared workspace root;
  a CLI tool that cannot run tool-less (Codex, Antigravity) can no longer be
  bound to a lane and serves agent runs only. A personal CLI agent run is
  locked to its adapter's safe mode, as in a space (Claude: permission mode
  `default` with the stdio permission tool and only a locked settings file;
  Codex: read-only; Antigravity: plan mode); Mistral Vibe is refused for
  personal rows. Codex MCP discovery reads the run's own `CODEX_HOME`. A
  personal row's key is released only to its owner at the provider layer
  (`resolveModelKey`), so another user's request on it fails whatever key it
  brings; `/compact` never compacts another member's conversation on their
  personal model. In a space a personal CLI binding a commenter (or an
  adapter without a space mode) may not use falls through to the install
  lane instead of failing the turn, and side questions and the voice plan
  gate follow the same rules. `isRegisteredModel` only considers install
  rows and the caller's own (plus the reserved `u/` namespace), so another
  user's personal model id no longer blocks a passthrough. Red-team runs,
  `POST /api/eval/run` and `PATCH /api/topics/:topic/config` refuse personal
  rows. Admins see disabled and other orgs' install rows in
  `GET /api/models/:name` again; install rows fall back to the env key when
  the vault cannot be read (personal rows still fail loud). The SSRF guard
  also refuses `fec0::/10`, `ff00::/8`, IPv4-compatible `::a.b.c.d`, 6to4 of
  a private IPv4, local-use NAT64, Teredo and documentation ranges, and a
  personal endpoint must be `https://`. Personal rows may set
  `contextWindow` and `maxTokens` within bounds, and a compaction that runs
  on a personal row is funded `own`.
- **Shared spaces: review fixes to the access layer** (coworking S1).
  Admins no longer list, read or stream another user's agents in a space
  (history list, live list, live details, events, stop). Starting an agent or
  a pipeline, or messaging an agent, never keeps a space principal from a
  `?sessionId=`, so a viewer or a member of an archived space cannot start a
  run there; such routes keep the space for reads and stops only. The
  personal repositories refuse to write into a space (an agent context in
  a space, or a caller's `workspaceId`). Viewers cannot open chats in a space;
  an archived space refuses new chats, chat edits, learning checks, monitor
  events and plan feedback. Removing, demoting or the leaving of an owner
  revokes the invite links they made, and an accept refuses a link whose
  creator is no longer an owner. Task wakeup notifications go only to people
  with access at send time: a personal task's owner, a space task's author
  and assignee while members; space assignees must be members and personal
  ones the owner, and space tasks are never assigned to roles or nodes.
  Archive also cancels the space's queued jobs and expires its pending
  prompts; a removal cancels the member's queued jobs there. A failed
  follow-up after a committed membership change is reported in a `warning`
  instead of a 500. Impersonated space changes name the admin in the audit
  row. A user who authored space content cannot be deleted; a deletable one
  leaves their spaces with audit rows first. The personal predicate is now
  positive (no workspace, or a personal one), the gateway lets members follow
  a space artifact, a page slug prefers the viewer's personal artifact and
  never opens a space page to a guest, and a space search uses no personal
  repositories or extra scan paths.

- **Events reach their own user only.** Every gateway and turn event now names
  its user, including swarm, pipeline and agent-stream events that used to go
  out user-less to every signed-in browser. `/ws` and `/gateway` deliver an
  event to its user's connections only, whatever the connection's trust level
  or admin rights.
- **Live-artifact events go to the artifact only.** Artifact updates are sent
  to connections subscribed to `artifact:<id>` after an access check (the
  workspace owner), and the gateway now accepts the `artifact_token` sign-in
  the embed SDK sends; such a connection can follow its one artifact and
  nothing else.
- **The artifacts tool uses the agent's workspace.** It no longer guesses one
  of the user's workspaces; without a workspace in context it refuses.
- **Documents, knowledge and search no longer cross users** (coworking S0a,
  L1–L3). The documents tool lists, reads and searches only the user's own
  documents, and an admin's agent no longer inherits the admin bypass. The
  knowledge base is per user: every chunk has an owner, and the knowledge
  routes, the knowledge, documents and notes tools, and global search see the
  caller's own entries plus the product docs. Admins reach the whole
  knowledge base only with `?scope=install` on `/api/knowledge`, which is
  audited. Global search returns only the caller's sessions and hooks.
  Migration 0125 assigns owners to existing chunks (documents, notes, and
  workspace files by path); chunks it cannot attribute are visible to admins
  through `?scope=install` only.
- **Deactivation takes effect at once.** Deactivating a user (admin console or
  SCIM) revokes their sessions, refuses their API tokens, passkey, SAML and
  device-pairing logins, closes every socket they hold, stops their agents,
  expires their pending permission and approval prompts and ends any
  impersonation of them. Sessions now read `is_active` and `is_admin` from the
  database on every request, so a demoted admin loses admin rights immediately
  (their gateway connections are closed and reconnect without them). Hooks,
  heartbeats and monitors of an inactive user no longer fire. Migration
  `0126_user_deactivation` adds `users.deactivated_by`.
- **SCIM is scoped to its org.** A SCIM token's DELETE and PATCH answer 404 for
  users outside its org, deactivate an account only when no other org holds it,
  and can no longer re-activate an account an admin deactivated (409). SCIM
  DELETE now answers a proper empty 204. SCIM POST no longer adopts an
  existing account outside the org by `userName` (409 `uniqueness`), and
  PATCH changes `userName`/`emails` only on an account the org alone holds
  (403 otherwise). An org's SAML IdP signs in only that org's members or new
  accounts; a username held by an account outside the org is refused (403),
  so an IdP can no longer sign in as the install admin.
- **Deactivation closes sockets that were still signing in**, and an admin's
  deactivation of an account SCIM had already switched off is recorded, so
  that org's SCIM cannot undo it. If a step of a deactivation fails, the admin
  edit still applies and the response carries `warnings`.
- **Global search returns only skills the caller can see** (system, own and
  their orgs'), not other users' private skills.
- **Live-artifact viewers are bounded.** At most 50 `artifact_token`
  connections per artifact; each closes when its token expires, and all close
  (with their tokens refused) when the artifact is deleted or its visibility
  changes.
- **The bundled web server appends its peer to `X-Forwarded-For`**, so it can
  be listed in `TRUSTED_PROXIES` (`127.0.0.1,::1` in the Docker image) without
  letting clients pick their own address.
### Security: trust, client addresses, and who answers a request

- **No more `local` or `system` trust.** The `local` gateway auth method and
  the `~/.octipus/local-token` file are gone (the server no longer writes it),
  as is the unwired `hmac` method. An admin signed in on loopback, or behind a
  reverse proxy on the same host, used to see every user's events and pass
  every session ownership check; admin API tokens did so from anywhere. Every
  connection is now `user` trust: ownership checks (joining a session,
  `/history`, `/proposals`, `agent.stop`, `chat.steer`, `chat.interject`)
  compare user ids, and admin-only commands read `is_admin` from the database.
  `/abort` and `/status` cover the caller's own agents only.
- **The TUI signs in with your account.** It uses the CLI login
  (`~/.octipus/session.json`), opens the login prompt once when there is none,
  and does not connect without one. `/logout` disconnects.
- **Client addresses come from the socket.** `X-Forwarded-For` / `X-Real-IP`
  are honoured only from proxies listed in the new `security.trustedProxies`
  (`TRUSTED_PROXIES`, default empty) — for the gateway, REST rate limits,
  login and passkey lockouts, and audit rows. The gateway's per-address cap now
  applies only to connections that have not authenticated yet.
- **Voice mode** on `/ws` checks session ownership, and the voice planning gate
  is keyed by session and user.
- **Requests are answered by their requester.** Admins no longer answer other
  users' permission requests or agent approvals through REST, `/ws` or the
  gateway, and `GET /api/chat/approvals/pending` lists the caller's own. An
  admin unblocks someone else's run through
  `POST /api/admin/permission-requests/:id/resolve` or
  `POST /api/admin/approvals/:id/resolve` with a `reason`, which is audited;
  `GET /api/admin/permission-requests` and `GET /api/admin/approvals` list
  what is pending.

**Upgrade notes:** run `/login` in the TUI once (it prompts on start). If
Octipus runs behind nginx, Caddy or a load balancer, set `TRUSTED_PROXIES` to
the proxy's address, or every client shares the proxy's address for rate
limits. Extensions that registered commands with `minTrustLevel: 'local'`
now use `adminOnly: true`; an extension that still passes `minTrustLevel:
'local'` or `'system'` gets an admin-only command and a deprecation warning.

### Security: sign-in hygiene

- **Sign-ins are audited.** `/api/auth/login` and `/api/auth/login-mobile`
  write a `login` audit row on success and `login_failed` (with the reason:
  unknown user, bad password, bad TOTP code, disabled, locked out) on failure;
  `/api/auth/register` writes `user_created`.
- **TOTP works in the web.** The login page now reads the server's
  `requiresTOTP` answer, shows the code field and resubmits with the code;
  TOTP accounts could not sign in from the browser before.
- **Back to where you were.** Login and register accept a `returnTo` that must
  be a same-origin path (one leading `/`, no `//`, no backslash, no control
  characters); anything else is refused with 400. The web sends the page you
  were on and returns there after sign-in.
- **Pairing codes are hashed and single-use.** Device pairing codes are stored
  as `sha256(code)` and redeemed with an atomic get-and-delete, so two
  concurrent redeems of one code no longer both get a session. Codes issued
  before the upgrade stop working (they expire within five minutes anyway).
### One multi-user model

- **Workspaces are always on.** The `multiuser.orgWorkspaces` setting
  (`MULTIUSER_ORG_WORKSPACES`) is removed: `/api/me/workspaces` and the
  workspace header always work, and `/api/admin/orgs` stays admin-only. A
  stored row for the setting is deleted at startup.
- **Workspace resolution fails closed.** When the workspace of an
  authenticated request cannot be resolved, the request answers 503 instead
  of running without a workspace filter.
- **No stand-in users.** A user id that is not a real user is no longer mapped
  to "the first admin" (skills routes) or "the first user" (the profiles
  tool); it is an error. `'system'` is only ever a system job: system jobs keep
  their rate-limit exemption and stay outside per-user Docker isolation, and
  the Atlassian tools refuse without a real user. With
  `security.dockerIsolation: enforce`, a Docker call with neither now fails
  instead of running unisolated.
- **User deletion is guarded.** Deleting a user goes through one check
  (`assertDeletable`), which refuses the last active admin.
### Workspaces: notes, integrity, transfer and workspace secrets

- **Notes follow the request's workspace** (coworking S0c). Every note route
  (list, query, index, tags, read, backlinks, suggestions, pin, delete,
  capture) shows the current workspace's notes plus user-level ones, and new
  notes land in the current workspace. `workspaceId` is no longer accepted in
  the `POST /api/notes` and `POST /api/notes/capture` bodies. A slug lookup in
  a workspace falls back to a user-level note of that slug, so daily capture
  appends to an existing user-level daily note instead of creating a second
  one.
- **Migration 0127 repairs workspace stamps.** Notes, tasks, knowledge links,
  repos and background jobs whose `workspace_id` named a deleted workspace or
  another user's workspace become user-level; a note that would then clash
  with a user-level note of the same slug is renamed `<slug>-<first 8 chars of
  its id>` (the existing user-level note, or the oldest, keeps the slug). The
  five columns now reference `workspaces(id) ON DELETE SET NULL`, like every
  other `workspace_id`. Deleting a workspace renames its notes the same way
  when their slug is already used at user level.
- **Transfer moves the whole workspace.** Transferring a workspace now moves
  the previous owner's rows of every workspace table — notes, tasks,
  memories, embeddings, links, repos, agents, pipelines, jobs and the rest,
  not only sessions, documents and hooks — in one transaction. Workspace
  secrets are re-encrypted under the recipient's key; before, a transferred
  secret could no longer be decrypted. The table list lives in
  `src/db/workspace-tables.ts`, and `scripts/backfill-workspace-id.ts` uses
  it too (it now also stamps notes, tasks, memories and links). The
  workspace's files directory moves to the recipient too (see "Files per
  workspace"); a transfer onto an existing directory is refused with 409
  `files_conflict` and changes nothing.
- **Workspace secrets resolve by name.** `getByName` with a workspace now
  returns that workspace's secret (it was selected, then never decrypted). A
  `scope='workspace'` secret bound to no workspace is no longer shown or
  returned in every workspace.

### Workspaces become real (coworking S0c)

- **A turn runs in its session's workspace.** The root agent, role heartbeats
  and gateway `chat.send` used the user's default workspace whatever session
  they ran in, and went on without one when it could not be resolved. A turn
  now uses `session.workspaceId` (the default only when the session has none),
  checks the user owns it, and fails rather than run unscoped. Tasks,
  artifacts, files and memories a turn produces land in that workspace.
- **The TUI's workspace is honoured.** The gateway reads `?workspace=` (id or
  slug) at sign-in and stores it on the connection; a name that matches none
  of the user's workspaces fails the sign-in. `chat.send` accepts a
  `workspaceId`, and new sessions are created in it, else in the connection's
  workspace. An existing session keeps its own.
- **Files per workspace.** Each workspace has its own file root,
  `users/<id>/workspaces/<files_dir>/files`. `workspaces.files_dir` is stored
  (migration 0127): the workspace that is each user's default at upgrade
  keeps `default`, every other workspace (and every new one) uses its id.
  Changing the default, or creating a workspace as the default, moves no
  file. A transfer renames the directory to
  `users/<recipient>/workspaces/<workspace id>`; deleting a workspace removes
  its directory. The file browser,
  the Changes tab, `/changes`, uploads, the repo registry and the shell all
  follow the session's or the request's workspace. A user's agent never
  resolves to the flat `workspace.rootPath`: an agent without a real user is
  refused, and a system job names its root.
- **Shell `cwd` is checked.** A named working directory must lie inside the
  workspace root, an allowed extra path or the dev-mode project; a relative
  one is taken from the workspace (or project). This keeps the work where the
  evidence gate and Changes tab look; it is not a sandbox.
- **A pipeline stage's verify command runs in the session's workspace.** It
  had no workspace outside dev mode and was reported to the auditor as not
  run.
- **Hooks and link suggestions follow the workspace.** A directly spawned
  (non-orchestrated) hook agent runs in the hook session's workspace, and
  note link suggestions offer only notes of the note's workspace and
  user-level notes.
- **A new user's first requests no longer race.** Parallel first requests
  each creating the default workspace could collide and answer 503; the
  insert now tolerates the race and reads the winner's row.

**Behaviour changes for users of several workspaces:** files created from a
non-default workspace before this release sit in the `default` directory and
stay there (nothing is moved); new files from that workspace go to its own
directory. Memories now follow the session's workspace: facts learned in a
non-default workspace, which were filed under the default one, are no longer
mixed into it. Existing memories are not migrated.

### Shared spaces (coworking S1, backend)

- **Spaces: workspaces several people share.** A space is a workspace with
  no owning user; access is membership with a role (`owner`, `editor`,
  `commenter`, `viewer`, `guest`), read from the database on every request.
  `POST /api/spaces` creates one (who may: `spaces.creation`, `any_user` by
  default or `admins`); `/api/spaces/:id/...` renames, archives, lists and
  manages members and invites, and shows the space's activity. Someone who is
  not a member gets 404 for every space, admins included. See
  [docs/SPACES.md](docs/SPACES.md).
- **Invite links.** Owners create links per role with a clamped lifetime
  (`spaces.inviteMaxTtlHours`, default 30 days) and a use count; only a hash
  of the token is stored, a single-use link admits exactly one person, and a
  revoke reaches only its own space. `GET /api/invites/:token` previews a link
  without signing in; both invite routes are rate-limited like logins. A space
  holds at most `spaces.maxMembers` members (default 50).
- **Removal takes effect at once.** Removing or downgrading a member stops
  their agents in the space, expires their pending prompts there and pauses
  the data sources they own on the space's artifacts. The last owner cannot be
  removed, demoted or leave, and a user who is the last owner of a space
  cannot be deleted.
- **Archive, then delete for good.** An archived space is read-only and its
  agents stop. An owner can delete it once it has been archived for
  `spaces.purgeAfterArchiveDays` (default 7): every row and file of the space
  goes, in one transaction; its audit and cost history stay.
- **Every change is audited** with the space's id (`space_*` audit actions).
- Migration `0128_spaces` adds `workspaces.kind`, `created_by` and
  `archived_at` (and makes `user_id` nullable for spaces only),
  `workspace_members`, `workspace_invites`, `workspace_id` on `audit_log`,
  `permission_requests` and `cost_log`, `funding` on `cost_log` and `agents`,
  paused flags on artifact data sources, and a per-workspace unique note slug.
- **Members work on the space's content.** With a space selected
  (`X-Octipus-Workspace`), notes (and their links), tasks and comments,
  documents, artifacts and their pages, knowledge, sessions and notifications
  read and write the space's rows by the member's role: viewers read,
  commenters also comment, editors and owners write (a refused write is 403,
  an archived space 409). Every other route runs in the caller's personal
  default workspace, except agents and pipelines addressed by id, which follow
  their session. A header naming a space you are not (or no longer) a member
  of is 404 on every route but sign-in, health, `/api/me/workspaces` and
  `GET /api/spaces`.
- **Personal paths never return a space's rows**, for their author or an
  admin: the personal repositories, the note and link repositories, the notes
  graph, global search, knowledge search, role-agent and heartbeat probes,
  memory routes and the admin session lists all exclude shared workspaces.
  Links resolve inside one scope, vault sync stays personal, and a space's
  files live in `<workspace.rootPath>/spaces/<id>/files` and its uploads in
  `<workspace.documentsPath>/spaces/<id>/`.
- **Space tasks wake their own people.** Closing a blocker wakes and notifies
  the dependent task's author (and a user assignee), whoever closed it; a
  space task never wakes a role heartbeat. A data source of a space artifact
  refreshes only while its owner may write in the space, and pauses
  otherwise. Private artifacts in a space are their creator's only.
- **Notifications carry their workspace.** A notification filed with a
  `workspaceId` lists in that workspace's inbox (and user-level ones
  everywhere).
- **The agent works inside a space.** A member's private chat in a space
  runs the agent there: its tools read and write the space's notes, tasks,
  documents, artifacts, knowledge and files by the member's role. Every
  agent context is built in one place (`buildAgentContext`,
  `src/core/agent/context.ts`), which reads the membership and refuses a
  viewer, a removed member, an archived space, and schedules or monitors in a
  space; children inherit the space, what started the run (`trigger`) and
  who pays (`funding`, `own` for now). `POST /api/agents` follows the session
  it names: 403 for a viewer, 404 for a non-member, 409 for an archived space;
  `POST /api/pipelines` likewise, for roles that may write (editors, owners).
- **One decision for every tool call.** `routeApprovalFor` re-reads the
  membership on every call, on all six dispatch paths (agent loop, tool
  middleware, CLI permission relay, MCP, verification gate, action recovery):
  a commenter's agent runs only read and comment tools, nobody runs a
  personal-only tool in a space (scheduling, monitors, pipelines and recipes,
  memory and profile tools, vault sync, indexing, meeting notes, writes
  through personal connectors — the agent is told why), and once a session
  has read your private data, writing into the space asks first even with
  the flow guard off.
- **Personal memories and profile stay out of spaces**, child workers
  included, and space sessions are never learned from (`sessionAudience`).
- **CLI models in spaces** run only in a mode where their own tools stay
  behind Octipus's checks (Claude: permission mode `default` with the
  permission tool; Codex: read-only; Antigravity: plan); Mistral Vibe is
  refused, commenters use API models only, and an install CLI login serves
  spaces only when its model is marked `metadata.cliAgent.sharedUse: true`.
- **Spaces: personal connections and agent configuration stay out.** In a
  space, writes go only through tools known to act on the space; writes
  through your OAuth connectors (`connector_call_tool`), MCP servers, real
  browser (`browser-ext`), MCP server administration, skill distillation and
  `update_skill` are refused and not offered, and their reads mark the
  session private so writing that data into the space asks first. The flow
  label is now stored on the session (`sessions.flow_label`, migration 0128),
  so a restart keeps it. A Claude-binary CLI model in a space reads no user,
  project or local settings file (`--setting-sources=` with a locked
  `--settings` file), and nothing writes `.claude/`, `.codex/`, `.gemini/`,
  `.agents/` or `.mcp.json` in a space's files. A pipeline's verify command
  follows the space rules, a pipeline resumes only for a starter who can
  still write, and a space artifact takes no `tool` or `mcp` data source.
- **Only an administrator edits a system skill.** Before, any signed-in user
  could change a skill shared by every user (`update_skill`, `PATCH
  /api/skills/:id`).
- **Cost rows name the space.** Every model call of a space turn writes
  `cost_log.workspace_id` and `funding`; compaction, embeddings, memory
  extraction, toolshim, decision, vision and OCR calls are stamped `install`.
  Permission requests carry their workspace, and an admin who is not a member
  of a space can neither list nor answer its requests and approvals.
### The web is on the gateway (coworking S0d)

- **One gateway connection per tab.** The web app's chat page, permission
  prompts, recommended-models panel and documents page share one `/gateway`
  connection per browser tab (`/auth/ws-ticket` → `auth`). Every tab of a user
  receives that user's events, so a reply, an error, a steered message or an
  answered prompt shows in all of them. **The legacy `/ws` and
  `/ws/permissions` sockets are removed** — integrations still on them must
  move to `/gateway` (frame mapping in `docs/architecture/gateway.md`). The
  browser extension's `/ws/browser-bridge` and `/voice` are unchanged.
- **New gateway messages:** `chat.error`, `approval.resolved`, `document.*`,
  `model.install_progress` and `voice.speak` events; the `permission.pending`
  snapshot after `subscribe` (a tab opened after a prompt was raised shows
  it); client `voice.set` and `replay { sessionId, afterEventId }` (own
  sessions only). In-app deliveries to `webchat:<you>` arrive as a
  user-stamped `chat.message`. `approval.respond` for an unknown or foreign
  request now answers `APPROVAL_NOT_FOUND` instead of nothing.
- **Limits are settings:** `gateway.maxConnectionsPerUser` (default 20, was a
  fixed 10; a tab over it shows "Too many open tabs"),
  `gateway.maxFrameBytes` (default 256 KiB, the gateway socket's
  `maxPayload` — it was the `ws` default of 100 MiB) and
  `gateway.replayMaxSessions` (default 500; replay buffers are now capped,
  least recently active first, and dropped when a session is deleted or
  archived). Env: `GATEWAY_MAX_CONNECTIONS_PER_USER`,
  `GATEWAY_MAX_FRAME_BYTES`, `GATEWAY_REPLAY_MAX_SESSIONS`.
- **Workspace switches are clean.** The API client's workspace header (now
  the workspace id) changes synchronously on a switch and the query cache is
  cleared; workspace-scoped queries key on the workspace id.

- **Tabs keep to their own session.** A reply, error, status line or
  streamed text of another session (another tab's turn) no longer stops this
  tab's spinner or replaces its streamed text, a tab on "New chat" no longer
  jumps into another tab's session, and only the spoken turn's own reply is
  read aloud. `voice.set {on:false}` from a tab that did not turn voice on is
  ignored, and a closing tab takes a session out of voice mode only when no
  other tab of the user holds it there.
- **A refused message says so.** A `chat.send` refused before its turn starts
  (`INVALID_MESSAGE`, `RATE_LIMITED`, `SESSION_NOT_FOUND`) stops the spinner
  and shows why; the chat page checks the 100 000-character limit and the
  frame cap (`auth_ok.maxFrameBytes`) before sending.
- **Reconnects do not duplicate.** `replay` without `afterEventId` answers
  `gap: true` with no events (the client reloads from REST) instead of the
  whole buffer; a replayed reply and another tab's steered message are
  matched against their persisted rows instead of shown twice. `auth_ok`
  reports the frame cap the socket enforces (read at start), not a later
  config value. Replay buffers are also dropped for sessions removed by a
  space purge. Model install progress is re-read on reconnect.
- **In-app delivery needs a chat page.** A delivery to `webchat:<you>` counts
  as delivered only while a connection shows the chat page (it subscribes to
  the `chat:inbox` resource); an open terminal or a tab on another page no
  longer counts.

**Behaviour changes:** the TUI uploads pasted or attached images over REST
(`POST /sessions/:id/attachments`, creating the session first if needed) and
names them in `fileRefs`, as the web does, so images up to the 10 MiB upload
limit work under the default `gateway.maxFrameBytes`. Inline `chat.send`
`attachments` are now held to 256 KiB each. Approval answers from the web go
over the gateway instead of `POST /chat/approve` (the route stays for REST
clients).

## v0.6.0 — Shared work, budgets, and stronger review (2026-10-01)

Octipus 0.6.0 brings a shared task board for people and role agents, dollar
spend budgets, and explicit acceptance criteria for pipeline review. It also
improves long-running CLI work, skill management, and MCP connections. This
release includes 95 commits since v0.5.1, before release preparation.

### Shared tasks and background work

- **Task board:** assign tasks to users, roles, or swarm nodes; claim work with
  atomic, expiring leases; and leave progress comments. The tasks page adds
  assignee filters, claim controls, and a role-agent panel.
- **Role agents and wakeups:** enabled roles work assigned tasks on the
  heartbeat. Completing a blocker or the last child task wakes dependent work;
  PostgreSQL notifications carry wakeups across processes and a database lease
  coordinates role turns. Child briefs include goal ancestry, and task
  mutations enter the audit trail.
- **Persistent session monitors** track follow-up work. Agent approvals are
  stored in the database rather than only in process memory.

### Spending, permissions, and data flow

- **Dollar spend budgets:** admins can set daily or monthly limits per user,
  role, or workspace. The default warning is 80%; reaching 100% pauses agents
  and refuses further runs until reset or a limit increase. Budget settings,
  dashboard cards, banners, and chat refusals show the same recorded spend.
  Budgets are opt-in. Unknown CLI/subscription costs count as $0, and an
  in-flight call can cross the limit, so these are not exact billing caps.
- **Flow guard:** sessions track reads of untrusted content, private data, and
  raw credentials. Qualifying outbound calls escalate from ALLOW to ASK,
  without an extra model call. It defaults to `agent.flowGuard: ask`; unattended
  calls that need approval are blocked. Labels are in memory and reset on
  restart. Bridged tools are checked, but Codex native tools have no per-call
  relay; vault-authenticated calls have a documented exemption. See
  [Flow guard](https://github.com/PatriceA/octipus/blob/v0.6.0/docs/FLOW-GUARD.md)
  for the coverage and limits.
- **Authorization fixes:** enforce ownership for mid-run guidance, hooks, and
  notification destinations; verify webhook signatures against raw bytes,
  deduplicate redeliveries, and queue accepted events fairly.

### Review and execution reliability

- **Acceptance criteria:** plan items can name criteria that QA must check with
  evidence. An unmet or omitted criterion prevents a pass. Using the same model
  for implementation and review produces a notice pointing to the Verify lane;
  the Bug Fix recipe now uses that lane for verification.
- **Attempt tracking:** retries compare changes against the original baseline.
  A worse swarm retry that changed no files retains the earlier attempt, and
  pipeline escalation identifies the best earlier attempt and its commit.
- **CLI continuity:** preserve parent and child sessions, support explicit
  child `resumeKey` values and opt-in Git worktrees, deliver image attachments,
  and keep meaningful mid-run messages visible after reload. Long tool calls
  and child collection survive bridge delays more reliably.
- **CLI controls and portability:** expose the role's assigned skill index,
  direct delegation through `spawn_child`, add shell-network hook checks, and
  fix Windows command resolution and metacharacter escaping. Quota detection
  now uses failed vendor runs rather than matching ordinary output.

### Skills, models, and MCP

- **Skills:** pin skills per chat or as defaults, deduplicate imports, hide
  personal entries, and reload mounted skills without restarting. Agents and
  MCP clients can update editable skills through shared authorization;
  mounted skills remain editable at their source.
- **MCP package:** `octipus-mcp-server@0.6.0` adds an `update_skill` alias,
  includes skill IDs in listings, and documents shared authorization and
  mounted-skill restrictions for updates. Existing skill tools and loading
  aliases remain available; the server now advertises 87 tools across 25 groups.
  The backend adds MCP permission controls, reconnects dropped servers on demand, applies HTTP request
  timeouts, and keeps an unavailable server from blocking tool dispatch.
- **Optional decision models:** a decision lane supports TypeSafe Jev and a
  local Ollama stand-in, with shadow evaluation for routing, retrieval,
  categorization, and review. Privacy and retention checks gate remote use;
  this is an optional capability, not a new required provider.
- **Everyday fixes:** configurable email-triage categories and mailbox labels,
  chat slash-command suggestions, reduced history polling, corrected settings
  toggles, and preservation of embedded data when initialization fails.

### Upgrade notes

- Back up the database/data directory and `.env` (including `MASTER_KEY`) and
  stop Octipus before updating. Node.js **24.19.0 or newer** remains required
  for the full application. Reinstall locked dependencies and rebuild the
  backend, web app, CLI, and MCP server; database migrations **0108–0119** run
  during normal backend startup.
- New source installations support `octi update` (`--dry-run` previews it).
  Existing v0.5.1 installations should first use the installer update path in
  the [installation guide](https://github.com/PatriceA/octipus/blob/v0.6.0/docs/INSTALLATION.md).
- Update a global MCP installation with
  `npm install -g octipus-mcp-server@0.6.0`, or pin your MCP client's npx
  arguments to `["-y", "octipus-mcp-server@0.6.0"]`, then restart that client.
  The npm package is the bridge; update the connected backend too to use the
  new skill-update behavior.
- Review unattended workflows affected by the default flow guard. Spend limits
  need admin configuration; role agents and child worktrees also require
  explicit setup.

[Full comparison](https://github.com/PatriceA/octipus/compare/v0.5.1...v0.6.0)

## v0.5.1 — The MCP server, on npm (2026-09-18)

`octipus-mcp-server` is published to npm, so an MCP client — Claude Desktop,
Claude Code, anything that speaks the protocol — can reach an Octipus instance
without checking the repository out:

```json
{ "mcpServers": { "octipus": {
    "command": "npx", "args": ["-y", "octipus-mcp-server"],
    "env": { "OCTIPUS_URL": "http://localhost:3005", "OCTIPUS_API_KEY": "octi_…" } } } }
```

The package was ready to publish four releases ago and never was, which left a
few things to fix on the way out — each of them the kind that is free to change
now and breaking afterwards.

- **The installed command was `assistant-mcp`**, named after what this project
  was called before the rebrand. It is `octipus-mcp` now. Nothing referenced the
  old name; every install after a publish would have.
- **The server reported version `1.0.0` in the MCP handshake** — hardcoded, and
  wrong in every build ever shipped. It reads its own package version now.
- **`octipus_chat` advertised an `expert_id`** it was sending to an API that
  stopped reading it when the expert layer was retired.
- **The docs listed `octipus_list_experts` and `octipus_chat_with_expert`**,
  which the server no longer registers, and claimed 88 tools across 26 groups
  where it advertises 86 across 25 — counted by asking a running server rather
  than by reading the source.
- **The package now carries a LICENSE**, a homepage, an issues link and
  keywords; npm only packs files inside the package directory, so the repo-root
  licence never reached it.

**Release process.** The gate now runs the tests of the package it publishes —
the MCP server has its own suite that `npm test` at the root does not touch,
which is how the expert removal broke it unnoticed. It also fails when the
committed version does not match the tag: `sync-version` rewrites the runner's
copy so the artifact is right, but it never wrote back to the repository, which
is why `package.json` sat at `0.1.0` while the tags climbed to v0.4. And the
process itself is written down in CONTRIBUTING.md rather than living in a
workflow comment.

**Topics API.** `PUT /api/topics/agents/binding` and
`PATCH /api/topics/coding/config` write through to the lane a retired name
resolves to instead of returning 404. The model registry and the topic-config
store always resolved those names; only the API rejected them, which made the
v0.5 compatibility promise false exactly where a script would lean on it.

## v0.5 — One model per kind of work (2026-09-18)

114 commits since v0.4. The theme is that Octipus stopped asking one model to do
everything: a request is now routed to a *lane* before the turn starts, each lane
carries its own model binding, and the layer that used to sit between a request
and its model — the expert — is gone. Alongside that, a conversation with a
vendor CLI survives the turn that started it, and the token ledger finally tells
the truth about what a cached prompt costs.

Measured against the same four-task harness the previous release was measured on
(one model, one endpoint, ten harnesses — <https://harness-arena.net>), the same
work is 15–31% cheaper per run than v0.4 and the standing prompt fell from 20,951
tokens a call to 12,357.

### Lanes: the model is chosen per request, not per install

`agents` — the one lane that served every worker — is split, and two more lanes
join it. The full set is now `build`, `everyday`, `verify`, `research` and
`background`, and each binds its own primary, backup and executor model on the
Topics page.

- **`build`** takes implementation, debugging, architecture and anything that
  leaves an artefact someone later depends on. This is where a stronger model
  changes the quality of the answer rather than whether one arrives.
- **`everyday`** takes chat, lookups, classification, summaries and drafting —
  high volume, low stakes, wrong answers visible immediately.
- **`verify`** takes review and QA, and exists to be a *different* model from the
  one that did the work: a second opinion from the model that wrote the code
  shares the blind spot that produced it.
- **`research`** keeps its own binding because it is the highest-token work in
  the system and should be pinnable somewhere cheap on its own.
- **`background`** takes memory extraction, summarisation and LLM-as-judge.

Routing happens *before* the turn, in `src/core/agent/lane-intent.ts`, and the
rule is the cost of being wrong. A model sent to the wrong tool notices and calls
`list_tools`; a model sent to the wrong lane notices nothing — a weak model does
not stall on hard work, it produces something plausible and finishes. So work
that names a file, a stack trace or a diff fails *up* into `build`, and
everything else falls to `everyday`.

Every retired topic name still resolves (`coding`, `qa`, `writing`, `chat`,
`voice` and the rest alias to their lane), so existing bindings, scripts and
plugins keep working.

`spawn_child`'s `topic` argument now actually selects the child's lane instead of
only labelling the topic path, and `escalate_to_expert` becomes
`escalate_to_other_lane` — it refuses when the lane named resolves to the model
the parent is already on, before the escalation budget is spent.

### Roles replace experts, and you can write your own

The `presets` table and the whole expert layer are gone (migration
`0105_drop_experts`). An expert was a row that paired a role with tools, a
prompt, critical rules and a model preference — and every one of those parts
already had a better home:

| was on the expert | lives now |
|---|---|
| role + tools | the role itself |
| critical rules | `RoleMeta.criticalRules`, appended to the role prompt |
| skills | skill↔role assignments, keyed by role name |
| deliverable template | the role's `prompt.md` OUTPUT section |
| model preference | the lane the role resolves to |

The practical failure it removes: standing instructions used to be a *database*
lookup, so a seed that had not run — or a row an operator deleted — silently
produced a specialist with no rules, and nothing said so. They are behaviour for
a kind of work, so they now belong to the role that does it.

Roles themselves became editable data rather than sixteen folders in the source
tree. The Topics page lists each lane's roles underneath it; an admin can add a
role with a name, a one-line description, a prompt and a tool list, edit any
shipped role, and delete one they created. A created role joins the live registry
immediately — no restart — and becomes spawnable at once.

How a role gets *used* is worth stating plainly, because the grouping does not
say it: nothing selects a role out of a lane. The arrow runs role → lane. A role
is chosen by an agent naming it in `spawn_child`, off its one-line description,
which is why the description is a required field rather than a comment — a role
with a blank one is a bare name in the delegation menu that nobody picks.

### The advertised tool list is chosen for the message

Lazy tool discovery already split a role's tools into an advertised core and a
long tail reachable through `list_tools`. That split was per role — identical on
every turn — so a coding turn that only touches files and a shell still paid for
the user's notes, to-do list, knowledge base, chat channels, repo registry and
web search on every single call.

The core set is now a property of the **message**. Two rules keep it survivable:
it can only ever *shrink* a role's own list, so nothing new is granted and the
role's `toolIds` remains the permission boundary; and it fails open, so a tool
group with no entry in the intent table is always kept and shipping a new tool
cannot silently lose it. Swarm children get the same treatment as the root.

Measured on the arena's model: 20,951 tokens a call → 12,357.

### A vendor CLI conversation survives the turn

Claude Code and Codex runs are resumed across turns instead of starting cold
every time: the vendor session id is stored on the Octipus session, only the new
turn is sent, and Octipus's own compaction is piped through to the vendor
session. A resume that fails falls back to a cold run rather than failing the
turn. `cli.reuseSessions` is **removed** — reuse is always on, and an adapter
declares whether it can resume at all.

Two isolation holes closed along the way: the one-shot CLI provider path and the
agent CLI path both now load an isolated MCP configuration unconditionally,
rather than inheriting whatever MCP servers the host user happens to have
configured. CLI prompts are sent on stdin, because a multi-line argv is silently
truncated on Windows, and the tool bridge no longer returns fault detail to its
caller. Runaway completions have a cap and a kill.

### The token ledger tells the truth about caching

- A **billable-token** figure that excludes cache reads, and every cost gate,
  budget comparison and spawn decision now reads *that* rather than the grand
  total. A cached prompt was previously charged against budgets at full price.
- Anthropic, OpenAI-compatible and LiteLLM cache counters are recognised and
  logged, including the cache-write/cache-read split, with a warning when cache
  tokens arrive on a model that has no cache pricing configured.
- Every assembled system prompt is splittable at a volatile marker, so the
  static tier can sit ahead of a provider's cache breakpoint instead of being
  invalidated by a per-turn block.
- An OpenRouter conversation is kept on one endpoint, because a provider switch
  mid-conversation throws the prompt cache away.
- An Octipus session is one coherent conversation *across* providers.

### Windows

A batch of real portability work: the premise check and the docs index key paths
the same way, shell commands keep their paths and a deadline actually kills the
process, `devMode` accepts a Windows project path (and refuses Windows system
directories), owner-only files are owner-only there too, CocoIndex installs, the
real `node.exe` is spawned, CRLF is out of the tree, and Vitest can see its own
test files.

### Desktop, mobile and connectors

- The desktop app runs a self-healing preflight before launch, rebuilds the
  backend when `dist/` is older than the sources, selects its mode through Vite
  rather than an `sh` env prefix, and stops watching the Rust build directory.
- Paired phones get push notifications for approvals and permission requests, a
  30-day session lifetime, and never get advertised a LAN URL they cannot reach.
- A native multi-repo registry with Java support, ownership scoping and hardened
  discovery; a CocoIndex Code connector; MCP stdio child-environment hardening.
- Mutating tool calls are journalled so an uncertain outcome can be reviewed
  after a crash or a cancellation, with cancellation plumbed through.
- An MCP server's tool list is read to the last page, not just the first.

### Operator-facing changes

- **New lanes need binding.** `build`, `everyday`, `verify`, `research` and
  `background` each take their own model on the Topics page. Retired names still
  resolve, so nothing breaks unbound — but until you bind them, routing changes
  the log line and nothing else.
- **The topics API accepts retired names.** `PUT /api/topics/agents/binding`
  and `PATCH /api/topics/coding/config` write through to the lane the name
  resolves to instead of returning 404, so an existing script keeps working; the
  response reports the canonical topic it landed on. A name that is not a topic
  at all is still a 404.
- **`cli.reuseSessions` is removed.** Vendor CLI session reuse is always on.
- **The `presets` table is dropped.** If you customised an expert's prompt, copy
  it into a skill before taking migration `0105` — that is the replacement, and
  the reason skill proposals now promote to skills rather than to experts.
- **`GET|POST|PATCH|DELETE /api/experts` are gone**, replaced by `/api/roles`,
  which now also creates and deletes. `GET /api/roles` returns a role's prompt
  and critical rules to admins only.
- **The MCP server's `octipus_chat` drops its `expert_id` parameter**, which had
  been sent to an API that no longer reads it.
- **`GET /api/health/detailed` reports the running version**, so "which build is
  answering" is a reading rather than a guess.
- **The version is now declared in one place.** `package.json` is the source;
  `scripts/sync-version.ts` rewrites the web app, the plugin SDK, the MCP package
  and the Tauri bundle from it on a release tag. Those four had said `0.1.0`
  since the first release because they were never in the list.

### Fixed

- `/clear` leaked cleared conversations into resumed CLI sessions.
- A vendor CLI session id was mistaken for an Octipus session id.
- `codex exec resume` rejected `--sandbox`.
- Binding a model with no embedding capability to the `embedding` topic is
  refused at the API rather than failing at first use.
- OpenRouter model discovery no longer sorts by price; read-only meta-tools
  default to ALLOW; `search_files` accepts globs.
- `defaultMaxTokens` could exceed `maxTokens` after a migration raised only one
  of the two defaults.
- Custom Anthropic endpoint discovery, vault secrets with surrounding
  whitespace, and the Voyage model list.


## Earlier — the backlog these releases drew from (2026-05 – 2026-08)

### The orchestrator hop is gone — one agent loop per turn (2026-08-23)

Phase 9 of [`docs/plans/rebuild-execution-plan.md`](docs/plans/rebuild-execution-plan.md),
which closes that plan. The agent you talk to now holds real tools.

**What changed for a user.** A message used to be read twice: a keyword
classifier decided whether it was "casual" (a tool-less one-shot completion) or
work (an `orchestrator` agent whose only tools were `spawn_child` and
`profiles`). That orchestrator could not do anything itself, so 51% of its runs
read the request, concluded they needed nobody, and answered from memory —
18.2% of all agent tokens for a hop that returned nothing. The root of a turn
now runs as the `general` role with the general toolset **plus** the delegation
meta-tools: it reads the file, runs the search, stores the note, and calls
`spawn_child` only when a task genuinely needs a specialist. Delegation, swarms
and pipelines are unchanged.

**Operator-facing changes.**

- **`orchestrator.mode` no longer accepts `router`.** An existing `router`
  setting (DB or `ORCHESTRATOR_MODE`) is migrated to `lite` at load; nothing to
  do, and boot will not fail on it. Modes are now `auto | full | lite`, and a
  mode is a *prompt tier*, not a control-flow branch: a small model runs the
  same loop with a trimmed prompt, a tool list capped to
  `orchestrator.smallModelMaxTools`, and a hard iteration cap.
- **`orchestrator.liteMaxIterations` default 3 → 8.** Three was sized for
  "delegate once and relay"; a root that does its own work needs to read,
  search, and answer. An explicit setting is untouched.
- **`orchestrator.routerSmallModelMaxParams` keeps its name** — it is the
  "small model" threshold every trim in the product reads, not a mode selector.
- **The `orchestrator` role is deleted.** Custom per-role tool allowlists for it
  are ignored; the roles API no longer lists roles that have no folder. Casual
  turns are agent runs now, so they appear in the agent list and in cost
  tracking, where the old shortcut was invisible to both. Expect a casual turn
  to count more tokens (it carries a tool schema) at roughly unchanged latency
  and near-unchanged cost — the bulk is the prefix providers cache.
- **Unattended runs (hooks, heartbeats) no longer raise approval prompts.**
  The root can hit an `ASK`-level permission now that it holds tools; on a run
  with nobody watching, the existing unattended path (auto-approve, or refuse
  via `multiuser.unattendedDenyActions`) applies instead of waiting out the
  five-minute request TTL and then failing.

  **Superseded 2026-09-10:** unattended `ASK` actions now return
  `approval_required`; they are not auto-approved. Stored `DENY` decisions take
  precedence over broad allow rules. See
  [`docs/reports/consolidation-2026-09-10.md`](docs/reports/consolidation-2026-09-10.md).

**Two latent bugs fixed on the way, both of which affected any install.**
`loadRolesFromDb` rebuilt each in-memory role from the four columns the `roles`
table has, so at boot it silently dropped `readOnly` — the only per-handler
write filter in the product, meaning the read-only `qa`, `review` and
`architecture` roles regained file-writing tools after startup — along with
`coreToolIds`, which disabled lazy tool discovery everywhere. Both are now
preserved, pinned by a database-backed test.


### Hermes v0.18 adoption — learning loop, verification, Vertex (2026-07-16/17, PRs #237–#245)

Selectively adopts ideas from Hermes Agent v0.18 ("The Judgment Release")
after a comparison against octipus. What we stole/finished, why, and what we
deliberately ignored is in
[`.octipus/plans/hermes-v018-adoption.md`](.octipus/plans/hermes-v018-adoption.md);
Mixture-of-Agents was assessed and **parked** (opt-in preset only — see
[ROADMAP](ROADMAP.md) → *Later*).

- **CI unblock (#240).** `main` had been red team-wide since #231 — the only
  `*.integration.test.ts` missing the `describe.skipIf(!isIntegration)` guard
  (`topic-alias`) ran its embedded-PGlite setup in the unit lane, where a
  process-global DB/registry singleton made it order-dependent (passed locally,
  failed in CI). Gated it behind `INTEGRATION=1` like every sibling. Backend CI
  green again.
- **Learning loop — octipus can now *generate* skills, not just prune them
  (A1-M1 #244, A1-M2 #245).** A new **`skill_distill` tool** distils a reusable
  skill from recent conversation, provided text, or a **verified-good
  trajectory**, and files it as a **pending proposal** for review — never a live
  skill directly (the human approve gate stays in the loop). `skill_proposals`
  gained a **`kind` (`skill` | `expert`)** discriminator so the approve route
  promotes a distilled *procedure* into a skill (it only made experts before) +
  a `sourceRef` for provenance. Trajectory distillation is gated on quality:
  outcome must be `success` and, if the session recorded B1 verification
  evidence, none of it may have failed. Distiller model resolves via the
  `skill_distillation` topic → shared `background` lane. See
  [`docs/EXPERT-TOPIC-SKILL-ROUTING.md`](docs/EXPERT-TOPIC-SKILL-ROUTING.md)
  ("Skill lifecycle").
- **Verification evidence ledger (B1 #242).** QA verdicts were computed then
  dropped; they now persist to a durable, append-only `verification_evidence`
  table (`kind`, `passed`, `confidence`, `detail`) and are readable per session
  at `GET /api/verification/:sessionId` (ownership-scoped). The "verified" rule
  fails loud: **no evidence ⇒ not verified**. Foundation for evidence-backed
  completion contracts; `pre_verify` hooks + the verify-stop-loop are the
  tracked follow-up (B1b). See
  [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) ("Verification evidence").
- **Trajectory export for training (B2 #243).** `scripts/trajectories/export.ts`
  turns recorded runs into chat-format training JSONL for offline eval /
  fine-tune pipelines — `--from/--to/--outcome/--out`, reads compressed or plain
  dailies, re-runs the PII filter at export, and reports scanned/exported/
  filtered/malformed counts (no silent truncation).
- **Vertex AI provider with OAuth2 token minting (A3 #241).** First-class
  `vertex` provider via Google's OpenAI-compatible endpoint, authenticated by a
  short-lived access token **minted from a service account** (RS256 JWT-bearer
  grant via `node:crypto`, cached + refreshed before expiry) — **no static
  keys** on disk; the SA lives in the vault. Selected by a `vertex/` model
  prefix. See [`docs/CUSTOM-PROVIDERS.md`](docs/CUSTOM-PROVIDERS.md)
  ("First-class Vertex AI provider").
- **Scheduler reliability hardening (A2 #238).** Adapts three Hermes cron
  fixes onto the task scheduler: **missed-grace** (an overdue task past its
  window is dropped once with a `skipped_missed` event, not run stale);
  **fail-closed on wake-gate drift** (a gate that can't be *evaluated* fails the
  task after a cap instead of deferring forever — a legitimate "not now" still
  defers); and a **liveness heartbeat**. Also wires `getScheduler().start()`
  into boot — the worker loop had **no caller**, so the task queue (e.g.
  artifact cleanup) was filled but never drained.

### Live voice conversation — talk to the orchestrator (2026-07-13/14, PRs #210–#217)

Realtime, hands-free voice in the web chat that runs the full orchestrator
pipeline. Architecture + tuning knobs in [`docs/VOICE.md`](docs/VOICE.md)
("Realtime Web Voice Conversation").

- **Realtime duplex voice (Phase 4, #210–#213).** `/voice` WebSocket streams
  16 kHz PCM off an AudioWorklet through streaming STT (local whisper.cpp or
  Mistral Voxtral); per-sentence streaming TTS with **barge-in**; and a Twilio
  media-stream path (`/voice/media/:provider`) for duplex phone calls.
- **Propose-then-confirm gate (#216).** With the mic on, a work request isn't
  dispatched blind — Octipus proposes an approach (or asks one short clarifying
  question when the request is vague) and only executes on your spoken "yes";
  "no" cancels, anything else refines. Runs on the fast model mapped to the
  **`voice` topic**; read-only over the orchestrator (can't self-spawn). Voice
  turns only — typed chat is unchanged.
- **Backend narrator (#216).** Agent lifecycle is spoken as it happens
  (`worker_spawned`/`worker_completed` → `{type:"speak"}` frames over `/ws`),
  session-scoped; the reply is spoken fresh from each `chat_response`, fixing the
  stale-reply repeat.
- **Make the spoken loop usable (#214).** Default Mistral TTS voice
  (`en_paul_neutral`) so `/speak` stops 500-ing; whisper `[BLANK_AUDIO]` filtered
  at the root; `Sources:` footer + markdown stripped before TTS.
- **Live-testing fixes (#217).** Gate now also catches `ambiguous` turns (vague
  speech rarely scores as a clean `task`); warmer, conversational planning tone;
  utterance silence window widened to 2000 ms so a pause doesn't split a
  sentence; Voxtral wired for realtime STT; enlarged live-transcript readout; and
  a **WebSocket reconnect-storm fix** — the auth-ticket failsafe no longer opens
  empty-token sockets or retries at a flat interval, so a rate-limited
  `/auth/ws-ticket` backs off and recovers instead of looping.

### OpenClaw gap integration — eight phases (2026-07-12, PRs #199–#207)

Closes the gaps ranked "worth closing" in `docs/OPENCLAW-COMPARISON.md`,
delivered as eight independently-reviewed, CI-green PRs. Plan and
per-workstream status in
[`docs/plans/openclaw-gap-integration.md`](docs/plans/openclaw-gap-integration.md).

- **CI & security hardening (WS1 — PRs #199, #201, #202).**
  `bun audit` is now **blocking** (with a reviewable allowlist);
  CodeQL, semgrep (`p/typescript` + `p/security-audit`), zizmor
  workflow audit, and `dependency-review` run on every PR; a
  tag-driven `release.yml` extracts the CHANGELOG section and syncs
  `package.json` on `v*` tags; an install smoke test runs
  `install.sh` + `octi doctor` on ubuntu **and** macOS. Also fixed the
  repo's long-standing CI flakiness — a bun coverage stdout burst was
  crashing test runs with `WriteFailed`; `coverageReporter=["lcov"]`
  in `bunfig.toml` removes the ~530-row table from the pipe.
- **Observability (WS4 — PR #199).** Prometheus metrics via
  `prom-client` (`src/core/telemetry.ts`) with `record*` helpers that
  never throw, and end-to-end `runId` correlation via
  `AsyncLocalStorage` (`src/core/run-context.ts`) stamped into pino
  logs and exposed on `/metrics`. **Operator-visible:** `/metrics`
  now serves a real registry; legacy gauge names preserved.
- **API-token scope enforcement (WS6.1 — PR #199).**
  `src/security/scopes.ts` — token scopes are now enforced, not just
  stored. **Back-compat:** a token with *empty* scopes retains
  full access, so existing tokens are unaffected.
- **OpenAI-compatible HTTP API (WS6 — PR #200).** New `GET /v1/models`
  and `POST /v1/chat/completions`. `model: octipus/orchestrator`
  (default) runs the full pipeline; `octipus/<role>` forces a role; a
  raw registry model id is a single-turn passthrough. Protocol-correct
  SSE streaming (`stream: true`) and an OpenAI error envelope so
  off-the-shelf SDKs work. **User-visible:** point any OpenAI client at
  `/v1` with an `octi_` token.
- **Heartbeat / proactive loop (WS2 — PR #203).** A cron-runner-driven
  periodic per-user turn, gated **cheap-first** (quiet hours → quota →
  a pending-work probe, all before any LLM call). Standing instructions
  come from a pinned `HEARTBEAT` note. Migration 0077 adds the
  `heartbeat` trigger type. **Operator-visible:** off unless a
  `HEARTBEAT` note is pinned.
- **`tool_search` (WS5 — PR #204).** Embedding-based semantic ranking
  layered onto the existing lazy tool discovery and wired into
  `list_tools`, so large role tool-sets surface the right tool by
  meaning, not just name.
- **Local-runtime presets (WS8 — PR #205).** Model presets +
  autodiscovery for local runtimes (Ollama / LM Studio / vLLM / …)
  reusing the OpenAI-compat provider, plus `/api/models/presets` and
  `/api/models/discover`.
- **Versioned plugin SDK (WS3 — PR #207).** `@octipus/plugin-sdk`
  publishes the plugin contract (manifest types, `validateManifest`,
  `checkApiVersion` with semver gating) and a `validatePlugin` kit
  that dry-runs a plugin's full lifecycle. New `octi plugin validate
  <dir>` CLI and a `plugin-validate` CI job over `extensions/*`.
  Consumed by the host via a tsconfig path alias — zero install
  impact. **Plugin authors:** set `apiVersion` + `capabilities.tools`
  in `plugin.json` (see `docs/PLUGINS.md`).

**Deferred (tracked on the roadmap):** token-true streaming for `/v1`
(needs a token-delta path through the orchestrator — step-1 SSE ships
now), an inbound email channel (ASK-gated), OpenTelemetry traces
(metrics + `runId` shipped; the OTel SDK is dependency-blocked in the
build environment), and plugin remote-install/signing. Subscription
OAuth was dropped (Octipus is multi-user only).

### Voice — first-class, multi-surface (2026-07-10, PRs #187–#197)

Voice becomes a real channel across web, TUI, and messaging, with a
local-first STT path and a cloud TTS default so it works with no host
setup.

- **Live voice conversation in the web chat (#191).** Hands-free mode:
  talk, and Octipus streams a reply and speaks it back, with background
  agents spawning exactly as in text. Half-duplex loop (mic →
  VAD-segmented utterance → local `whisper.cpp` transcribe → the same
  pipeline as text → speak → listen), a live-voice toggle +
  listening/thinking/speaking chip in the composer, and graceful
  text-only degrade when TTS is off. **User-visible:** TTS default
  flipped to cloud (Mistral Voxtral) so voice-out works out of the box;
  piper stays the local opt-in. Streaming STT + barge-in deferred to a
  realtime phase.
- **Voice on every channel + Telegram voice-out + TUI push-to-talk
  (#195, #197).** Voice-in across all channels, Telegram voice replies,
  and push-to-talk voice in the TUI.
- **Mistral vision + OCR and Voxtral STT/TTS (#188, #190).** Native
  Mistral vision + OCR; Voxtral speech-to-text and text-to-speech
  engines.
- **Local whisper reliability (#193, #194).** Cross-platform fixes to
  decode / language-detect / gating / install so local `whisper.cpp`
  works reliably.
- **Windows `octi.cmd` parity (#187).** The Windows launcher reaches
  command parity with the bash `octi`.

### Swarm reliability — release-candidate hardening (2026-07-06–08, PRs #179–#186, #196)

A budget/liveness diagnosis arc (RC5/RC7) that makes swarm budgets
actually bind and stops orphaned agents from outliving their parents.

- **Budgets bind; detached orphans are killed (#181, #182).** On
  *normal* completion (not just failure) a parent now aborts + cancels
  any detached child still pending after auto-collect, so answering the
  user no longer leaves a child running. The orphan reaper actually
  *stops* unambiguous orphans (a detached child of an already-terminal
  parent) instead of only relabeling DB rows. The token-budget cap
  binds even under providers that under-report usage.
- **Capability + context-window gates at spawn (#183, #186).** A
  worker's model is gated for capability at binding time and for
  context-window fit at spawn — failing loud instead of mid-turn.
- **Liveness-gated reaper + hard backstop (#185, #184).** A
  heartbeat / last-activity signal gates the age-based reaper so a
  healthy long-running orchestrator isn't torn down; an absolute
  backstop resolves a wedged `collect_children` wait.
- **Fan-out + relay correctness (#180, #196).** Depth-1 subagents are
  discoverable so fan-out can happen; fixes for scaffolding leaks,
  duplicate spawns, per-child relays, and misread child status.
- **Also:** research-drift failure fix (#179); each spawned worker now
  sees its siblings' prior actions; 60 s dedup on identical sends to the
  same target; a `remember_this` loop + duplicate-memory fix; the saved
  research report is conditional rather than mandatory; the orphan
  reaper runs periodically, not only at boot.

### Provider correctness + orchestrator robustness (2026-07-04, PRs #172–#177)

- **Gemini tool calling fixed; every provider lane hardened (#174).**
  `flash-lite` is now usable as an orchestrator — the QA conclusion
  "flash-lite can't tool call" was an integration bug. Schemas are
  sanitized for Gemini (`$schema`/`$id`/`$defs` stripped, `$ref`
  preserved), orphaned tool-calls get synthesized error results,
  empty-content turns are filtered, and a new
  `toolChoice: auto|required|none` maps per provider (OpenAI
  `tool_choice` / Gemini `functionCallingConfig.mode`). Truncated turns
  retry natively with more tokens before the toolshim; one shared
  `parseToolCallArguments` helper across providers.
- **Orchestrator relay fidelity + child-aware timeouts (#175).**
  Auto-collect gives each forgotten detached child a real relay budget
  (2–12k chars) instead of truncating to 500, with a deterministic
  fallback that appends child results verbatim when the final answer is
  a stub. `collect_children` is on the lite-mode tool surface. A
  stopped child emits a complete-shaped terminal event so the UI
  spinner resolves and a detached parent finalizes.
- **CLI agent fidelity + MCP session-before-spawn (#173, #176).**
  CLI-agent event/tool-tracking fidelity; the MCP path creates a
  session before spawning an agent.
- **Fixes (#172, #177):** experts null-override, dev-session workspace
  root, and model-lane visibility; a bun-test preload reaps leaked
  per-test `/tmp` scratch dirs.

### `writing` model lane (2026-07-02, PR #171)

- **Operator-visible:** Long-form roles (`research`, `writer`, `pm`,
  `communication`) all funneled into the single `agents` model lane
  after topic consolidation, so they couldn't be bound to a cheaper /
  faster model than coding work. A new canonical `writing` lane is added
  and those four roles re-pointed to it (alias-table only — no role
  config changes). Migration 0075 seeds the writing lane's binding from
  the current `agents` binding so nothing fails loud on deploy; rebind
  `writing` to a flash model on the Topics page. Mirrored in the web
  Topics UI and the health feature list. (Routing analysis in #169;
  e2e topic-coverage fix in #170.)

### Core file refactor (2026-07-01, PR #167)

- **Programmer-visible:** Split the four largest logic-heavy files
  (`api/routes/models.ts`, `core/orchestrator/service.ts`, `core/swarm/spawner.ts`,
  `core/agent-worker.ts`) into focused sibling modules — routes now delegate to
  a `src/services/` layer, and swarm budget/validation/cache plus the
  detached-child manager and tool-loop detector are their own units. No
  behavior change; every public API and import surface preserved.

### Session changes review — `/changes` (2026-07-01)

- **User-visible:** Review the file changes an agent made during a session. A
  git-backed `/changes` view surfaces every touched file, with a new web
  **Changes** tab and the same set rendered in the TUI client.

### Orchestrator detach — activated + hardened (2026-07-01)

- **Operator-visible:** Detached subagents are now collected by default
  (`maxPendingDetached` 0 → 6) instead of being discarded in await-mode, so
  long-running child results actually land. Swarm budget accounting reconciled:
  canonical wall-clock is 600 s (10 min) per level, and child spend feeds the
  shared pool.

### Robustness + MCP auto-reconnect + permission queue UI (2026-07-01, PR #168)

- **Operator-visible:** MCP servers **auto-reconnect** after a drop, and
  a **permission-queue UI** surfaces pending approvals. Approval-manager
  global-resolution and timeout bugs fixed; worker spawners proactively
  check tool availability; the skill markdown parser moved to `js-yaml`;
  registry + visual-analyzer test coverage added. Docs: QA sections for
  topic model-roles / session changes / detachments, a roadmap sweep,
  and seven shipped design notes archived under `.octipus/archive/`.

### Provider, desktop, and web fixes (2026-06-26–28)

- **Desktop lifecycle (#164).** `octi desktop` backgrounds by default so
  the GUI survives closing the terminal (`--foreground`/`--stop` to
  control); `octi stop` / `uninstall` reap the desktop app; new
  `octi start/restart --backend-only` (aliases `--headless` / `--no-web`)
  run the backend with no UI so desktop/TUI users attach their own
  client; fixed a desktop-dev `ChunkLoadError` by giving `next dev` its
  own `.next-desktop` cache separate from the static-export build.
- **Provider / prompt fixes.** DeepSeek: always send `reasoning_content`
  on tool-call turns; the orchestrator no longer treats a thinking-only
  turn as the final answer; the current date is stamped into the prompt.
- **Browser extension** now authenticates the bridge with an API token
  instead of the master key.
- **Web:** a refresh button on provider model-discovery; DocumentCard
  hydration-error fix (nested buttons).

### QA batch — end-user surfaces (2026-06-10)

Findings from the 2026-06-10 QA pass, delivered as nine focused branches
(each independently reviewed). Highlights:

- **Single-user mode removed — always multi-user.** The `multiuser.enabled`
  flag and the legacy `MASTER_KEY` Bearer fallback are gone; every request
  must carry a session or API token. A single-user install simply never
  creates a second user. Workspaces are always per-user; the default
  workspace root moved out of the repo tree to `~/.octipus/workspace`
  (gitignore-leak fix). **Operator action:** anyone authenticating via
  `MASTER_KEY` must mint an API token (`POST /api/tokens`) or log in. Run
  `bun run test:e2e` against a live stack before deploying. Supersedes the
  feature-flag note in the 2026-05 multi-user entry below.
- **Agent file-writes resolve correctly in the UI.** `file_change` events now
  carry the path the tool actually wrote (post session-relocation), fixing
  "File not found" when clicking an agent-created file.
- **Notes / to-dos route to their real features.** The `general` role now has
  the `notes` and `tasks` tools (+ prompt routing), so "write a note" / "add
  a to-do" hit the Notes / Tasks tabs instead of dropping a loose markdown
  file. The Tools page shows which roles can use each tool.
- **Markdown renders everywhere.** A shared sanitized renderer backs chat,
  Deep Research reports, document/file previews, and a new Notes
  Edit/Preview toggle.
- **Run-mode indicator.** The web header and TUI status bar show
  Router / Light / Full (derived from the default-model size); the duplicate
  user card was removed from the sidebar.
- **Dashboard feature-status rework.** Required vs optional per feature,
  OCR + Vision shown separately, Memory Extraction + Evaluation added,
  Architecture dropped, per-feature hover help, two-column layout.
- **New-repo parent folder.** "Create new repository" lets you pick the
  parent folder (root / additional paths) with a destination preview;
  symlink-safe containment.
- **MCP feature tools.** tasks, notes, email, memory, Deep Research, and
  Reader are now exposed on the standalone MCP server.
- **Email overhaul.** HTML bodies render (server-side sanitized), messages
  mark read on open, inbox paginates (Load more), "Draft reply" proposes
  directions for you to choose before drafting, bigger reading pane, triage
  shows a result summary.

### Streamlined setup (2026-05-26)

One way in. The six divergent setup paths (`install.sh`, inquirer
`scripts/setup.ts`, pi-tui `scripts/init.ts`, `bin/octi start`,
`web/app/setup/page.tsx`, `docker-entrypoint.sh`) collapse into a
single `octi setup` wizard. After it runs, the service is runnable
and the user picks TUI or web — both surfaces consume the same
backend; neither owns onboarding.

User-visible:

- **`octi setup`** is the only wizard. Walks storage → secrets →
  backend boot → admin account → provider+key → default model →
  capabilities install (Playwright, MCP, browser ext, …). Supports
  `--non-interactive` (env-var driven, for CI / Docker builds) and
  `--remote <url>` (configure a running container from your host).
- **`.env` is secrets only** — `MASTER_KEY`, `JWT_SECRET`,
  `SESSION_SECRET`, storage targeting, `API_HOST`/`API_PORT`, and
  one-shot `BOOTSTRAP_*` vars consumed at first boot. Everything
  else (ports, channels, workspace, providers, feature flags) lives
  in the `settings` table / vault and is editable via the API at
  runtime.
- **`octi capabilities`** lists installed/missing optional tools.
  Sub-commands: `octi capabilities install <id>` and
  `octi capabilities install --all` to fix gaps after first run.
- **Web `/setup` is gone.** First-run onboarding happens in the
  terminal; the legacy route redirects to `/chat` once the system
  is set up, or shows a one-paragraph CLI hint otherwise.
- **Docker reports its own capabilities.** Playwright Chromium and
  the MCP server build are pre-baked in the image; the
  `capabilities` table reflects that on first boot. The entrypoint
  prints a one-shot `octi setup --remote` hint when the system has
  not been set up yet.

Internal:

- **Shared probe utilities** (`src/setup/probes.ts`) and a canonical
  provider registry (`src/setup/providers.ts`) replace three
  duplicated copies.
- **Capability service** (`src/capabilities/service.ts`) persists
  every tool's `checkAvailability()` result into a new
  `capabilities` DB table. The orchestrator gates `getToolsForRole`
  against this table at spawn time, so an agent that requires
  Playwright but lacks it logs a clear
  `octi capabilities install browser` hint instead of failing deep
  in a tool call.
- **Settings registry** (`src/config/settings-registry.ts`) gained
  explicit `*.apiKey` entries for OpenAI / Anthropic / Gemini /
  DeepSeek so the wizard can route keys into the vault through the
  existing `PATCH /api/settings/:key` handler.
- **Deleted**: `scripts/setup.ts` (715 LOC inquirer wizard) and the
  five `web/components/setup/*.tsx` step components. The
  `@inquirer/prompts` dev-dep dropped with them.

### Orchestrator freedom + Hermes-inspired curator (2026-05-24)

Branch `claude/orchestrator-freedom-hermes-fixes`. 8-phase land
inspired by a deep-dive into the Hermes-agent and pi-mono repos.
Headline: the orchestrator can now narrate, supervise, and chat to
the user while children run — it used to block on every spawn. Plus
a Hermes-style skill curator, a `/model` slash command, and a pile
of UX polish that surfaced while wiring everything together.

User-visible:

- **Orchestrator can talk while children work.** `spawn_child mode:
  "detach"` is now valid at depth 0 — the orchestrator fires up to
  six parallel agents, narrates progress, takes side-channel
  questions, then synthesizes via `collect_children` (or the
  framework auto-collects before the final reply). Previously every
  spawn was a blocking await: persona-narration events fired but the
  UI only saw them after the worker finished, so it looked like
  narration only triggered on errors. Now narration appears live.
- **Narration actually appears in chat.** The persona-narration
  bridge has been emitting `swarm.narration` events since the
  2026-05-20 ship but no surface rendered them — chat went silent
  during waits. New `narration` message role + chat-UI handler
  surfaces them as compact inline italics.
- **Tool-call streaming in the agent card.** Per-tool
  `tool_call_complete` events flip rows from spinner → check (or
  red X) the moment a tool returns, with duration + result preview.
  While the agent is running you see the live stream of what it's
  doing; once the agent finishes the inline list collapses and the
  tool count badge stays in the agent header. Survives the 10s
  REST poll without flickering.
- **Inline code stays inline.** LLM outputs like "the container is
  ` octipus-pg `" rendered as full-width fenced blocks. New
  formatting rule in every role prompt + a UI heuristic that
  collapses short single-line fenced blocks (≤80 chars, no
  language) to inline code.
- **Swarm-tree "Task brief" shows the full brief.** The WS event
  used to slice the preview to 200 chars while the DB stored 4000 —
  the modal looked truncated until a hard reload. Slice unified at
  4000; modal height bumped from `max-h-72` to `max-h-[60vh]`.
- **`/model` slash command.** Switch the orchestrator model for
  the current session without editing config. `/model <id|name>`
  to set, `/model clear` to revert, `/model list` to browse,
  `/model` to show the active override. Bad picks (reasoner,
  no-tools, known-unreliable for orchestration) get rejected at
  command time, not mid-turn. In-memory; resets on restart.

Operator-visible:

- **Skill curator (Phase 4 — Hermes-inspired learning loop).**
  Skills now track `last_used_at`, `usage_count`, `archived_at`,
  `curation_notes` (migration `0061_skill_curator_lifecycle`).
  A debounced in-process tracker (5s window or 32-id threshold,
  race-safe follow-up flush) records every prompt-injection of a
  skill. `runSkillCurator()` flags skills unused >30d, auto-archives
  unused >90d with a note. `findActiveByTopic` now filters archived.
- **Cross-provider tool-call IDs survive edge cases.**
  `normalizeToolCallId` falls back to a hash when stripping
  invalid chars would leave an empty string — earlier those silently
  dropped the assistant↔tool message link. Added idempotency and
  length-cap tests.
- **Orchestrator detach budget is configurable per level.**
  `LEVEL_DEFAULT[0].maxPendingDetached`: 0 → 6 (matches `fanOut`).
  Override per deployment via `config.swarm.levelDefaults.orchestrator`.

Internal:

- New: `src/skills/{curator,usage-tracker}.ts`,
  `src/core/orchestrator/session-model-override.ts`,
  `src/core/commands/model.ts`,
  `src/core/orchestrator/meta-tools-detach.test.ts`,
  `src/core/tool-executor-events.test.ts`.
- Reshape: `ModelSelector.selectForOrchestration(sessionId?)` runs
  both the default model and the session override through the same
  suitability gate.
- Roadmap items closed by this branch: **Skill auto-extension —
  promotion path** (curator covers archive lifecycle; promotion UI
  remains).
- Tests: 2009 / 0 / 128 pass / fail / skip across 200 unit files;
  134/138 e2e pass (4 failures pre-existing — env config + flake).

### UX + personality revamp (2026-05-20)

Branch `claude/octopus-ux-personality-swToC`. Five-slice land of the
full plan at `docs/plans/ux-personality-revamp.md` (Hermes-agent
inspired). User-visible:

- **Orchestrator now has an identity.** Per-user, persists across
  every channel. Default is `Octipus` — an octopus-machine that
  refers to itself in the third person, uses "we" for the swarm,
  and gives short dry replies. Rename via `/persona name <X>`;
  change tone/narration/free-form facts via `/persona ...`. Six
  preset YAMLs ship under `personas/` (`octipus`, `terse-engineer`,
  `mentor`, `nautilus`, `concierge`, `verbose-academic`). Specialist
  children stay role-defined — persona is host-level only.
- **Live swarm narration.** New `swarm.narration` event mirrors
  `swarm.node_spawned` / `node_completed` / `budget_warning` with
  persona-rendered text ("Octipus dispatches a research arm.",
  "qa arm failed. Predictable."). Per-user `persona.narration: off
  | minimal | chatty` setting.
- **Side-channel messages.** New gateway message type
  `chat.interject` lets the user ask a quick question while a
  swarm runs. Reply lands as `chat.message` with `sideChannel: true`
  and persona attribution. Running orchestrator is neither cancelled
  nor blocked.
- **Friendly no-engine path.** First message before a model is
  configured no longer throws — replies in the persona voice with
  three concrete next steps (`bun run setup`, `octi doctor`, web
  Models page).
- **Casual chat is persona-aware.** `directResponse` (the
  greetings/small-talk path that bypasses the orchestrator) now
  uses the same persona resolver — so "hi" gets an Octipus reply
  too, not a generic friendly-assistant string.

Operator-visible:

- **One-shot installer.** `curl -fsSL .../install.sh | bash` (Unix)
  or `iex (irm .../install.ps1)` (Windows) clones, installs deps,
  builds the compiled binary, symlinks it onto PATH, runs setup.
- **Compiled `octi` binary.** `bun run build:cli` produces a static
  ~95MB executable at `dist/octi`. Retires the PATH-mutation
  `scripts/setup.ts` used to do. Handles
  help/version/doctor/init/tui/edit/persona natively; delegates
  start/stop/restart/status/logs/open to the bash dispatcher.
- **`octi init`.** New pi-tui based setup wizard. Welcome →
  service auto-detect → storage mode → provider (Ollama first if
  detected, then LiteLLM, then direct provider — Voyage excluded)
  → model picker → API key → summary → writes .env. Falls back
  to `bun run setup` (the inquirer flow) on non-TTY.
- **`octi doctor`.** 15 environment health checks: bun, .env,
  vault keys, storage mode, base persona, state dir, Ollama,
  LiteLLM, postgres, redis, backend, MCP server build, browser
  extension, log sanity, disk space. JSON + text output.
- **First-boot model bootstrap.** `src/db/bootstrap-model.ts` reads
  `BOOTSTRAP_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL` from
  `.env` (written by `bun run setup` / `octi init`), seeds a
  default `model_config` row, stores the API key in the vault.
  Idempotent.

Programmer-visible:

- **`before-agent-start` hook.** New typed mutable-context hook in
  `src/core/orchestrator/hooks.ts`. Fires inside `runOrchestrator`
  with `BuildSystemPromptOptions` — handlers can prepend, append,
  or substring-replace the system prompt. The persona-block
  injector is the first consumer. `SECURITY_PREAMBLE` and
  `roles/orchestrator/prompt.md` stay byte-untouched (DESIGN.md
  rule #6). Extensions can subscribe — see PLUGINS.md.
- **New meta-tools on the orchestrator:**
  - `remember_about_self` — writes durable behavioral rules into
    the per-user persona profile (parallel to `remember_this`).
  - `reflect` — answers "what are you doing?" by reading the live
    swarm tree, no spawn, no LLM call.
- **New REST routes** at `/api/persona` (GET resolved, GET
  /presets, PATCH, POST /facts, DELETE /facts/:idx, POST /reset).
  See API.md.
- **Schema:** new `category='assistant'` rows in `profiles`,
  composite `(user_id, category)` index added by migration 0060.
- **Docs:** `docs/CONFIGURATION-PRECEDENCE.md` explains the
  `.env`-bootstrap vs DB-runtime split; `personas/octipus.yaml`
  is the canonical voice spec; full design at
  `docs/plans/ux-personality-revamp.md`.

1929 / 0 / 133 pass / fail / skip on `bun test src`. Typecheck +
lint clean.

### Legacy `source_type` retirement (2026-05-17, PR #28)

Completes the column-retirement flagged after the memory-redesign
cleanup arc. Phase A (migration 0049) added `purpose` as the
canonical categorisation column; `source_type` carried alongside
it during the soft-migration window. This drops `source_type`
entirely.

**Breaking — single-operator cut. External callers, MCP-tool
prompts, and the web UI all switch in lockstep.**

- **Schema.** Migration 0056 drops `embeddings_source_type_idx` and
  the `source_type` column. Idempotent. The Phase A backfill already
  mirrored every value onto `purpose`, so no information is lost.
- **Service.** `EmbeddingService.store / indexText / indexStructured /
  search / ftsSearch / hybridSearch / listAll / readById /
  deleteBySource` now take or return `purpose: EmbeddingPurpose`
  instead of `sourceType: string`. `getStats()` returns `byPurpose`.
  `SearchResult.sourceType` → `purpose`. The `purposeFromSourceType`
  shim is removed.
- **API.** `POST /knowledge/search`, `POST /knowledge/index`, and
  `GET /knowledge` rename the request field `sourceType` → `purpose`.
- **MCP tool.** `search_knowledge` argument renames `source_type` →
  `purpose` with an updated description listing the canonical values
  (`document`, `code`, `message`, `image_description`,
  `knowledge_artifact`, `ephemeral`). `read_knowledge` return field
  renames as well.
- **Web.** `/knowledge` page renames every visible reference — types,
  state, query strings, the "Source Type" picker label (now
  "Purpose"), the color/icon registries. New colors for
  `image_description`, `knowledge_artifact`, and `ephemeral`.
- **Other callers.** `rag/health.ts` probe row uses
  `purpose='ephemeral'` + a unique `sourceId` for cleanup;
  `retention-service.ts` orphaned-doc and legacy-ephemeral filters
  use `purpose`; `indexer.ts`, `documents/processor.ts`, and
  `tools/filesystem/index.ts` pass `purpose` directly.

### Memory-redesign cleanup follow-up — Phases A-G (2026-05-16, PR #27)

Seven follow-up phases on top of the original Phase 1-7 audit fixes.
Plan in `.octipus/memory-redesign.md`; commits `fbf2a8f..e416263`.

- **Phase A — clear desk.** Drop unused `SCIM_PATCH_SCHEMA` (biome
  lint); gate the Whisper-dependent voice tests on `WHISPER_BINARY`
  + `WHISPER_MODEL_PATH`; gate the LiteLLMClient-dependent
  embeddings tests on `INTEGRATION=1` so the unit suite is green
  by default; mark `.octipus/memory-redesign.md` as shipped;
  update `docs/QA.md` for the deleted permanent `qa-demo` channel.
- **Phase B — memory finish-the-job.** `recordAgentCompletion`
  derives `task_state.task_kind` from the role (`review` → `review`,
  `qa`/`security` → `finding`, else `agent_output`); new
  `TaskStateRepository.reapOrphans` drops typed-output rows whose
  session was deleted; new `scripts/check-embedding-drift.ts` +
  `db:check-embedding-drift` npm script + boot-time warning when
  the `embeddings` or `memories` table carries multiple distinct
  `embedding_version` values.
- **Phase C — memory user-facing.** PII filter at the judge
  boundary (redact-not-drop, confidence knocked down 0.2 on
  redaction); new `remember_this` orchestrator meta-tool for
  explicit fact promotion through the same judge pipeline; new
  `config.memory.extractionCadence` (`per_turn` / `on_compaction`
  / `off`); new `/memory` web page + `GET/DELETE /api/memory`
  endpoints + supersession-chain viewer + soft-delete (sets
  `valid_until`, preserves audit trail).
- **Phase D — architecture cleanup.** Split retention out of
  `rag/embeddings.ts` (1100+ lines) into
  `rag/retention-service.ts`; remove `compactedSummary` writes
  in favour of the `compaction_entries` log; readers fall back
  to `compactedSummary` only for sessions compacted before this
  change; mark `SessionContext.compactedSummary` `@deprecated`;
  codify the repository-pattern exceptions list in
  `CONTRIBUTING.md`.
- **Phase E — test coverage.** New `scim.test.ts` (8 auth-refusal
  tests against every endpoint); `voice.test.ts` (3 tests for
  unauth + malformed body); `channels/discovery.test.ts` (4 tests
  verifying the shipped channel folders load + uniqueness).
- **Phase F — vector index strategy.** Migration 0055 reads the
  prevailing embedding dimension across `embeddings` and
  `memories`; if homogeneous, `ALTER COLUMN TYPE vector(N)` +
  `CREATE INDEX USING hnsw (vector_cosine_ops)`; if empty,
  no-op; if drifted, `RAISE NOTICE` and skip. Restores HNSW
  performance without locking the deployment into a specific
  embedding model.
- **Phase G — infrastructure & docs.** README documents
  Bun-only server runtime explicitly; mcp-server CI now runs
  `bun run build` + asserts `dist/index.js` exists + `npm pack
  --dry-run` confirms the artefact ships in the tarball.

### Memory-redesign cleanup — Phases 1-7 (2026-05-16, PR #27)

Audit of the just-shipped memory-redesign work surfaced 4 critical
and 11 medium-priority defects. Phases 1-7 closed them.

- **Phase 1 — Phase B + D delivery gaps.** Phase B shipped writers
  but no readers — new `task_state` MCP tool
  (`list_recent_session_tasks`, `read_task_state`) added to the ten
  roles that already carry `knowledge`. `AgentContext.workspaceId`
  typed and threaded from orchestrator → swarm → worker so
  `recordAgentCompletion` finally populates the `workspace_id` FK
  that was previously NULL on every row; `swarmNodeId = agent.id`
  filled too. Memory scope wired to `classification.topic` instead
  of the constant `'orchestrator'`. `updateMemoriesAfterTurn`
  receives the just-persisted user message id and the last three
  turns. Plan-execute and expert paths now fire memory.
- **Phase 2 — schema cleanup.** Migration 0054 adds the real FK on
  `embeddings.doc_id` with `ON DELETE CASCADE` (Phase C declared the
  column but not the FK); recreates
  `memories_user_scope_type_active_idx` as a partial index
  (`WHERE superseded_by IS NULL`); refreshes the stale Phase 0/4
  nullable-userId comments on `embeddings`.
- **Phase 3 — code quality.** Replace `sql.raw` vector-literal
  splicing with parameterised binds in `memories.searchSimilar` and
  `rag.hybridSearch`. Memory judge uses the canonical
  `buildEmbeddingVersion` helper and hoists the embedding-model
  lookup out of the per-candidate loop. `renderMemoriesBlock`
  surfaces confidence next to inferred facts (`p<0.9`). Dead
  `retrieveSemantic` removed (silent factType default violated
  fail-loud). Dead "duplicates" cleanup pass removed (Phase A unique
  index makes duplicate inserts impossible).
  `cosineSimilarity` / `l2Distance` typed `column: AnyPgColumn`.
- **Phase 4 — test coverage.** 9 integration tests for
  `MemoryRepository` (supersede atomic, user isolation,
  `OR(NULL, scope)` filter, retrieveTop ordering, supersession
  chains, non-finite vector rejection, empty vector early-return);
  9 unit tests for confidence rendering + extractor boundary cases.
- **Phase 5 — small cleanup.** Delete dormant
  `src/channels/qa-demo/`; log on the `discovery.test.ts` teardown
  failure instead of a bare `catch {}`.
- **Phase 6 — npm posture.** Root package marked `private: true`
  with `license` + `repository`; mcp-server now ships `dist/` via
  `files: ['dist', 'README.md']` and a `prepublishOnly` script;
  versions synced.
- **Phase 7 — focused coverage.** `rate-limiter.ts` 0% → 85% via 13
  unit tests; `org-membership.ts` eager paths 0% → 100% via 5 tests.

### Memory-redesign — final wiring (2026-05)

Closes the two deferred "ships disabled" pieces left from the phase
batch so nothing in `.octipus/memory-redesign.md` remains a leftover.

- **Memory layer is now wired into the orchestrator turn.**
  `OrchestratorService.handleMessage` fetches the top-N active
  memories scoped to `(userId, agentScope='orchestrator')` once per
  turn and threads the rendered block into both the orchestrator's
  own system prompt and the `directResponse` system prompt via a new
  optional `extraSystemContext` parameter. After the response is
  produced, a fire-and-forget `updateMemoriesAfterTurn` extracts /
  judges / persists new facts. Auto-no-ops when (a) no model is
  bound to topic `memory_extraction` (extractor skips, no LLM call)
  or (b) the memories table is empty (retrieval returns empty,
  prompt unchanged). Zero behaviour change until the operator binds
  the extraction model.
- **`SearchResult` surfaces ancestor heading path.** `search`,
  `ftsSearch`, and `hybridSearch` now project `section_path` +
  `heading_level` so callers can render structural context next to
  a hit without a second query. `getAncestorHeadings` remains for
  callers that need the full ancestor row objects (abstracts etc).

### Memory-redesign Phase D — memories layer (2026-05)

Atomic, updatable long-term memories. Distinct from RAG embeddings
(content chunks) and `task_state` (per-session workflow). One row =
one fact about the user with ADD/UPDATE/DELETE/NOOP semantics driven
by an LLM judge.

- **New table `memories`** (migration `0053`) with self-FK
  `superseded_by` (never destructive — updates insert a new row and
  link the old). `memories_active` view filters superseded + expired
  so callers don't have to remember the predicate.
- **`src/core/memory/`** — `repository.ts` (typed CRUD, vector-scoped
  search, LFU-ordered retrieval), `extractor.ts` (LLM call: latest
  user turn → candidate facts, short-circuits on no-first-person
  turns), `judge.ts` (embed candidate, find closest existing match,
  LLM picks action, apply), `retrieval.ts` (turn-start hot list +
  `renderMemoriesBlock` for system-prompt injection).
- **ModelRegistry**: new topic `memory_extraction` (cheap model;
  extractor + judge bind to it).
- **Not auto-wired into the orchestrator.** The operator must first
  bind a model to `memory_extraction`; the wiring into
  `OrchestratorService.handleMessage` ships separately so per-turn
  LLM spend turns on deliberately.

### Memory-redesign Phase E — image-purpose tagging (2026-05)

Vision-derived rows in `embeddings` (vision-LLM caption + OCR for an
image upload) are now tagged `purpose='image_description'` at write
time, so the retention policy for images can diverge from the
document retention policy without a schema change. No vector model
or storage layer added.

### Memory-redesign Phase C — document hierarchy (2026-05)

A chunk now knows its section path. Retrieval can pull "Clause 4.2"
plus its ancestor headings into the prompt without extracting a
knowledge graph.

- **Migration `0052`** adds `parent_chunk_id` (uuid, self-FK
  ON DELETE SET NULL), `section_path text[]`, `heading_level
  smallint`, `doc_id uuid` to `embeddings`. GIN index on
  `section_path` for path queries.
- **`src/core/rag/markdown-chunker.ts`** walks Markdown, emits one
  chunk per heading and one per body block, threads `parentIndex`
  so callers can resolve `parent_chunk_id` after insert. ATX
  headings only; fenced code blocks pass through verbatim.
- **`EmbeddingService.indexText`** dispatches to the structural
  chunker when the content (or `metadata.filePath`) looks like
  Markdown. Other content types keep using the flat chunker.
- **`EmbeddingService.getAncestorHeadings(chunkId)`** walks the
  parent chain for retrieval-side ancestor injection (wiring into
  the orchestrator ships in a follow-up).

### Memory-redesign Phase A.5 — retention_policies (2026-05)

Per-purpose retention replaces the hardcoded 30-day sweep.

- **Migration `0051`** adds `retention_policies(purpose pk,
  max_age_days, lfu_min_access, lfu_min_age_days, notes, updated_at)`
  seeded with the defaults from
  `.octipus/memory-redesign-schema.sql`.
- **`EmbeddingService.cleanup`** now runs a per-purpose pass first
  (age cap OR cold-and-stale LFU per row). Result adds
  `byPurpose: Record<string, number>`. Legacy passes
  (orphaned-docs / short-entries / duplicates) remain as backstop
  for non-purpose rows.

### Memory-redesign Phase B.2 — LISTEN subscriber (2026-05)

Closes the deferred follow-up from Phase B. Sibling agents can now
react to peer completions without polling.

- **`src/db/task-state-listener.ts`** wraps a dedicated postgres-js
  connection (max=1, separate from the query pool — LISTEN ties up a
  socket). `subscribeTaskState(sessionId, handler)` returns an
  unsubscribe function; multiple subscribers on the same session
  share one upstream LISTEN via reference counting.
- Embedded (PGlite) mode returns a no-op subscriber — readers must
  poll. Same trade-off as the rest of embedded mode.
- Shutdown hook wired into SIGTERM/SIGINT so the dedicated
  connection closes cleanly on process exit.

### Memory-redesign Phase B — workflow state out of RAG (2026-05)

Sibling agents stop discovering each other's results through cosine
similarity over chunked text and start reading typed SQL rows.

- **New table `task_state`** (migration `0050`) with per-session
  LISTEN/NOTIFY trigger (`task_state_<session_id>`). Holds the typed
  durable record of agent work: inputs, outputs (jsonb), status,
  depends_on, error. Indexed by `(session_id, created_at)` for
  sibling-discovery reads.
- **`src/core/rag/auto-indexer.ts` deleted.** Agent outputs no longer
  land in the `embeddings` table — they were polluting cosine search
  (a 4 KB trace ranked against a one-line user preference). Replaced by
  `src/core/agent-task-recorder.ts`, which calls
  `TaskStateRepository.create` with the same skip-rules (orchestrator
  outputs and outputs < 100 chars are still skipped).
- **`TaskStateRepository`** added with create / complete / fail /
  updateStatus / getById / listSessionRecent / listByOwnerStatus /
  deleteDoneOlderThan. Long-lived LISTEN subscriber deferred to a
  follow-up so the connection-management story can land as its own
  reviewable change.
- **Knowledge tool + Web** drop `agent_output` from the
  `search_knowledge` source-type filter (and the Web Knowledge page
  loses the orange "Agent Output" stats tile / filter option). The RAG
  cleanup pass keeps the old branch but now matches
  `purpose='ephemeral' OR source_type='agent_output'` — steady-state
  count is expected to stay at 0.

### Memory-redesign Phase A — embeddings purpose + versioning (2026-05)

See prior batch c entry below for the artifacts/single-user batch.

- Adds `purpose`, `content_sha256`, `embedding_version`,
  `access_count`, `last_accessed_at` to `embeddings`. Migration `0049`
  truncates and adds NOT NULL columns plus a UNIQUE
  `(purpose, source_id, content_sha256)` dedup index.
- Write path: app-side SHA-256 + `embedding_version` (`<model>/<dim>`).
  ON CONFLICT (dedup key) DO UPDATE just refreshes `last_accessed_at`,
  so re-indexing unchanged content is a no-op.
- Read path: `search` / `ftsSearch` / `hybridSearch` fire-and-forget
  bump `access_count` + `last_accessed_at` on returned rows.

### Live artifacts + single-user fixes (2026-05 batch c)

Bug-fix and DX batch surfaced while bringing the live-artifacts feature
end-to-end in a single-user install.

- **Single-user mode now provisions a default workspace.** The artifacts
  feature (and any other workspace-scoped surface) previously 500'd in
  single-user installs because `resolveWorkspace` returned
  `workspaceId: null` when `multiuser.orgWorkspaces` was off. The flag
  is now correctly scoped to *multi-workspace switching*; real users
  always get a default workspace. `/api/me/workspaces` GET is no longer
  flag-gated (mutations stay gated).
- **Artifact pages render in iframes again.** The global
  `X-Frame-Options: DENY` middleware was overriding the per-artifact CSP
  and blocking the same-origin embed iframe. Artifact routes (`/a/*`,
  `/__artifacts__/*`) now skip the global XFO + generic CSP and rely on
  the per-artifact CSP with `frame-ancestors`.
- **Swarm token-budget changes now apply to running sessions.**
  `deriveChildBudget` re-reads `swarm.levelDefaults.*.tokens` from
  current config on every spawn instead of using the snapshot captured
  at root-node creation, so raising the cap via the settings UI takes
  effect on the next child spawn. Decreases still need a session
  restart (we never shrink a parent's effective cap below `used`).
- **Artifacts tool now reachable by agents.** The `artifacts` tool was
  registered but no role's `toolIds` included it, so orchestrator
  routing fell through. Added to `general` and `data` roles, with
  matching classifier keywords ("live artifact", "dashboard", "rss
  feed", etc.).
- **Tighter artifact tool descriptions + validation.**
  `create_live_artifact` / `update_live_artifact` now spell out the
  template ↔ source coupling rule, the visibility consequence
  (`workspace` returns 404 to anonymous viewers), and the auto-refresh
  wake-gate. `sources` param gains per-kind config examples; `kind` and
  `visibility` get enum constraints. The server cross-checks
  `{{data.<name>.…}}` references against attached sources and returns
  any mismatches in a new `warnings[]` field. Create now returns
  `embedUrl` + `outerUrl` + `visibility` + `warnings`.

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
