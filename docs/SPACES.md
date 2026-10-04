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
- A user who is the last owner of a space **cannot be deleted**
  (`assertDeletable`, `src/security/user-deletion.ts`); the refusal names the
  spaces.
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
- A space is limited to `spaces.maxMembers` members (default 50); an accept
  into a full space answers 409 `space_full`.
- Revoking (`DELETE /api/spaces/<id>/invites/<inviteId>`) works only through
  the invite's own space.

## When a membership changes

Removing a member, downgrading their role or changing a guest's scope takes
effect at once (`onMembershipChanged`, `src/core/spaces/membership.ts`):

- their running agents in the space stop;
- their pending permission and approval prompts raised there expire;
- the data sources they own on the space's artifacts pause (they resume when
  the person is again a member who may write);
- an in-process membership version is bumped, for paths that check
  membership at keystroke rate.

## Archive and delete

- **Archive** (`POST /api/spaces/<id>/archive`, owner): the space becomes
  read-only — reads work; no writes, no new invites, no agent runs. Every agent
  running in it stops. **Unarchive** undoes it.
- **Delete for good** (`DELETE /api/spaces/<id>`, owner) only for a space
  archived at least `spaces.purgeAfterArchiveDays` days (default 7). In one
  transaction it deletes every row of the space — every table listed as
  `delete` in `WORKSPACE_TABLES` (`src/db/workspace-tables.ts`), plus rows
  keyed by the space's sessions — checks that none is left, writes a
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
`workspace_id`. Members read them, newest first, at
`GET /api/spaces/<id>/activity?limit=50&before=<timestamp>`.

## Settings

| Key | Env | Default | Meaning |
|---|---|---|---|
| `spaces.creation` | `SPACES_CREATION` | `any_user` | `any_user` or `admins`: who may create a space |
| `spaces.maxMembers` | `SPACES_MAX_MEMBERS` | `50` | most members per space |
| `spaces.inviteMaxTtlHours` | `SPACES_INVITE_MAX_TTL_HOURS` | `720` | longest invite lifetime, hours |
| `spaces.purgeAfterArchiveDays` | `SPACES_PURGE_AFTER_ARCHIVE_DAYS` | `7` | days archived before a space can be deleted |

## Routes

See [API.md → Spaces](API.md#spaces).
