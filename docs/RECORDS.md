# Record types, records and forms

Record types hold the structured data a business keeps beside its cases:
an invoice with an amount and a due date, a vehicle with a plate and a leasing
end, a licence with seats and a renewal date. A record type is data, not code:
a module or a plugin defines it, and every record of it is validated against
the type's fields. Records link to cases like any other entity
([CASES.md](CASES.md)). Forms let people outside the install submit a record:
an application, a callback request, a relative's wish.

This is point C1b of the [business OS plan](plans/business-os.md).

## Record types

A type has a `key` (`invoice`; lower-case letters, digits and `_`, unique per
scope), a `name`, an optional `description`, its `fields` and an optional
`titleField`.

Each field is `{ key, label, type, required?, options?, help? }`:

| Type | Stored as | Checked |
|---|---|---|
| `text` | string | at most 2,000 characters |
| `textarea` | string | at most 20,000 characters |
| `number` | number | a finite number (`"12,5"` is read as 12.5) |
| `money` | number | like `number`, rounded to cents, in the currency's major unit |
| `date` | `YYYY-MM-DD` | a real calendar date |
| `boolean` | true / false | `true`, `false` or their strings |
| `select` | one of `options` | must be one of them |
| `email` | string | an email address |
| `phone` | string | digits, spaces and `+ ( ) / . -` |
| `url` | string | an `http://` or `https://` address |

At most 50 fields per type. A record's `title` is taken from `titleField`
(which must be a `text` field), else from its first filled text field.

Changing a type keeps the data of existing records. A removed field's value
stays in old records until their next write, which drops it. Every write
checks all of a record's values against the current fields, not only the
changed ones: a new required field, a field whose type changed, or a removed
`select` option must be fixed on the record's next write. A type that still
has records cannot be deleted.

## Records

A record is `{ type, data }`. Every write is validated against the type's
current fields, and every problem is reported at once (`problems` in the API,
the tool's result). Unknown keys are refused, so a typo does not vanish. On an
update, fields that are not sent keep their value, and `null` or an empty
string clears one.

Records carry an optional `externalKey` like cases: creating with a key that
already exists in the scope returns the existing record.

Records link to cases through `case_links` with the entity type `record`
(`POST /api/cases/:id/links`, the cases tool's `link_to_case`). Deleting a
record removes its links.

## Who sees what

Record types, records and form links are scoped like cases: personally the
owner's own; in a space every member reads them and editors and owners write.
Guests see none. A record's type is always a type of the same scope.

## Forms

A form link is a URL for people without an account. It shows the type's fields
with a title and an intro, and each submission saves a record of that type. A
link can also open a case of a given kind for each submission, with the record
linked as `submission`.

- **Creating a link** is a write: an editor or owner of the space (or the owner
  of a personal type) mints it with `POST /api/record-types/:id/form-links`.
  The response holds the raw `token` once; only its sha256 is stored.
- **A submission to a space's type writes as the link's creator**, re-checked
  on every submission. If the creator is deactivated, leaves the space, loses
  the right to write, or the space is archived, the link stops working. A
  submission to a personal type writes as the type's owner (after a workspace
  transfer, the recipient).
- **One submission, all or nothing:** the record, the case and its link are
  written together; if a later step fails, the earlier ones are deleted again
  and the submission does not count.
- **Limits:** a link can expire (`expiresAt`) and cap its submissions
  (`maxSubmissions`). A submission that fails validation does not count.
  Revoking is immediate.
- **Abuse:** the public form routes have a per-IP window of their own (30
  requests per minute, on top of the general per-IP cap), so neither guessing
  tokens nor flooding a form gets far. It is not the sign-in window: an office
  behind one address filling in a form cannot lock itself out of logging in.
  An unknown and a dead token both answer 404.
- **Untrusted input:** submitted text comes from outside. It is stored as data
  and never sent to a model by the form itself. A case opened by a form says
  in its summary that its content is untrusted, so an agent that later reads it
  knows.

The agent's `records` tool cannot mint form links: publishing a form to
outsiders is a person's decision.

The form page is `/forms/:token` in the web app, which needs no sign-in; the
records page (`/records`) mints and revokes links and shows a new link once.

## Agent tool

The `records` tool (in the `general` role's tool set):

| Tool | Permission |
|---|---|
| `list_record_types`, `list_records`, `get_record` | read (ALLOW) |
| `define_record_type` (create or change by key), `create_record`, `update_record` | write (ASK) |

In a space session it acts on the space by the member's role. A commenter's
turn may run the three read tools.

## API

All routes but `/api/forms` act on the space named by the `X-Octipus-Workspace`
header. An id the scope does not reach is a 404; invalid fields or data are a
400 with `problems`.

| Route | What it does |
|---|---|
| `GET /api/record-types` | List types. |
| `POST /api/record-types` | Create a type: `{ key, name, description?, fields, titleField? }`. |
| `GET /api/record-types/:idOrKey` | One type. |
| `PATCH /api/record-types/:id` | Change a type. |
| `DELETE /api/record-types/:id` | Delete a type without records. |
| `GET /api/record-types/:id/form-links` | The type's form links (never their tokens). |
| `POST /api/record-types/:id/form-links` | Mint a link: `{ title, intro?, caseKind?, expiresAt?, maxSubmissions? }`. Returns the `token` once. |
| `DELETE /api/record-types/:id/form-links/:linkId` | Revoke a link. |
| `GET /api/records?type=&q=&limit=` | List records, by type id or key. |
| `POST /api/records` | Create a record: `{ type, data }`. |
| `GET /api/records/:id` | One record with the cases it is linked to. |
| `PATCH /api/records/:id` | Change fields: `{ data }`. |
| `DELETE /api/records/:id` | Delete a record and its case links. |
| `GET /api/forms/:token` | Public: the form's title, intro and fields. |
| `POST /api/forms/:token` | Public: submit `{ data }`. |
