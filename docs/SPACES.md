# Shared spaces

A **space** is a workspace several people share. Members see the same notes,
tasks, documents, artifacts and files, and each works with the agent in their
own private sessions inside the space. Spaces are always available; who may
create one is a policy setting.

This page describes what is built. The full design, including the parts
still to come (rooms, live documents, sponsored agents, guests), is
[docs/plans/coworking-spec.md](plans/coworking-spec.md).

> **Status (coworking S1, backend foundation).** Spaces, members, roles,
> invites, archive and purge are in place, with their REST routes. Content
> routes acting on a space (notes, tasks, documents, artifacts, files in a
> space), the agent inside a space and the web screens land in the next
> slices; until then a space holds members and their activity log.

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
  so a removed member's client can recover.
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

## Settings

| Key | Env | Default | Meaning |
|---|---|---|---|
| `spaces.creation` | `SPACES_CREATION` | `any_user` | `any_user` or `admins`: who may create a space |
| `spaces.maxMembers` | `SPACES_MAX_MEMBERS` | `50` | most members per space |
| `spaces.inviteMaxTtlHours` | `SPACES_INVITE_MAX_TTL_HOURS` | `720` | longest invite lifetime, hours |
| `spaces.purgeAfterArchiveDays` | `SPACES_PURGE_AFTER_ARCHIVE_DAYS` | `7` | days archived before a space can be deleted |

## Routes

See [API.md → Spaces](API.md#spaces).
