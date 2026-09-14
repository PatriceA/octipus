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

MCP meta-tools are available to these roles: **research**, **coding**, **general**, **devops**, **security**, **data**, **ai**, **automation**, **architecture**. The root runs as `general` and therefore has MCP access. Other roles (qa, design, review, communication, finance, pm, writing) don't include MCP by default — add `'mcp'` to their `toolIds` in `src/core/agent/roles/<name>/config.ts` if needed.

## Execution permissions

Tool discovery does not authorize execution. The bridge checks each outbound
call using tool ID `mcp` and action `<serverId>.<remoteToolName>`, including lazy
calls and artifact refresh/collection. ASK prompts through an attended session;
unattended calls are blocked. Stored DENY takes precedence. Reviewed grants can
be limited by session, workspace, argument patterns, and expiry; see
[Tools API](API.md#tools).

Old expanded-tool overrides using `mcp:<serverId>` need review and recreation
under the canonical `mcp` action identity. These checks govern bridge dispatch,
not the internal behavior or isolation of an external MCP server.

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
octi restart
```

Octipus will auto-connect to n8n on startup. Verify with:

```bash
curl -H "Authorization: Bearer $OCTIPUS_API_TOKEN" http://localhost:3005/api/mcp/servers | jq
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
curl -H "Authorization: Bearer $OCTIPUS_API_TOKEN" http://localhost:3005/api/mcp/circuit

# Force-reset a stuck breaker
curl -X POST -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  http://localhost:3005/api/mcp/circuit/n8n/reset
```

Reset the breaker after you've fixed the underlying issue (restarted the server, fixed auth, etc.). The reset is not a workaround — if failures continue, the breaker will trip again.

## Optional code search with CocoIndex Code

The **MCP → Connectors** tab offers **CocoIndex Code** alongside the account
connectors. It is optional: ordinary Octipus installation and filesystem search
work without it. CocoIndex maintains its own code index; source chunks are not
added to Octipus's general knowledge base.

An administrator selects a folder **on the backend machine**, chooses a local
embedding model, and clicks **Install and connect**. The card reports installation
and connection progress and surfaces setup errors. A remote desktop or browser
client cannot use a client-local folder unless the backend can also access it.

The managed installer runs on Linux, macOS and Windows backends. It needs
Python 3.11 or newer and `uv` or `pipx` available to the
Octipus process, or an existing `ccc` installation with local embedding support
(`cocoindex-code[full]`). The installer does not install
Python or a Python package manager. In Docker, these prerequisites and the
selected repository folder must be available inside the backend container.

On Windows the installer resolves `ccc.exe` and, because that launcher is a
compiled binary with no shebang to read, finds the interpreter backing it in
uv's tool directory (`<uv tool dir>\cocoindex-code\Scripts\python.exe`). The
manual route below remains available and is the one to use when the backend
has no `uv`, or when CocoIndex is already installed some other way.

This is an installation-wide MCP server, shared with agents on that Octipus
server. The selected folder controls where CocoIndex searches; it is not a
per-user access boundary. Choose only code suitable for that shared access.
Local embeddings do not need a provider API key. Installation and initial model
downloads require network access. The local embedding dependencies, including
PyTorch, can occupy several GB of disk space.

After connection, agents with MCP access discover CocoIndex through
`mcp_list_tools` and call its search tool through `mcp_call_tool`. Existing MCP
execution permissions still apply. Setup downloads the selected embedding model
and builds the initial index before reporting connected. This may take time for
large folders. Later searches refresh the index incrementally by default.
Search results help locate relevant code; agents should inspect the current
files before editing.

**Apply and reconnect** updates the selected folder/model and refreshes its
index. Changing models rebuilds the managed index. **Remove connector**
disconnects and removes the managed MCP server configuration; installed packages
and index files remain on disk. General knowledge search and built-in repository
navigation are unaffected.

This connector provides semantic code search, not a cross-repository call graph.
See the [CocoIndex Code documentation](https://github.com/cocoindex-io/cocoindex-code)
for upstream search and indexing behavior.

### Windows manual CocoIndex setup

Windows backends can use an individually configured stdio MCP server instead
of the managed connector. Prefer the managed installer above — it does these
steps for you, and it now runs on Windows. Use this route when the backend has
no `uv`, when CocoIndex is already installed another way, or when you want the
server outside the connector's lifecycle.

Run PowerShell on the **backend machine**, under the Windows account that runs
Octipus. Installing on a Windows desktop client does not install anything on a
remote Linux/Docker backend.

Install uv, following its [Windows installation instructions](https://docs.astral.sh/uv/getting-started/installation/#winget):

```powershell
winget install --id=astral-sh.uv -e
```

Open a new PowerShell window. Install CocoIndex and initialize the chosen
repository (replace `C:\src\project` with your folder):

```powershell
uv tool install --upgrade 'cocoindex-code[full]'
$cocoExe = Join-Path (uv tool dir --bin) 'ccc.exe'
$env:COCOINDEX_CODE_DIR = Join-Path $env:LOCALAPPDATA 'Octipus\cocoindex-manual'
Set-Location 'C:\src\project'
& $cocoExe init
& $cocoExe index
& $cocoExe search 'session authentication'
Write-Output $cocoExe
Write-Output "COCOINDEX_CODE_DIR=$env:COCOINDEX_CODE_DIR"
```

During `init`, select **sentence-transformers** for local embeddings and choose
a model. This uses separate manual-connector settings under LocalAppData.
Wait for indexing to finish and confirm that a query relevant to your code
returns results. Stop and resolve any command errors before adding the server.
The package and model downloads can take time and use several GB of disk space.
See [upstream CocoIndex setup](https://github.com/cocoindex-io/cocoindex-code).

As an Octipus administrator, open **MCP → MCP Servers → Add Server**, choose
**stdio**, and enter:

| Field | Value |
|---|---|
| Name | `CocoIndex Windows` (keeps it distinct from the managed connector) |
| Command | The full `ccc.exe` path printed above, without surrounding quotes |
| Arguments | `mcp` |
| Working directory | Your repository folder, for example `C:\src\project` |
| Process settings → Request timeout | `1800` seconds |
| Process settings → Treat stderr output as an error | Off; CocoIndex writes ordinary logs to stderr |
| Environment Variables | The printed `COCOINDEX_CODE_DIR=…` line with its full absolute path |

Save the server. Confirm that it becomes connected and that its tool list
contains `search`. It uses the normal MCP execution permissions and is shared
with agents on this server. Manage connection/removal in **MCP Servers**; the
managed CocoIndex card does not track this manual installation.

If startup fails:

- **Executable not found:** check the full path from `uv tool dir --bin` and
  that the backend account can execute it. Restart Octipus if its environment
  predates installation. Full executable paths avoid relying on an updated PATH.
- **Wrong repository or model:** verify the working directory and the exact
  `COCOINDEX_CODE_DIR` environment value. Run the commands using that same account
  and settings directory. Avoid inherited `COCOINDEX_CODE_HOST_CWD` or host-path
  mappings from another CocoIndex installation.
- **No search results:** run `ccc index` from the selected folder using the same
  settings directory; inspect ignored files and reported indexing errors.
- **Changed embedding model:** disconnect in Octipus, run `ccc daemon stop`,
  `ccc reset --force`, then `ccc index` in the selected folder/settings context,
  and reconnect. Reset removes the code index, not source files.

Removing the MCP server does not uninstall CocoIndex or delete its local index.
