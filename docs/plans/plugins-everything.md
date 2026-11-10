# Plugins for everything

Status: accepted; phases 1, 2 and 4 implemented, phase 3 started with the reader (2026-11-10).

## Why

Every new capability so far has been core code: a route, a page, a tool, a
job, a prompt section, wired in by hand and switched by a module flag. That
makes the core grow with every request and makes a feature the user wants
next a code change in Octipus itself.

DeepSeek Harness takes the opposite position: its core is about 99 Cordis
plugins (model adapter, tool registry, agent loop included), any of them can
be hot-reloaded, and the agent can write and install a plugin in the middle
of a conversation ("Creator mode"). What it gives up is safety: every plugin
runs in the server process with its full authority, and its own docs tell
users to treat a plugin like shell access.

We want its reach without its trust model. Octipus already has the safe
half: plugin packages run out of process, sandboxed (bwrap / firejail /
sandbox-exec), with declared network hosts, a read-only package directory, a
content hash checked at every start, Ed25519 signing, revocation, a registry
and an admin page. What they can do is narrow: they add tools. This plan
widens what a plugin can contribute until a new feature is a plugin, not a
core change, and keeps in-process code as the exception.

## The shape

**One plugin, two runtimes.** A plugin is a directory with one manifest,
`octipus-plugin.json`, installed, pinned, signed, approved and listed the
same way whatever runs it:

| Runtime | Runs as | Can | Trust needed |
|---|---|---|---|
| `package` (default) | An MCP server over stdio, in the sandbox | Everything in "Contributions" below, through its tools | Admin installs and approves the content hash |
| `in-process` | A module loaded into the server (`octi.*`, today's trusted extensions) | Additionally: agent hooks (`context`, `tool:before/after`, `compact:before`, `spawn:*`), model providers | As for `package`, plus an explicit "run in the server process" approval, recorded with the hash |

The in-process runtime is today's `extensions.trusted` list, moved onto the
package install path: same hash pinning, signing, revocation and registry, so
a trusted extension is no longer "a file on disk listed in config" but an
installed, approved, auditable plugin. Discovery from `~/.octipus/extensions`
keeps working for development and logs that it is unpinned.

**Contributions** are declared in the manifest and bound to the plugin's own
tools, so the host stays the only code that touches routes, the UI, the
scheduler and the prompt. Each one is registered with a disposer, so enabling,
disabling, upgrading or reloading a plugin applies at once, without a restart
(the Cordis "every registration is an effect" rule):

| Contribution | Manifest | What the host does |
|---|---|---|
| Tools | `tools` (exists) | MCP tools with declared effects, permissions, flow guard |
| Slash commands | `commands: [{ name, tool, description }]` | `/name args` calls the tool as the user, no model turn |
| Schedules | `schedules: [{ id, cron, tool, input? }]` | The cron runner calls the tool (as the install, effect rules apply) |
| Events | `events: [{ on, tool }]` | Selected gateway events (session created, task done, note saved, …) call the tool, async, rate-limited |
| Prompt sections | `prompt: { file, roles? }` | Static markdown added to agents' system prompt (install tier) while enabled |
| Context | `context: { tool, roles? }` | Called at turn start like a context hook; its text rides the turn tier |
| Pages | `ui: { pages: [{ path, title, icon?, entry }] }` | Sidebar entry; the page is the plugin's static HTML served in a sandboxed iframe, talking to the host only through a `postMessage` bridge that calls the plugin's own tools as the signed-in user |
| Settings / secrets | `settings`, `secrets` (exist) | Admin form, env vars |
| Host API | `host: ["notes:write", "tasks:write", …]` | A short-lived per-plugin token in `OCTIPUS_HOST_TOKEN`; the plugin calls a narrow host API (`OCTIPUS_HOST_URL`, reachable only through its egress proxy) limited to the declared scopes, acting as the user who triggered the call |

Storage needs nothing new: a package already has a private writable data
directory (`OCTIPUS_PLUGIN_DATA_DIR`).

## Phases

1. **One install path for both runtimes.** `runtime` in the manifest;
   in-process plugins installed, pinned, signed and approved like packages,
   with the extra in-process approval; the extension loader reads approved
   in-process plugins from the package store; `octi.*` registrations bound to
   the plugin's enable state.
2. **Contributions.** Commands, schedules, events, prompt sections, context,
   pages (iframe + bridge) and the scoped host API, each with a disposer, each
   visible on the admin page (what a plugin adds) and refused at install when
   malformed.
3. **Prove it on a module.** Move one module (`reader`, then `research`) out
   of core into a first-party plugin, signed by the Octipus publisher key,
   shipped in the default registry. The module's declarations (routes, pages,
   tools, jobs) map onto contributions; a module that is a plugin is switched
   on by installing it.
4. **Creator mode, sandboxed.** A skill and templates for writing a
   `package` plugin, a read-only `plugin_api` tool that describes the live
   contribution and host-API contract, and an `install_plugin` action that
   installs the agent's bundle **disabled**: an admin reviews the content
   hash on the admin page and enables it. The agent never gets in-process
   code, and Octipus does not start anything it writes before a person
   approves those exact bytes (the agent's own shell is held by the shell
   sandbox and its ASK prompts, see PLUGIN-PACKAGES.md).

## Phase 3, the reader: declaration → contributions

The `reader` module is the first to move. The bundled plugin `plugins/reader`
(a dependency-free stdio MCP server and a static page) does what the module
did, through contributions only:

| Module declaration (`src/modules/reader.ts`) | What it was | In the plugin |
|---|---|---|
| `routes: ['/api/reader']` `POST /` | Fetch a URL through the SSRF guard, extract a clean article | Tool `read_url` (read) → host scope **`web:read`**: the host fetches with the same guard and extraction (`fetchReaderDoc`) and hands back the article; the plugin has no network of its own |
| `POST /action` | summarize / simplify / translate / action_items / ask, one call on the `everyday` lane | Tool `reader_action` (read) → host scope **`model:complete`** (same prompts, same untrusted-content framing, same 12,000-character cap) |
| `POST /tasks` | Action items → tasks (`source: reader`, category Reading, linked to the article) | Tool `create_tasks` (write) → `tasks:write`, with the new `category` and `link` fields; the source is `agent` with `sourceRef { plugin, tool, url, label }` |
| — (the module promised notes, the page had none) | | Tool `save_note` (write) → `notes:write`: the article, or an action's result, as a note |
| `pages: ['/reader']` | The React page | `ui.pages: [{ path: 'read' }]`: static HTML/JS in the sandboxed frame, calling the four tools through the bridge; saving asks the user (write effect) |
| `tools: []`, `jobs: []` | — | Agents get the four tools too (`mcp.plugin-reader.*`), which the module never gave them |
| `profiles: ['research']` | Onboarding switched it on | `profiles: []`; the onboarding plan and Settings → Modules point admins to Admin → Plugin packages → Bundled (`replacedBy`) |

What the plugin surface gained, each general rather than reader-shaped:
the host scopes `web:read` and `model:complete`, `category`/`link` on
`tasks:write`, `maxProtection` defaulting to 1 for a package with `web:read`,
and bundled plugins (`plugins/` in the install: listed, installed pinned and
disabled, enabled by an admin approving their scopes).

What is not done yet: the core reader (route, page, `src/core/reader`'s
action code) stays, deprecated, for installs that have the module on; the
extraction (`fetchReaderDoc`) stays in any case, as what `web:read` runs.
It goes once installs have moved (a release later). Bundled plugins are not
signed with an Octipus publisher key, nor listed in a default registry.
Behaviour differences: the page shows no lead image and loads no remote
image (the page CSP allows its own files only); a link in an article fills
the address field instead of navigating; translate and ask take their
argument in a field (a sandboxed frame opens no dialog). `research` is next.

   *Status: implemented.* The `plugin_dev` tool group (`plugin_api`,
   `plugin_template`, `plugin_validate`, `plugin_install`; the plan's
   `install_plugin` is `plugin_install`), three templates under
   `src/plugins/templates/`, the system skill "Write an Octipus plugin", and
   "Authored by an agent" on the admin page, read from the install's audit row
   (no migration). Only an admin's agent installs (decided: a non-admin's
   agent is refused and told to ask an admin); runtime `in-process` and paths
   outside the agent's workspace are refused; an agent upgrades only packages
   an agent installed. See
   [PLUGIN-PACKAGES.md](../PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent).
   Left: the older `plugin-development` skill still teaches the deprecated
   in-process extensions; retire or redirect it once phase 3 lands.

## What we do not copy

- **The core as plugins.** Rewriting the agent loop, model router and tool
  registry onto a DI container buys hot reload of the core and costs a rewrite
  plus the safety model. The core stays code; features move out.
- **Unsandboxed third-party code.** In-process stays opt-in per plugin, with
  its own approval, and only for what needs it (hooks, providers).
- **Profile-wide surprises.** A contribution's effect is scoped and listed on
  the admin page; a plugin cannot replace a core service.

## Pitfalls to design against (from DeepSeek Harness)

- Silent "pending" plugins: a contribution that cannot bind (missing tool,
  bad cron) fails the install with a reason, and a runtime failure shows on
  the plugin's row.
- Whole-config replacement on update: settings are merged per key (as today).
- Concurrent disposers: a plugin's disposers run in reverse registration
  order.
- Required vs optional: a plugin that fails to start never stops the server.
