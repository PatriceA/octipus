# Plugins for everything

Status: accepted, phases 1 and 2 in progress (2026-11-10).

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
   code, and nothing it writes runs before a person approves those exact bytes.

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
