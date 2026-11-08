# Plugin packages

A plugin package brings a connection to another system — DATEV, a bank API,
euregon snap, Meta — without changing Octipus itself. It ships outside the main
repository and runs as its own process: a local MCP server, started and
fenced in by Octipus. This is point C2 of the
[business OS plan](plans/business-os.md).

Plugin packages are not the older in-process plugins of [PLUGINS.md](PLUGINS.md),
which run inside the server with its full rights. Use a package for anything
that talks to the outside world or handles credentials. Those plugins are
deprecated; `octi plugin convert <dir>` turns one into a package
([PLUGINS.md](PLUGINS.md#converting-to-a-plugin-package)).

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
| `network` | The hosts it talks to (`api.example.com`, `*.example.com` for its subdomains, `api.example.com:8443` for one port). Shown at install; the package reaches only these, on 443 and 80 unless a port is given — enforced only under the sandbox ([Network](#network)). |
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
  variables, its settings, its secrets and `OCTIPUS_PLUGIN_DATA_DIR` — and
  nothing else of the host: no provider keys, no master key, no database URL,
  no other variable.
- **A data directory for its state.** `OCTIPUS_PLUGIN_DATA_DIR` points at
  `<workspace.rootPath>/plugin-data/<name>`, created when the server starts and
  removed on uninstall. A package **must keep its runtime state there** (caches,
  databases, tokens it refreshes): its own directory is read-only under the
  sandbox and pinned by hash ([Content pinning](#content-pinning)).
- **The sandbox, when it is on.** With `security.shellSandbox` set to `auto`
  or `required`, the server runs under bwrap or firejail with its directory
  mounted **read-only** (bwrap `--ro-bind`, firejail `--read-only`), its data
  directory as the only writable one, and no direct network; the hosts in
  `network` are reached through the egress proxy ([Network](#network)). With
  the sandbox `off` (the default), it runs unwrapped; its directory is then
  writable and the declared hosts are advice, not enforced.
- **Network only to its declared hosts** — see [Network](#network).
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
(refused at install) counts by its target. Nothing is left out — not even
`node_modules/.cache`: a cache a build tool writes on its own is still a place
running code could stage executable content in. Only paths relative to the
package root enter the listing, so the copy hashed at install hashes the same
as the installed directory.

Install and upgrade copy the package into a staging directory beside the
installed one and hash **the copy**, before it replaces anything; the row (new
manifest, version and hash) is written in the same transaction that swaps the
files in. A failure while copying, hashing or swapping leaves the old files and
the old row together (an upgrade stays disabled).

Before **every start** of the package's server — host start, enable, restart
after a change, reconnect after a crash — the hash is recomputed. A restart
first waits for the old process to exit (it is killed after 3 seconds), so it
cannot still be writing while the new start is checked; concurrent starts of
the same server (an on-demand reconnect and the backoff timer) share one check
and one process. On a mismatch the server is not started; the package keeps
`enabled` but shows the problem *"Modified since it was approved (hash
mismatch)"* with the hash its files have now as `actualHash`, the log names
the package with the recorded and the actual hash, and the audit log gets one
`content_mismatch` row (with both hashes) per package and pair of hashes — a
reconnect loop does not repeat it. Enabling a disabled package whose files do
not match is refused as well, naming both hashes. A server already running
keeps running until its next start.

To accept the new content, review the files that hash to `actualHash` and
approve **that hash**:

```
PATCH /api/plugin-packages/:name { "approveContent": "sha256:<actualHash>" }
```

The files are hashed again when the request arrives: only if they still hash
to the reviewed value is it recorded (audit op `content_approved`, with the old
and new hash) and the package started if it is enabled; otherwise the request
is refused with `409` naming the actual hash, and nothing changes.
`{ "approveContent": "sha256:…", "enabled": true }` approves and enables in
one write. `"approveContent": true` is refused (`400`): pass the hash you
reviewed. Reinstalling with `"upgrade": true` also records a fresh hash.

A package installed **before pinning existed** has no hash. Its first start
records the current one, logs it and writes the audit op
`content_pinned_first_use` (with the hash) once (trust on first use), so
existing installs keep running after the update; from then on it is checked
like any other.

A package keeps its runtime state in its data directory
(`OCTIPUS_PLUGIN_DATA_DIR`), which is not hashed. Under the sandbox its own
directory is read-only, so a write there fails; without the sandbox a package
that writes into its own directory reads as modified on its next start and
must be approved again.
Signatures over the hash come with signed packages (C15).

## Network

Each running package with `network` hosts gets its own egress proxy inside the
Octipus process: an HTTP proxy on `127.0.0.1` (an ephemeral port) that accepts
`CONNECT` (HTTPS and other TCP) and plain-HTTP forwarding only to a declared
host — an exact name, or any subdomain for `*.example.com` (not the apex;
declare it too) — on 443 and 80, or on exactly the port an entry names.
Everything else is answered `403` and logged with the package name and the
host ("Plugin package network request refused"). The server is started with
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and the lower-case forms) pointing at
the proxy and `NO_PROXY` cleared.

What that holds depends on the platform:

| Where | A package with hosts | A package without hosts | Status `network.state` |
|---|---|---|---|
| Linux, sandbox `auto`/`required`, bwrap or firejail found | Enforced: the server has its own network namespace with only loopback. The proxy's Unix socket is mounted in, and a small launcher (run with Octipus's own Node binary) bridges the namespace's `127.0.0.1` to it, so the proxy is the only way out. | Offline: no network at all. | `restricted` / `offline` |
| Linux with the sandbox `off` (the default), or no runner found | **Not enforced.** The proxy variables point well-behaved HTTP clients at the proxy, but a direct connection still works. | Not enforced: nothing blocks the network. | `not_enforced` |
| macOS, Windows | **Not enforced**, as above: neither bwrap nor firejail exists there. | Not enforced. | `not_enforced` |

`GET /api/plugin-packages` reports this per package as `network`
(`{ state, detail }`), so an operator sees "Network not enforced on this
platform" where the hosts are only advice. A client that ignores proxy
variables (some SDKs, raw sockets) fails under the sandbox and goes direct
without it — run packages with `security.shellSandbox` on where that matters.

Host names are resolved by Octipus, not the package, once per request. If any
address a declared host resolves to is loopback, private (RFC 1918),
link-local (including the cloud metadata address `169.254.169.254`), CGNAT
(`100.64.0.0/10`), unique-local IPv6 (`fc00::/7`), unspecified, an
IPv4-mapped private address or otherwise reserved, the request is refused
`403` and logged with the package, the host and the address ("declared host
resolves to a private address"). The proxy then connects to the address it
checked, never resolving the name again, so DNS rebinding between the check
and the connection cannot reach an internal address. A package cannot reach
internal services through the proxy at all; declaring an IP literal is refused
in the manifest already.

Plain-HTTP forwarding sends the target's own `Host` (`host[:port]` of the
requested URL), never the one the client wrote, and drops hop-by-hop headers in
both directions: `Connection` and every header it lists, `Keep-Alive`,
`Proxy-*`, `TE`, `Trailer`, `Upgrade` and `Transfer-Encoding` (Node re-frames
the body itself). When the client goes away the upstream request is aborted,
and stopping the server's proxy aborts every request still in flight.

**Known limit:** a `CONNECT` tunnel carries TLS the proxy does not open, so it
sees the name in `CONNECT`, not the server name (SNI) or `Host` the client then
sends. A package can declare `api.example.com` and, inside a tunnel to its
address, ask for another name served from the same IP (a shared CDN or load
balancer). The proxy holds the destination address, not the virtual host.

Under the sandbox the proxy's Unix socket lives in a fresh directory under
`<workspace.rootPath>/plugin-run` (falling back to `$XDG_RUNTIME_DIR` when that
path is too long for a socket), never under `/tmp`: firejail runs with
`--private-tmp`, which hides the host's `/tmp` whatever is whitelisted, and
bwrap mounts a per-start scratch directory over `/tmp`. Both runners mount the
socket directory by its own path.

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
   { "approveContent": "sha256:<reviewed hash>" }` after a hash mismatch
   ([Content pinning](#content-pinning)).
6. **Uninstall:** `DELETE /api/plugin-packages/:name` removes the server, the
   files, the data directory, the row and the secrets.

`GET /api/plugin-packages` lists installed packages with their manifest,
settings, which secrets are set, whether the server is connected, why it is
not when it should be, and whether its network is enforced (`network`).

Every change is in the audit log (`resource_type = plugin_package`).

## Not yet

- Packages reporting events back (a new invoice in DATEV opening a case):
  plan point C2b.
- Signed packages, remote install and the marketplace page: C15. Until then a
  package is pinned by its content hash only ([Content pinning](#content-pinning)).
- A web page for plugin packages.
- Network enforcement off Linux (macOS `sandbox-exec`, Windows): the egress
  proxy is advisory there.
- In a shared space, plugin tools follow the rules of personal connections
  (reads allowed, writes asked or refused); space-level packages come later.
