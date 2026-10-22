# Cases, contacts and follow-ups

Cases ("Vorgänge"), contacts ("Personen") and follow-ups ("Wiedervorlagen")
are the shared core that business modules build on
([business OS plan](plans/business-os.md), point C1). A module or plugin does
not bring its own tables for "an invoice" or "a complaint": it files a case of
that kind and links what belongs to it.

## The model

| Entity | Table | What it is |
|---|---|---|
| Case | `cases` | One matter of business: an incoming invoice, a complaint, an inquiry, a contract review. Has a title, a free-text `kind`, a status, a summary and an assignee. |
| Contact | `contacts` | A person or organisation the business deals with: client, relative, referrer, supplier, applicant. Has contact details, an address, tags, free attributes, and (for a person) the organisation they belong to. |
| Link | `case_links` | What a case links to: a contact, document, task, note, artifact or record ([RECORDS.md](RECORDS.md)), with an optional role ("client", "sender", "invoice"). One link per entity and case. |
| Follow-up | `tasks.remind_at` | A task with a reminder date, linked to a case with the role `follow_up`. When the date passes, its assignee is notified once. |

Contacts are not `profiles`. Profiles are the assistant's personal memory of the
people in one user's life; contacts are business records that a whole space
shares.

### Case status

| Status | Meaning |
|---|---|
| `open` | Being worked. |
| `waiting` | Waiting on someone outside (a supplier, a relative, an authority). |
| `done` | Finished. |
| `archived` | Kept for the record, out of the lists. |

`closedAt` is stamped when a case leaves `open`/`waiting` and cleared when it
comes back.

### External keys

Cases and contacts carry an optional `externalKey`: the id of the matter in
the system it came from (`mail:<message-id>`, `datev:4711`). It is unique per
scope. Creating with a key that already exists returns the existing row
instead of a duplicate, so a connector that reports the same matter twice is
harmless.

## Who sees what

Cases and contacts are scoped like tasks
([coworking spec §5.5](plans/coworking-spec.md)):

- **Personal:** the owner's own rows. A personal case can only be assigned to
  its owner.
- **In a space:** every member reads the space's cases and contacts, editors
  and owners write them, viewers and commenters only read. An archived space
  reads only. A case is assigned to a member who is not a guest.
- **Guests** see no cases and no contacts.
- Personal paths never return a space's rows, for their author or for an
  admin.

A link is made only to an entity the same scope reaches: a space case links
the space's contacts, documents, tasks, notes and artifacts, never a member's
personal ones. Reading a case resolves each link again and leaves out links
whose entity is gone or out of reach (a deleted document, another member's
private artifact). A link whose entity row no longer exists is removed on
that read; one that only the reader cannot reach stays for those who can.
Deleting a contact removes the links to it; deleting a case removes its links.
`GET /api/cases/linked` answers an empty list for an entity the caller cannot
see.

## Follow-ups

A follow-up is a task with `remindAt`, linked to the case as `follow_up`. Its
assignee defaults to the case's assignee, unless that person can no longer be
assigned (left the space, became a guest); then it is unassigned.

The cron loop checks every minute (`core/tasks/reminders.ts`). For each active
task (open or in progress) whose `remindAt` has passed and that has not
reminded yet, it notifies:

- the assigned user, or else the author;
- in a space, only while that person is still a member who is not a guest. If
  the assignee left the space, the author is told instead.

The notification has type `task_reminder` and names the task and the cases it
is linked to. Each follow-up reminds once. Changing `remindAt` re-arms it;
sending the same date again does not. Done and archived tasks do not remind:
their passed follow-up is marked handled without telling anyone.

`remindAt` takes ISO 8601. A bare date (`2026-11-02`) is the start of that day
in the user's timezone (the browser's `tz`, else the saved preference, else
UTC); for `dueAt` a bare date is the end of that day, as on the tasks page.

Any task can carry `remindAt`, not only case follow-ups: the tasks API and the
`tasks` tool accept it too.

## Agent tool

The `cases` tool (in the `general` role's tool set) has:

| Tool | Permission |
|---|---|
| `list_cases`, `get_case`, `find_contacts`, `get_contact` | read (ALLOW) |
| `create_case`, `update_case`, `link_to_case`, `unlink_from_case`, `add_follow_up`, `create_contact`, `update_contact` | write (ASK) |

In a space session the tool acts on the space by the member's role. A
commenter's turn may run the four read tools.

## API

All routes act on the space named by the `X-Octipus-Workspace` header, like
`/api/tasks`. An id the caller's scope does not reach is a 404.

| Route | What it does |
|---|---|
| `GET /api/cases` | List cases. Query: `status`, `active=true`, `kind`, `assignee`, `q`, `limit`. |
| `POST /api/cases` | Create a case. |
| `GET /api/cases/:id` | One case with its resolved `links`. |
| `PATCH /api/cases/:id` | Change title, kind, status, summary, assignee. |
| `DELETE /api/cases/:id` | Delete a case and its links. |
| `POST /api/cases/:id/links` | Link an entity: `{ entityType, entityId, role? }`. |
| `DELETE /api/cases/:id/links/:linkId` | Remove a link. |
| `POST /api/cases/:id/follow-ups` | Add a follow-up: `{ title, remindAt, dueAt?, notes?, assigneeUserId?, tz? }`. |
| `GET /api/cases/linked?entityType=&entityId=` | The cases an entity is linked to. |
| `GET /api/contacts` | List contacts. Query: `q`, `tag`, `kind`, `organizationId`, `limit`. |
| `POST /api/contacts` | Create a contact. |
| `GET /api/contacts/:id` | One contact with the cases it is linked to. |
| `PATCH /api/contacts/:id` | Change a contact. |
| `DELETE /api/contacts/:id` | Delete a contact; its people lose the organisation, links to it are removed. |

## In the web

The sidebar's **Business** group has the pages: **Cases** (list, filters,
links, follow-ups, status), **Contacts** (people and organisations, with the
cases each is linked to) and **Records** ([RECORDS.md](RECORDS.md)). In a space
they show the space's rows; viewers and commenters see them read-only.

## Not yet

- A case timeline (comments, status history). The audit log records every API
  change and tool call in the meantime.
