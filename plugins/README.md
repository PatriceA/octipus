# The example plugin

`plugins/reader` is **the example plugin**: the reference implementation of a
package plugin (docs/PLUGIN-PACKAGES.md). Read it before you write your own.
It is the only plugin kept in this repository.

Reader reads a web page in a clean view and turns it into notes and tasks. It
shows, in a few hundred lines with no dependencies:

- **Tools with effects.** `server.mjs` is an MCP server over stdio. Its four
  tools are declared in `octipus-plugin.json` with the narrowest true effect:
  `read_url` and `reader_action` are `read`, `save_note` and `create_tasks`
  are `write`.
- **Host API scopes.** It has no network of its own. Everything goes through
  the Octipus host API with the token each call carries: `web:read` (the host
  fetches the page through its SSRF guard), `model:complete` (the user's
  everyday model), `notes:write` and `tasks:write` (the calling user's own
  data).
- **A page through the bridge.** `ui/` is a static page (no inline script or
  style) that Octipus serves sandboxed at `/plugins/reader/read`. It calls the
  same tools through the page bridge, and a `write` tool asks the user first.

Its test, `plugins/reader.test.ts`, sits beside the package and never inside
it: a package directory is exactly what gets hashed and installed.

## Installing it

An admin installs it under **Admin → Plugin packages → Bundled**, or with
`octi plugin install-bundled reader`. Like any package it is installed
disabled, and enabling it needs its host scopes approved. Shipping with
Octipus gives it no other trust.

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
