# Octipus MCP server

This package exposes an Octipus backend as a Model Context Protocol server. It
registers 87 tools across 25 groups for chat, search, agents, sessions, models,
knowledge, documents, tasks, research, and administration. Tool availability
and results still depend on the connected backend, the authenticated user, and
that user's permissions.

## v0.6.0

This release adds the `update_skill` alias for `octipus_update_skill` and
includes skill IDs in listings. Existing `list_skills` and `get_skill` aliases
remain available for managed agent workflows.
Update the connected Octipus backend to 0.6.0 for the new update behavior.
Mounted skills must still be edited at their source and reloaded.

Install this version with `npm install -g octipus-mcp-server@0.6.0`, or use
`npx -y octipus-mcp-server@0.6.0` in your MCP client. Restart the client after
updating. See the [full release notes](https://github.com/PatriceA/octipus/releases/tag/v0.6.0).

## Install

Published on npm, so nothing needs to be checked out to use it:

```bash
npx octipus-mcp-server            # run it without installing
npm install -g octipus-mcp-server # or install, and get `octipus-mcp` on PATH
```

It is a bridge, not a backend: it needs a running Octipus instance to talk to,
and the URL and credentials below are how it finds one.

To build it from a checkout instead — when changing it, or to run an unreleased
revision:

```bash
cd mcp-server
npm install
npm run build
```

The server requires Node.js 18 or newer. The rest of the Octipus repository
requires Node.js 24 or newer, so use Node.js 24 when developing both together.

## Connect over stdio

Start the Octipus backend first, then set its URL and one authentication method:

```bash
export OCTIPUS_URL=http://localhost:3005
export OCTIPUS_API_KEY=octi_your_token
npm run start:stdio
```

A personal access token in `OCTIPUS_API_KEY` is the preferred setup. Alternatively,
set both `OCTIPUS_USER` and `OCTIPUS_PASSWORD` for an account without TOTP. The
bridge logs in through `/api/auth/login-mobile`, caches the returned token until
shortly before its server-reported expiry, and shares concurrent login attempts
within one backend client. Accounts requiring TOTP should use a personal access
token; this bridge has no interactive TOTP flow.

In username/password mode, a backend `401` refreshes authentication and retries
the request once. API-key mode takes precedence and does not refresh or retry
an unauthorized request. Other errors are returned without authentication retries.

`OCTIPUS_API_KEY` accepts a personal access token or session JWT. Protected
backend calls require configured credentials. The transport key described below
is separate from backend authentication.

The direct tool bridge (`octipus_list_tools`, `octipus_execute_tool`, and the
web search, page fetch, knowledge, messaging, notes, tasks, profiles and email
tools built on it) calls `/api/tools/all` and
`/api/tools/:id/tools/:name/execute`. With a non-admin token it lists and runs
only the tools your own chat agent has (the general role's tools, without the
install's MCP servers), under your tool permissions; anything that would ask
for approval is refused. An admin token reaches every registered tool. The
health, model and channel status tools need an admin token.

The default transport is stdio, so `npm start` and `npm run start:stdio` are
equivalent. A typical MCP client configuration — Claude Desktop, Claude Code,
or anything else that speaks MCP over stdio — is:

```json
{
  "mcpServers": {
    "octipus": {
      "command": "npx",
      "args": ["-y", "octipus-mcp-server"],
      "env": {
        "OCTIPUS_URL": "http://localhost:3005",
        "OCTIPUS_API_KEY": "octi_your_token"
      }
    }
  }
}
```

From a checkout, point the client at the built entry instead — `"command":
"node"`, `"args": ["/absolute/path/to/octipus/mcp-server/dist/index.js"]` — so
it runs the revision you are editing rather than the published one.

## HTTP/SSE transport

```bash
export OCTIPUS_API_KEY=octi_your_backend_token
export MCP_API_KEY=choose-a-separate-transport-key
npm run start:http
# Alternate port or explicit network bind:
npm run start:http -- --port 4010 --host 0.0.0.0
```

The listener defaults to `127.0.0.1:3010`. `--host` overrides `MCP_HOST`;
`--port` changes the port. A nonempty `MCP_API_KEY` is required at startup.
Use TLS through a reverse proxy when exposing it remotely.

This preserves the legacy MCP HTTP+SSE transport (deprecated by the SDK); it
is not the newer Streamable HTTP `/mcp` protocol:

- `GET /sse` opens a stream and advertises `/messages?sessionId=<id>`.
- `POST /messages?sessionId=<id>` sends JSON-RPC to that stream's session.
  Accepted messages return `202`; results arrive as SSE events.
- Both endpoints require `Authorization: Bearer <MCP_API_KEY>`. Configure the
  header for both the stream request and subsequent POSTs in your client.
- Each stream has its own MCP server/protocol state. Closing the stream removes
  the session; unknown or closed sessions return `400`.
- Requests with an `Origin` header must match `CORS_ORIGINS` exactly (a
  comma-separated list, default `http://localhost:3007`). Other origins get
  `403`. Native clients without `Origin` are accepted if authenticated.
- SDK parsing limits POST bodies to 4 MB and rejects malformed JSON-RPC.
- `GET /health` is public and reports listener availability, not backend readiness.

All HTTP clients act through the **same configured Octipus backend account**.
The transport key is a shared access credential, not a per-user identity. Backend
permissions still apply, including unattended ASK refusal. Share this bridge
only with clients authorized to use that account. Stdio continues to work without
an HTTP transport key.

## Tests

`npm test` builds the package and runs Node tests for authentication and real SDK
HTTP/SSE roundtrips against local fixtures, including concurrent clients,
rejected requests, and disconnect/shutdown cleanup. These tests do not measure
live model quality or validate a remote proxy deployment.

### Updating skills

Use `octipus_list_skills` to find the skill ID, read it with `get_skill`, then call
`update_skill` (also available as `octipus_update_skill`) with `skill_id` and only
the fields to change. `content` replaces the complete Markdown body; an empty
string clears it and activates the structured fields. Omitted fields, the skill
ID, and role assignments are preserved. Custom skills require their owner or an
administrator. Mounted skills remain read-only: edit the source and use
**Reload mounted skills** in Octipus. The same `update_skill` tool is available
to internal agents without an MCP connection.
