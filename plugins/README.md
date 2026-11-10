# The example plugins

Two plugins ship in this repository, as **the example plugins**: reference
implementations of a package plugin (docs/PLUGIN-PACKAGES.md). Read them
before you write your own. They are the only plugins kept here.

Both are a dependency-free MCP server over stdio (`server.mjs`) and a static
page (`ui/`), with no network of their own: everything goes through the
Octipus host API with the token each call carries, and the page calls the same
tools through the page bridge (a `MessagePort`), where a `write` tool asks the
user first.

## Reader: a call that does its work at once

`plugins/reader` reads a web page in a clean view and turns it into notes and
tasks. It shows, in a few hundred lines:

- **Tools with effects.** Its four tools are declared in
  `octipus-plugin.json` with the narrowest true effect: `read_url` and
  `reader_action` are `read`, `save_note` and `create_tasks` are `write`.
- **Host API scopes for work inside one call:** `web:read` (the host fetches
  the page through its SSRF guard), `model:complete` (the user's everyday
  model), `notes:write` and `tasks:write` (the calling user's own data).
- **A page** that Octipus serves sandboxed at `/plugins/reader/read`.

## Research: work that outlives the call

`plugins/research` runs deep research on a question in the background and
saves the cited report to the user's documents. It replaced the core research
module. It shows:

- **Long work without a long token.** A call's host token lives at most 30
  seconds; research takes minutes. `start_research` (`write`) asks the host
  for a background run of its own research agent (`agent:run`), as the user,
  and keeps only the run id. The host runs it under the user's permissions,
  budgets and protection routing, and the agent's web searches and fetches go
  through the host's own tools.
- **Reading it back in a later call.** `research_status` (`read`) reads the
  run by its id: a read tool may read a run, only a write tool starts one.
- **Saving as a document.** `save_report` (`write`) saves the finished report
  with `documents:write`, recording the plugin and tool that made it, and
  updates that same document when saved again.
- **A page that polls.** `/plugins/research/run` starts a run (the user
  confirms), reads its status every few seconds without asking, shows the
  report as text only, and saves it (the user confirms again).

## Tests

Each plugin's test sits beside its package and never inside it, since a
package directory is exactly what gets hashed and installed:
`plugins/reader.test.ts` and `plugins/research.test.ts` spawn the real server
against a fake host behind a fake egress proxy. The end-to-end tests with a
real host are in `src/plugins/packages/bundled.isolation.test.ts` and
`bundled-research.isolation.test.ts`; the pages are tested in
`tests/web/reader-plugin.spec.ts` and `tests/web/research-plugin.spec.ts`.

## Installing them

An admin installs either under **Admin → Plugin packages → Bundled**, or with
`octi plugin install-bundled reader` or `octi plugin install-bundled research`.
Like any package, each is installed disabled, and enabling it needs its host
scopes approved: Reader's `web:read`, `model:complete`, `notes:write` and
`tasks:write`; Research's `agent:run` and `documents:write`. Shipping with
Octipus gives them no other trust. Both may see protection level 1 only (they
have pages, and `web:read` and `agent:run` reach the web).

## Your own plugins do not go here

A plugin you make, by hand, with `octi plugin` or through an agent in Creator
mode, stays on your machine, whether you run a release install or a git
checkout:

- its source lives in a directory of yours or in the agent's workspace;
- the installed copy lives in `<workspace.rootPath>/plugin-packages`, and its
  data in `<workspace.rootPath>/plugin-data`.

Octipus offers only the plugins it ships (`SHIPPED_PLUGINS` in
`src/plugins/packages/bundled.ts`) as bundled. Any other directory here is
ignored by git and never listed as bundled. Install it from its own directory
instead. See docs/PLUGIN-PACKAGES.md#where-plugins-live.
