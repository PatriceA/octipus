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
| `roles.<role>` | Rules added for every tool call made by an agent of that role (`research`, `coding`, ...). Its `default` overrides the global one. |
| `requireEnforcement` | Refuse a shell command whose network no sandbox can confine, instead of running it with the proxy as advice ([shell commands](#shell-commands)). |

A rule is `{ action, host | cidr, ports?, schemes?, note? }`:

- `host`: `api.example.com` (exactly that name), `*.example.com` (any
  subdomain — not the apex; list it too), or an IP address.
- `cidr`: an address range (`203.0.113.0/24`, `2001:db8::/32`), matched
  against the addresses the request connects to.
- `ports`: the ports it covers (all when absent). `schemes`: `http` and/or
  `https` (both when absent).
- `note`: shown in refusals and the audit log.

## How a request is decided

1. The host is put in one canonical form: lower case, IDN as punycode,
   percent-escapes and full-width dots decoded, numeric IPv4 spellings
   (`0x7f000001`, `2130706433`) as dotted quads, IPv6 compressed and without
   brackets, IPv4-mapped IPv6 as its IPv4, trailing dots removed. A URL's
   userinfo (`https://allowed.example@evil.example/`) is never the host.
2. The rules that apply are the global ones, the role's and the tool's.
3. **Deny wins:** any deny rule matching the name, or any address the name
   resolved to, refuses.
4. Otherwise an allow rule matching the name allows — or an address rule
   covering *every* resolved address.
5. Otherwise the default: the tool's, else the role's, else the global one.

Addresses are the ones the connection is pinned to: the fetch path and the
proxy both resolve once, judge those addresses, and connect to one of them, so
a name that re-resolves later (DNS rebinding) cannot change the answer.

**The SSRF guard comes first and is not configurable here.** Loopback,
private, link-local, CGNAT, unique-local and cloud-metadata addresses
(`169.254.169.254`) stay refused whatever a rule allows.

## Where it applies

Only to tool calls: every handler of a built-in tool runs with its tool id
and the agent's role (`BaseTool`), and a plugin package's network as
`plugin:<name>`. Octipus's own traffic — model providers, webhooks, hooks,
federation, provider discovery — is not a tool's and is not judged by it.

| Path | Status | What is judged |
|---|---|---|
| Web fetch (`fetchGuarded`): websearch's API-schema fetch, vision's image URLs, the plugin host's `web:read` | Enforced | Every hop: each redirect target is judged like the first URL, before it is contacted. |
| Browser pages: `browser` open/navigate, `websearch` fetch_page | Partial | The URL before navigation; after it, every hop of the redirect chain and the address the page came from. A refused page is not returned. **Not judged:** sub-resources the page loads, and navigation a later click causes. |
| Shell commands (`shell` run / run_background) | Enforced with a Linux or macOS sandbox, advisory without | See below. |
| Plugin packages with declared `network` hosts | Enforced where the package is sandboxed | The policy is applied in the package's egress proxy on top of its manifest: a declared host the policy denies is refused. Under a `deny` default the package needs an allow (`"plugin:<name>": { "default": "allow" }` allows exactly its manifest). Under `plugins.sandbox: off` the proxy itself is advice only ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#network)). |

Not covered: websearch's search queries (the configured SearXNG or the
search engine pages it scrapes), external MCP servers you configured (their
own processes and network), the SSH execution environment (commands run on
the remote host, with its network), and system-initiated commands
(verification gates, Companion maintenance).

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
Clients that ignore proxy variables, and protocols that cannot go through an
HTTP proxy (`git` over SSH, raw sockets, DNS), fail under the enforced modes.
A `CONNECT` tunnel's contents are opaque to the proxy: it is judged as
`https` on its port, and a client can present another TLS name (SNI) inside
it — narrow such rules with `ports`.

`GET /api/settings/egress` and a warning in the server log say which mode the
shell is in.

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
