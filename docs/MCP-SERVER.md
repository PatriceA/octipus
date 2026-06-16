# MCP Server

Standalone MCP server (`mcp-server/`) that exposes Octipus capabilities as MCP tools for CLI models like Claude Code and Antigravity (`agy`).

## Tools

| Tool | Description |
|------|-------------|
| `octipus_search` | Search the web via SearXNG |
| `octipus_fetch_page` | Fetch and extract text from a URL |
| `octipus_list_agents` | List running agents with status |
| `octipus_spawn_agent` | Spawn a new autonomous agent |
| `octipus_stop_agent` | Stop a running agent |
| `octipus_send_message` | Send a message to a running agent |
| `octipus_get_agent_events` | Get agent events (polling with cursor) |
| `octipus_list_sessions` | List recent chat sessions |
| `octipus_get_messages` | Get messages from a session |
| `octipus_list_models` | List available AI models |
| `octipus_model_health` | Get model health status |
| `octipus_chat` | Send a message through the orchestrator |
| `octipus_chat_with_expert` | Chat using a specific expert |
| `octipus_list_experts` | List available experts |
| `octipus_list_tools` | List available tools |
| `octipus_execute_tool` | Execute any tool (filesystem, shell, git, browser-ext, etc.) |
| `octipus_list_skills` | List domain knowledge skills |
| `octipus_get_skill` | Get skill details |
| `octipus_create_skill` | Create a custom domain knowledge skill |
| `octipus_update_skill` | Update an existing skill |
| `octipus_delete_skill` | Delete a custom skill |
| `octipus_search_knowledge` | Search the RAG knowledge base |
| `octipus_index_file` | Index a file into the knowledge base |
| `octipus_create_recurring_task` | Create a scheduled task |
| `octipus_list_recurring_tasks` | List recurring tasks |
| `octipus_update_recurring_task` | Update a recurring task |
| `octipus_delete_recurring_task` | Delete a recurring task |

## Setup

```bash
cd mcp-server && npm install && npm run build
```

## Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "octipus": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "OCTIPUS_URL": "http://localhost:3005",
        "OCTIPUS_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

## Antigravity / agy (`.gemini/settings.json`)

```json
{
  "mcpServers": {
    "octipus": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "OCTIPUS_URL": "http://localhost:3005",
        "OCTIPUS_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

## Browser Extension via MCP

CLI models can interact with your real browser through the MCP bridge:

```
octipus_execute_tool(tool_id="browser-ext", tool_name="get_tabs", args={})
octipus_execute_tool(tool_id="browser-ext", tool_name="screenshot", args={})
octipus_execute_tool(tool_id="browser-ext", tool_name="extract_content", args={"selector": "main"})
octipus_execute_tool(tool_id="browser-ext", tool_name="navigate", args={"url": "https://example.com"})
```

Requires the Chrome extension to be connected. See [Browser Extension](BROWSER-EXTENSION.md).

## HTTP Transport

```bash
node mcp-server/dist/index.js --transport http --port 3010
```
