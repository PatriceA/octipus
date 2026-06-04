# MCP Integration (Client)

Connect external MCP servers to Octipus so agents can use their tools. Unlike simple MCP integrations that expose all tools upfront (flooding the model context), Octipus uses **lazy tool discovery** — agents only see two meta-tools (`mcp_list_tools` and `mcp_call_tool`) and fetch tool details on demand.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  Agent (coding, research, devops, etc.)             │
│                                                     │
│  Built-in tools: filesystem, shell, git, ...        │
│  MCP meta-tools: mcp_list_tools, mcp_call_tool      │
└────────────┬────────────────────────────┬───────────┘
             │ 1. list tools              │ 2. call tool
             ▼                            ▼
┌─────────────────────────────────────────────────────┐
│  MCPBridge (singleton)                              │
│  Manages connections to all configured MCP servers  │
└────────┬──────────────┬──────────────┬──────────────┘
         │              │              │
    ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
    │ n8n     │   │ Brave     │  │ Custom  │
    │ (SSE)   │   │ (stdio)   │  │ (SSE)   │
    └─────────┘   └───────────┘  └─────────┘
```

**Why lazy loading?** Each MCP server can expose dozens of tools with full JSON schemas. With 3-4 servers connected, that's hundreds of tool definitions sent to the model on every request — wasting context window and degrading response quality. With lazy loading, the model sees just 2 small tools and only fetches schemas when it decides to use an MCP tool.

## Configuration

### Config file

MCP servers are configured in a JSON file. Set the path via environment variable or settings:

```bash
# .env
MCP_SERVERS_CONFIG=./mcp-servers.json
MCP_AUTO_START=true
MCP_CONNECTION_TIMEOUT=30000
```

### Server config format (`mcp-servers.json`)

```json
{
  "servers": [
    {
      "id": "n8n",
      "name": "n8n Workflows",
      "isEnabled": true,
      "transport": "sse",
      "sseUrl": "http://localhost:5678/mcp/abc123/sse",
      "postUrl": "http://localhost:5678/mcp/abc123",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    },
    {
      "id": "brave-search",
      "name": "Brave Search",
      "isEnabled": false,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/brave-search-mcp"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      }
    }
  ]
}
```

### Transport types

| Transport | Use case | Fields |
|-----------|----------|--------|
| **stdio** | Local MCP servers (npm packages, local scripts) | `command`, `args`, `env` |
| **sse** | Remote/containerized MCP servers (n8n, web services) | `sseUrl`, `postUrl`, `headers` |

### Which roles get MCP access?

MCP meta-tools are available to these roles: **research**, **coding**, **general**, **devops**, **security**, **data**, **ai**, **automation**, **architecture**. Other roles (qa, design, review, communication, finance, pm, writing, orchestrator) don't include MCP by default — add `'mcp'` to their `toolIds` in `src/core/orchestrator/roles/<name>/config.ts` if needed.

## Managing servers

### Via Web UI

Go to **Settings → MCP** to add, enable/disable, connect, and disconnect MCP servers.

### Via API

```bash
# List servers
GET /api/mcp/servers

# Add a server
POST /api/mcp/servers
{ "id": "my-server", "name": "My Server", "transport": "stdio", "command": "npx", "args": [...] }

# Enable/disable
POST /api/mcp/servers/:id/toggle
{ "enabled": true }

# Connect/disconnect manually
POST /api/mcp/servers/:id/connect
POST /api/mcp/servers/:id/disconnect

# Remove
DELETE /api/mcp/servers/:id

# List all MCP tools (expanded, for UI)
GET /api/mcp/tools
```

## Agent interaction

When an agent with MCP access needs external tools, it follows this pattern:

1. **Discover** — calls `mcp_list_tools` to see available servers and tools with their parameter schemas
2. **Call** — calls `mcp_call_tool` with `server_id`, `tool_name`, and `arguments`

The agent decides autonomously whether MCP tools are relevant. If no MCP servers are connected, the meta-tools are not injected at all (zero overhead).

---

## Setting up n8n as an MCP Server

n8n has native MCP support via the **MCP Server Trigger** node (available in n8n v1.80+).

### Step 1: Create a workflow in n8n

1. Open n8n at `http://localhost:5678`
2. Create a new workflow
3. Add the **MCP Server Trigger** node as the trigger

### Step 2: Add tool nodes

Connect tool nodes to the MCP Server Trigger. Each connected tool becomes a separately callable MCP tool. Options:

- **Built-in tool nodes** — HTTP Request, Google Calendar, Slack, GitHub, etc.
- **"Call n8n Workflow" tool** — exposes an entire existing workflow as a single tool (great for complex automations)

Example: connect a "Call n8n Workflow" tool pointing to your "Deploy to Production" workflow, and agents can trigger deployments via MCP.

### Step 3: Configure authentication

In the MCP Server Trigger node settings:

1. Click **Authentication**
2. Choose **Bearer Authentication** or **Header Authentication**
3. Create credentials in n8n (Settings → Credentials) with a token value
4. Note the token — you'll use it in Octipus config

### Step 4: Get the MCP URLs

The MCP Server Trigger shows two URLs:
- **Test URL** — for debugging (only works in test mode)
- **Production URL** — works when workflow is activated

The URL format is: `http://localhost:5678/mcp/<path>`

For SSE transport, append `/sse`: `http://localhost:5678/mcp/<path>/sse`

### Step 5: Activate the workflow

Toggle the workflow to **Active** so the production URL works.

### Step 6: Configure Octipus

Add the n8n server to `mcp-servers.json`:

```json
{
  "servers": [
    {
      "id": "n8n",
      "name": "n8n Workflows",
      "isEnabled": true,
      "transport": "sse",
      "sseUrl": "http://localhost:5678/mcp/<your-path>/sse",
      "postUrl": "http://localhost:5678/mcp/<your-path>",
      "headers": {
        "Authorization": "Bearer <your-n8n-mcp-token>"
      }
    }
  ]
}
```

Replace `<your-path>` with the path from the MCP Server Trigger node, and `<your-n8n-mcp-token>` with the Bearer token from step 3.

### Step 7: Restart Octipus

```bash
octipus restart
```

Octipus will auto-connect to n8n on startup. Verify with:

```bash
curl http://localhost:3005/api/mcp/servers | jq
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Connection refused | Check n8n is running: `docker ps \| grep n8n` |
| 401 Unauthorized | Verify Bearer token matches n8n credentials |
| SSE hangs | If behind reverse proxy, disable buffering for `/mcp*` routes |
| Tools not appearing | Ensure workflow is **activated** (not just saved) |
| Test URL works but production doesn't | Activate the workflow (toggle at top right) |
| Server stuck disconnected after repeated failures | Circuit breaker opened — see below |

---

## Circuit Breaker

`src/mcp/circuit-breaker.ts` wraps each MCP server connection with a three-state circuit breaker to stop bad servers from pinning the event loop.

| State | Meaning |
|-------|---------|
| `closed` | Normal operation. Failures are counted. |
| `open` | Three consecutive failures tripped the breaker. Calls fail fast without hitting the server. Exponential backoff controls when the breaker tests recovery. |
| `half_open` | A single probe call is allowed; success → `closed`, failure → `open` again with longer backoff. |

Behaviour:
- **3 consecutive failures** on a server flip the breaker from `closed` to `open`.
- **Exponential backoff** governs when the breaker tries a half-open probe.
- The web UI shows a **state badge** per server in Settings → MCP.
- Admins can **force a reset** via API.

### API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp/circuit` | Current state of every server's breaker (admin only) |
| POST | `/api/mcp/circuit/:serverId/reset` | Force a breaker back to `closed` for the given server (admin only) |

```bash
# Inspect breakers
curl -H "Authorization: Bearer $TOKEN" http://localhost:3005/api/mcp/circuit

# Force-reset a stuck breaker
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3005/api/mcp/circuit/n8n/reset
```

Reset the breaker after you've fixed the underlying issue (restarted the server, fixed auth, etc.). The reset is not a workaround — if failures continue, the breaker will trip again.
