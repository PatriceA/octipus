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
servers and plugin packages; the vault, permissions, users and
spaces; settings, skills, the tools page and evaluations; backups.

## The modules

| Module | What it adds |
|---|---|
| `business` | Cases, contacts, record types, records and public forms ([CASES.md](CASES.md), [RECORDS.md](RECORDS.md)) |
| `mail` | Mailboxes over IMAP / POP3 and sending over SMTP ([MAIL.md](MAIL.md)) |
| `scan-folders` | Folders whose new files are filed into the documents ([SCAN-FOLDERS.md](SCAN-FOLDERS.md)) |
| `protection` | Protection levels 1-4 ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md)) |
| `inbox` | The Gmail / Outlook inbox of a connected account: triage, drafts, tasks from mail, the email processor tool and the heartbeat's inbox watch |
| `artifacts` | Live artifacts: hosted dashboards, tables, feeds and pages, their refreshes, and saving a chat answer as one ([ARTIFACTS.md](ARTIFACTS.md)) |
| `people` | Profiles of people, pets and organisations, the profiles tool, and the profile context agents get (the persona stays core) |
| `voice` | Speech in the chat and the mobile app, the voice sockets, and phone calls ([VOICE.md](VOICE.md)) |
| `channels` | Telegram, Slack, Teams and WhatsApp, group channels, linking a chat, and the messaging tool ([CHANNELS.md](CHANNELS.md)); the in-app chat and notifications stay core |
| `recall` | Context hooks: knowledge passages and the notes index handed to agents as they start ([CONTEXT-HOOKS.md](CONTEXT-HOOKS.md)) |

## Modules that move to plugins

A module can move out of the core into a plugin package
([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md), plan:
[plans/plugins-everything.md](plans/plugins-everything.md)).

| Module | Now | Removed in |
|---|---|---|
| `reader` | The example plugin `plugins/reader` ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#bundled-plugins)): the *Reader* page under Plugins, and the agent tools `read_url`, `reader_action`, `save_note`, `create_tasks`. An admin installs it under Admin → Plugin packages → Bundled. It is an example, not a product feature: no use case brings it. | 0.6 |
| `research` | The example plugin `plugins/research` ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#bundled-plugins)): the *Research* page under Plugins, and the agent tools `start_research`, `research_status`, `save_report`. A question is researched in the background by the host's own research agent, as the user (host scope `agent:run`), and the report saved to the documents when the user asks (`documents:write`). An admin installs it under Admin → Plugin packages → Bundled. It is an example, not a product feature: no use case brings it. | 0.6 |

The core modules, their routes (`/api/reader`, `/api/research`) and their
pages (`/reader`, `/research`) are gone. An install whose `modules.enabled`
still lists `reader` or `research` (migration 0152 put them there) keeps the
ids; they are ignored, like any id this build does not declare. Tasks the
core modules made keep their `source` (`reader`, `research`), and research
runs they left in `background_jobs` (`kind: research`) still show in the
away digest until the retention removes them; their reports are documents.

## What "off" means

A module that is off is gone for everyone, agents included. Its data stays.

| Where | When the module is off |
|---|---|
| API | Its routes answer 404 (`code: "module_off"`), before sign-in is checked: the same as a route that does not exist. |
| Agent tools | Its tools are in no agent's tool set: roles, pipeline stages, swarm children, hooks, the tool search, the CLI bridge and the tools page. A worker that started before the switch stops offering and listing them on its next turn, and any call that still names one is refused. A pipeline stage that names only an off module's tools gets no tools, not its role's whole set. |
| Automations | Its background jobs do not run (mail sync, the scan folder sweep). A hook whose action runs one of its tools is refused when saved and when it fires. |
| Web | Its pages leave the sidebar, and a group left empty goes too. A bookmarked page says the module is off and points admins to Settings → Modules. |
| Links | A case link to an entity of the module (a mail message while `mail` is off) is not shown and not offered. It is kept, and shows again when the module is back. |
| Fields | With `protection` off, agents see no protection levels in tool results. The REST API still carries the stored field. |
| Prompts | Prompt text about a module is marked (`<!-- module:<id> -->`, see `src/core/modules/prompt.ts`) and left out of every agent's system prompt while the module is off. |

## Who turns them on

The onboarding's first step turns on the modules of the use cases picked
([ONBOARDING.md](ONBOARDING.md)): `development` brings none, `company` the
business ones, `product` and `research` theirs. The plan review lets an admin
tick any other (voice, which no use case brings, included) or untick one the
answers do not need.

## Switching

Admins switch modules in **Settings → Modules**. The setting is
`modules.enabled` ([CONFIGURATION.md](CONFIGURATION.md)), and a change takes
effect at once, without a restart.

- Turning a module on also turns on what it depends on.
- Turning a module off is refused while a module that depends on it is on.
- Turning a module off deletes nothing. Its data stays, and turning it on
  again brings everything back as it was.

A job already running when its module is switched off finishes; nothing new starts. An install from before modules starts with every module on. A new install
starts with the core only, until the onboarding or an admin turns modules on.

`GET /api/modules` reports every module and whether it is on.
`PUT /api/modules/:id` with `{ "on": true | false }` switches one (admins).

## Capability gates

A module is the operator's switch. A **capability** is what the install has
a model for. Octipus needs one chat model and nothing else; everything below
is optional, and **not configured means off**, exactly as a module that is
switched off:

| Capability | Configured when |
|---|---|
| `embedding` (search & memory) | a model is bound to the Embedding lane |
| `see` (reading images) | a model is bound to the Vision lane, or the default model reads images |
| `ocr` (scanned documents) | a model is bound to the OCR lane, or `see` is configured |
| `draw` (image generation) | a model is bound to the image generation lane |
| `hear` (speech to text) | a speech-to-text engine is available |
| `speak` (text to speech) | a text-to-speech engine is available |

A feature is on only when its module is on **and** every capability it needs
is configured (`src/core/capabilities/gates.ts`). While one is not:

| Where | What happens |
|---|---|
| Agent tools | A function that needs it (`requires` on its registration) is in no agent's tool set, not listed by `list_tools`, not reachable from codemode. A running worker drops it on its next turn; a call that still names it is refused with what is missing (`capability_not_configured`). Configured again, it is offered again without a restart. |
| Prompts | Text marked `<!-- cap:<id> -->` (or a block closed by `<!-- /cap -->`) is left out; `<!-- cap:!<id> -->` marks the text used instead. |
| Background work | Nothing runs that would need it. Without an embedding model nothing is chunked or embedded — not even tried: no file is read for indexing, no memory is extracted (no background model call), the recall hook is skipped. |
| API | Its routes answer 409 `capability_not_configured` with what is missing and where to set it up. |
| Web | Its pages leave the sidebar; a bookmarked one says what is missing. Its controls are not shown (the microphone without speech to text). |
| Health | Reported as off, never as degraded or failed. Only a chat model is required. |
| Channels | A voice note without speech to text gets one line asking to type; an image no model can read reaches the agent as "an image arrived that nobody here can read", so it says so instead of guessing. |

**Content saved while embedding is off** (documents, notes, repositories) is
recorded in `index_backlog`. When an embedding model is bound, a catch-up job
indexes exactly those items once and deletes each row it finishes; content
that already has vectors is never re-embedded. A row that fails five times is
kept with its error.

What is configured is decided once at boot, before anything is served, and
recomputed whenever a model, a lane binding or a voice setting changes (and
every minute as a backstop). `GET /api/modules` reports it as `capabilities`.
