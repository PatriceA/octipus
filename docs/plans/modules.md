# Modules: a lean core, the rest switched on when wanted

Status: design, for review. Nothing here is built yet.

## Why

Octipus is a workstation, not a slim harness. But someone who installs it to
build software should get exactly that: the agents, their tools and the
things they work on. Today every feature is always on, whatever the
onboarding profile:

- **Menu:** the sidebar shows every page (the Business group with cases,
  contacts and records included).
- **Tools:** the general agent is offered every tool container in its role
  (`src/core/agent/roles/general/config.ts`): cases, records, mail and
  protection included. That costs prompt space on every turn and puts choices
  in front of a coding agent that it never needs.
- **Background work:** the cron tick runs every sweep (mail sync, scan
  folders) whether or not anything uses them. Task reminders and the nightly
  backup are core and stay.
- **Onboarding:** the use case picked (`development`, `company`, `product`,
  `research`) only chooses which questions are asked
  (`src/shared/onboarding/use-cases.ts`). Afterwards nothing differs.

The business OS work (plan points C1-C6) made this visible, but the problem is
older: research, the reader, the email inbox, persona and profiles are also
always there.

The aim: **a lean core that is the agent runner and dock, and modules on top
that a profile switches on.** A module that is off is gone: no menu entry, no
tool, no background job, no API. Its data, if any, stays untouched.

Big outside integrations (DATEV, banks, Meta, snap) stay
[plugin packages](../PLUGIN-PACKAGES.md), not modules. A module is code that
ships with Octipus but is not everyone's; a plugin package is code that ships
elsewhere.

## Core and modules

### The core (always on)

| Area | Why it is core |
|---|---|
| Chat, sessions, agents, roles, pipelines, hooks and schedules | The agent runner itself |
| Tasks (to-do), notifications | What agents and people hand each other |
| Notes, documents, knowledge, memory | What agents read and write while working |
| Models, topics, MCP servers, connectors, plugin packages | How agents reach models and the outside |
| Vault, permissions, users, spaces | Who may do what, and where |
| Settings, skills, tools page, evaluations | Running and tuning the install |
| Backups | Every install needs them |

Two of these, documents and tasks, are used by modules too: documents have
protection levels and can be filed by scan folders, and tasks are a case's
follow-ups. They stay core; the module adds to them.

### First modules (the business OS work)

| Module | What it switches | Turned on by |
|---|---|---|
| `business` | Cases, contacts, record types, records, public forms: pages `/cases`, `/contacts`, `/records`, `/forms/*`; routes `/api/cases`, `/api/contacts`, `/api/record-types`, `/api/records`, `/api/forms`; tools `cases`, `records` | `company` |
| `mail` | IMAP / POP3 / SMTP accounts: routes `/api/mail`; tool `mail`; the mail sync sweep | `company` |
| `scan-folders` | Scan folders: routes `/api/scan-folders`; the scan sweep | `company` |
| `protection` | Protection levels and, later, the privacy gateway (C6b-d): routes `/api/protection`; tool `protection`; the level fields in views and tools; routing enforcement | `company` |

### Later modules (existing features, a second step)

| Module | What it switches | Turned on by |
|---|---|---|
| `inbox` | The Gmail / Outlook inbox, triage and the heartbeat's mail watch (`/email`, `email-processor`) | `company` |
| `research` | Research jobs and the research page | `product`, `research` |
| `reader` | The reader | `research` |
| `recall` | Recall and the knowledge graph page | `research` |
| `people` | Persona, people and profiles | `company`, `product` |
| `artifacts` | Live artifacts and their hosting | anyone who asks |
| `voice`, `channels` | Voice; Telegram, Slack, Teams, WhatsApp | the onboarding's chat question |

Each of these needs its own look at what else reads it before it can be
switched off. They come after the first four, one at a time.

## How a module works

### Declared once, in code

Each module has one declaration (`src/modules/<id>.ts`) that lists everything
it brings:

```ts
export const businessModule: ModuleDefinition = {
  id: 'business',
  title: 'Cases, contacts and records',
  description: 'Matters of business, the people and organisations involved, structured records and public forms.',
  profiles: ['company'],
  dependsOn: [],
  routes: ['/api/cases', '/api/contacts', '/api/record-types', '/api/records', '/api/forms'],
  pages: ['/cases', '/contacts', '/records', '/forms'],
  tools: ['cases', 'records'],
  jobs: [],
  caseEntities: ['contact', 'record'],
  docs: 'docs/CASES.md',
};
```

The registry (`src/core/modules/registry.ts`) holds every module and answers
one question: `isModuleOn(id)`.

### On or off: one install-wide setting

- **Storage:** the setting `modules.enabled` lists the modules that are on. It
  goes through the existing settings service
  (`src/config/settings-service.ts`), so a change takes effect at once on
  every process, with no restart.
- **Who changes it:** admins, in Settings → Modules. The page shows each
  module with its description, what it adds, and what depends on it.
- **Turning a module off deletes nothing.** Its tables and rows stay, and
  turning it on again brings everything back as it was.
- **Install-wide, not per user:** a module changes what agents can do and what
  runs in the background, which is the install's business. Hiding pages per
  user, without changing what is on, can come later if it is wanted.

### Where "off" is enforced

One check, `isModuleOn`, at each place a module reaches the install:

| Place | When the module is off |
|---|---|
| **API** | Requests under its route prefixes answer 404, from one guard in the server before any route runs. It is the same answer as for a route that does not exist. |
| **Agent tools** | Its tool containers are left out of every agent's tool set: roles, pipeline stages, tool search. A call that names one anyway is refused. |
| **Background jobs** | Its cron sweeps do not run. |
| **Web** | `GET /api/modules` tells the web what is on. The sidebar leaves out the module's pages and drops a group that ends up empty. A bookmarked page shows "This module is off" with a link to Settings → Modules for admins. |
| **Links and views** | A case link to an entity of an off module (a mail message when `mail` is off) is not shown. It is not deleted. Fields a module adds to core views (protection levels on documents) are left out. |
| **Agent prompts** | Role prompts and context hooks do not mention what is off. A coding agent is not told about cases. |

### Dependencies

`dependsOn` names the modules a module needs. Turning a module on turns on what
it depends on, and turning one off refuses while a module that depends on it
is on. The first four modules have no hard dependencies on each other:
- mail and scan folders file into documents, which are core;
- cases link to mail only when both are on.

### `protection` needs particular care

Protection levels count unclear content as 4. With the privacy gateway (C6b)
built, level 3-4 content stays on local models. On a developer install that
would mean every document the agent reads keeps the session local. So:

- with `protection` **off**, levels are neither shown nor enforced: no
  routing change, no pseudonymization, no plugin gate;
- with `protection` **on**, unclear means 4, as documented in
  [PROTECTION-LEVELS.md](../PROTECTION-LEVELS.md).

Turning it on later is safe: stored levels are kept, and everything without
one counts as unclear (4) from that moment.

### Onboarding

The guide's plan ends with one more step: **set the modules** from the use
cases picked. Several use cases can be picked, so their modules are combined:

| Picked | Modules on |
|---|---|
| `development` | none: the core only |
| `company` | `business`, `mail`, `scan-folders`, `protection` (later: `inbox`, `people`) |
| `product` | later: `research`, `people` |
| `research` | later: `research`, `reader`, `recall` |

The step shows what it will switch on, like every other step of the plan, and
Settings → Modules changes it afterwards.

### Existing installs and new ones

- **Existing installs:** the migration turns on every module, so nobody loses
  a page or a tool they use. An admin switches off what they do not need.
- **New installs:** the core only, until the onboarding (or an admin) turns
  modules on. Skipping the onboarding leaves the lean core.

### Keeping it honest: a conformance test

As with the space routes (`src/api/space-routes.test.ts`), a test lists every
mounted route prefix, tool container, cron sweep and sidebar page. Each one
must be core (on an explicit list) or belong to exactly one module. A new
feature cannot slip in as always-on by accident: whoever adds it decides.

A second test runs with every module off and checks that:
- the module routes answer 404;
- the general role's tools contain none of them;
- the sweeps do nothing;
- `GET /api/modules` reports them as off.

## Order of work

1. **Registry and setting:** the four first modules declared, the migration
   for existing installs, `GET /api/modules`, Settings → Modules.
2. **Enforcement:** the route guard, tool filtering, cron gating, the sidebar,
   case links, and the conformance and "all off" tests.
3. **Onboarding:** the use-case-to-modules step.
4. **Later modules:** inbox, research, reader, recall, people, artifacts,
   voice and channels, one at a time.

C6b-d (the privacy gateway) come after step 2, inside the `protection` module.

## Decisions for you

1. **Granularity of the first modules:** four modules (`business`, `mail`,
   `scan-folders`, `protection`), or one `company` bundle? Recommended: four.
   A practice may want mail and scan folders without cases, and the cost is
   only four rows in Settings.
2. **Existing installs:** everything on (recommended, nothing disappears), or
   modules set from the use cases they once picked?
3. **New installs without onboarding:** core only (recommended), or everything
   on?
4. **The later modules (step 4):** do them, or stop after the business modules?
