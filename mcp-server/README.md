# Octipus MCP server

This package exposes an Octipus backend as a Model Context Protocol server. It
registers 88 tools across 26 groups for chat, search, agents, sessions, models,
knowledge, documents, tasks, research, and administration. Tool availability
and results still depend on the connected backend, the authenticated user, and
that user's permissions.

## Install and build

From the repository root:

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

Use `OCTIPUS_API_KEY` for current deployments. Although the bridge still reads
`OCTIPUS_USER` and `OCTIPUS_PASSWORD`, its login path expects a token that the
current login endpoint does not return, so that alternative is not currently
usable.

The HTTP/SSE transport (`npm run start:http`) is experimental and should not be
treated as a production remote endpoint. `MCP_API_KEY` protects its MCP-facing
endpoints, while the `OCTIPUS_*` credentials authenticate requests from the
bridge to the Octipus backend.

`OCTIPUS_API_KEY` may contain an Octipus API key or JWT. Requests are
unauthenticated when it is not configured.

The default transport is stdio, so `npm start` and `npm run start:stdio` are
equivalent. A typical MCP client configuration is:

```json
{
  "mcpServers": {
    "octipus": {
      "command": "node",
      "args": ["/absolute/path/to/octipus/mcp-server/dist/index.js"],
      "env": {
        "OCTIPUS_URL": "http://localhost:3005",
        "OCTIPUS_API_KEY": "octi_your_token"
      }
    }
  }
}
```

## Experimental HTTP/SSE transport

The process can start an HTTP listener for development:

```bash
MCP_API_KEY=choose-a-separate-transport-key npm run start:http
```

The default port is `3010`; pass `-- --port 4010` to change it. The intended MCP
endpoint is `/sse`. `MCP_API_KEY` protects the MCP transport with a bearer token, while
`OCTIPUS_API_KEY` authenticates requests from this server to Octipus. Set
`CORS_ORIGINS` to a comma-separated allowlist when browser clients use the HTTP
transport.

The current `/messages` handler does not hand requests to the SDK transport, so
the HTTP mode is not a working general-purpose remote MCP endpoint yet. Use
stdio for client integrations.
