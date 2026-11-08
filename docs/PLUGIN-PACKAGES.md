# Plugin packages

A plugin package brings a connection to another system — DATEV, a bank API,
euregon snap, Meta — without changing Octipus itself. It ships outside the main
repository and runs as its own process: a local MCP server, started and
fenced in by Octipus. This is point C2 of the
[business OS plan](plans/business-os.md).

Plugin packages are not the older in-process plugins of [PLUGINS.md](PLUGINS.md),
which run inside the server with its full rights. Use a package for anything
that talks to the outside world or handles credentials.

## What a package is

A directory with an `octipus-plugin.json` manifest at its root and a local MCP
server (any language) that the manifest says how to start:

```json
{
  "name": "finapi",
  "version": "1.0.0",
  "apiVersion": "1.0.0",
  "title": "finAPI bank accounts",
  "description": "Reads balances and transactions of connected bank accounts.",
  "publisher": "Example GmbH",
  "server": { "command": "node", "args": ["dist/server.js"] },
  "tools": {
    "list_accounts": { "effect": "read", "description": "Connected accounts and balances" },
    "list_transactions": { "effect": "read" },
    "prepare_transfer": { "effect": "write", "description": "Draft a SEPA transfer file" }
  },
  "network": ["sandbox.finapi.io", "*.finapi.io"],
  "maxProtection": 2,
  "settings": [{ "key": "environment", "label": "Environment", "type": "select", "options": ["sandbox", "live"], "required": true }],
  "secrets": [
    { "key": "FINAPI_CLIENT_ID", "label": "Client ID", "required": true },
    { "key": "FINAPI_CLIENT_SECRET", "label": "Client secret", "required": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Lower-case, `a-z0-9-`, 2-50 characters. `octipus`, `mcp`, `system`, `plugin` are reserved. |
| `version`, `apiVersion` | Semantic versions. This host reads `apiVersion` 1.x up to 1.0: the same MAJOR, a MINOR no newer than the host's. |
| `server` | `command` and `args`, run in the package directory over stdio. Optional `requestTimeoutMs`. |
| `tools` | Every tool the server offers, with its `effect` (below). At least one. |
| `network` | The hosts it talks to. Shown at install; the sandbox gives the package network only when it lists at least one. |
| `maxProtection` | The highest protection level (1-4) of data it may see. A call from a conversation holding content above it is refused ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md#plugin-calls-c6d)). Left out: 1 for a package with `network` hosts, 4 for one without. |
| `settings` | Non-secret settings as [record type fields](RECORDS.md#record-types), handed to the server as `OCTIPUS_SETTING_<KEY>`. |
| `secrets` | Credentials, stored in the vault, handed to the server as environment variables under their own `key`. |

Every problem in a manifest is reported at once; a package that does not fit is
refused at install.

## Tool effects

The package says what each tool does, and Octipus decides the permission from
it. A declaration can only make a tool stricter:

| Effect | Meaning | Permission |
|---|---|---|
| `read` | Reads only. | ALLOW by default. A user's rule can ask or deny. |
| `write` | Changes data in the connected system. | ASK by default. |
| `external` | An effect outside the organisation: a payment, a message to a person, a post. | Always ASK. A rule can deny it but never allow it, and an unattended run (a heartbeat, a schedule) is refused. |

A tool the server offers but the manifest does not declare is hidden from the
agent and refused if called.

## How a package runs

An enabled package runs as the MCP server `plugin-<name>`:

- **Its own process, its own directory.** The server starts in the package
  directory under `<workspace.rootPath>/plugin-packages/<name>`.
- **A minimal environment.** It gets `PATH`, `HOME`, the locale and temp
  variables, its settings and its secrets — and nothing else of the host: no
  provider keys, no master key, no database URL, no other variable.
- **The sandbox, when it is on.** With `security.shellSandbox` set to `auto`
  or `required`, the server runs under bwrap or firejail with its directory as
  the only writable one, and with network only if `network` lists a host. With
  the sandbox `off` (the default), it runs unwrapped; the declared hosts are
  then shown, not enforced.
- **Not part of the MCP server list.** It does not appear among the servers on
  the MCP page and cannot be edited, removed or toggled there. Ids starting
  with `plugin-` belong to packages: adding such a server by hand is refused,
  and one stored directly in `mcp.servers` or `mcp-servers.json` is ignored,
  so it can never stand in for a package and drop its declared effects.

Every change (install, settings, secrets, enable, disable) restarts the
package's server if its configuration changed.

## Content pinning

What runs is what an admin installed. Install, upgrade and content approval
record a **content hash** of the package directory on its row
(`plugin_packages.content_hash`, shown as `contentHash`):

```
sha256 over:  octipus-plugin-content/v1
              name <manifest name>
              version <manifest version>
              file <sha256 of the bytes> "<relative/path>"     one line per file,
              ...                                              sorted by path
```

Every file counts — any changed byte, added, removed or renamed file changes
the hash — but not directory order, timestamps or permissions. A symbolic link
(refused at install) counts by its target. Only `node_modules/.cache`, at any
depth, is left out: build tools write their caches there on their own, and
nothing in it is the package's code.

Before **every start** of the package's server — host start, enable, restart
after a change, reconnect after a crash — the hash is recomputed. On a
mismatch the server is not started; the package keeps `enabled` but shows the
problem *"Modified since it was approved (hash mismatch)"*, and the log names
the package with the recorded and the actual hash. Enabling a disabled package
whose files do not match is refused as well. A server already running keeps
running until its next start.

To accept the new content (after reading what changed):

```
PATCH /api/plugin-packages/:name { "approveContent": true }
```

This records the hash of the files as they are now (audit op
`content_approved`, with the old and new hash) and starts the package if it is
enabled; `{ "approveContent": true, "enabled": true }` does both in one write.
Reinstalling with `"upgrade": true` also records a fresh hash.

A package installed **before pinning existed** has no hash. Its first start
records the current one and logs that once (trust on first use), so existing
installs keep running after the update; from then on it is checked like any
other.

A package that writes into its own directory at runtime (its only writable one
in the sandbox) will read as modified on its next start; it should keep its
runtime state elsewhere (a temp directory), or be approved again.
Signatures over the hash come with signed packages (C15).

## Installing and managing

Admins only. A package installs from a directory on the server; the
marketplace (plan point C15) will fetch signed packages instead.

1. **Install:** `POST /api/plugin-packages { "path": "/opt/plugins/finapi" }`.
   The directory is copied into the plugin directory (no symbolic links, at most
   200 MB and 20,000 files). The package starts **disabled**, so its tools,
   effects, hosts and protection level can be read first.
2. **Configure:** `PATCH /api/plugin-packages/:name { "settings": {...} }`, and
   `PUT /api/plugin-packages/:name/secrets/:key { "value": "..." }` for each
   secret (`null` removes it). Secret values are never returned.
3. **Enable:** `PATCH /api/plugin-packages/:name { "enabled": true }`. Refused
   while a required setting or secret has no value; settings and `enabled` in
   one PATCH are saved together or not at all. A required secret of an enabled
   package cannot be removed; disable it first.
4. **Upgrade:** install again with `"upgrade": true`. The package is disabled
   before any file is replaced and stays disabled until enabled again, since
   its tools may have changed. Each setting the new version still declares and
   accepts is kept; a new required setting must be set before enabling.
   The new files' hash replaces the old one.
5. **Approve changed content:** `PATCH /api/plugin-packages/:name
   { "approveContent": true }` after a hash mismatch
   ([Content pinning](#content-pinning)).
6. **Uninstall:** `DELETE /api/plugin-packages/:name` removes the server, the
   files, the row and the secrets.

`GET /api/plugin-packages` lists installed packages with their manifest,
settings, which secrets are set, whether the server is connected, and why it is
not when it should be.

Every change is in the audit log (`resource_type = plugin_package`).

## Not yet

- Packages reporting events back (a new invoice in DATEV opening a case):
  plan point C2b.
- Signed packages, remote install and the marketplace page: C15. Until then a
  package is pinned by its content hash only ([Content pinning](#content-pinning)).
- A web page for plugin packages.
- In a shared space, plugin tools follow the rules of personal connections
  (reads allowed, writes asked or refused); space-level packages come later.
