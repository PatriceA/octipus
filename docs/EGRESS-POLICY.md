# Egress policy

What tools may reach on the network, set by the operator in one place:
`security.egressPolicy` (Settings → Security, or `PUT /api/settings`). One
engine (`src/security/egress-policy.ts`) decides for every outbound path a
tool can take; what each path actually holds on your host is reported at
`GET /api/settings/egress` (admin).

Without a policy — the default — nothing changes: tools reach what they
reached before.

## The setting

```json
{
  "default": "deny",
  "rules": [
    { "action": "allow", "host": "*.wikipedia.org", "schemes": ["https"] },
    { "action": "allow", "host": "docs.python.org" },
    { "action": "deny", "cidr": "203.0.113.0/24", "note": "partner network" }
  ],
  "tools": {
    "shell": { "rules": [
      { "action": "allow", "host": "registry.npmjs.org", "ports": [443] },
      { "action": "allow", "host": "pypi.org" },
      { "action": "allow", "host": "files.pythonhosted.org" }
    ] },
    "plugin:reader": { "default": "allow" }
  },
  "roles": {
    "research": { "rules": [{ "action": "allow", "host": "*.arxiv.org" }] }
  },
  "requireEnforcement": false
}
```

| Field | Meaning |
|---|---|
| `default` | `allow` (default) or `deny`: what a request no rule matches gets. |
| `rules` | Global rules, applied to every tool. |
| `tools.<id>` | Rules added for one tool: a tool id (`shell`, `websearch`, `browser`, `vision`) or `plugin:<package>`. Its `default` overrides the role's and the global one. |
| `roles.<role>` | Rules added for every tool call made by an agent of that role (`research`, `coding`, ...). Its `default` overrides the global one. A spawned agent is judged under its own role **and every ancestor's** ([roles](#roles)). |
| `requireEnforcement` | Refuse what the policy cannot judge instead of letting it through: a shell command whose network no sandbox can confine ([shell commands](#shell-commands)), and every action listed under [not covered](#not-covered). |

At most 200 entries each in `tools` and `roles`, and 500 rules per scope.

A rule is `{ action, host | cidr, ports?, schemes?, note? }`:

- `host`: `api.example.com` (exactly that name), `*.example.com` (any
  subdomain — not the apex; list it too), `*` (every host), or an IP address.
  Any other wildcard (`*.*.com`, `api.*`) is refused when the setting is
  saved: it would match nothing.
- `cidr`: an address range (`203.0.113.0/24`, `2001:db8::/32`), matched
  against the addresses the request connects to. An IPv6 range inside the
  IPv4-mapped, IPv4-compatible or 6to4 space is the IPv4 range it stands
  for (`::ffff:203.0.113.0/120` = `203.0.113.0/24`); one too short to convert
  is refused. Other IPv6 ranges (`::/0` included) match native IPv6 only.
- `ports`: the ports it covers (all when absent). `schemes`: `http`, `https`
  and/or `ssh` (git over SSH) — all when absent.
- `note`: shown in refusals and the audit log.

## How a request is decided

1. The host is put in one canonical form: lower case, IDN as punycode,
   percent-escapes and full-width dots decoded, numeric IPv4 spellings
   (`0x7f000001`, `2130706433`) as dotted quads, IPv6 compressed and without
   brackets, IPv4-mapped, IPv4-compatible and 6to4 IPv6 as the IPv4 they
   carry, trailing dots removed. A URL's userinfo
   (`https://allowed.example@evil.example/`) is never the host.
2. The rules that apply are the global ones, the role's and the tool's.
3. **Deny wins:** any deny rule matching the name, or any address the name
   resolved to, refuses.
4. Otherwise an allow rule matching the name allows — or an address rule
   covering *every* resolved address.
5. Otherwise the default: the tool's, else the role's, else the global one.

Addresses are the ones the connection is pinned to: the fetch path and the
proxies both resolve once, judge those addresses, and connect to one of them,
so a name that re-resolves later (DNS rebinding) cannot change the answer.

**Before resolving**, the name alone is judged. Where it settles the answer —
a deny on the name, or a `deny` default with no allow that the name or an
address rule could still give — the request is refused without a DNS query,
so a name under a deny default cannot carry data out through DNS. Only where
an address rule could still change the answer is the name resolved first.

**The SSRF guard comes first and is not configurable here.** Loopback,
private, link-local, CGNAT, unique-local and cloud-metadata addresses
(`169.254.169.254`) stay refused whatever a rule allows.

## Roles

A role scope is a boundary along the whole spawn chain: an agent's tool call
is judged under its own role and under the role of every agent above it, and
allowed only when each of them allows it. A `coding` agent under
`roles.coding.default: deny` cannot reach a host by spawning a `research`
child to fetch it. The chain is carried by every spawn path: swarm children
and the workers of pipeline stages, hook actions and the plugin host agent.

A scheduled artifact refresh runs for no agent, so it has no role: only the
global rules and `tools.artifacts` apply to it. A refresh a tool call
triggers is judged as that call (its tool and role chain).

## Where it applies

To tool calls: every handler of a built-in tool runs with its tool id, the
agent's role and its ancestors' roles (`BaseTool`); a plugin package's
network as `plugin:<name>`; an artifact data source as `artifacts` (a
scheduled refresh as its owner's, with no role). Octipus's own traffic — model providers,
webhooks, hooks, federation, provider discovery — is not a tool's and is not
judged by it.

| Path | Status | What is judged |
|---|---|---|
| Web fetch (`fetchGuarded`): websearch's API-schema fetch, vision's image URLs, artifact `http`/`rss` sources and the `art_collect_*` collectors, the plugin host's `web:read` | Enforced | Every hop: each redirect target is judged like the first URL, before it is contacted. Private and metadata addresses refused. |
| Browser pages: `browser` (every action, `evaluate` included), `websearch` search and fetch_page, `visual` | Enforced | The browser context is routed through its own egress proxy, so every request a page makes — redirect hops, sub-resources, scripts, clicks — is judged before it is sent; Chromium's loopback bypass is switched off. A context opened before the policy applied, or for another tool or role chain, is not reused. Behind the proxy, a navigation the proxy refused is reported as a refusal (the proxy's own `403`, or a failed tunnel), and the post-connect address check is skipped: `serverAddr()` would be the proxy itself, which already pinned and judged the connection. `visual` refuses private addresses up front and, under a policy, captures with Chromium. Every headless Chromium runs with WebRTC limited to proxied UDP and QUIC off (with or without a policy), so a page cannot send UDP around the proxy. Not through the proxy: the browser's own DNS prefetch. Under a `deny` default, allow the search engines (`www.google.com`, `html.duckduckgo.com`) for `websearch`. |
| Shell commands (`shell` run / run_background) | Enforced with a Linux or macOS sandbox, advisory without | See below. |
| `git` clone / pull / push, `github` repo_clone | Partial | See [git](#git). |
| Plugin packages with declared `network` hosts | Enforced where the package is sandboxed | The policy is applied in the package's egress proxy on top of its manifest: a declared host the policy denies is refused. Under a `deny` default the package needs an allow (`"plugin:<name>": { "default": "allow" }` allows exactly its manifest). Under `plugins.sandbox: off` the proxy itself is advice only ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#network)). |

### Not covered

These reach the network in ways the policy cannot judge. With a policy active
they still run unless `requireEnforcement: true`, which refuses the ones
marked *refused*:

| What | Why | Under `requireEnforcement` |
|---|---|---|
| `docker`: compose_project, start_container, build_image, exec_command | Containers and builds use the Docker daemon's network | Refused |
| `browser-ext`: navigate, new_tab, evaluate, click, press_key, fill, select, drag, fill_login | Drives the user's own browser | Refused (also `visual`'s extension fallback) |
| `mcp_admin`: mcp_add_server | An added MCP server is its own process | Refused |
| `test_container`: run (`run_test_container`) | The container runs on Docker's bridge network | Refused |
| CLI-agent models with vendor-native tools | Their tools run inside the vendor CLI | Refused (the run fails before the CLI starts) |
| The `github` tool's API calls, websearch through your SearXNG, the `connections` tool (a configured connection's approved origins), the plugin host's repository collector (an approved repository's remotes), MCP servers you configured, the SSH execution environment, system-run commands (verification gates, Companion maintenance) | Fixed or operator/user-configured destinations, or another machine's network | Still run |

The list was made by searching every tool for a process or container it
starts with network of its own; skill scripts run with no network at all
(`--unshare-all`) and are not on it.

`GET /api/settings/egress` lists all of them.

## Shell commands

Nothing parses commands for host names. A command that asks for network
(`network: true`, or a host-services stage) gets no network of its own, only
an egress proxy that asks the policy about every connection:

| Sandbox (`security.shellSandbox`) | What happens | Enforced? |
|---|---|---|
| Linux, bwrap or firejail | The command runs in a network namespace with only loopback; the proxy's Unix socket is mounted in, and a launcher bridges the namespace's `127.0.0.1` to it and sets `HTTP(S)_PROXY`. The proxy is the only way out. | Yes |
| macOS, sandbox-exec (`required`) | The Seatbelt profile allows outbound TCP only to the proxy's loopback port. | Yes |
| Off, `auto` without a working runner, macOS under `auto`, Windows | The command keeps the host network. It gets `HTTP(S)_PROXY` pointing at the proxy, which only well-behaved HTTP clients honour; a direct connection is not stopped. | **No — advisory.** With `requireEnforcement: true` the command is refused instead. |

A sandboxed command that did not ask for network has none, as before.

Inside the namespace, loopback is the command's own: `NO_PROXY` is
`localhost,127.0.0.1,::1`, so `start a server && curl localhost:3000` works.
Services on the **host's** loopback or the LAN, which `network: true`
reached before, are refused under any active policy — the proxy refuses
private addresses whatever a rule allows, and no rule re-opens them. Use a
host-services stage without a policy, or run such commands where no policy
applies.

The proxy's socket is created under `$XDG_RUNTIME_DIR` (else the temp
directory), outside every workspace folder, and mounted only into the
command it serves. firejail does not hide `$XDG_RUNTIME_DIR`, so every
proxy also requires a per-command token: the launcher sends it first on each
connection, from an environment variable it removes before starting the
command; a client without it gets nothing. Socket directories a crashed run
left behind are removed the next time a sandboxed command needs a proxy.
firejail hides the temp directory: without `XDG_RUNTIME_DIR`, a firejail
command has no network (the log says so).
Clients that ignore proxy variables, and protocols that cannot go through an
HTTP proxy (`git` over SSH, raw sockets, DNS), fail under the enforced modes.
A `CONNECT` tunnel's contents are opaque to the proxy: it is judged as
`https` on its port, and a client can present another TLS name (SNI) inside
it — narrow such rules with `ports`.

`GET /api/settings/egress` and a warning in the server log say which mode the
shell is in.

## git

The `git` and `github` tools run git as a process of their own, not through
the proxy, so a policy is applied before git starts:

- **The URL git will use** is judged with its addresses, as `https`/`http`
  or `ssh`: `insteadOf` applied (`git ls-remote --get-url`), a remote's push
  URLs for a push, and for a push to a URL the `pushInsteadOf` rewrite.
  scp-style remotes are cut where git cuts them (the host ends at the first
  `:`, brackets kept whole); a spelling git or ssh could read differently
  from a person (`a:x@b:repo`, a backslash or two `@` in a URL) is refused.
  `git://`, `ext::` and other `<helper>::` transports are refused.
- **`gh repo clone`** is judged on what gh will clone: the repository URL on
  its host as `gh repo view` reports it, over the protocol gh is configured
  to use for that host (`git_protocol`), and the parent of a fork.
- **Repository configuration** the model could have written that reroutes
  the run or runs a command — `http.proxy`, `remote.<name>.proxy`,
  `remote.<name>.uploadpack`/`receivepack`, `core.sshCommand`,
  `core.gitProxy`, `core.fsmonitor`, `core.hooksPath`, credential helpers,
  `protocol.*`, includes, filter and merge drivers, submodule recursion — is
  refused at repository scope. The operator's global and system git
  configuration is trusted and left alone.
- **pull, push and clone run with hooks off**, `ext::` disabled and no
  fsmonitor.

Not judged: what git does after it starts (an HTTP redirect it follows,
submodules, LFS endpoints), and hooks of local actions such as commit.
Private hosts are not refused for git (an internal server worked before and
still does when a rule allows it).

Independently of any policy, no value the model passes — a branch, remote,
URL, path, target, repository — may start with `-`: `pull` with a branch of
`--upload-pack=<command>` ran that command on the server. git's positionals
follow `--`; gh's are checked instead, since gh gives `--` a meaning of its
own.

## Refusals

A refused request:

- returns an error to the model naming the host, port, scheme, tool, role and
  the rule (`Network access to x.example:443 (https) is denied by the
  operator's egress policy for tool websearch as role research — default
  (deny). Do not retry this host; ...`). Through the proxy, the command sees
  `403` with the rule in the body.
- is logged (`Egress refused by policy`) and written to the audit log as
  `permission_denied`, resource `egress`, `host:port`, with
  `{ host, port, scheme, tool, role, rule, path }` — never a URL path, query,
  header or body.
