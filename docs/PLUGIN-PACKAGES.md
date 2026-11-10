# Plugin packages

A plugin package brings a connection to another system — DATEV, a bank API,
euregon snap, Meta — without changing Octipus itself. It ships outside the main
repository and runs as its own process: a local MCP server, started and
fenced in by Octipus. This is point C2 of the
[business OS plan](plans/business-os.md).

Plugin packages are not the older in-process plugins of [PLUGINS.md](PLUGINS.md),
which run inside the server with its full rights. (Trusted extensions, the
`octi.*` modules that hook the agent loop, can now be installed as packages
too, with `runtime: "in-process"`: see [Runtimes](#runtimes).) Use a package for anything
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
| `maxProtection` | The highest protection level (1-4) of data it may see. A call from a conversation holding content above it is refused ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md#plugin-calls-c6d)). Left out: 1 for a package with `network` hosts, the `web:read` host scope or `ui` pages (a page can leak what it shows, [Pages](#pages)), 4 for one with none of these. |
| `settings` | Non-secret settings as [record type fields](RECORDS.md#record-types), handed to the server as `OCTIPUS_SETTING_<KEY>`. |
| `secrets` | Credentials, stored in the vault, handed to the server as environment variables under their own `key`. |
| `commands`, `schedules`, `events`, `prompt`, `context` | What the package adds besides tools, each bound to one of its own tools ([Contributions](#contributions)). |
| `runtime` | `package` (the default: this page) or `in-process` ([Runtimes](#runtimes)). |
| `entry` | For `in-process` only: the module to load. |
| `ui` | Pages the package adds to the web app: `{ "dir"?: "ui", "pages": [{ "path", "title", "icon"?, "entry" }] }` ([Pages](#pages)). |
| `host` | Host API scopes it asks for, from `notes:read`, `notes:write`, `tasks:read`, `tasks:write`, `documents:read`, `notify`, `web:read`, `model:complete`; an admin approves them when enabling ([Host API](#host-api)). |

Every problem in a manifest is reported at once; a package that does not fit is
refused at install.

## Runtimes

A plugin is installed, pinned, signed, approved, listed and audited the same
way whatever runs it; `runtime` says what does:

| Runtime | Runs as | Trust needed |
|---|---|---|
| `package` (default) | An MCP server over stdio, in the sandbox ([How a package runs](#how-a-package-runs)) | An admin installs it and approves its content hash |
| `in-process` | A [trusted extension](PLUGINS.md#from-an-extension-octihook-trusted-extensions-only) loaded into the server process (`octi.*`): it can hook the agent loop, register tools and model providers | As for `package`, plus an explicit approval to run in the server process, recorded with the content hash |

An in-process plugin's manifest names its module instead of a server:

```json
{
  "name": "auditlog",
  "version": "1.0.0",
  "apiVersion": "1.0.0",
  "title": "Audit every tool call",
  "description": "Writes a line for each tool call through a tool:after hook.",
  "runtime": "in-process",
  "entry": "dist/index.mjs"
}
```

- **`entry`**: a path relative to the package root (no `.`/`..` segments) to
  an ES module (`.mjs` or `.js`) whose default export is the extension
  factory, `(octi) => void | Promise<void>`, the same shape as an extension in
  `~/.octipus/extensions` ([PLUGINS.md](PLUGINS.md)). It must be a file in
  the package at install.
- **One bundled module.** The entry is the package's only code file (no other
  `.js`, `.mjs`, `.cjs`, `.ts`, `.jsx`, `.tsx`, `.node` or `.wasm` anywhere in
  it; data files such as a README are fine), and it imports nothing by path
  (`./x`, `../x`, `/x`, `file:`), only Node built-ins (`node:fs`, …). Bundle
  the plugin and its dependencies into one file, for example
  `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/plugin.mjs`.
  Install refuses a package that breaks this, saying which file or line.
- **What applies**: `name` (lower-case letters and digits only, no `-`: its
  tools are named `ext_<name>__<id>`), `version`, `apiVersion`, `title`,
  `description`, `publisher`, `homepage`; content pinning, signatures,
  revocation, registries, remote install, upgrade and uninstall, unchanged.
- **What is refused**, because only a sandbox or a server process of its own
  would make it true: `server` and `tools` (nothing is started; its tools are
  registered with `octi.registerTool`, each with its effect), `network` (it
  has the server's network), `maxProtection` (it can read whatever the server
  can). `settings` and `secrets` are refused too: nothing hands them to an
  in-process module yet (a provider names a system vault secret instead).

**The in-process approval.** Approving its content says *these bytes are what
I reviewed*; running them in the server process gives them the server's full
authority, so it is a second, explicit decision:

```
PATCH /api/plugin-packages/auditlog { "approveInProcess": "sha256:<contentHash>" }
```

The hash must be the approved `contentHash` and the files must still hash to
it (`409` otherwise), under the same signature rules as enabling (a revoked
key is refused; under `plugins.requireSignature`, unsigned content too). It is
recorded on the row with who and when (`inProcess` in the view) and audited
(`in_process_approved`). Enabling an in-process plugin without it is refused
(`409`). It covers one content hash: an upgrade, or approving changed content,
clears it (the audit row of the content approval says so), and the plugin is
not loaded again until it is approved for the new bytes. A plugin installed
from a URL must carry a trusted signature, like any package, and still needs
this approval.

On the web page an in-process plugin's row says **in-process**, and while the
approval is missing shows its content hash with **Approve running in the
server process** (after a confirmation). From the command line:
`octi plugin approve-in-process <name> [--hash sha256:<hex>]`.

**Loading.** While an in-process plugin is enabled and approved, the
extension system loads it from its installed directory (read in place, never
written), after the check every package start gets: its files hash to the
approved content hash, its signature file is the approved one, its key is
not revoked, and under `plugins.requireSignature` it carries a trusted
signature. Then the package is listed and hashed once more, the entry's bytes
are read into memory and must match that listing's line for the entry (a
listing that hashes to the approved hash), and those bytes are imported from
memory (a `data:` URL). What runs is exactly what was checked: a file changed
after the read never runs, and one changed before it fails the check. A plugin that fails the check, cannot be imported or whose factory
throws is not loaded, the reason shows as its problem, and the server runs on.
Its factory gets the same `octi` API as a trusted extension. Disabling,
uninstalling or upgrading it disposes everything it registered (event
handlers, commands, hooks, tools, providers, `onDispose` callbacks), the last
registration first; enabling or approving loads it again. No restart either
way.

Because the module is its bytes, new content always loads new code and
nothing it imports can go stale: there is no file it imports.

What in-process does not give: a sandbox. The checks above make sure the code
that runs is the code an admin approved, signed by whom it says; they do not
limit what that code can do once it runs.

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
  or `required`, the server runs under bwrap or firejail (Linux) or
  `sandbox-exec` (macOS) with its directory **read-only** (bwrap `--ro-bind`,
  firejail `--read-only`, a Seatbelt `deny file-write*`), its data directory
  as the only writable one, and no direct network; the hosts in
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

## Contributions

Besides its tools, a package can add slash commands, schedules, event
handlers, a section of the agents' system prompt and per-turn context. Each
one is declared in the manifest and names one of the package's **own
declared tools**; the host is the only code that touches the command list,
the scheduler, the event bus and the prompt, and every call goes through the
same door as an agent's call to that tool (`mcp.plugin-<name>.<tool>`): its
declared [effect](#tool-effects), the permission rules, approvals, the
[protection level](PROTECTION-LEVELS.md#plugin-calls-c6d) and the circuit
breaker all apply. Nothing a contribution does waves a call through.

```json
{
  "commands": [{ "name": "balance", "tool": "list_accounts", "description": "Show balances", "input": { "account": "$args" } }],
  "schedules": [{ "id": "nightly-sync", "cron": "15 2 * * *", "tool": "sync", "input": { "full": false } }],
  "events": [{ "on": "document.completed", "tool": "classify_document" }],
  "prompt": { "file": "agent-notes.md", "roles": ["general"] },
  "context": { "tool": "account_summary", "roles": ["general"] }
}
```

Refused at install, with every reason at once: a contribution naming a tool
the package does not declare, a `context` tool that is not a `read`, a command
name or schedule id used twice, a cron expression that does not parse, an
event not on the list below, a prompt file that is not a `.md` file inside the
package (no `..`, no link out of it, at most 8,000 characters of UTF-8), and a
command name that Octipus, an extension or another installed package already
uses.

### Approving contributions

Contributions reach every user of the install: prompt text in every user's
agents, every user's messages sent to a context tool, every user's events,
schedules running as an admin, commands anyone can type. So they are
approved on their own, for exactly what was reviewed:

- The **contributions hash** (`contributions.hash` in the view,
  `sha256:<hex>`) covers the canonical JSON of the manifest's `commands`,
  `schedules`, `events`, `prompt` and `context` (keys sorted, empty lists
  left out) and the prompt file's bytes.
- Enabling a package that has any contributions needs
  `approveContributions: "<that hash>"` (in the same PATCH as `enabled`, or
  before it); without it, or with another hash, it is refused (409, the body
  carrying `contributionsHash`). The approval is recorded
  (`approved_contributions_hash`) and audited (`contributions_approved`).
- **Install and every upgrade clear it**, and approving changed content
  whose contributions hash differs clears it too (audited as
  `contributions_approval_cleared`); the package must be approved again
  before it is enabled.
- Contributions bind only while the approved hash is the current one, read
  from the files at bind time; the prompt text bound is the text hashed.
- On the web page each package's row lists everything it contributes: each
  command, schedule (cron, UTC) and event with its tool and effect and whom it
  runs as, the context tool, and the full prompt text. Enabling shows all of
  it again and approves it ("Approve and enable"). From the command line:
  `octi plugin approve-contributions <name>` shows the same and asks, or
  takes `--hash`.

**Bound while enabled, without a restart.** Every contribution is registered
with a disposer when the package is enabled and approved, and disposed (in reverse
registration order) when it is disabled, upgraded (an upgrade leaves it
disabled) or uninstalled; re-enabling binds it again. A contribution that
cannot bind at that moment (a command name an extension took since install,
files that no longer hash to the approved content) is left out and its reason
listed; the rest bind, and the next change tries again. The package view
(`GET /api/plugin-packages`, `contributions`) lists what each package adds,
whether each part is bound now, the last run of each schedule, event and
context tool (`lastRun`: when, whether it worked, why not), and the
`problems`.

### Slash commands

`commands: [{ name, tool, description, input? }]`. `/name args` calls the
tool **as the user who typed it**, without a model turn, and answers with the
tool's text (cut to 8,000 characters). It works on every surface that takes
slash commands (web chat, the TUI, channels), as `/name` and as
`/<package>:name`. `input` is the tool's arguments; a string value `"$args"`
(anywhere in it) is replaced by the text after the command. Without `input`
the tool gets `{ "text": "<args>" }`.

The call is the user's: their permission rules apply, a `write` tool asks
them where the client can show an approval (web, TUI, messaging apps) and is
refused where it cannot (the REST API), and an `external` one always asks.

Names are lower-case `a-z0-9-` (at most 32 characters). A package may not
take a name Octipus or an extension uses (`/help`, `/status`, …), another
installed package's command, or `/cancel`.

### Schedules

`schedules: [{ id, cron, tool, input? }]`. The cron runner calls the tool
with `input` (or `{}`) at every minute the expression matches. Cron is five
fields in **UTC** (minute, hour, day of month, month, day of week; `*`,
numbers, ranges `1-5`, steps `*/15`, lists `1,15`; Sunday is 0 or 7).

- **Who it runs as:** the install — the admin who installed or last upgraded
  the package — **unattended**. A `read` tool runs. A `write` tool is ASK by
  default and, with nobody to ask, refused, until that admin gives it an ALLOW
  rule (`mcp`, `plugin-<name>.<tool>`). An `external` tool is always refused:
  the same policy as every unattended run, no bypass. When the installer's
  account is gone or no longer an active admin, the schedule does not run
  (its `lastRun` says so): reinstall or upgrade the package as an admin.
- **Once:** every instance runs the loop, and each minute of a schedule is
  claimed in the shared store before it runs. A tick that comes late fires the
  minutes it missed, up to five back.
- **Bounded:** at most four schedule calls of all packages run at once, and a
  schedule whose previous call is still running skips its turn. A failure (an
  error, a refusal, a tool reporting an error) is logged and recorded as the
  schedule's `lastRun`.

### Events

`events: [{ on, tool }]`, with `on` one of these gateway events. The tool gets
`{ "event": {...} }` with **ids only**, never a reply, a file's contents or an
error text:

| `on` | When | `event` |
|---|---|---|
| `chat.response` | A root turn answered | `type`, `at`, `userId`, `sessionId` |
| `document.completed` | An uploaded document was processed | `type`, `at`, `userId`, `documentId` |
| `document.failed` | Processing an uploaded document failed | `type`, `at`, `userId`, `documentId` |

The call runs **as the user the event belongs to, unattended** (a `write` tool
only under that user's ALLOW rule, an `external` one never). An event of a
session whose content is above the package's `maxProtection` is not
delivered. Delivery is asynchronous, after the event: at most 60 events a
minute and 4 at once per package, the rest dropped (and the drop recorded); a
failing tool never reaches the publisher or another package.

### Prompt sections

`prompt: { file, roles? }`. The file's markdown is added to the system prompt
of agents of the named roles (every role when `roles` is left out) while the
package is enabled, ordered by package name. It is read only from files that
still hash to the approved content and whose contributions hash was approved,
so it is exactly what the admin reviewed ([Content pinning](#content-pinning),
[Approving contributions](#approving-contributions)).

Each section is fenced: a `<plugin-prompt plugin="<name>">` block that says it
is third-party text from that package, approved by an administrator, which
cannot override the system or operator instructions, change the agent's role
or rules, or grant a permission; angle brackets in the text are replaced so it
cannot close the fence. **The fence is advice to the model, not a boundary**:
the text is still in the system prompt of every agent of every user and the
model reads it. Approve a prompt section only from a publisher you would let
write instructions to your agents, and read the whole text first (it is at
most 8,000 characters).

It is static and the same for every user, so the root agent carries it in
the **install tier** of its prompt, after the role prompt and the delegation
text: the cached prefix every user's sessions share
([DIRECT-PROVIDERS.md](DIRECT-PROVIDERS.md)) stays shared; enabling or
disabling a package changes it once for everybody. Workers carry it in their
static base.

### Context

`context: { tool, roles? }`. Before every root turn and every worker of the
named roles (all when left out), the tool is called with
`{ "query": <the message or the worker's brief>, "role": <role> }`, and its
text rides the **turn tier** of the system prompt, beside the
[context hooks](CONTEXT-HOOKS.md)' blocks, as
`<plugin-context plugin="<name>">` with angle brackets replaced so it cannot
close the fence.

- The tool must be a `read`. It runs as the user, unattended (a rule that
  makes it ASK refuses it), and the session's protection level applies.
- It does not run where other people read the reply (a group thread, a room),
  where the session's text may not be copied, or in a space.
- It has 3 seconds and 4,000 characters; a failure or a timeout costs the
  turn the block, never the turn, and is recorded as the context's `lastRun`.

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
the hash — but not directory order, timestamps or permissions. The one file
left out is the signature, `octipus-plugin.sig` in the package root, since it
signs this hash; it is pinned on its own instead ([Signed packages](#signed-packages)). A symbolic link
(refused at install) counts by its target. Nothing is left out — not even
`node_modules/.cache`: a cache a build tool writes on its own is still a place
running code could stage executable content in. Only paths relative to the
package root enter the listing, so the copy hashed at install hashes the same
as the installed directory.

Install and upgrade copy the package into a staging directory beside the
installed one and hash **the copy**, and check its signature, before they touch
anything installed; only then is an upgraded package disabled. The row (new
manifest, version and hash) is written in the same transaction that swaps the
files in. A refused or failed upgrade leaves the old files and the old row
together, and a package that was enabled is enabled (and running) again.

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
not match is refused as well, naming both hashes (the `409` body carries
`actualHash`). A **disabled** package is not started, so its view checks
instead: once it has a recorded hash, every view hashes its files and shows the
same problem and `actualHash` on a mismatch, so its content can be reviewed and
approved before enabling it. A server already running keeps running until its
next start.

To accept the new content, review the files that hash to `actualHash` and
approve **that hash** — on the web page (Admin → Plugin packages shows the
recorded and the actual hash, and "Approve this content" sends the hash shown),
with `octi plugin approve <name> --hash sha256:<actualHash>`, or through the API:

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

## Signed packages

A publisher can sign a package, and a host can trust the publisher's key. The
signature covers the content hash above, so it covers every file of the
package, its name and its version.

```
octi plugin keygen ./acme                       # writes acme.key (private) and acme.pub
octi plugin sign ./my-package --key ./acme.key  # writes my-package/octipus-plugin.sig
```

`octipus-plugin.sig` is JSON, in exactly the form `octi plugin sign` writes
(these three keys in this order, two-space indented, a trailing newline):

```json
{
  "alg": "ed25519",
  "keyId": "ed25519:<sha256 hex of the raw public key>",
  "signature": "<base64 of the 64-byte signature>"
}
```

The signature is Ed25519 (no new dependency: `node:crypto`) over the bytes
`octipus-plugin-signature/v1\n<content hash>`, the `sha256:<hex>` string
behind a fixed prefix, so a signature made for this cannot pass as one over
anything else the key signs. The signature file is the one file the content
hash leaves out, so signing does not change the hash. Sign last: any change to
the files after signing, the manifest included, invalidates the signature.
Keep the `.key` file secret (it is written `0600`); `keygen` never overwrites a
file. `sign` refuses a package with a symbolic link or special file anywhere
in it (as install does) and writes the signature through a temporary file and
a rename, never through a link. The temporary file is made in the package's
parent directory, so a `sign` that dies half-way leaves nothing in the package.

Because the signature file is outside the content hash, it is held on its own,
whatever `requireSignature` says:

- **Canonical form only.** Anything else — another key, another order or
  spacing, more than 1 KiB, a key id or signature of the wrong shape, a link
  or a directory in its place — is refused at install, at approval, at
  enabling and at every start (audit op `signature_file_refused`). The file
  has no room for content a package could run.
- **Pinned.** The sha256 of its bytes (`plugin_packages.signature_hash`;
  null when there is none) is recorded with the content hash at install,
  upgrade, approval and a first-use pin, and compared before every start. A
  signature file that appeared, disappeared or changed refuses the start like
  a content mismatch (problem *"octipus-plugin.sig changed since the content
  was approved"*, audit op `signature_file_mismatch` once per pair of hashes,
  enabling refused); approving the content records the new one.
- **Not a server entry.** A manifest whose `server.command` or `server.args`
  names `octipus-plugin.sig` is refused.

The host trusts the keys in `plugins.trustedPublishers` (Settings, or the
config file):

```json
"plugins": {
  "trustedPublishers": [
    { "name": "Acme GmbH", "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----", "notAfter": "2027-12-31" },
    { "name": "Acme GmbH (2025 key)", "publicKey": "…", "revoked": true }
  ],
  "revokedKeys": ["ed25519:<64 hex>"],
  "requireSignature": false
}
```

`publicKey` is the PEM from `keygen` (`acme.pub`), or base64 of the raw 32-byte
key or of its DER SPKI. An entry whose key cannot be read is logged and trusts
nothing.

A key stops being trusted three ways, each a config change that applies to the
next check (no restart):

- **`revoked: true`** on its entry: the key was withdrawn (leaked, replaced).
  The entry stays, so a package signed by it is shown as *signed by a revoked
  key* of that publisher rather than by an unknown one.
- **`revokedKeys`**: key ids (`ed25519:<64 hex>`, what `keygen` prints and
  `octipus-plugin.sig` names), revoked whether or not an entry lists them —
  for a key you never trusted but want named as revoked, or to revoke without
  touching the publisher list. A key listed twice is revoked if any listing
  revokes it.
- **`notAfter`**: an ISO date (`2027-12-31`, read as the start of that day,
  UTC) or date-time with a zone (`2027-12-31T18:00:00+01:00`). After it the key
  trusts nothing. A signature carries no time of signing, so expiry ends the
  key's trust for **everything** it signed, not only for later signatures:
  re-sign with the new key before the old one expires.

**Install and upgrade** check the signature on the staging copy, against the
hash recorded for it:

| Signature | `requireSignature` off (default) | `requireSignature` on |
| --- | --- | --- |
| valid, by a trusted key | installed; `signedBy` names the publisher | installed; `signedBy` names the publisher |
| invalid (malformed, or does not match the files) | refused (`400`) | refused (`400`) |
| by a key not in `trustedPublishers` | installed as unsigned, with a warning in the response (`warnings`) | refused (`400`) |
| by a revoked key | refused (`400`) | refused (`400`) |
| by an expired key | installed as unsigned, with a warning | refused (`400`) |
| none | installed as unsigned | refused (`400`) |

A [remote install](#remote-install) accepts only the first row, whatever
`requireSignature` says.

A refused upgrade leaves the old files and row as they were, enabled if they
were. An upgrade must also keep its publisher and not go back:

- **Same signer.** When the installed version is signed by a trusted
  publisher, an upgrade signed by another key (or not signed by a trusted
  one) is refused (`409`) unless the request says `"allowSignerChange": true`;
  the `upgraded` audit row then records `signerChange` (both publishers and
  key ids). Re-signing with a rotated key is such a change.
- **Not older.** A version lower than the installed one (semantic version
  order, a pre-release before its release) is refused (`409`) unless
  `"allowDowngrade": true`; the audit row records `downgrade: true`.

The publisher who signed is recorded on the row
(`plugin_packages.signed_by`, and in the `installed`/`upgraded` audit rows,
with the key id).

`signedBy` and `signature` in the package view are **recomputed for every
view**: the signature over the recorded content hash, checked against the keys
trusted now, in the signature file that was approved with it (one small file
read and one verification; the package is not re-hashed). `signature` is
`{ status, keyId, publisher, detail }` with `status` one of `valid`,
`unsigned`, `unknown_key`, `revoked`, `expired`, `invalid` or `changed` (not
the signature file approved with the content); `signedBy` is the publisher
when it is `valid`, else `null`. A key removed, revoked or expired, or a
replaced signature file, shows at once; the row's `signed_by` keeps what held
at install or approval.

**Every start** checks the content hash as before. A package signed by a
**revoked** key does not start, whatever `requireSignature` says (audit op
`signature_revoked`, once per package and key), and enabling it or approving
its content is refused: remove the signature file and approve the content as
unsigned, or have it signed again with a trusted key. With `requireSignature`
on, the files must also carry a valid signature by a key trusted **now**: a
package with none, or whose key was removed from the config or expired, does
not start (the problem says why; audit op `signature_refused`, once per
package, hash and reason), and enabling it is refused. With `requireSignature`
off, an expired, unknown or removed key is advice: the package keeps running
and its view shows the state. The signature file is checked as described above
in every case.

**Approving changed content** (`approveContent`) records who signed the new
content: `signedBy` becomes the publisher if a valid trusted signature covers
it, and is cleared otherwise. An admin's approval makes the content the admin's,
not the publisher's (a signature left from before the change no longer matches
and reads as invalid). If the publisher signs the new content, approving it
records them again. With `requireSignature` on, approving content without a
valid trusted signature is refused (`409`).

**Rotating a key** is a config change:

1. The publisher makes a new key (`octi plugin keygen`) and publishes its
   `.pub`.
2. Add it to `trustedPublishers` as its own entry, beside the old one.
3. The publisher re-signs the packages with the new key; upgrade them (from a
   directory, a URL or a registry).
4. Retire the old key: give its entry a `notAfter` for a planned rotation, or
   `revoked: true` at once for a leaked key (or list its key id in
   `revokedKeys`). Keep the entry rather than deleting it, so the view names
   the packages still signed by it as revoked or expired instead of unknown.

A package still signed by a revoked key stops at its next start. One signed by
an expired or removed key stops too with `requireSignature` on; with it off, it
keeps running and its view shows the state (`signedBy: null`). Upgrading to
the re-signed version is a change of signer: pass `allowSignerChange`.

What a signature guarantees: the files are byte for byte what the holder of
that key signed, under that name and version. What it does not:

- that the code is safe or does what it says — it runs with the same limits
  as an unsigned package (sandbox, network, declared tools and effects), and
  an admin still reads what it declares before enabling it;
- that the key is still in the publisher's hands — a leaked key signs
  anything until it is revoked or expires here; nothing tells a host a key
  was revoked (no online revocation list): each host's config has to say so;
- anything about where the package came from: a URL or registry only says
  where the bytes were fetched; the signature says who made them.

## Remote install

```
POST /api/plugin-packages { "url": "https://plugins.example.com/finapi-1.2.0.tar.gz", "sha256": "sha256:<hex>" }
```

Admins only, like a directory install. The tarball (`.tar.gz`) is:

1. **Fetched** over https through the SSRF guard every fetch of a
   user-supplied URL uses (`fetchGuarded`): the host is resolved and every
   address checked against private, loopback, link-local and other reserved
   ranges, and the connection is pinned to the checked address. Redirects
   are followed by hand, at most three, each https and checked again. A URL
   with credentials in it is refused. At most 50 MB is read, and the
   download times out after a minute.
2. **Checked** against `sha256` when given (with or without the `sha256:`
   prefix; a registry install always gives the index's), before anything is
   unpacked. A mismatch is refused (`400`).
3. **Unpacked** into a fresh directory under
   `<workspace.rootPath>/plugin-downloads` by a minimal tar reader (POSIX
   ustar, with pax and GNU long names) that takes regular files and
   directories only. The whole archive is refused on a symbolic or hard link,
   a device, a FIFO, any other entry type, a pax `linkpath`, an absolute path,
   a drive letter, a backslash, a `..` segment, a NUL, a path given twice, or
   a file where a directory is. Files are written new (never through anything
   already there) with mode 0644, or 0755 when the archive marks them
   executable. The unpacked size and file count have the limits of a
   directory install (200 MB, 20,000 files), and the gunzip output is capped
   before anything is read, so a compression bomb stops early. The package is
   the archive root when `octipus-plugin.json` is there, or its single
   top-level directory (`package/` from `npm pack`, `<name>-<version>/` from
   `tar`).
4. **Installed** like a directory (staging copy, content hash, signature,
   swap), except that it **must carry a valid signature by a trusted
   publisher**, whatever `requireSignature` says: unsigned, unknown, expired,
   revoked or invalid is refused (`400`), and nothing is left behind. The
   `installed`/`upgraded` audit row records the URL as `source`.

`"upgrade": true` replaces an installed package, as from a directory. The
download directory is removed whether the install succeeds or not.

## Registries

A registry is an https URL serving a JSON index:

```json
{
  "packages": [
    {
      "name": "finapi",
      "version": "1.2.0",
      "description": "Reads balances and transactions of connected bank accounts.",
      "url": "https://plugins.example.com/finapi-1.2.0.tar.gz",
      "sha256": "<64 hex, the sha256 of the tarball>"
    }
  ]
}
```

A host lists the registries it reads in the config:

```json
"plugins": { "registries": [{ "name": "Acme", "url": "https://plugins.example.com/index.json" }] }
```

`GET /api/plugin-packages/registry` (admins) fetches every index the same way
as a tarball (https, the SSRF guard, at most 1 MB), keeps each for a minute,
and answers `{ packages: [{ registry, name, version, description, url,
sha256, installedVersion }], errors: [{ registry, error }] }`. An entry with a
bad name or version, a non-https URL or no sha256 is skipped (and logged); a
registry that cannot be read is listed in `errors` while the others still
show. Admin → Plugin packages → **Browse** lists them; Install (or Upgrade,
for an installed package) is a remote install with the entry's `url`,
`sha256`, `name` and `version`: a tarball whose manifest names another package
or version than the entry is refused (`400`), so an entry cannot install
something other than what it lists. `name` and `version` may be sent with any
install (`POST /api/plugin-packages`) to the same effect.

A registry is trusted only to point at tarballs: what installs is decided by
the package's own signature against `trustedPublishers`. A registry can offer
a package you do not trust; it cannot make you install one. A signed index
(below) additionally says who wrote the list.

### Signed registry indexes

A registry entry may name the publisher whose signature its index must carry:

```json
"plugins": {
  "trustedPublishers": [{ "name": "Acme", "publicKey": "-----BEGIN PUBLIC KEY-----..." }],
  "registries": [{ "name": "Acme", "url": "https://plugins.example.com/index.json", "publisher": "Acme" }]
}
```

The publisher signs the index file with the key it signs packages with:

```
octi plugin sign-index ./index.json --key ./acme.key   # writes ./index.json.sig
```

and serves `index.json.sig` beside the index: `.sig` is appended to the
URL's path and its query kept (`…/index.json?channel=stable` →
`…/index.json.sig?channel=stable`); a registry URL with a fragment (`#…`) is
refused when it names a publisher. The signature file
has the canonical form of `octipus-plugin.sig` ([Signed
packages](#signed-packages)): `{ alg, keyId, signature }`, Ed25519. The signed
message is `octipus-registry-index/v1\n` followed by `sha256:<hex>` of the
**exact index bytes** served — not of a re-serialised JSON, so publish the
signed file unchanged — behind its own prefix, so a package signature can
never pass for an index signature, nor the other way round.

When `publisher` is set, the index is listed only if `<url>.sig` verifies over
the bytes fetched with a key of **that** publisher in `trustedPublishers` that
is neither revoked (`revoked`, `revokedKeys`) nor expired (`notAfter`).
Otherwise the registry is reported in `errors` and none of its packages show:
no `.sig` (404), a signature by another publisher's key (even a trusted one),
a changed index, or a revoked or expired key. A revocation or expiry counts
whichever `trustedPublishers` entry (or `revokedKeys`) files it, as for
packages. The trust config is part of the index cache key, so revoking a key
refuses its indexes on the next listing. Without `publisher`, an index is
listed unsigned, as before. Either way, installing from it still requires the
package's own trusted signature.

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
| macOS, sandbox `auto`/`required`, `/usr/bin/sandbox-exec` present | Enforced: the server runs under a generated Seatbelt profile that denies all network except outbound TCP to the proxy's own port on `localhost`, and the proxy variables point at that port. Anything else — another host, another local port, a Unix socket, DNS — is refused by the kernel. | Offline: the profile allows no network at all. | `restricted` / `offline` |
| Linux or macOS with the sandbox `off` (the default), or no runner found | **Not enforced.** The proxy variables point well-behaved HTTP clients at the proxy, but a direct connection still works. | Not enforced: nothing blocks the network. | `not_enforced` |
| Windows | **Not enforced**, as above: Windows has no built-in runner comparable to bwrap or Seatbelt (AppContainer and job-object network limits need a native helper Octipus does not ship). | Not enforced. | `not_enforced` |

`GET /api/plugin-packages` reports this per package as `network`
(`{ state, detail }`), so an operator sees "Network not enforced on this
platform" where the hosts are only advice. A client that ignores proxy
variables (some SDKs, raw sockets) fails under the sandbox and goes direct
without it — run packages with `security.shellSandbox` on where that matters.

Under `security.shellSandbox: required`, a package that declares hosts where
no runner can enforce them (Windows; Linux or macOS with no runner found) is
**not started**: its server fails to connect with "the network of plugin
package … cannot be enforced on this platform". Under `auto` it starts with
the advisory proxy, as in the table. The status reads `refused` then, for a
package with or without hosts.

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
socket directory by its own path, and both set `TMPDIR=/tmp` (the private one).

bwrap needs unprivileged user namespaces. Hosts that restrict them through
AppArmor — Ubuntu 23.10 and later, 24.04 included, with
`kernel.apparmor_restrict_unprivileged_userns=1` — need an AppArmor profile
for `/usr/bin/bwrap` that allows `userns`, or that sysctl set to `0`; otherwise
bwrap cannot start and the server fails to launch (see
[MULTI-USER.md](architecture/MULTI-USER.md#operator-runbook)). firejail is
setuid and not affected. `src/security/shell-sandbox.linux.e2e.test.ts` checks
both runners for real; CI runs it on Ubuntu.

### macOS: sandbox-exec

On macOS the sandbox is `/usr/bin/sandbox-exec` with a Seatbelt (SBPL)
profile written for each start (`buildSeatbeltProfile` in
`src/security/shell-sandbox.ts`). Package servers use it under both `auto`
and `required`. The shell tool uses it only under `required` (where it would
otherwise refuse to run); under `auto`, shell commands on macOS keep running
unwrapped as before. The profile starts from `(deny default)` and allows back
only:

- **Files:** metadata (names, sizes, times) anywhere, because path resolution
  stats every parent directory; contents only under the system and runtime
  directories (`/System`, `/bin`, `/sbin`, `/usr/{bin,sbin,lib,libexec,share}`,
  `/private/etc`, `/private/var/db/timezone`, the Command Line Tools, the
  user-level runtime directories the Linux sandbox also exposes, and Octipus's
  own Node binary), the package directory and the writable ones.
  Under the Homebrew and MacPorts prefixes (`/opt/homebrew`, `/usr/local`,
  `/opt/local`) only the program directories are readable (`bin`, `sbin`,
  `lib`, `libexec`, `share`, `opt`, `Cellar`, `Frameworks`); their `var`
  (Postgres, MySQL, Redis data — possibly Octipus's own database) and `etc`
  (service configs) are denied explicitly, except the public CA bundles
  (`etc/ca-certificates`, `etc/openssl@3/cert.pem` and `certs`).
  The package directory is read-only: an explicit `deny file-write*` for it,
  followed by the allow for the writable paths (the last matching rule wins),
  so a writable directory inside it would stay writable, as with bwrap.
  Writable: the data directory and a per-start scratch directory, which is
  the server's `TMPDIR` (there is no private `/tmp` to mount over). The rest
  of the home directory is unreadable.
- **Network:** nothing without hosts. With hosts, outbound TCP to
  `localhost:<proxy port>` only. Unlike Linux, there is no network namespace,
  so the Unix-socket bridge is not used: its "loopback" would be the host's,
  and the profile would have to allow loopback broadly for the bridge's own
  port, which would let the server reach any local service. Allowing exactly
  the proxy's port is narrower. DNS stays off too: the proxy resolves names.
- **Processes:** exec, fork and signals within the sandbox, sysctl reads,
  and a short list of system services (directory services, logging,
  notifications, preferences). Preferences are readable only in the global
  domain (`kCFPreferencesAnyApplication`: locale and similar settings), not
  other apps' domains, which can hold tokens. Node does not read preferences
  itself; no other domain is known to be needed, so none is listed.

Apple marks `sandbox-exec` as deprecated, but it ships with every current
macOS release and is used by the system and by other developer tools. If a
future release removes it, detection finds nothing: `auto` then runs
unwrapped (`not_enforced`) and `required` refuses to start the server.

## Pages

A package can add pages to the web app: static HTML of its own, shown in a
sandboxed frame, that talks to the host only through a `postMessage` bridge
calling the package's **own tools** as the signed-in user.

```json
"ui": {
  "dir": "ui",
  "pages": [{ "path": "dashboard", "title": "Bank dashboard", "icon": "layout-dashboard", "entry": "index.html" }]
}
```

| Field | Meaning |
|---|---|
| `dir` | The directory whose files are served, relative to the package root; default `ui`. Its scripts, styles, images and fonts sit alongside the entry. |
| `pages[].path` | The page's route under `/plugins/<name>/`: lower-case `a-z0-9-` segments, up to four. |
| `pages[].title` | Sidebar label and page title. |
| `pages[].icon` | A lucide icon name (`layout-dashboard`, `list-todo`, `database`, …); an unknown one shows a puzzle piece. |
| `pages[].entry` | The `.html` file, relative to `dir`. |

Every path is a plain relative path — no `..`, no absolute path, no hidden
segment, no backslash — or the manifest is refused at install. At most 20 pages.

**What the host serves.** `GET /api/plugin-ui/<name>/<file>` serves a file of
the package's UI directory, and only:

- while the package is **enabled** and its files still hash to the approved
  content hash ([Content pinning](#content-pinning); re-hashed at most once a
  minute, and refused at once while the server reports a mismatch);
- from inside `dir`: the real path of the file must be the same path under
  the real UI directory, so no symbolic link (refused at install anyway) leads
  anywhere else;
- with a known static type (`.html`, `.css`, `.js`, `.mjs`, `.json`, `.map`,
  `.txt`, `.svg`, `.png`, `.jpg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`;
  anything else is a 404), `X-Content-Type-Options: nosniff`, at most 5 MB;
- only where it belongs, by `Sec-Fetch-Dest`: the HTML entry only into a frame
  (`iframe`; opened as a top-level `document`, an `object` or anything else it
  is a 404), scripts as `script`, styles as `style`, images as `image`, fonts as
  `font`. Browsers send `Sec-Fetch-*` only to https and localhost: there a
  request without it is refused; on plain http to another address (a LAN
  install), where no browser sends it, its absence is accepted and the CSP
  below still sandboxes the document;
- under this CSP, `<base>` being the configured public URL (`oauth.publicUrl` /
  `PUBLIC_URL`) plus `/api/plugin-ui/<name>/` — or, without one, the address
  the request came in on (`X-Forwarded-Host` / `-Proto` only from a proxy in
  `security.trustedProxies`). With a public URL set, pages work only when the
  app is opened at that URL:

  ```
  default-src 'none'; script-src <base>; style-src <base>; img-src <base> data:;
  font-src <base>; media-src <base>; connect-src 'none'; frame-src 'none';
  worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';
  frame-ancestors 'self'; sandbox allow-scripts
  ```

  No inline script, no `eval`, no `fetch` or WebSocket, no form, no frame, and
  `sandbox allow-scripts` without `allow-same-origin`: the document has an
  opaque origin even when opened directly, so it cannot read the app's
  cookies, storage or DOM. Only the app itself may frame it.

The files are static and the same for everyone, so they are served without a
sign-in (a sandboxed frame's requests carry no cookie). **Put no data or
secret in them**: whatever a page shows comes through the bridge.

**In the web app.** Each enabled package's pages are listed by `GET
/api/plugin-ui` (signed in) and appear in the sidebar under *Plugins*; disabling
the package removes them. `/plugins/<name>/<path>` shows the page in an
`<iframe sandbox="allow-scripts">`.

**The bridge** is a `MessagePort`, never a broadcast. The app loads the frame
at the entry's URL (built only from the server's page listing, each path
segment checked and encoded) with a fragment:

```
/api/plugin-ui/<name>/<entry>#octipus=<nonce>&parent=<the app's origin, URL-encoded>
```

A fragment never goes over the network, and a document the frame navigates to
does not get it. The page opens a `MessageChannel` and hands one end to its
parent, to that exact origin (never `'*'`); from then on it talks only over its
own end:

```js
const params = new URLSearchParams(location.hash.slice(1));
const channel = new MessageChannel();
const waiting = new Map();   // id (a number) → resolve
channel.port1.onmessage = (e) => {
  // { octipus: 'result', id: 1, ok: true, result }          — the MCP tool result
  // { octipus: 'result', id: 1, ok: false, error, code }    — refused or failed
  const resolve = typeof e.data?.id === 'number' ? waiting.get(e.data.id) : undefined;
  if (resolve) { waiting.delete(e.data.id); resolve(e.data); }
};
parent.postMessage({ octipus: 'ready', nonce: params.get('octipus') }, params.get('parent'), [channel.port2]);
// a call:
waiting.set(1, (reply) => { /* … */ });
channel.port1.postMessage({ octipus: 'call', id: 1, tool: 'list_accounts', args: {} });
```

The app takes the **first** `ready` that comes from its own frame (its window,
with the opaque origin `"null"`), carries the nonce it chose and transfers
exactly one port, and ignores every later `ready`. It never posts to the
frame's window: everything goes over that port, the capability the page holds.
Calls must have exactly this shape (`id` a short string or a number, `tool` a
tool name, `args` a plain object under 100 kB; any other key refuses it); at
most 4 are in flight and 10 a second. It then calls

```
POST /api/plugins/<name>/call/<tool>   { "args": {...}, "confirm"?: true }
```

as the signed-in user, always with the page's own package name: a page cannot
address another package's tools. The server refuses a tool the manifest does
not declare (`404 unknown_tool`), a package that is disabled or has no pages
(`404`), and more than 20 calls in a burst per user and package (`429`). The
call takes **the same path as an agent's**: the tool's declared effect, the
user's permission rules, the protection level, the audit
(`resource_type = tool`).

**Write and external effects.** A request has no approval channel, so a call the
rules would ask about (`write` by default, `external` always) is refused with
`409 approval_required` and the tool's effect. The web app then shows the user
its own dialog — outside the page's frame, naming the package, the tool, its
effect and the arguments — and only on *Allow once* repeats the call with
`confirm: true`, which counts as the approval of that one call (audited as
`resource_type = plugin_page`, op `call_confirmed`). *Refuse* answers the page
`denied_by_user`. A DENY rule is never overridden. The page itself cannot set
`confirm`: it only names a tool and its arguments.

**Navigation.** A page can navigate its own frame (a link, `location =`, a
meta refresh). The port lives in the page's document, so a navigation destroys
it: nothing sent afterwards reaches anyone, and a document navigated to has no
fragment, so no nonce and no port (even if it navigated while still parsing,
before any `load` was seen). The app also counts the frame's `load` events: on
any after the first, it closes the port for good, empties the frame
(`about:blank`) and tells the user the page navigated away.

**Treat a page as able to leak.** What a page is shown, it can put into the
URL of a navigation, which leaves before the app sees the next load (the CSP
blocks every other way out: fetch, forms, images and scripts elsewhere). A package's tools
already see what they return, so this is a leak to the package's author, not
a widening of what the package can read. That is why a package with `ui` and
no declared `maxProtection` counts as leaving the house (1), like one with
`network` hosts; declare a higher `maxProtection` only for a publisher you
trust with that data. (Serving pages from a separate origin is not
implemented: the sandbox already gives them an opaque origin.)

## Host API

A package can act in Octipus for the user who called it — read their notes,
create a task — through a narrow host API, limited to the scopes it declares
and an admin approved:

```json
"host": ["notes:read", "tasks:write", "notify"]
```

| Scope | Endpoint | What |
|---|---|---|
| — | `GET /api/plugin-host/whoami` | The token's package, tool, scopes, workspace kind and expiry. |
| `notes:read` | `GET /api/plugin-host/notes?limit=&tag=` | The user's notes in the call's workspace (at most 100), bodies included. |
| `notes:write` | `POST /api/plugin-host/notes { title, body?, tags? }` | Creates a note; never overwrites (`409 exists` for a taken title). |
| `tasks:read` | `GET /api/plugin-host/tasks?status=` | The user's own tasks (at most 200). A task carries the protection level and flow label of the conversation it came from (its provenance): one above the package's `maxProtection` is left out (`withheld` counts them), and the rest raise the calling session's level and label, as the tasks tool does. |
| `tasks:write` | `POST /api/plugin-host/tasks { title, notes?, priority?, dueAt?, category?, link?: { url, label? } }` | Creates a task for the user (audited as a task mutation by `plugin:<name>`), filed under `category` and linked back to `link.url` (an http(s) URL). |
| `documents:read` | `GET /api/plugin-host/documents/:id` | One document: metadata and extracted text. |
| `notify` | `POST /api/plugin-host/notify { title, body? }` | A notification to the calling user, and to nobody else. |
| `web:read` | `POST /api/plugin-host/web/read { url }` | One public web page, fetched by the host and turned into a clean article: `{ url, title, byline?, siteName?, publishedAt?, contentHtml, textContent, wordCount, estReadMinutes, truncated }`. |
| `model:complete` | `POST /api/plugin-host/model/complete { system?, prompt, maxTokens?, temperature? }` | One text completion on the calling user's `everyday` model: `{ output, model }`. |

**`web:read`** lets a package read any public page without network of its
own: the host fetches it through the same SSRF guard as the agents' web
fetch (`fetchGuarded`: public addresses only, the IP pinned for the connect,
each redirect checked again), at most 5 MB and 15 s, HTML only, and hands
back only the cleaned article (allowlist HTML with no script, style or event
handler, and plain text), the text cut at 100,000 characters (cleaned HTML
over 400,000 characters is left out; `truncated` says so). A refused URL or
failed fetch is `422 fetch_failed`. A user whose rules deny the web tool's
fetch (`websearch` `fetch`) does not get the scope. A URL can carry data out
like any request, so a package with `web:read` and no `maxProtection` may see
level 1 only, as one with `network` hosts.

**`model:complete`** runs one completion, with no tools and no history, on
the model the calling user's `everyday` lane resolves to (their own binding
first, then the install's): `409 no_model` when none is bound. The system
text is at most 4,000 characters, the prompt 40,000, `maxTokens` at most
4,000 (default 1,200), `temperature` 0-1 (default 0.3). It costs what the
user's own model calls cost; the host API's rate limit (60 requests in a
burst per package and user) applies, and every call is audited.

`web:read` and `model:complete` change no data, so a `read` tool gets them;
`notes:write`, `tasks:write` and `notify` only go to `write` and `external`
tools.

**Approval.** Enabling a package that declares `host` needs every declared
scope approved: `PATCH /api/plugin-packages/:name { "enabled": true,
"approveHostScopes": [...] }` (Admin → Plugin packages shows the scopes and
asks when you enable). Only declared scopes can be approved. The approved set is
stored with the package (`approvedHostScopes`). **Every upgrade clears it**: a
new version's tools may have other effects (a tool that turned from `read` to
`write` would widen what its calls' tokens carry), so it cannot be enabled
until its scopes are approved again. Disabling, upgrading, uninstalling or
changing the approval revokes every token in flight.

**Which calls get a token.** Only a call a user started themselves:

- a tool call of the user's own agent, in their conversation (`trigger` `user`, a session);
- a slash command they typed (a `commands` contribution);
- a call from the package's page, by the signed-in user.

Never a call from a schedule, an event or the turn-start context (they run
for users who did not ask, or as the installing admin), nor a heartbeat,
cron, room, remote or listen turn, nor a contribution kind the host does not
know: those calls carry no `_meta["octipus/host"]`.

**The token.** With every `tools/call` to such a package the host sends, in the
request's own metadata (it works over stdio, where a per-call environment
variable cannot):

```json
"_meta": { "octipus/host": {
  "url": "http://octipus-host.internal",
  "token": "ocph_…",
  "expiresAt": "2026-11-10T10:00:35.000Z",
  "scopes": ["notes:read"]
} }
```

The token is minted for that call and revoked when it returns; it expires with
the call's timeout, **at most 30 seconds** whatever `requestTimeoutMs` says, so
a token kept past its call cannot be used during another user's. It is bound to:

- **the package** — another package presenting it gets `401`;
- **the user who triggered the call** (the agent's user, or the signed-in user
  of a page) **and the workspace it ran in** (a space, or their own);
- **its scopes**: declared ∩ approved ∩ what the tool's effect allows (a
  `read` tool never gets `notes:write`, `tasks:write` or `notify`) ∩ what the
  user holds (the scope's module is on, and the user's own rules do not DENY
  the matching action of the `notes`, `tasks` or `documents` tool). A call
  left with no scope carries no token.

Tokens live in memory, as hashes, never outlive their call and are never
accepted by the rest of the API (they are neither session nor API tokens).
`OCTIPUS_HOST_URL` is set in the server's environment when it has host scopes.

**Reaching it.** The package calls `http://octipus-host.internal/api/plugin-host/…`
with `Authorization: Bearer <token>` **through its egress proxy** (`HTTP_PROXY`,
an absolute-form request; Node's `fetch` needs `NODE_USE_ENV_PROXY=1` or a
proxy agent). The proxy of a package with host scopes forwards that name, on
port 80, under `/api/plugin-host/` only, to the host's own API port on loopback
— never resolved through DNS, never another path (`%`, `..` and empty segments
are refused), port or loopback service, never through `CONNECT` — drops the
client's cookies, forwarding and Octipus headers, and stamps the package name
(`x-octipus-plugin-egress`) with the proxy's own secret
(`x-octipus-plugin-egress-key`: random, generated when the proxy starts, held
only in memory and dropped when it stops). The host API accepts a request
only with the secret of a live proxy of the package it names, so the stamp
cannot be forged by a client that reaches the API port directly. A package without approved scopes reaches nothing
by that name, even if it lists it in `network`. A package with only `host`
(and no `network`) still gets a proxy, so under the sandbox it is
`restricted`, not `offline`.

**What applies on the host.** Each request is checked against the token
(present, live, this package's, carrying the endpoint's scope), the user (still
active) and the workspace, re-resolved for the request: a space membership
removed or a role lowered meanwhile applies at once, and the space role's
rules (a viewer cannot write) apply as in the user's own agent. A document
above the package's `maxProtection` is refused (`403 protection_level`; an
unclear level counts as 4), and one that is read raises the calling session's
protection level. 60 requests in a burst per package and user, then `429`.
Every request with a valid stamp and token, allowed or refused, is one audit
row (`resource_type = plugin_host`, the op, the scope, the status, the tool).
A request refused before that (no or a forged stamp, no or a dead token) is
limited per client address (then `429`) and audited in aggregate: one row
(op `refused`, its `code`, `count`) per kind and package per minute, carrying
the refusals counted since the previous row.

## Bundled plugins

First-party plugins ship with Octipus as package directories under
`plugins/` in the checkout or install (the Docker image included). Each is an
ordinary plugin package; shipping with Octipus gives it no trust of its own:

- **Listed** on Admin → Plugin packages under *Bundled*, by `GET
  /api/plugin-packages/bundled` (name, version, title, description, the host
  scopes it asks for, the version installed here) and by `octi plugin bundled`.
- **Installed** with *Install* on that list, `POST /api/plugin-packages {
  "bundled": "<name>" }` (`"upgrade": true` for a newer bundled version) or
  `octi plugin install-bundled <name> [--upgrade]`: exactly an install from
  its directory, so it is copied, its content hash pinned, its signature
  checked, and it starts **disabled**. The audit row names the source
  (`bundled:<name>`).
- **Enabled** by an admin like any package, approving the host API scopes it
  asks for.

Not yet: bundled plugins are not signed with an Octipus publisher key, so
under `plugins.requireSignature` they are refused like any unsigned package.

| Plugin | What it does | Host scopes |
|---|---|---|
| `reader` | The reader ([MODULES.md](MODULES.md)): a page in a clean view, summarized, simplified, translated, its action items or an answer about it, saved as a note or as to-dos. Tools `read_url`, `reader_action` (read), `save_note`, `create_tasks` (write); the page *Reader* at `/plugins/reader/read`. | `web:read`, `model:complete`, `notes:write`, `tasks:write` |

## Installing and managing

Admins only, on the web page (Admin → Plugin packages, and Browse for the
registries), from the command line (`octi plugin list`, `octi plugin
approve`) or through the API. A package installs from a directory on the
server, signed or not ([Signed packages](#signed-packages)), or from an https
tarball, signed by a trusted publisher ([Remote install](#remote-install)).

1. **Install:** `POST /api/plugin-packages { "path": "/opt/plugins/finapi" }`,
   `{ "url": "https://…/finapi-1.2.0.tar.gz", "sha256": "…" }`, or `{ "bundled": "reader" }`
   for a plugin shipped with Octipus ([Bundled plugins](#bundled-plugins)).
   The directory is copied into the plugin directory (no symbolic links, at most
   200 MB and 20,000 files) and its signature checked. The package starts
   **disabled**, so its tools, effects, hosts and protection level can be read
   first. The response has `signedBy` and any `warnings`.
2. **Configure:** `PATCH /api/plugin-packages/:name { "settings": {...} }`, and
   `PUT /api/plugin-packages/:name/secrets/:key { "value": "..." }` for each
   secret (`null` removes it). Secret values are never returned. On the web
   page, **configure** on a package's row shows its settings as a form typed
   by the manifest's fields and each secret as set or not set, with a
   write-only field to set or replace it and Clear; or `octi plugin set` and
   `octi plugin secret` ([From the command line](#from-the-command-line)).
3. **Enable:** `PATCH /api/plugin-packages/:name { "enabled": true }`. Refused
   while a required setting or secret has no value; settings and `enabled` in
   one PATCH are saved together or not at all. A required secret of an enabled
   package cannot be removed; disable it first. A package with `host` scopes
   needs them approved too (`"approveHostScopes": [...]`, [Host API](#host-api));
   an upgrade clears that approval.
4. **Upgrade:** install again with `"upgrade": true` (`"allowSignerChange"`
   and `"allowDowngrade"` for another publisher or an older version, see
   [Signed packages](#signed-packages)). Once the new files are copied and
   checked, the package is disabled before any file is replaced and stays
   disabled until enabled again, since its tools may have changed. Each setting the new version still declares and
   accepts is kept; a new required setting must be set before enabling.
   The new files' hash replaces the old one.
5. **Approve changed content:** `PATCH /api/plugin-packages/:name
   { "approveContent": "sha256:<reviewed hash>" }` after a hash mismatch
   ([Content pinning](#content-pinning)), or "Approve this content" on the
   web page, or `octi plugin approve <name> [--hash sha256:<hex>]`. An
   in-process plugin also needs `{ "approveInProcess": "sha256:<contentHash>" }`
   before it can be enabled, and again after new content ([Runtimes](#runtimes)).
6. **Uninstall:** `DELETE /api/plugin-packages/:name` removes the server, the
   files, the data directory, the row and the secrets (**uninstall** on the
   web page, after a confirmation, or `octi plugin uninstall <name>`).

`GET /api/plugin-packages` lists installed packages with their manifest,
settings, which secrets are set, whether the server is connected, why it is
not when it should be, whether its network is enforced (`network`), its
content hash (and `actualHash` on a mismatch), who signed it (`signedBy`),
the signature state (`signature`), its `runtime` and, for an in-process
plugin, its in-process approval and whether it is loaded (`inProcess`;
`connected` then means loaded).

the signature state (`signature`) and what it contributes
(`contributions`, [Contributions](#contributions)).

### From the command line

```
octi plugin list
octi plugin approve finapi --hash sha256:<actualHash>
octi plugin approve finapi            # shows the actual hash and asks (at a terminal only)
octi plugin approve-in-process auditlog --hash sha256:<contentHash>   # an in-process plugin
octi plugin approve-contributions finapi   # shows its commands, schedules, events, context and prompt text, and asks
octi plugin approve-contributions finapi --hash sha256:<contributions.hash>
octi plugin set finapi region=eu limit=50 note=   # settings; key= clears one
octi plugin secret finapi FINAPI_CLIENT_SECRET    # hidden prompt
octi plugin secret finapi FINAPI_CLIENT_SECRET < secret.txt   # or stdin
octi plugin secret finapi FINAPI_CLIENT_SECRET --clear
octi plugin uninstall finapi          # asks; --yes when not at a terminal
octi plugin bundled                   # the plugins shipped with Octipus
octi plugin install-bundled reader    # install one, disabled (--upgrade for a newer version)
```

They call the running backend at `http://localhost:$API_PORT` (3005 by
default) with the bearer token in `OCTIPUS_API_TOKEN` (an admin's API token,
Settings → API Tokens; [API.md](API.md#getting-an-api-token)), as `octi
persona` does. `list` shows each package's state, runtime, signature, network
state, its recorded and actual hash and, for an in-process plugin, its
in-process approval. `approve-in-process` works like `approve`, for the
approved content hash. `approve` without `--hash` refuses when it
cannot ask (not a terminal) and prints the command to run after reviewing; a
`409` (the files changed again) is shown and exits non-zero. `set` sends the
pairs as one settings change (the backend checks them against the manifest;
all or nothing); exactly `key=` clears a setting, and a value of spaces alone
is refused. `secret` never takes the value on the command line, where it
would end up in the shell history and the process list, and a refused command
line is never repeated back: it reads the value from a prompt that does not
echo (escape sequences and control characters other than Backspace are
dropped), or from stdin (one trailing newline dropped), refuses one longer
than 10,000 characters (what the API accepts), and never prints it. `uninstall` asks at a terminal and is refused elsewhere
without `--yes`.

Every change is in the audit log (`resource_type = plugin_package`).

## Not yet

- Packages reporting events back on their own (a new invoice in DATEV opening
  a case): plan point C2b. Today a package learns of host events only through
  [Events](#events), and acts only through its tools.
- Search, ratings or publisher pages: a registry is a flat list (signed by
  its publisher when the host asks for it, [Signed registry
  indexes](#signed-registry-indexes)).
- Online revocation: a revoked key is revoked on a host only when that host's
  config says so (`revoked`, `revokedKeys`, `notAfter`).
- Network enforcement on Windows: the egress proxy is advisory there (no
  built-in runner; see [Network](#network)).
- In a shared space, plugin tools follow the rules of personal connections
  (reads allowed, writes asked or refused); space-level packages come later.
