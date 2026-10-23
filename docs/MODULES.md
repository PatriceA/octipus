# Modules

Octipus has a core that is always on, and modules on top of it that an
install switches on when it wants them. Someone who uses Octipus to build
software gets the core: the agents, their tools and what they work on. A
practice that runs its office on it switches on cases, mail and scan
folders as well.

The design and its reasons are in [plans/modules.md](plans/modules.md).

## The core

Chat, sessions, agents, roles, pipelines, hooks and schedules; tasks and
notifications; notes, documents, knowledge and memory; models, topics, MCP
servers, connectors and plugin packages; the vault, permissions, users and
spaces; settings, skills, the tools page and evaluations; backups.

## The modules

| Module | What it adds |
|---|---|
| `business` | Cases, contacts, record types, records and public forms ([CASES.md](CASES.md), [RECORDS.md](RECORDS.md)) |
| `mail` | Mailboxes over IMAP / POP3 and sending over SMTP ([MAIL.md](MAIL.md)) |
| `scan-folders` | Folders whose new files are filed into the documents ([SCAN-FOLDERS.md](SCAN-FOLDERS.md)) |
| `protection` | Protection levels 1-4 ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md)) |

## Switching

Admins switch modules in **Settings → Modules**. The setting is
`modules.enabled` ([CONFIGURATION.md](CONFIGURATION.md)), and a change takes
effect at once, without a restart.

- Turning a module on also turns on what it depends on.
- Turning a module off is refused while a module that depends on it is on.
- Turning a module off deletes nothing. Its data stays, and turning it on
  again brings everything back as it was.

An install from before modules starts with every module on. A new install
starts with the core only, until the onboarding or an admin turns modules on.

`GET /api/modules` reports every module and whether it is on.
`PUT /api/modules/:id` with `{ "on": true | false }` switches one (admins).
