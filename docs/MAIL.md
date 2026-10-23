# Mail over IMAP, POP3 and SMTP

Octipus reads mailboxes on any mail server (German mail hosts, an on-prem
Exchange, the KIM client module, a fax-to-mail drop) and sends from them.
This is point C3 of the [business OS plan](plans/business-os.md). It works
alongside the Gmail and Microsoft 365 inbox (`/api/email`, [API.md](API.md)),
which keeps working through OAuth.

## Personal and functional mailboxes

A mail account lives in a scope, like a case ([CASES.md](CASES.md)):

| Scope | Who reads | Who writes drafts, sends, marks read | Who sets it up |
|---|---|---|---|
| Personal | The owner only. No admin read either. | The owner | The owner |
| A space (a functional mailbox: info@, the practice's KIM address) | Every member | Editors and owners | The space's owners |

A guest of a space reaches no mailbox. Messages carry their account's scope,
so a message is read exactly where its account is.

## Accounts

An account has:

- **Address and label**, and optionally the display name it sends with.
- **Protocol:** `imap` (a folder, `INBOX` by default) or `pop3` (a drop).
- **Incoming server:** host, port, security and user name (the address by
  default). Its password is stored in the vault.
- **Outgoing server (optional):** SMTP host, port, security and user name.
  Without one the account only receives. Without its own password it uses
  the incoming one, but only when both are the same host.

Security is `tls` (implicit TLS: IMAP 993, POP3 995, SMTP 465), `starttls`
(required: a server that does not offer it fails) or `none`.

Passwords are vault system secrets (`mail:<account>:incoming`,
`mail:<account>:outgoing`). The API reports only whether one is set.

A password goes only to the server it was entered for. Moving a server to
another host, port or user name forgets its password unless a new one comes
with the change, so changing an account can never send the stored password
somewhere else. Passwords of an account removed with its space or its owner
are cleaned up within the hour.

Testing a login (`POST /accounts/:id/test`) is part of setting up: in a space
only its owners can do it.

### Hosts

The Octipus server opens the connection, so a mailbox setting must not turn
into a way to probe the local network:

- A host that resolves to a private, loopback or link-local address is **on
  the local network**. Only an admin can set an account up there (the KIM
  client module, an Exchange in the office). The account then carries the
  admin's allowance; without it such a host is refused at save and again at
  every connection.
- **Unencrypted** (`none`) connections are allowed only on the local network.
  A local server with a self-signed certificate (a KIM client module) is set
  up with `none`.
- Every connection resolves the name once and connects to that address,
  checking TLS against the name. A name cannot answer with a public address
  at the check and a private one at connect time.

Changing an account's servers checks them again. Moving to a public host
drops the local-network allowance.

## Sync

Every minute the cron tick syncs each enabled account whose last sync is
more than 5 minutes old. After a failure the wait doubles, up to an hour.
`POST /api/mail/accounts/:id/sync` syncs one account now.

- **IMAP:** the first sync takes the newest messages of the last 30 days (at
  most 200). Later syncs take every new message by UID. A rebuilt folder (new
  UIDVALIDITY) starts over without storing a message twice.
- **POP3:** the first sync looks at the newest 200 messages' headers. It
  takes the ones from the last 30 days and passes over the rest for good.
  Later syncs take every message not stored yet.
- **Nothing on the server changes.** Messages are not deleted (POP3 sends no
  `DELE`) and flags are not set. "Unread" is Octipus's own mark: IMAP starts
  it from `\Seen`, POP3 mail starts unread.
- A message is stored once per account: by its server id, and for received
  mail also by its `Message-ID`. A POP3 copy with the same Message-ID under
  another id is remembered and not fetched again.
- **One bad message never blocks the mailbox.** NUL bytes and broken UTF-16
  are stripped, and a message the database still refuses is kept as a
  placeholder ("open it in the mail client").
- **A deadline.** One account's sync is stopped after 10 minutes, and its
  connection dropped. A slow or hostile server cannot hold up the other
  accounts. Sends and login checks have a deadline too.
- An archived space's mailboxes are not synced.
- A message over 25 MB is stored with its headers and a note only; open it in
  the mail client.

Stored per message: the addresses, subject, a plain-text body, the HTML body
sanitized like the Gmail inbox's (no scripts, no remote images), the
attachments' names and sizes, and the raw source (in `mail_raw`), from which
attachments are downloaded.

## Filing attachments

An account with `fileAttachments: true` files the attachments of every mail it
receives into the documents of its scope (personal, or the space's). This is
the path for fax-to-mail and scan-to-mail drops. Filing happens as the account's
author, resolved again for each message: an author who can no longer write
there files nothing. Each attachment is filed on its own; the ones that could
not be filed are tried again on later syncs, and until then the account shows
why. The documents carry `metadata.source = "mail"` with the account and
message. The message itself is stored either way. For files dropped into a directory instead, see
[SCAN-FOLDERS.md](SCAN-FOLDERS.md).

## Drafts

Agents and people write drafts. A draft is stored here, never sent by being
saved:

- **A reply** (`replyTo` a received message) goes to its `Reply-To` or
  sender. With "all", the other recipients go in cc, leaving out the account's
  own address. The subject gets "Re:", `In-Reply-To` and `References` thread
  it, and the original is quoted below.
- **A new message** names its account, recipients, subject and text.

Recipients are plain addresses ("a@x.de", "Jane <j@y.de>"), at most 50 per
message. Drafts are plain text; attachments on outgoing mail are not
supported yet.

## Sending

A draft is sent over the account's SMTP server:

- **Never implicit.** The API needs `confirm: true`. The agent's
  `send_mail_draft` is ASK and marked dangerous: a broad allow rule does not
  wave it through, and an unattended run (a heartbeat, a schedule) is refused.
- **Once.** The draft is claimed (`draft` → `sending`) in one statement, so two
  sends of one draft cannot both go out.
- **Failures are kept.** A failed send is `failed` with the server's answer and
  can be edited or sent again.
- **Interrupted sends are not resent blindly.** A send cut off between the
  claim and the outcome (a restart) stays `sending`. After 15 minutes the
  sweep marks it `failed` with a note that it may have gone out, so the
  author can check the Sent folder first.
- **A copy in Sent.** For an IMAP account, the sent message is also appended
  to the folder the server marks as Sent, when it has one.

## Agent tool `mail`

| Tool | Permission | What it does |
|---|---|---|
| `list_mail_accounts` | read (ALLOW) | The mailboxes of the scope |
| `list_mail` | read (ALLOW) | Messages, newest first: by account, status, unread, text |
| `read_mail` | read (ALLOW) | One message: addresses, text (capped), attachment names |
| `save_mail_draft` | draft (ALLOW) | A reply or a new message, saved, not sent |
| `send_mail_draft` | send (ASK, dangerous) | Send a saved draft |

Mail text reaches the agent framed as the sender's data, never as
instructions. Reading marks the session private and suspicious for the flow
guard, and sending counts as egress.

In a space, the tool works on the space's mailboxes: commenters read, and
editors draft and send (with approval).

A received message can be linked to a case (`link_to_case` with entity type
`mail`).

## API

All under `/api/mail`, scoped by the workspace header like every space route.

| Method and path | What |
|---|---|
| `GET /accounts` | The scope's accounts (no passwords; whether each is set) |
| `POST /accounts` | Create: `address`, `incoming`, optional `protocol`, `outgoing`, `folder`, `label`, `displayName`, `fileAttachments`, `passwords: { incoming, outgoing }` |
| `PATCH /accounts/:id` | Change any of those; `passwords.x: null` removes one |
| `DELETE /accounts/:id` | Remove the account, its messages and passwords |
| `POST /accounts/:id/test` | Log in with the stored passwords; what failed, per server |
| `POST /accounts/:id/sync` | Sync now |
| `GET /messages` | `account`, `status`, `unread=true`, `q`, `limit`, cursor `before` + `beforeId` |
| `GET /messages/:id` | One message with text, sanitized HTML and attachments |
| `PATCH /messages/:id` | `{ unread }` |
| `GET /messages/:id/attachments/:index` | One attachment, always as a download |
| `POST /drafts` | `{ replyTo, body, all }` or `{ accountId, to, cc, subject, body }` |
| `PATCH /drafts/:id` | Change a draft or a failed send |
| `DELETE /drafts/:id` | Remove a draft or a failed send |
| `POST /drafts/:id/send` | `{ confirm: true }` |

## Not yet

- A web page for mail (plan point C3b).
- The heartbeat's "new mail" check for IMAP/POP3 accounts (it covers Gmail
  and Outlook today).
- Attachments on outgoing mail, and flags or deletion on the server.
- OAuth (XOAUTH2) for IMAP servers that require it.
