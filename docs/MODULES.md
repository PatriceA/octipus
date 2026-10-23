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

## What "off" means

A module that is off is gone for everyone, agents included. Its data stays.

| Where | When the module is off |
|---|---|
| API | Its routes answer 404 (`code: "module_off"`), before sign-in is checked: the same as a route that does not exist. |
| Agent tools | Its tools are in no agent's tool set: roles, pipeline stages, swarm children, hooks, the tool search, the CLI bridge and the tools page. A worker that started before the switch stops offering them on its next turn, and any call that still names one is refused. |
| Automations | Its background jobs do not run (mail sync, the scan folder sweep). A hook whose action runs one of its tools is refused when saved and when it fires. |
| Web | Its pages leave the sidebar, and a group left empty goes too. A bookmarked page says the module is off and points admins to Settings → Modules. |
| Links | A case link to an entity of the module (a mail message while `mail` is off) is not shown and not offered. It is kept, and shows again when the module is back. |
| Fields | With `protection` off, agents see no protection levels. |

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
