# Coworking — people working together in Octipus

> **Concept, 2026-10-04.** Nothing here is built. The buildable version, reviewed against the code, is [coworking-spec.md](coworking-spec.md). This document decides what
> coworking means for Octipus, what it needs, and in which order to build it.
> It sits next to two existing plans:
> [group-chat-bot.md](group-chat-bot.md) (shipped: Octipus inside a team's
> Slack / Teams / Telegram channel) and
> [workroom-and-swarm-federation.md](workroom-and-swarm-federation.md) (draft:
> several *models* working one problem, and several *instances* lending each
> other models). This plan is about several *people*, and it reuses the
> instance-to-instance transport of that plan rather than inventing a second one.
>
> **Decided since the first draft:** who pays (each member's own agent by
> default, an optional sponsored space agent; see [Who pays](#who-pays-whose-agent-thinks))
> and that a hosted space is live, like a cloud service, with no local copies
> on other installs (see [Live, not synced](#live-not-synced)).

## Goal

A small team works in Octipus the way it works in a shared office:

- **one room** — a chat where every member and the agent talk, with everyone
  seeing the same conversation;
- **the same things** — the same files, notes, documents, task board and
  artifacts, edited by several people (and the agent) at once without anyone
  overwriting anyone;
- **the same agent, with clear hats** — the agent knows the project, works for
  whoever asked, and never leaks one member's private data to the others;
- **across installs** — two people (or two companies) who each run their own
  Octipus can share one room and one set of documents, and their two agents can
  work together, without either side handing over its keys, its mail or its
  disk.

Non-goals: replacing Google Docs / Office for long-form word processing, video
or voice calls with several people, a public "community" mode with anonymous
users, and a replicated room with no host (see "Not doing").

## Three levels of coworking

| Level | Who | Where it happens | Status |
|---|---|---|---|
| **A. Octipus in a team's chat** | A team on Slack / Teams / Telegram | Their chat platform; Octipus is a member | Shipped (group channels) |
| **B. A shared space in one Octipus** | Users of one install | Octipus web app (and the group channel bound to it) | This plan, phases C0–C4 |
| **C. A shared space across installs** | Users of several installs, and their agents | Hosted by one install, joined from others | This plan, phase C5 |

Level A already proved the hard rules for a shared audience (who acts, what
others may see, prompts and approvals in a shared place). Levels B and C reuse
those rules; they do not reinvent them.

## What exists today

Verified against `main` (524be79):

| Need | What is there | What is missing |
|---|---|---|
| A container for a project | `workspaces` (`src/db/schema/organizations.ts`), with `workspace_id` on sessions, notes, tasks, documents, artifacts, memories, hooks, embeddings | `workspaces.user_id` is a single owner. No members, no roles, no invites |
| Isolation | `src/db/repositories/scoped.ts` filters every read by `principal.userId`; Postgres RLS (`src/security/rls.ts`, migration 0034) | Both assume "my rows". Nothing reads by membership |
| Picking a workspace | `X-Octipus-Workspace` → `src/security/workspace-resolver.ts`; `web/components/workspace-picker.tsx` | A foreign workspace id silently falls back to the caller's default |
| Grouping users | `organizations`, `org_members(role)` behind `multiuser.orgWorkspaces` (off); org-shared skills and models | Org roles are not enforced; orgs share config, not work |
| Sharing an output | Artifacts: `visibility private/workspace/signed/public`, `artifact_share_links`, append-only `artifact_versions` | `workspace` visibility only matches workspaces the viewer *owns* (`src/api/routes/artifact-pages.ts:70`) |
| Shared chat | Group channels: one thread, one session *per member* (`src/channels/group-handler.ts`) | No single session with several humans. `sessions.user_id` is one owner. `MULTI-USER.md` §7.2 sketches `session_shares`, not built |
| Editing the same file | Session files: content hash version, stale write → 409 (`src/core/session-files.ts`) | No live co-editing, no presence, no history for notes or documents (notes keep only `body_sha256`) |
| Task board | `tasks` with `assignee_kind user/role/node`, checkout leases (`src/core/tasks/checkout.ts`), `task_comments` | Tasks are visible to their owner only, so "assign to Anna" means nothing to Anna |
| Real time | Gateway hub (`src/core/gateway/hub.ts`) with replay buffers; Postgres LISTEN/NOTIFY for task state | Fan-out drops any event whose `userId` is not the connection's user (`hub.ts:103`); no room or space topic; event bus is in-process |
| Shared-audience safety | Flow guard `suspicious` start + private reads raised to ASK in group sessions; fenced transcripts; no personal memories in group turns | Written for group channels only |
| Cost | Spend budgets incl. the `group_channel` scope | No space scope |
| Instance-to-instance | Nothing implemented. Swarm federation plan: Ed25519 identity, pairing, typed Zod protocol, `peer:<id>` service principal | No `space.*` messages |

The short version: **every row in Octipus has exactly one owner, and every
read path is built on that.** Coworking is mostly the work of adding a second
way to be allowed to see a row, *membership*, without weakening the first.

## Core concept: the Space

A **space** is a workspace with members. That is the whole new noun.

- A personal workspace stays as it is: one member, the owner. Nothing changes
  for single-user installs or for anyone who never shares.
- A shared workspace ("space") has members with a role, and everything that
  carries its `workspace_id` belongs to the space, not to the person who made
  it: files, notes, documents, tasks, artifacts, rooms, space memory, space
  connectors, the space budget.
- A space is created by a user and may be attached to an organization. Leaving
  the organization does not delete the space; the owner role decides.

Why not a new table next to `workspaces`: `workspace_id` is already on all the
nouns that matter (sessions, notes, tasks, documents, artifacts, memories,
hooks, embeddings) and the resolver, the picker and the filesystem layout
already key on it. A parallel "space" would need all of that twice.

### Roles

| Role | Can |
|---|---|
| `owner` | Everything, including members, connectors, budget, delete, federation |
| `editor` | Talk in rooms, run the agent, edit files / notes / tasks, accept agent suggestions |
| `commenter` | Talk in rooms, run the agent (read-only tools only), comment, propose tasks |
| `viewer` | Read rooms, files, notes, board |
| `guest` | Like `commenter`, limited to the rooms and folders they were invited to; never sees the member list beyond those rooms |

Roles are code (an enum and one `can(role, action)` table in
`src/security/space-access.ts`), not configuration. Admin of the install is
not automatically a member of every space; admins keep the existing explicit
`*Admin` paths and impersonation with audit.

### Data model (sketch)

```
workspaces                       -- existing
  + kind enum ('personal','shared') default 'personal'
  + org_id uuid?                 -- optional org attachment
  + host_instance_id text?       -- C5: null = hosted here
  + agent_funding enum ('own','unattended','sponsored') default 'unattended'
  + sponsor_user_id uuid?        -- owner whose models fund sponsored work

workspace_members
  workspace_id · user_id · role · invited_by · joined_at · removed_at?
  PK (workspace_id, user_id)

workspace_invites
  id · workspace_id · email? · role · token_hash · expires_at · created_by · redeemed_by? · revoked_at?
  -- same token pattern as artifact_share_links; raw token only in the response

space_memory                     -- facts about the project, visible to all members
  id · workspace_id · body · source ('member','agent') · author_user_id · session_id? · created_at · retracted_at?

note_revisions / document_revisions
  id · target_id · body_or_storage_path · sha256 · author_kind ('user','agent') · author_user_id · on_behalf_of_user_id? · created_at

room_members                     -- C1: who is in a room session
  session_id · user_id · role_override? · last_read_message_id · muted
messages
  + author_user_id uuid?         -- who typed it; null for the agent
```

`sessions.user_id` stays the *creator* of a room (and stays NOT NULL, so
nothing that assumes it breaks). Access to a room comes from
`room_members`, not from `user_id`.

### Access: a second door, not a wider first door

`ScopedRepos` must keep meaning "mine". Loosening it to "mine or shared" would
put every one of its callers one bug away from leaking a row. Instead:

- New `SpaceRepos` (`src/db/repositories/space.ts`), built only for a
  `(principal, workspaceId)` pair after a membership check, and only for the
  nouns a space shares. Reads filter by `workspace_id = $space` and nothing
  else. Writes stamp `workspace_id` and the author.
- The workspace resolver stops falling back silently when the header names a
  space the caller is a member of: it returns that space and the member's role.
  A space they are not a member of still collapses to "not found".
- RLS gets a membership policy for those tables: visible when
  `workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_user_id AND removed_at IS NULL)`.
  Same "bypass on missing GUC" shape as 0034.
- `WorkspaceFS` for a space roots at `$DATA_ROOT/spaces/{workspaceId}/files/`,
  not under any one user's directory, so removing a member never moves files.
- Everything personal stays on `ScopedRepos`: personal memories, mail, vault
  user secrets, personal tasks, sessions in personal workspaces.

## Who acts: the two hats

This is the decision everything else depends on. In a shared room the agent
answers *someone*, and what it may touch must be obvious to everyone in the
room.

**Hat 1 — the space.** Tools that act on things the space owns run as the
space: its files, notes, tasks, artifacts, space memory, and **space
connectors** (a GitHub repo, a shared drive folder, a Jira project, connected
once by an owner with credentials stored in the vault at `scope=workspace`,
which the vault schema already has). Results are space content; posting them
in the room is fine.

**Hat 2 — the requester.** Tools that act on a member's own things (their mail,
calendar, personal drive, personal notes, personal memories) run as the
member who asked, exactly as group channels do today:

- reads of personal data are ASK, and the prompt with details goes only to the
  requester (in their private side panel, not in the room);
- the result is shown to the requester first, with **Share into room** as an
  explicit action. Until they press it, the agent's room reply may say only
  that it found something and sent it to them privately;
- personal memories are never loaded into a room turn; the space memory is.

Every turn records both: `principal = requester`, `space = workspace_id`. The
effective permission is the requester's permission ∩ the space policy ∩ the
role's limits. A commenter cannot launch a shell command through the agent
just because the agent could.

**Flow guard.** A room session is a shared audience, so it starts with the
labels group sessions use. Anything a member shares into the room is space
content from then on. Anything labelled `secret` is never shared, even on
request. Federated spaces (C5) add a `federated` audience label: content
crossing to another install is checked once more (see below).

## Who pays: whose agent thinks

Two questions are easy to blur, and this plan answers them separately:

- **who thinks**: the model, the subscription or API key, the cost;
- **what it may touch**: the space's rules (the two hats above).

**Default: every member brings their own agent.** A request runs on the
requester's own setup (their models, their subscription or keys, their spend
budget and quota). The work lands in the space under the space's rules. So:

- paying never buys rights: a commenter with a large subscription is still a
  commenter;
- the space never pays for a member's thinking unless its owner chose to;
- a personal subscription only ever answers its owner's own requests.
  Consumer plans (Claude, ChatGPT, …) are generally licensed to one person, so
  the design never routes another member's request through someone's
  personal login.

In a company install the admin already provides models to every user
(install or org models). Those count as the member's own setup: the company
pays, as it does today.

**Optional: a sponsored space agent.** The owner can attach models (API keys
or org models, never a personal subscription) and a space budget. The sponsor
pays for:

1. **Unattended work**, where nobody asked right then: `listen` / `proactive`
   replies, schedules, monitors, the agent working an unassigned board task,
   and execution on the host on behalf of a visiting member (C5). This work
   always needs a sponsor; without one, these features are off for the space.
2. **Members without their own setup** (guests, a client), if the owner opts
   in, with a cap per member.

One space setting, `agent_funding`:

| Value | A member's request | Unattended work |
|---|---|---|
| `own` | Requester's setup; members without one cannot run the agent | Off |
| `unattended` (default) | Requester's setup | Sponsor |
| `sponsored` | Sponsor, with a per-member cap | Sponsor |

**Visible and accountable.**

- Every agent reply says who paid, e.g. "Anna's agent · Sonnet" or "Space agent".
- Each `cost_log` row carries the requester, the `workspace_id` and `funding` (`own` / `sponsor`).
- Own-funded turns count only against the requester's budget and quota.
- Sponsored turns count against the space budget and show in the owner's per-member breakdown.
- When the space budget runs out, sponsored work pauses while own-funded work carries on.

**What it needs.** Today models are configured for the install or an org
(`model_config.org_id`); only cost is per user (`cost_log.user_id`). Bringing
your own agent needs per-user model setup:

- user-scoped model entries, with keys in the vault at `scope=user`;
- CLI subscription logins (`src/models/providers/cli-provider.ts`) bound to
  the user who logged in;
- a turn resolves the requester's models first, then the install or org
  models the admin allows.

**Across installs** this needs nothing extra: a visiting member's requests
run on their own install with their own setup (see C).

## B. Coworking inside one Octipus

### Rooms (shared chat)

A room is a session with `room_members`. A space has a default room
("General") and any number of topic rooms; a room can be private to a few
members.

- **Speaker attribution.** Every human message carries `author_user_id`; the
  agent's context shows `Anna:` / `Ben:` exactly as the group transcript
  fence does. Members cannot pose as one another (the name comes from the
  row, not the text).
- **When the agent speaks.** Same modes as group channels: `mention` (default:
  `@octipus` or a reply to it), `listen`, `proactive`, with the same quiet
  hours, caps and cheap gate. One addressing model for the web room and the
  Slack channel.
- **One turn at a time.** Turns in a room queue. A second request while the
  agent works is queued, shown as queued, and runs as *its* requester. `/stop`
  stops the running turn; only its requester or an editor may stop it.
- **Private side panel.** Each member can open "ask privately" next to the
  room: a personal session that can read the room transcript and the space,
  whose output only that member sees. This is the group channels' per-member
  session, made visible. It is also where hat-2 results land first.
- **Approvals.** A permission prompt for a hat-2 action goes to the requester
  only. A prompt for a hat-1 action that changes the space (delete a folder,
  push to the space repo, publish an artifact) can be answered by the requester
  if they are an editor, otherwise by any editor; the room sees "waiting for an
  editor to approve" without the details only when the space is federated.
- **Read state and mentions.** `last_read_message_id` per member, unread
  counts in the sidebar, `@anna` notifies Anna through her own notification
  preferences (web push, her linked DM). This reuses the notification service.

### The same documents

Three kinds of shared things, three concurrency answers:

1. **Notes and Markdown documents → live co-editing.** Use a CRDT (Yjs) behind
   the existing CodeMirror editor (`y-codemirror.next`). The server keeps one
   `Y.Doc` per open note, syncs it over the gateway socket, and writes the
   text back to `notes.body` (plus a `note_revisions` row) when editing goes
   quiet. Everyone sees everyone's cursor and selection.
2. **Workspace files (code, data) → leases plus version check.** Live
   co-editing of a code file while an agent also writes it is a recipe for
   broken builds. Instead: opening a file for edit takes a **soft lease**
   ("Ben is editing `src/app.ts`", shown to all); the session-files 409 check
   stays the hard guarantee. This is the same file-lease mechanism as the
   workroom watchdog (W0), extended so a holder can be a human.
3. **Artifacts, tasks, board → records.** Row-level updates with the version
   checks and checkout leases that exist; changes stream to every member.

**The agent is a co-editor, not a ghost.** In a shared note or document the
agent edits in **suggestion mode** by default: its changes appear as tracked
suggestions attributed "Octipus for Anna", which any editor accepts or
rejects. A space owner can let the agent apply directly in chosen folders
(generated reports, scratch). In workspace files the agent takes the same
lease a human does and is refused when someone else holds it; it then tells
its requester who is editing, instead of waiting or overwriting.

**History.** Every save of a note or document writes a revision with author
kind, author and on-behalf-of. Restore is a new revision, never a rewrite.
"Who changed this line" works for agents as well as people.

### Presence and real time

- New space-scoped events: `space.presence`, `space.room.message`,
  `space.doc.update`, `space.task.changed`, `space.activity`. Each carries
  `workspaceId`, and the hub delivers it to connections whose user is a
  current member (membership cached per connection, invalidated on change).
  The existing per-user rule at `hub.ts:103` stays for all other events.
- Presence: who is online in the space, which room or document they have open,
  and whether the agent is working and for whom ("Octipus — working for Anna:
  drafting release notes").
- **Single process first.** The event bus, Yjs docs and presence live in
  memory, like the group buffer today. That is enough for every install we
  ship (embedded PGlite is one process anyway). Multi-process needs a
  cross-process fan-out; LISTEN/NOTIFY works for small events but not for
  Yjs update streams, so that is a separate decision when someone needs it.

### Shared board, memory and budget

- **Board.** Space tasks live on the space board. `assignee_kind = 'user'` now
  means a member, who sees it on the space board and in "My work" across
  spaces. "Take this" in a room (and 🐙 in a bound Slack channel) creates a
  space task instead of a personal one.
- **Space memory.** The agent may propose facts about the project ("the
  release branch is `release/1.4`"); they are written to `space_memory` with
  provenance and shown in a Space memory panel where any editor can retract
  them. Personal memories never flow into it automatically.
- **Budget.** A `space` spend-budget scope, like `group_channel`, for the
  sponsored agent only (see [Who pays](#who-pays-whose-agent-thinks)).
  Own-funded turns stay on the requester's budget. The owner sees sponsored
  spend per member and per room.
- **Activity feed.** One stream per space: who edited what, what the agent did
  for whom, which tasks moved. Built on `audit_log` and `run_events` with the
  space id, filtered for members.

### Bridge to group channels

A space can be bound to an enrolled group channel. Then:

- messages in the Slack thread and in the web room are the same conversation
  (the room mirrors the channel, each linked member is the same member);
- taken tasks land on the space board;
- the space budget replaces the separate channel budget.

This is how a team that lives in Slack gets the documents and board of a
space without leaving Slack, and how a member who prefers the web app sees
the same thread.

## C. Coworking across several Octipus installs

The scenario: Patrice runs Octipus at home; a client runs their own; they work
on a project together. Neither will put their keys, mail or disk into the
other's install. Both want their own agent in the room.

### The model: hosted spaces, visiting members

- **One host.** A federated space lives on exactly one install, its *host*.
  The host stores the files, notes, board, rooms and history, and its rules
  are final. This is the Slack-Connect shape, not a peer-to-peer mesh: it is
  simple to reason about and to revoke.
- **Visiting members.** A user of another install joins *through their own
  install*. On the host they appear as `anna@<instance-fingerprint>` with a
  role, backed by a `peer:<id>`-scoped principal (the swarm plan's service
  principal pattern), never as a local user with a password.
- **Their own client.** The visitor uses their own Octipus web app. The
  space shows in their sidebar with a "hosted by …" badge and opens a live
  view of the host; nothing is copied to their install (see below).
- **Bring your own agent.** Each visitor's own Octipus agent can join the room
  as `octipus@<their-instance>`. It thinks with *their* models, keys and
  memories, on *their* hardware, at *their* cost. It reaches the space only
  through **space operations** (read a file or note, edit within the role,
  suggest, post, task operations), the same ones the web UI uses, each
  checked by the host against the member's role. It never runs a host tool
  (shell, builds, space connectors); those run only on the host's sponsored
  space agent (hat 1), for a member whose role allows it.

### Live, not synced

A hosted space works like a cloud service: one copy, on the host.

- Visitors and their agents read **on demand** through space operations. An
  agent fetches the file it needs for this turn; it does not hold a copy of
  the space.
- **Co-editing is the only stream**: while someone has a note open, its Yjs
  updates flow live. That is live editing of one copy, not syncing two.
- **No sync engine, no conflicts between copies, no offline mode.** If the
  host is offline, the space is offline, as with any cloud tool.
- Revocation is clean: there is nothing left on the visitor's install to
  delete, except what their agent already read into its own session history.
  The revoke dialog says so.

### What this enables

- **Privacy-preserving coordination.** "Find a slot for the review next week":
  each agent reads its own owner's calendar privately and posts only the free
  slots. No calendar crosses installs.
- **Split work.** A task on the space board assigned to `anna@other` is worked
  by Anna's agent on Anna's machine with Anna's repo access; the result comes
  back as a suggestion or an attached file.
- **Pooled expertise.** Each side's agent brings its own skills and the
  knowledge base its owner chose to expose to the space.

### Protocol (on top of the swarm transport)

Reuse identity, pairing, transport and the constitution from
[workroom-and-swarm-federation.md §2.2–2.5](workroom-and-swarm-federation.md).
Add a typed, small `space.*` family:

| Direction | Message | Payload |
|---|---|---|
| host → guest | `space.invite` | space id, name, role, rooms/folders in scope, expiry |
| guest → host | `space.join` / `space.leave` | member handle, agent handle? |
| guest → host | `space.watch` / `space.unwatch` | the room or document a member has open now |
| host → guest | `space.event` | live events for what is watched (messages, presence, task changes); nothing is replayed beyond the open view |
| guest → host | `space.read` | read a file, note, task or room page on demand, under the member's role |
| guest → host | `space.post` | room message from a visiting member or agent |
| both | `space.doc.sync` | Yjs update for a note open for co-editing (scoped to that note) |
| guest → host | `space.suggest` / `space.write` | suggested change as a diff with base version; or a direct write where the role and a held lease allow it |
| guest → host | `space.task.op` | propose / claim / comment / report on a space task |
| host → guest | `space.revoked` | membership ended; live access closed |

Hard rules, added to the peer constitution:

1. **The host decides.** Every `space.*` message is checked on the host
   against the member's role and the space's scope. A visitor's install cannot
   grant itself more than the invite says.
2. **Space operations only, never host tools.** Visiting members and their
   agents act only through the `space.*` operations above. They never cause a
   host tool run. Execution (shell, builds, space connectors) is done only by
   the host's sponsored space agent, for a member whose role allows it; with
   no sponsor, it is not available to visitors.
3. **Content from another install is untrusted input.** Messages, suggestions
   and task reports from visitors go through the input guard and are fenced as
   member content in the host agent's context, as group transcripts are today.
4. **What leaves the host is space content only.** Personal data of host
   members never leaves the host unless shared into the room; anything labelled `secret`
   never leaves it. The host's agent treats a federated room as a wider audience
   than a local one.
5. **Agent turn-taking is code.** Agents do not answer agents unless a human
   addressed them, and a room has a per-hour cap on agent-to-agent turns.
   Two agents cannot talk each other into a loop or a cost spiral.
6. **Revocation closes live access at once.** There is no mirror to wipe; the
   UI says plainly that what a visitor's agent already read stays in that
   agent's own session history.
7. **Audit both ends.** Every federated event carries the member handle and
   the instance id on both installs.

### Cheaper path first: guests

Before any federation, the host can invite an outsider as a **guest user** of
the host install (invite link, passkey, `guest` role, limited rooms and
folders). That covers "a client joins our project" without new protocol, and
it is the right default for people who do not run Octipus. Federation is for
the case where the other side has its own install and wants its own agent in
the room.

## Phases

| Phase | Builds | Ship check |
|---|---|---|
| **C0 — Shared workspaces** | `workspaces.kind`, `workspace_members`, invites (link + accept), roles in `space-access.ts`, `SpaceRepos`, RLS membership policy, resolver change, space `WorkspaceFS` root, space files / notes / tasks / artifacts visible to members, members page, activity feed (read side) | Two users in one space: both see and edit the same note and task; a third user gets 404 on every space route; a removed member loses access at once; DB tests through the real repos and routes |
| **C1 — Rooms** | `room_members`, `messages.author_user_id`, attributed transcript, addressing modes, turn queue, two hats with personal-read ASK to the requester, Share into room, space memory, private side panel, role-aware approvals, unread / mentions, space-scoped gateway events; own-agent funding: per-user models and keys, CLI logins bound to their user, "paid by" label, `cost_log` funding | A room with two members: Ben's request runs as Ben on Ben's models and is billed to Ben; Anna's personal-mail read prompt reaches only Anna and nothing appears in the room until she shares it; a commenter cannot trigger a write tool |
| **C2 — Live documents** | Yjs co-editing for notes and Markdown docs, presence and cursors, revisions with author and on-behalf-of, agent suggestion mode, file soft leases for humans and agents | Two browsers type in one note at once with no lost characters; the agent's edit appears as a suggestion attributed to its requester; an agent write into a file Ben holds is refused and reported |
| **C3 — Team surface** | Space board with member assignment and "My work", sponsored space agent (`agent_funding`, sponsor models, space budget scope, per-member caps), bridge to a group channel (mirror + taken tasks on the space board), notifications | A Slack thread and its web room show the same conversation; 🐙 in Slack lands on the space board; an exhausted space budget pauses sponsored work in both while own-funded requests carry on |
| **C4 — Guests** | Guest role, external invite by email with passkey sign-up, scoped rooms / folders, guest-visible member list | A guest sees only the invited room and folder; every other route returns 404 |
| **C5 — Federated spaces** | Requires swarm F0–F1 (identity, pairing, transport). `space.*` protocol, host checks, live access (watch, read on demand, co-editing), visiting agents through space operations, revocation, audit on both ends | Two installs in docker-compose: a visitor posts, co-edits a note, claims a task worked by their own agent on their own models; nothing of the space is stored on the visitor's install; the host refuses a role escalation and a tool request; revocation closes live access within one heartbeat |

C0 and C1 are the core; each later phase stands on its own. C5 waits for the
federation transport and should not start before C0–C2 have been used by a
real team.

## Not doing

- **Peer-to-peer spaces without a host.** CRDTs could replicate text, but
  roles, removal, budgets and approvals need one place that decides.
- **Loosening `ScopedRepos`.** Membership is a second, narrow path.
- **Merging personal memories into a space** automatically, ever.
- **One shared agent identity with everyone's tools.** The agent always acts
  either as the space or as the requester, never as "everyone".
- **Real-time co-editing of code files.** Leases and suggestions instead.
- **Multi-process real time** in the first cut.
- **Offline copies of a hosted space.** One copy, on the host.
- **Answering other members through someone's personal subscription.**

## Open questions

1. **Room session ownership.** Keep `sessions.user_id` as creator and add
   `room_members`, or move rooms to their own table? Proposal: keep the
   session (it brings streaming, compaction, retention, the whole agent
   loop) and add membership.
2. **Space connectors.** Which connectors may be space-scoped in C1
   (proposal: GitHub, a Drive / OneDrive folder, Jira) and which stay
   personal only (mail, calendar, chat).
3. **Yjs persistence.** Store Yjs updates and compact into the note body
   (proposal), or keep the Y.Doc binary as the source of truth?
4. **Org relationship.** Must a space belong to an org in multi-user installs?
   Proposal: optional; an org can list and adopt spaces, but personal spaces
   can be shared without one.
5. **Workroom inside a space.** A workroom (several models on one problem)
   could run inside a space room, with members watching and approving its
   task list. Proposal: yes, once both exist; the workroom's user gate becomes
   "any editor".
6. **Members without their own setup under `unattended`.** Block them with a
   "set up your models" hint, or let them ask the owner to sponsor them for
   the space? Proposal: the hint, plus a one-click request the owner can
   accept (which sets a per-member cap).
